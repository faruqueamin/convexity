'use strict';

/**
 * OptionsPlayEngine — paper options execution.
 *
 *   entry : ATM / ranked contract → limit buy at the ask (RiskGate first)
 *   exit  : profit-lock trail, bid stop, session flatten
 *   audit : PaperFillLedger + Alpaca CLI
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const Vol10sConfig = require('./Vol10sConfig');
const { alpacaCliEnv } = require('./alpacaCliEnv');
const { etNow } = require('./marketClock');
const { limitFromPeg, BUY_PEGS, SELL_PEGS } = require('./PaperFillLedger');
const RiskGate = require('./options/RiskGate');
const { evaluateBidMove } = require('./options/BidMoveGate');

const JOURNAL_MAX = 400;
const TICK_MS = 3000;
const BROADCAST_MIN_MS = 1000;
const RTH_START_MIN = 9 * 60 + 30;
const RTH_END_MIN = 16 * 60;
const OPEN_ORDER_STATUSES = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'pending_replace', 'held', 'done_for_day']);
const VECTOR_TAPE_EXITS = new Set(['flip_reverse']);

function envFlag(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return String(v).toLowerCase() === 'true' || v === '1';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class OptionsPlayEngine {
  static pickContractOpts(cfg = {}) {
    const allow0 = cfg.allow0dte === true;
    return {
      dteMode: allow0 ? '0dte' : 'weekly',
      maxDte: cfg.maxDte,
      skipZeroDte: !allow0,
      minPremium: cfg.minPremium,
      maxPremium: cfg.maxPremium,
      minDelta: cfg.minDelta,
      maxSpreadPct: cfg.maxSpreadPct,
    };
  }

  constructor({ optionsClient, paperClient, log, config, dataDir, configPath, fillLedger, getAccount, stockTape, optStream, pendingBook, eventLog } = {}) {
    this.optionsClient = optionsClient || null;
    this.paperClient = paperClient || null;
    this.logger = log || console;
    this.dataDir = dataDir || null;
    this.configPath = configPath || null;
    this.fillLedger = fillLedger || null;
    this.eventLog = eventLog || null;
    this.getAccount = typeof getAccount === 'function' ? getAccount : () => null;
    this.stockTape = stockTape || null;
    this.optStream = optStream || null;
    this.pendingBook = pendingBook || null;
    this.statePath = this.dataDir ? path.join(this.dataDir, 'options-state.json') : null;
    this.cfg = Vol10sConfig.sanitizeOptions(config || {});
    this.enabled = envFlag('VOL10S_OPT_ENABLED', this.cfg.enabled);
    this.armed = envFlag('VOL10S_OPT_ARMED', this.cfg.armed);
    this.onBroadcast = null;
    this.onUnderlyingFill = null;
    this.onUnderlyingCancel = null;
    this.onVectorFlat = null;
    this.onReconcileVector = null;

    this.positions = new Map();   // occ -> position
    this.working = new Map();     // orderId -> working buy
    this.journal = [];
    this.dailyPnl = 0;
    this.dailyDate = null;
    this.dailyLossLocked = false;
    this.lastError = null;
    this.lastCliSyncAt = null;
    this.running = false;
    this._tickTimer = null;
    this._exitTimer = null;
    this._cliTimer = null;
    this._busy = false;
    this._exitBusy = false;
    this._entryInflight = new Set();
    this._lastBc = 0;
    this._dirty = false;

    // Mandatory pre-trade risk gate — every entry path runs through this.
    this.gate = new RiskGate({
      config: RiskGate.configFromOptions(this.cfg),
      feed: this.optionsClient?.feed,
      log: this.logger,
    });

    this._loadState();
  }

  _syncGate() {
    if (!this.gate) return;
    this.gate.setConfig(RiskGate.configFromOptions(this.cfg));
    this.gate.setFeed(this.optStream?.feed || this.optionsClient?.feed);
  }

  // Unrealized PnL of open positions, marked to BID (what we could sell for now).
  _unrealizedPnl() {
    let u = 0;
    for (const p of this.positions.values()) {
      const mark = Number(p.lastBid) || Number(p.lastMid) || 0;
      if (mark > 0 && p.fillPrice > 0) u += (mark - p.fillPrice) * p.qty * 100;
    }
    return Math.round(u * 100) / 100;
  }

  _refreshLossLock() {
    const cap = Math.abs(Number(this.cfg.dailyMaxLossUsd) || 0);
    if (cap > 0 && this.dailyPnl + this._unrealizedPnl() <= -cap) this.dailyLossLocked = true;
    return this.dailyLossLocked;
  }

  // ─── persistence ──────────────────────────────────────────────────────────

  _loadState() {
    try {
      if (!this.statePath || !fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      this.armed = Boolean(raw.armed);
      this.journal = Array.isArray(raw.journal) ? raw.journal.slice(-JOURNAL_MAX) : [];
      const et = etNow();
      if (raw.dailyDate === et.date) {
        this.dailyPnl = Number(raw.dailyPnl) || 0;
        this.dailyDate = raw.dailyDate;
      }
      if (Array.isArray(raw.positions)) {
        for (const p of raw.positions) {
          if (!p || !p.occ || !(Number(p.fillPrice) > 0)) continue;
          this.positions.set(p.occ, {
            occ: p.occ,
            underlying: p.underlying || null,
            qty: Math.max(1, Math.floor(Number(p.qty) || 1)),
            fillPrice: Number(p.fillPrice),
            entryTs: Number(p.entryTs) || Date.now(),
            entryIv: Number(p.entryIv) || null,
            entrySpot: Number(p.entrySpot) || null,
            peakBid: Number(p.peakBid) || Number(p.fillPrice),
            lastBid: null,
            lastIv: null,
            play: p.play || null,
            session: p.session || null,
            lockArmed: Boolean(p.lockArmed),
            exitProfitLockArmed: Boolean(p.exitProfitLockArmed),
            exitProfitLockPeakPct: Number(p.exitProfitLockPeakPct) || 0,
            layers: Math.max(1, Math.floor(Number(p.layers) || 1)),
            sellOrderId: null,
            sellPlacedAt: 0,
            sellChases: 0,
            sellReason: null,
            sellLimit: null,
          });
        }
      }
    } catch (err) {
      this.logger.warn?.(`[opteng] state load failed: ${err.message}`);
    }
  }

  _saveState() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        armed: this.armed,
        dailyPnl: this.dailyPnl,
        dailyDate: this.dailyDate,
        positions: [...this.positions.values()].map((p) => ({
          occ: p.occ,
          underlying: p.underlying,
          qty: p.qty,
          fillPrice: p.fillPrice,
          entryTs: p.entryTs,
          entryIv: p.entryIv,
          entrySpot: p.entrySpot,
          peakBid: p.peakBid,
          play: p.play,
          session: p.session,
          lockArmed: p.lockArmed,
          exitProfitLockArmed: Boolean(p.exitProfitLockArmed),
          exitProfitLockPeakPct: Number(p.exitProfitLockPeakPct) || 0,
          layers: p.layers || 1,
        })),
        journal: this.journal.slice(-JOURNAL_MAX),
        savedAt: new Date().toISOString(),
      }, null, 2));
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      this.logger.warn?.(`[opteng] state save failed: ${err.message}`);
    }
  }

  // ─── journal / broadcast / state ──────────────────────────────────────────

  _journal(type, extra = {}) {
    const et = etNow();
    this.journal.push({ ts: et.iso, type, ...extra });
    if (this.journal.length > JOURNAL_MAX) this.journal.splice(0, this.journal.length - JOURNAL_MAX);
    this.eventLog?.record(type, { ...extra, play: extra.play || 'VECTOR', ts: et.iso });
    this._broadcast();
  }

  // Public journal hook for external actors (supervisor, kill switch).
  journalEvent(type, extra = {}) {
    this._journal(String(type || 'event').slice(0, 40), extra);
    this._saveState();
  }

  _broadcast(force = false) {
    this._dirty = true;
    if (!this.onBroadcast) return;
    const now = Date.now();
    if (!force && now - this._lastBc < BROADCAST_MIN_MS) return;
    this._lastBc = now;
    this._dirty = false;
    try { this.onBroadcast(this.getState()); } catch (err) {
      this.logger.warn?.(`[opteng] broadcast: ${err.message}`);
    }
  }

  getState() {
    const et = etNow();
    this._rollDay(et);
    const open = [...this.positions.values()].map((p) => {
      const bid = Number(p.lastBid) || 0;
      const ask = Number(p.lastAsk) || 0;
      const mid = Number(p.lastMid) || 0;
      const mark = bid || mid || 0;
      const mult = p.qty * 100;
      const pnlBid = bid > 0 && p.fillPrice > 0 ? (bid - p.fillPrice) * mult : null;
      const pnlAsk = ask > 0 && p.fillPrice > 0 ? (ask - p.fillPrice) * mult : null;
      const pnl = pnlBid != null ? pnlBid : (mark > 0 ? (mark - p.fillPrice) * mult : null);
      const parsed = this.optionsClient?.parseOcc?.(p.occ) || null;
      return {
        occ: p.occ,
        underlying: p.underlying,
        side: parsed?.side || null,
        strike: parsed?.strike ?? null,
        expiry: parsed?.expiry ?? null,
        qty: p.qty,
        fillPrice: p.fillPrice,
        bid: p.lastBid,
        mid: p.lastMid,
        ask: p.lastAsk,
        iv: p.lastIv,
        entryIv: p.entryIv,
        pnl: pnl != null ? Math.round(pnl * 100) / 100 : null,
        pnlBid: pnlBid != null ? Math.round(pnlBid * 100) / 100 : null,
        pnlAsk: pnlAsk != null ? Math.round(pnlAsk * 100) / 100 : null,
        pnlPct: mark > 0 && p.fillPrice > 0 ? Math.round(((mark - p.fillPrice) / p.fillPrice) * 1000) / 10 : null,
        pnlAskPct: ask > 0 && p.fillPrice > 0 ? Math.round(((ask - p.fillPrice) / p.fillPrice) * 1000) / 10 : null,
        peakBid: p.peakBid,
        liveMark: Boolean(p.liveMark),
        markAgeMs: p.markAt ? Date.now() - p.markAt : null,
        ageSec: Math.max(0, Math.round((Date.now() - p.entryTs) / 1000)),
        lockArmed: p.lockArmed,
        exitProfitLockArmed: Boolean(p.exitProfitLockArmed),
        exitProfitLockPeakPct: Number(p.exitProfitLockPeakPct) || 0,
        layers: p.layers || 1,
        exiting: Boolean(p.sellOrderId),
        play: p.play,
        session: p.session,
        entryTs: p.entryTs,
      };
    });
    return {
      ok: true,
      type: 'options_engine',
      ts: Date.now(),
      et: et.iso,
      running: this.running,
      enabled: this.enabled,
      armed: this.armed,
      entriesPaused: this.cfg.entriesPaused === true,
      rth: et.mins >= RTH_START_MIN && et.mins < RTH_END_MIN,
      open,
      working: [...this.working.values()].map((w) => ({
        orderId: w.orderId,
        occ: w.occ,
        underlying: w.underlying,
        qty: w.qty,
        limitPrice: w.limitPrice,
        ageSec: Math.max(0, Math.round((Date.now() - (w.startedAt || w.placedAt)) / 1000)),
        peg: w.peg,
        walkStep: w.pegIndex || 0,
        play: w.play,
        session: w.session,
      })),
      dailyPnl: Math.round(this.dailyPnl * 100) / 100,
      unrealizedPnl: this._unrealizedPnl(),
      dayPnlTotal: Math.round((this.dailyPnl + this._unrealizedPnl()) * 100) / 100,
      dailyLossLocked: this._refreshLossLock(),
      dailyDate: this.dailyDate,
      lastCliSyncAt: this.lastCliSyncAt,
      lastError: this.lastError,
      feed: this.optStream?.feed || this.optionsClient?.feed || null,
      streams: {
        stock: this.stockTape ? {
          feed: this.stockTape.feed, connected: this.stockTape.connected, authed: this.stockTape.authed,
          lastTickAt: this.stockTape.stats?.lastTickAt || null,
        } : null,
        options: this.optStream ? {
          feed: this.optStream.feed, connected: this.optStream.connected, authed: this.optStream.authed,
          lastTickAt: this.optStream.stats?.lastTickAt || null,
        } : null,
      },
      account: (() => {
        const a = this.getAccount() || {};
        return { cash: Number(a.cash) || null, equity: Number(a.equity) || null };
      })(),
      openPremium: this._openPremium(),
      gate: this.gate ? this.gate.getState() : null,
      fills: this.fillLedger ? this.fillLedger.getSummary() : null,
      journal: this.journal.slice(-120).reverse(),
      cfg: JSON.parse(JSON.stringify(this.cfg)),
    };
  }

  // ─── config / control ─────────────────────────────────────────────────────

  setArmed(armed) {
    this.armed = Boolean(armed);
    this._journal('system', { note: this.armed ? 'OPTIONS ARMED' : 'OPTIONS DISARMED' });
    this._saveState();
    this._broadcast(true);
    return this.armed;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this._journal('system', { note: this.enabled ? 'OPTIONS ENABLED' : 'OPTIONS DISABLED' });
    this._broadcast(true);
    return this.enabled;
  }

  getConfig() {
    return JSON.parse(JSON.stringify(this.cfg));
  }

  async setConfig(patch = {}) {
    const prevPoll = this.cfg.exitPollMs;
    const prevCli = this.cfg.cliSyncMs;
    this.cfg = Vol10sConfig.sanitizeOptions({ ...this.cfg, ...patch });
    this._syncGate();
    if ('enabled' in patch) this.enabled = this.cfg.enabled;
    if ('armed' in patch) this.armed = this.cfg.armed;
    if (this.configPath) {
      try {
        const full = Vol10sConfig.loadConfig(this.configPath);
        full.options = this.cfg;
        Vol10sConfig.saveConfig(this.configPath, full);
      } catch (err) {
        this.logger.warn?.(`[opteng] config persist failed: ${err.message}`);
      }
    }
    if (this.running && (prevPoll !== this.cfg.exitPollMs || prevCli !== this.cfg.cliSyncMs)) {
      this._startTimers();
    }
    this._journal('system', { note: 'options config saved' });
    this._broadcast(true);
    return this.getState();
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;
    await this.syncFromBroker().catch((err) => {
      this.logger.warn?.(`[opteng] startup sync: ${err.message}`);
    });
    this._startTimers();
    await this._refreshStaleMarks().catch((err) => {
      this.logger.warn?.(`[opteng] startup marks: ${err.message}`);
    });
    this._broadcast(true);
    this.logger.info?.(`[opteng] options engine started (enabled=${this.enabled} armed=${this.armed} open=${this.positions.size} working=${this.working.size})`);
  }

  _isOptionAsset(p) {
    if (!p) return false;
    const cls = String(p.asset_class || p.assetClass || '').toLowerCase();
    if (cls === 'us_option') return true;
    return Boolean(this.optionsClient?.parseOcc?.(p.symbol) || /^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(String(p.symbol || '')));
  }

  _adoptPositionRow(p) {
    const occ = String(p.symbol || '').toUpperCase();
    const parsed = this.optionsClient?.parseOcc?.(occ) || null;
    const underlying = String(p.underlying_symbol || parsed?.underlying || '').toUpperCase();
    const qty = Math.abs(Math.floor(Number(p.qty) || 0));
    const avg = Number(p.avg_entry_price || p.avg_entry || p.fillPrice) || 0;
    if (!(qty > 0) || !occ || !underlying) return false;
    const existing = this.positions.get(occ);
    if (existing) {
      existing.qty = qty;
      if (avg > 0) existing.fillPrice = avg;
      return false;
    }
    this.positions.set(occ, {
      occ,
      underlying,
      qty,
      fillPrice: avg || 0,
      entryTs: Date.parse(p.created_at || '') || Date.now(),
      entryIv: null,
      entrySpot: Number(p.current_price) || null,
      peakBid: Number(p.current_price) || avg || 0,
      lastBid: Number(p.current_price) || null,
      lastMid: null,
      lastAsk: null,
      lastIv: null,
      play: 'VECTOR',
      session: null,
      lockArmed: false,
      layers: 1,
      sellOrderId: null,
      sellPlacedAt: 0,
      sellStartedAt: 0,
      sellLastPegAt: 0,
      sellChases: 0,
      sellPegIndex: 0,
      sellReason: null,
      sellLimit: null,
      adopted: true,
    });
    this._journal('opt_sync_long', {
      symbol: underlying, occ, qty, avg, note: 'startup position', play: 'VECTOR',
    });
    return true;
  }

  _adoptWorkingOrder(o) {
    const occ = String(o.symbol || '').toUpperCase();
    const parsed = this.optionsClient?.parseOcc?.(occ);
    const underlying = String(o.underlying_symbol || parsed?.underlying || '').toUpperCase();
    const side = String(o.side || '').toLowerCase();
    const id = o.id;
    if (!id || !occ || !underlying) return;
    if (side === 'sell') {
      const p = this.positions.get(occ);
      if (p && !p.sellOrderId) {
        p.sellOrderId = id;
        p.sellLimit = Number(o.limit_price) || null;
        p.sellReason = 'adopted';
      }
      return;
    }
    if (side !== 'buy' || this.working.has(id)) return;
    const qty = Math.max(1, Math.floor(Number(o.qty) || 1));
    const limitPrice = Number(o.limit_price) || 0;
    const submitted = Date.parse(o.submitted_at || o.created_at || '') || Date.now();
    this.working.set(id, {
      orderId: id,
      occ,
      underlying,
      qty,
      limitPrice,
      startedAt: submitted,
      placedAt: submitted,
      lastPegAt: Date.now(),
      peg: 'mid',
      pegIndex: 0,
      bid: 0, mid: 0, ask: 0,
      entryIv: null,
      entrySpot: null,
      play: 'VECTOR',
      session: null,
      side: parsed?.side || 'call',
      dca: false,
      adopted: true,
    });
    this.pendingBook?.register({
      orderId: id, symbol: underlying, occ, kind: 'option', qty, limitPx: limitPrice, peg: 'mid',
      startedAt: submitted,
      placeFn: (px) => this.optionsClient.placeOptionBuy(occ, qty, { limitPrice: px }),
    });
    this._journal('opt_sync_working', { symbol: underlying, occ, qty, orderId: id, note: 'adopt open buy' });
  }

  async syncFromBroker() {
    if (!this.paperClient?.enabled) {
      this._reattachUnderlyings();
      return { adopted: 0 };
    }
    const [positions, orders] = await Promise.all([
      this.paperClient.getPositions(),
      this.paperClient.getOpenOrders().catch(() => []),
    ]);
    let adopted = 0;
    const brokerOcc = new Set();
    for (const p of positions || []) {
      if (!this._isOptionAsset(p)) continue;
      brokerOcc.add(String(p.symbol || '').toUpperCase());
      if (this._adoptPositionRow(p)) adopted += 1;
    }
    for (const [occ, p] of [...this.positions]) {
      if (brokerOcc.has(occ)) continue;
      this.positions.delete(occ);
      this._journal('opt_sync_flat', { symbol: p.underlying, occ, note: 'gone at broker' });
      const still = [...this.positions.values()].some((x) => x.underlying === p.underlying);
      if (!still) {
        try { this.onUnderlyingCancel?.({ symbol: p.underlying, reason: 'sync_flat' }); } catch (_) { /* */ }
      }
    }
    for (const o of orders || []) {
      if (!this._isOptionAsset(o) && !this.optionsClient?.parseOcc?.(o.symbol)) continue;
      this._adoptWorkingOrder(o);
    }
    this._reattachUnderlyings();
    try { this.onReconcileVector?.(); } catch (err) {
      this.logger.warn?.(`[opteng] vector reconcile: ${err.message}`);
    }
    this.logger.info?.(`[opteng] broker sync adopted=${adopted} open=${this.positions.size} working=${this.working.size}`);
    this._saveState();
    this._broadcast(true);
    return { adopted, open: this.positions.size, working: this.working.size };
  }

  vectorReconcileSnapshot() {
    return {
      open: [...this.positions.values()].map((p) => p.underlying),
      working: [...this.working.values()].map((w) => w.underlying),
      inflight: [...this._entryInflight],
    };
  }

  _reattachUnderlyings() {
    for (const p of this.positions.values()) {
      try {
        this.onUnderlyingFill?.({
          symbol: p.underlying, occ: p.occ, qty: p.qty, avg: p.fillPrice, adopted: true,
        });
      } catch (_) { /* */ }
    }
  }

  _startTimers() {
    clearInterval(this._tickTimer);
    clearInterval(this._exitTimer);
    clearInterval(this._cliTimer);
    this._tickTimer = setInterval(() => this._tick().catch((err) => {
      this.lastError = err.message;
      this.logger.warn?.(`[opteng] tick: ${err.message}`);
    }), TICK_MS);
    this._tickTimer.unref?.();
    this._exitTimer = setInterval(() => this._evalExits().catch((err) => {
      this.lastError = err.message;
      this.logger.warn?.(`[opteng] exits: ${err.message}`);
    }), this.cfg.exitPollMs);
    this._exitTimer.unref?.();
    if (String(process.env.VOL10S_ALPACA_CLI || '').toLowerCase() === 'true') {
      this._cliTimer = setInterval(() => this._cliSync().catch((err) => {
        this.logger.warn?.(`[opteng] cli_sync: ${err.message}`);
      }), this.cfg.cliSyncMs);
      this._cliTimer.unref?.();
    }
  }

  stop() {
    this.running = false;
    clearInterval(this._tickTimer);
    clearInterval(this._exitTimer);
    clearInterval(this._cliTimer);
    this._saveState();
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  _rollDay(et = etNow()) {
    if (this.dailyDate === et.date) return;
    this.dailyDate = et.date;
    this.dailyPnl = 0;
    this.dailyLossLocked = false;
  }

  _openPremium() {
    let n = 0;
    for (const p of this.positions.values()) {
      n += (Number(p.fillPrice) || 0) * (Number(p.qty) || 0) * 100;
    }
    for (const w of this.working.values()) {
      n += (Number(w.limitPrice) || 0) * (Number(w.qty) || 0) * 100;
    }
    return Math.round(n * 100) / 100;
  }

  _acctSnap() {
    const a = this.getAccount() || {};
    return {
      cash: Number(a.cash) || null,
      equity: Number(a.equity) || null,
      dailyPnl: this.dailyPnl,
      openPremium: this._openPremium(),
      feed: this.optionsClient?.feed || null,
    };
  }

  _posOnUnderlying(underlying) {
    for (const p of this.positions.values()) {
      if (p.underlying === underlying) return p;
    }
    return null;
  }

  _quoteToLedger(c) {
    return {
      bid: Number(c.bid) || 0,
      mid: Number(c.mid) || 0,
      ask: Number(c.ask) || 0,
      bidSz: Number(c.bidSz) || 0,
      askSz: Number(c.askSz) || 0,
    };
  }

  async _placeChunkedBuy(occ, qty, limitPrice, quote, peg, meta = {}) {
    const one = this.cfg.oneWorkingPerUnderlying !== false;
    const chunk = one ? Math.max(1, Math.floor(qty)) : Math.max(1, Math.floor(Number(this.cfg.chunkQty) || 100));
    const orders = [];
    let left = Math.max(1, Math.floor(qty));
    while (left > 0) {
      const n = Math.min(chunk, left);
      const order = await this.optionsClient.placeOptionBuy(occ, n, { limitPrice });
      this._registerWorking(order, occ, n, limitPrice, quote, peg, meta);
      orders.push(order);
      left -= n;
      if (one) break;
    }
    return orders;
  }

  _registerWorking(order, occ, qty, limitPrice, quote, peg, meta = {}) {
    const occId = String(occ || order.symbol || '').toUpperCase();
    this.fillLedger?.noteSubmit({
      kind: 'option',
      side: 'buy',
      symbol: meta.symbol,
      occ: occId || null,
      qty,
      orderId: order.id,
      limitPx: Number(order.limit_price) || limitPrice,
      peg,
      ...this._quoteToLedger(quote),
      feed: this.optionsClient?.feed,
      ...this._acctSnap(),
    });
    const now = Date.now();
    this.working.set(order.id, {
      orderId: order.id,
      occ: occId,
      underlying: meta.symbol,
      qty,
      limitPrice: Number(order.limit_price) || limitPrice,
      startedAt: now,
      placedAt: now,
      lastPegAt: now,
      peg,
      pegIndex: Math.max(0, BUY_PEGS.indexOf(peg)),
      bid: Number(quote.bid) || 0,
      mid: Number(quote.mid) || 0,
      ask: Number(quote.ask) || 0,
      entryIv: quote.iv ?? meta.entryIv ?? null,
      entrySpot: meta.spot || null,
        play: meta.play || null,
        session: meta.session || null,
        side: meta.side === 'put' ? 'put' : 'call',
        dca: Boolean(meta.dca),
        noWalk: Boolean(meta.noWalk),
    });
    this.pendingBook?.register({
      orderId: order.id,
      symbol: meta.symbol,
      occ: occId,
      kind: 'option',
      qty,
      limitPx: Number(order.limit_price) || limitPrice,
      peg,
      replaceMinMs: Math.max(Number(this.cfg.replaceMinMs) || 1500, Number(this.cfg.walkMs) || 10000),
      maxChaseSteps: meta.noWalk ? 0 : (Number(this.cfg.maxChaseSteps) || 0),
      placeFn: (px) => this.optionsClient.placeOptionBuy(occId, qty, { limitPrice: px }),
    });
  }

  _sizeQty(sig, mid) {
    let qty = this.cfg.contracts;
    const reqQty = Math.floor(Number(sig.qty) || 0);
    const strength = Number(sig.strength ?? sig.volMult);
    if (reqQty > 0) qty = reqQty;
    else if (Number.isFinite(strength) && strength >= this.cfg.boostMinMult && this.cfg.boostContracts > qty) {
      qty = this.cfg.boostContracts;
    }
    if (this.fillLedger) qty = this.fillLedger.nextQty(qty);
    const capUsd = Number(this.cfg.maxPremiumUsd) || Number(this.cfg.maxPositionNotional) || 15000;
    const px = Number(mid) || 0;
    if (px > 0) {
      const maxByUsd = Math.max(1, Math.floor(capUsd / (px * 100)));
      qty = Math.min(qty, maxByUsd);
    }
    const open = this._openPremium();
    const maxOpen = Number(this.cfg.maxOpenPremiumUsd) || 60000;
    if (px > 0 && open + qty * px * 100 > maxOpen) {
      qty = Math.max(0, Math.floor((maxOpen - open) / (px * 100)));
    }
    return Math.max(0, Math.min(500, Math.floor(qty)));
  }

  // ─── entry ────────────────────────────────────────────────────────────────

  async handleEntrySignal(sig = {}) {
    const symbol = String(sig.symbol || '').toUpperCase();
    if (!symbol) return { ok: false, reason: 'bad_symbol' };
    if (!this.running || !this.enabled || !this.armed) {
      return { ok: false, reason: 'engine_off', running: this.running, enabled: this.enabled, armed: this.armed };
    }
    const et = etNow();
    this._rollDay(et);
    const skip = (reason, extra = {}) => {
      if (lockHeld) this.pendingBook?.unlock(symbol);
      this._entryInflight.delete(symbol);
      this._journal('opt_skip', { symbol, reason, sigReason: sig.reason || null, ...extra });
      this.logger.info?.(`[opteng] SKIP ${symbol}: ${reason}`);
      return { ok: false, reason, ...extra };
    };
    let lockHeld = false;
    if (this._entryInflight.has(symbol)) return skip('entry_inflight');
    if (!this._inEntryWindow(et)) return skip('outside_entry_window', { et: et.iso });
    this._refreshLossLock();
    if (this.dailyLossLocked) {
      return skip('daily_loss_lock', { dayPnlTotal: Math.round((this.dailyPnl + this._unrealizedPnl()) * 100) / 100 });
    }
    if (this.cfg.entriesPaused === true) return skip('entries_paused');
    if (!this.optionsClient?.enabled) return skip('options_client_disabled');

    const side = sig.side === 'put' ? 'put' : 'call';
    const existing = this._posOnUnderlying(symbol);
    // One working order per symbol — absolute, including DCA adds (incident 2026-08-28).
    const workingSame = [...this.working.values()].some((w) => w.underlying === symbol);
    if (workingSame) return skip('working_order');
    if (existing?.sellOrderId) return skip('exit_in_progress', { occ: existing.occ });
    if (this.cfg.oneWorkingPerUnderlying !== false && this.pendingBook) {
      if (this.pendingBook.getForSymbol(symbol)) return skip('working_order');
      const equityHeld = this.pendingBook.isLocked(symbol);
      if (!equityHeld && !this.pendingBook.acquire(symbol)) return skip('working_order');
      lockHeld = !equityHeld;
    }
    this._entryInflight.add(symbol);

    const poolBreak = this._vectorPoolEntry(sig);

    this.stockTape?.watchNow?.(symbol);
    const tape = await this._waitTape(symbol, poolBreak ? 800 : 1500);
    if (!this.stockTape?.enabled) return skip('tape_no_stream');
    if (!tape?.fresh) return skip('tape_stale', { ageMs: tape?.ageMs ?? null, last: tape?.last ?? null });
    const sigClose = Number(sig.refPx) || Number(tape.last) || 0;
    if (!poolBreak) {
      if (side === 'call') {
        const faded = tape.last != null && sigClose > 0 && tape.last < sigClose * 0.997;
        const weak = tape.upRatio != null && tape.upRatio < 0.45;
        this._journal('opt_tape_check', {
          symbol, side, last: tape.last, upRatio: tape.upRatio, sigClose, faded, weak,
        });
        if (faded || weak) return skip('tape_faded', { last: tape.last, upRatio: tape.upRatio, sigClose });
      } else {
        const bounced = tape.last != null && sigClose > 0 && tape.last > sigClose * 1.003;
        const notWeak = tape.upRatio != null && tape.upRatio > 0.55;
        this._journal('opt_tape_check', {
          symbol, side, last: tape.last, upRatio: tape.upRatio, sigClose, bounced, notWeak,
        });
        if (bounced || notWeak) return skip('tape_not_weak', { last: tape.last, upRatio: tape.upRatio, sigClose });
      }
    }

    let spot = Number(tape.last) || Number(sig.refPx) || 0;
    if (!(spot > 0)) {
      spot = await this.optionsClient.getUnderlyingSpot(symbol).catch(() => null);
    }
    if (!(spot > 0)) return skip('no_spot');

    const pick = await this._pickForEntry(symbol, spot, side, { poolOnly: poolBreak });
    if (!pick.ok) {
      this._journal('opt_pick_fail', { symbol, reason: pick.reason, spot, detail: pick.detail || null, poolBreak });
      return { ok: false, reason: pick.reason === 'no_attached_contract' ? 'no_attached_contract' : 'pick_failed', detail: pick.reason, spot };
    }
    const c = pick.contract;
    const fromAttach = Boolean(pick.fromAttach);

    if (poolBreak && fromAttach) {
      const qRes = await this._resolveAttachedQuote(c, pick.attach || this.getAttached?.(symbol));
      if (!qRes.ok) return skip(qRes.reason || 'no_live_quote', { occ: c.occ, poolBreak: true });
      this._journal('opt_pool_quote', { symbol, occ: c.occ, bid: c.bid, ask: c.ask, source: qRes.source });
    } else {
      this.optStream?.watchNow?.(c.occ);
      const liveWaitMs = Math.max(500, Number(this.cfg.entryLiveQuoteWaitMs) || 6000);
      const liveQ = await this._waitOptQuote(c.occ, liveWaitMs);
      if (liveQ && (liveQ.bid > 0 || liveQ.ask > 0)) {
        c.bid = liveQ.bid; c.ask = liveQ.ask; c.mid = liveQ.mid;
        c.bidSz = liveQ.bidSz; c.askSz = liveQ.askSz;
        c.live = true;
      } else {
        const rest = await this.optionsClient.getSnapshotsByUnderlying(symbol, { spot }).catch(() => ({}));
        const snap = rest[c.occ] || null;
        if (!snap || (!(Number(snap.bid) > 0) && !(Number(snap.ask) > 0))) {
          return skip('no_live_quote', { occ: c.occ, restBid: c.bid, restAsk: c.ask });
        }
        c.bid = Number(snap.bid) || 0;
        c.ask = Number(snap.ask) || 0;
        c.mid = Number(snap.mid) || (c.bid > 0 && c.ask > 0
          ? Math.round(((c.bid + c.ask) / 2) * 100) / 100
          : (c.bid || c.ask || 0));
        c.bidSz = Number(snap.bidSz) || 0;
        c.askSz = Number(snap.askSz) || 0;
        c.live = false;
        this._journal('opt_rest_quote', { symbol, occ: c.occ, bid: c.bid, ask: c.ask, waitedMs: liveWaitMs });
      }
    }
    if (!(c.bid > 0) && !(c.mid > 0) && !(c.ask > 0)) return skip('no_quote', { occ: c.occ });

    if (!poolBreak) {
      const bidConfirm = await this._confirmBidMove(c.occ, side, symbol);
      this._journal('opt_bid_confirm', {
        symbol, occ: c.occ, side,
        ok: bidConfirm.ok,
        reason: bidConfirm.reason,
        detail: bidConfirm.detail,
        bidDelta: bidConfirm.bidDelta,
        askDelta: bidConfirm.askDelta,
        skipped: Boolean(bidConfirm.skipped),
        waitedMs: Number(this.cfg.entryBidConfirmMs) || 12000,
      });
      if (!bidConfirm.ok) {
        this.gate?.cooldown(symbol, Math.max(30, Math.floor((Number(this.cfg.symbolCooldownSec) || 120) / 3)), bidConfirm.reason);
        return skip(bidConfirm.reason, {
          occ: c.occ,
          detail: bidConfirm.detail,
          checks: bidConfirm.checks,
          bidDelta: bidConfirm.bidDelta,
          askDelta: bidConfirm.askDelta,
        });
      }
      if (bidConfirm.lastQuote) this._applyQuoteToContract(c, bidConfirm.lastQuote);
    }

    if (existing) {
      if (existing.occ !== c.occ) return skip('already_holding', { occ: existing.occ });
      const layers = existing.layers || 1;
      if (layers >= (this.cfg.dcaLayers || 3)) return skip('dca_max_layers', { layers });
      const mark = Number(c.mid) || Number(c.bid) || 0;
      if (existing.fillPrice > 0 && mark > 0) {
        const pnlPct = (mark - existing.fillPrice) / existing.fillPrice;
        if (pnlPct >= (this.cfg.dcaSkipPnlPct || 0.4)) return skip('dca_extended', { pnlPct: Math.round(pnlPct * 1000) / 10 });
      }
    } else if (this.positions.size + this.working.size >= this.cfg.maxConcurrent) {
      return skip('max_concurrent', { open: this.positions.size, working: this.working.size });
    }

    // ── mandatory risk gate: fresh-quote re-validation at order time ────────
    this._syncGate();
    this.gate.rollDay(et.date);
    const verdict = this.gate.evaluateEntry({
      symbol, side, contract: c, spot, et,
      quoteLive: c.live === true,
      trustPoolGate: poolBreak && fromAttach,
      ctx: {
        enabled: this.enabled,
        armed: this.armed,
        entriesPaused: this.cfg.entriesPaused === true,
        inWindow: true,
        dailyPnl: this.dailyPnl,
        unrealizedPnl: this._unrealizedPnl(),
        openPremiumUsd: this._openPremium(),
        openPositions: this.positions.size,
        workingOrders: this.working.size,
        workingOnSymbol: false, // already excluded above
        sellingOnSymbol: false, // already excluded above
        existingPosition: existing || null,
      },
    });
    if (!verdict.ok) {
      return skip(`gate_${verdict.reason}`, {
        occ: c.occ, spreadPct: verdict.spreadPct, dte: verdict.dte,
        checks: verdict.checks.filter((x) => !x.ok),
      });
    }

    // Size on the ASK — the worst case we can actually pay — never mid.
    const execPx = Number(c.ask) || Number(c.mid) || Number(c.bid) || 0;
    let qty = this._sizeQty(sig, execPx);
    qty = Math.min(qty, verdict.maxQty);
    if (!(qty > 0)) return skip('size_zero', { ask: c.ask, maxQty: verdict.maxQty });

    // Pool-break entries: one shot at live ask — no bid-walk or chase ladder.
    const poolEntry = poolBreak && fromAttach;
    const configuredPeg = poolEntry
      ? 'ask'
      : (['bid', 'mid', 'ask'].includes(String(this.cfg.buyPeg)) ? String(this.cfg.buyPeg) : 'ask');
    const walk = !poolEntry && this.cfg.entryBidWalkEnabled !== false && configuredPeg !== 'ask';
    const peg = walk
      ? configuredPeg
      : (configuredPeg === 'ask' ? 'ask' : (this.fillLedger?.nextBuyPeg(configuredPeg) || configuredPeg));
    if (walk && !(Number(c.bid) > 0)) return skip('no_bid', { occ: c.occ, ask: c.ask, mid: c.mid });
    const limitPrice = limitFromPeg(c, peg);
    if (!(limitPrice > 0)) return skip('no_limit', { peg, occ: c.occ });

    const workingNow = [...this.working.values()].some((w) => w.underlying === symbol);
    const pendingNow = this.pendingBook?.getForSymbol?.(symbol);
    const heldNow = this._posOnUnderlying(symbol);
    if (workingNow || pendingNow) return skip('working_order');
    if (!existing && heldNow) return skip('already_holding', { occ: heldNow.occ });

    let orders;
    try {
      orders = await this._placeChunkedBuy(c.occ, qty, limitPrice, c, peg, {
        symbol, spot, play: sig.play, session: sig.session, dca: Boolean(existing), entryIv: c.iv, side,
        noWalk: poolEntry,
      });
    } catch (err) {
      this.lastError = err.message;
      if (lockHeld) this.pendingBook?.unlock(symbol);
      this._journal('opt_buy_error', { symbol, occ: c.occ, qty, error: err.message, sigReason: sig.reason || null });
      this.logger.error?.(`[opteng] BUY ${c.occ}: ${err.message}`);
      return { ok: false, reason: 'order_error', error: err.message, occ: c.occ };
    }
    lockHeld = false;
    this._entryInflight.delete(symbol);
    const first = orders[0];
    this.gate.noteEntry(symbol);
    this._journal('opt_buy_sent', {
      symbol, occ: c.occ, qty, orderId: first?.id, peg,
      limitPx: limitPrice, mid: c.mid, bid: c.bid, ask: c.ask, delta: c.delta, iv: c.iv,
      expiry: c.expiry, strike: c.strike, dte: c.dte, spot, side,
      dca: Boolean(existing), chunks: orders.length,
      play: sig.play || null, session: sig.session || null, sigReason: sig.reason || null,
    });
    this.logger.info?.(`[opteng] BUY ${c.occ} x${qty} peg=${peg} @ $${limitPrice} (${symbol} spot $${spot})`);
    this._saveState();
    this._broadcast(true);
    return {
      ok: true, symbol, side, occ: c.occ, qty, orderId: first?.id,
      peg, limitPx: limitPrice, mid: c.mid, delta: c.delta, iv: c.iv,
      expiry: c.expiry, strike: c.strike, spot, dte: c.dte,
    };
  }

  async agentEntry(symbol, side, qty, reason) {
    const why = String(reason || '').slice(0, 200) || 'unspecified';
    return this.handleEntrySignal({
      symbol,
      side: side === 'put' ? 'put' : 'call',
      qty: Math.max(1, Math.min(500, Math.floor(Number(qty) || 1))),
      play: 'agent',
      session: 'agent',
      reason: why.startsWith('agent:') ? why : `agent: ${why}`,
    });
  }

  handleExitSignal(sig = {}) {
    const symbol = String(sig.symbol || '').toUpperCase();
    if (!symbol) return;
    const reason = String(sig.reason || '');
    if (reason === 'vol_death' && this.cfg.volDeathExitEnabled === true) {
      const et = etNow();
      for (const p of this.positions.values()) {
        if (p.underlying !== symbol || p.sellOrderId) continue;
        this._journal('opt_exit_signal', { symbol, occ: p.occ, reason });
        this._evalPosition(p, et, { force: true, structure: true }).catch((err) => {
          this.logger.warn?.(`[opteng] exit signal ${symbol}: ${err.message}`);
        });
      }
      return;
    }
    if (!VECTOR_TAPE_EXITS.has(reason)) {
      this._journal('opt_exit_ignore', { symbol, reason: reason || null, note: 'VECTOR options only exit on flip_reverse' });
      return;
    }
    for (const p of this.positions.values()) {
      if (p.underlying !== symbol || p.sellOrderId) continue;
      this._journal('opt_exit_signal', { symbol, occ: p.occ, reason });
      this._startSell(p, 'flip_reverse').catch((err) => {
        this.logger.warn?.(`[opteng] exit signal ${symbol}: ${err.message}`);
      });
    }
  }

  async flattenSymbol(symbol, reason = 'manual') {
    const sym = String(symbol || '').toUpperCase();
    for (const w of [...this.working.values()]) {
      if (w.underlying !== sym) continue;
      await this.paperClient?.cancelOrder?.(w.orderId).catch(() => {});
      this.fillLedger?.noteCancel({ orderId: w.orderId, reason: 'flatten_' + reason });
      this.working.delete(w.orderId);
      this.pendingBook?.release(w.orderId);
    }
    for (const p of [...this.positions.values()]) {
      if (p.underlying !== sym || p.sellOrderId) continue;
      await this._startSell(p, 'flatten_' + reason);
    }
    this._broadcast(true);
    return this.getState();
  }

  _lossCutAllowed(et = etNow()) {
    if (this.cfg.exitProfitOnly) return false;
    const gate = Vol10sConfig.parseHHMM(this.cfg.lossCutAfterEt);
    if (gate != null && et.mins < gate && !this.cfg.earlyLossCutEnabled) return false;
    return true;
  }

  _inEntryWindow(et) {
    const start = Vol10sConfig.parseHHMM(this.cfg.entryStartEt) ?? (9 * 60 + 35);
    const end = Vol10sConfig.parseHHMM(this.cfg.entryEndEt) ?? (16 * 60);
    return Vol10sConfig.minsInWindow(et.mins, start, end);
  }

  _vectorPoolEntry(sig = {}) {
    return String(sig.play || '') === 'VECTOR' && this.cfg.vectorPoolEntry !== false;
  }

  async _resolveAttachedQuote(c, att) {
    const freshMs = 5000;
    const markAge = att?.markAt ? Date.now() - att.markAt : Infinity;
    if (att && (att.bid > 0 || att.ask > 0) && markAge < freshMs) {
      c.bid = Number(att.bid) || 0;
      c.ask = Number(att.ask) || 0;
      c.mid = Number(att.mid) || (c.bid > 0 && c.ask > 0 ? Math.round(((c.bid + c.ask) / 2) * 100) / 100 : (c.bid || c.ask));
      c.bidSz = att.bidSz || 0;
      c.askSz = att.askSz || 0;
      c.live = att.live !== false;
      return { ok: true, source: 'attach_cache' };
    }
    this.optStream?.watchNow?.(c.occ);
    const peek = this.optStream?.peekQuote?.(c.occ);
    if (peek && (peek.bid > 0 || peek.ask > 0)) {
      c.bid = Number(peek.bid) || 0;
      c.ask = Number(peek.ask) || 0;
      c.mid = Number(peek.mid) || (c.bid > 0 && c.ask > 0 ? Math.round(((c.bid + c.ask) / 2) * 100) / 100 : (c.bid || c.ask));
      c.bidSz = Number(peek.bidSz) || 0;
      c.askSz = Number(peek.askSz) || 0;
      c.live = peek.live !== false;
      return { ok: true, source: 'stream_peek' };
    }
    const shortWait = Math.min(1500, Math.max(500, Number(this.cfg.entryLiveQuoteWaitMs) || 6000));
    const liveQ = await this._waitOptQuote(c.occ, shortWait);
    if (liveQ && (liveQ.bid > 0 || liveQ.ask > 0)) {
      c.bid = liveQ.bid; c.ask = liveQ.ask; c.mid = liveQ.mid;
      c.bidSz = liveQ.bidSz; c.askSz = liveQ.askSz;
      c.live = true;
      return { ok: true, source: 'stream_wait' };
    }
    return { ok: false, reason: 'no_live_quote', occ: c.occ };
  }

  async _pickForEntry(symbol, spot, side, { poolOnly = false } = {}) {
    const att = this.getAttached?.(symbol);
    if (att?.occ && (!att.side || att.side === side)) {
      return {
        ok: true,
        fromAttach: true,
        contract: {
          occ: att.occ,
          symbol: att.occ,
          strike: att.strike,
          expiry: att.expiry,
          dte: att.dte,
          side: att.side || side,
          bid: att.bid, ask: att.ask, mid: att.mid,
          bidSz: att.bidSz, askSz: att.askSz,
          delta: att.delta, iv: att.iv,
          spreadPct: att.spreadPct,
        },
        attach: att,
      };
    }
    if (poolOnly) return { ok: false, reason: 'no_attached_contract' };
    return this.optionsClient.pickContract(symbol, spot, side, OptionsPlayEngine.pickContractOpts(this.cfg));
  }

  async _waitTape(symbol, ms = 1500) {
    if (!this.stockTape?.enabled) return null;
    this.stockTape.watchNow(symbol);
    const t0 = Date.now();
    let tape = this.stockTape.getStrength(symbol);
    while (!tape?.fresh && Date.now() - t0 < ms) {
      await sleep(80);
      tape = this.stockTape.getStrength(symbol);
    }
    return tape;
  }

  async _waitOptQuote(occ, ms = 1200) {
    if (!this.optStream?.enabled) return null;
    this.optStream.watchNow(occ);
    const t0 = Date.now();
    let q = this.optStream.getQuote(occ, 2500);
    while (!q && Date.now() - t0 < ms) {
      await sleep(80);
      q = this.optStream.getQuote(occ, 2500);
    }
    return q;
  }

  async _confirmBidMove(occ, side, symbol) {
    if (this.cfg.entryBidConfirmEnabled === false) {
      return { ok: true, skipped: true, reason: 'disabled' };
    }
    const ms = Math.max(3000, Math.min(30000, Number(this.cfg.entryBidConfirmMs) || 12000));
    const minMove = Math.max(0.01, Number(this.cfg.entryBidMinMoveCents) || 0.01);
    const minDistinct = Math.max(1, Math.min(8, Number(this.cfg.entryBidMinDistinct) || 2));
    const requireLive = this.cfg.entryBidRequireLive !== false;
    const key = String(occ || '').toUpperCase();
    this.optStream?.watchNow(key);
    const tape0 = this.stockTape?.getStrength?.(symbol);
    const spotStart = Number(tape0?.last) || null;
    const samples = [];
    const seen = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const q = this.optStream?.peekQuote?.(key)
        || this.optStream?.getQuote?.(key, ms + 5000);
      if (q && (q.bid > 0 || q.ask > 0)) {
        const sig = `${q.bid}|${q.ask}|${q.bidSz}|${q.askSz}`;
        const rec = {
          t: Date.now(),
          bid: Number(q.bid) || 0,
          ask: Number(q.ask) || 0,
          mid: Number(q.mid) || 0,
          bidSz: Number(q.bidSz) || 0,
          askSz: Number(q.askSz) || 0,
          live: q.live !== false,
        };
        if (!seen.has(sig) || samples.length === 0) {
          seen.add(sig);
          samples.push(rec);
        } else if (samples.length) {
          samples[samples.length - 1] = rec;
        }
      }
      await sleep(100);
    }
    const tape1 = this.stockTape?.getStrength?.(symbol);
    const spotEnd = Number(tape1?.last) || spotStart;
    return evaluateBidMove({
      samples,
      side,
      spotStart,
      spotEnd,
      minMove,
      minDistinctBids: minDistinct,
      requireLive,
    });
  }

  _applyQuoteToContract(c, q) {
    if (!c || !q) return;
    if (q.bid > 0) c.bid = q.bid;
    if (q.ask > 0) c.ask = q.ask;
    if (q.mid > 0) c.mid = q.mid;
    if (q.bidSz != null) c.bidSz = q.bidSz;
    if (q.askSz != null) c.askSz = q.askSz;
    if (q.live !== false) c.live = true;
  }

  async _quoteFor(occ, underlying) {
    const live = this.optStream?.getQuote(occ, 2500);
    if (live) return { ...live, live: true };
    if (!underlying) return this.optStream?.peekQuote(occ) || null;
    const snaps = await this.optionsClient.getSnapshotsByUnderlying(underlying).catch(() => ({}));
    const snap = snaps[occ];
    if (snap) return { ...snap, live: false };
    return this.optStream?.peekQuote(occ) || null;
  }

  _applyQuote(p, q, live) {
    if (!p || !q) return;
    const bid = Number(q.bid) || 0;
    const ask = Number(q.ask) || 0;
    const mid = Number(q.mid) || (bid > 0 && ask > 0
      ? Math.round(((bid + ask) / 2) * 100) / 100
      : (bid || ask || 0));
    if (bid > 0) {
      p.lastBid = bid;
      if (bid > (p.peakBid || 0)) p.peakBid = bid;
    }
    if (ask > 0) p.lastAsk = ask;
    if (mid > 0) p.lastMid = mid;
    if (q.iv != null && Number.isFinite(Number(q.iv))) p.lastIv = Number(q.iv);
    p.liveMark = Boolean(live);
    p.markAt = Number(q.t) || Date.now();
  }

  _et10sKey(et = etNow()) {
    const bucketSec = Math.floor((et.h * 3600 + et.m * 60 + et.s) / 10) * 10;
    const hh = Math.floor(bucketSec / 3600);
    const mm = Math.floor((bucketSec % 3600) / 60);
    const ss = bucketSec % 60;
    return `${et.date} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  /** Aggregate option bid into closed 10s bars for profit-lock exits. */
  _noteOpt10sBid(p, bid, et = etNow()) {
    if (!(bid > 0) || !p) return null;
    const bucket = this._et10sKey(et);
    let closed = null;
    if (p._opt10sCur && p._opt10sCur.t !== bucket) {
      closed = p._opt10sCur;
      p._opt10sCur = null;
    }
    if (!p._opt10sCur) {
      p._opt10sCur = { t: bucket, o: bid, h: bid, l: bid, c: bid };
    } else {
      const cur = p._opt10sCur;
      cur.h = Math.max(cur.h, bid);
      cur.l = Math.min(cur.l, bid);
      cur.c = bid;
    }
    return closed;
  }

  _armOptProfitLock(p, fill, minPct, bar) {
    if (!p || !bar || !(fill > 0)) return;
    const threshold = fill * (1 + minPct / 100);
    if (bar.h >= threshold) {
      p.exitProfitLockArmed = true;
      p.exitProfitLockPeakPct = Math.max(Number(p.exitProfitLockPeakPct) || 0, (bar.h / fill - 1) * 100);
    }
  }

  /** Lock on +minPct option P&L (bid vs fill); exit on closed red 10s bid bar while still green vs fill. */
  _evalOptProfitLock10s(p, closedBar, cfg) {
    if (cfg.exitProfitLock10s === false || !(p.fillPrice > 0)) return null;
    const fill = p.fillPrice;
    const minPct = Math.max(1, Number(cfg.exitProfitLock10sMinPct) || 20);
    if (p._opt10sCur) this._armOptProfitLock(p, fill, minPct, p._opt10sCur);
    if (closedBar) this._armOptProfitLock(p, fill, minPct, closedBar);
    if (!closedBar || !p.exitProfitLockArmed) return null;
    if (closedBar.c < closedBar.o && closedBar.c > fill) {
      return {
        bid: closedBar.c,
        bar: closedBar.t,
        peakPct: Math.round((Number(p.exitProfitLockPeakPct) || 0) * 10) / 10,
        pnlPct: Math.round((closedBar.c / fill - 1) * 1000) / 10,
        minPct,
      };
    }
    return null;
  }

  _askPnlPct(p) {
    const ask = Number(p.lastAsk) || 0;
    const fill = Number(p.fillPrice) || 0;
    if (!(ask > 0) || !(fill > 0)) return null;
    return (ask - fill) / fill;
  }

  _bidPnlPct(p) {
    const bid = Number(p.lastBid) || 0;
    const fill = Number(p.fillPrice) || 0;
    if (!(bid > 0) || !(fill > 0)) return null;
    return (bid - fill) / fill;
  }

  _sellPegLadder(p) {
    if (Array.isArray(p.sellPegLadder) && p.sellPegLadder.length) return p.sellPegLadder;
    return this.fillLedger?.sellPegLadder() || SELL_PEGS;
  }

  applyStreamQuote(occ, q) {
    const key = String(occ || '').toUpperCase();
    if (!key || !(q?.bid > 0 || q?.ask > 0)) return;
    let touched = false;
    const p = this.positions.get(key);
    if (p) {
      this._applyQuote(p, q, true);
      touched = true;
      this._checkExits(p, etNow()).catch((err) => {
        this.logger.warn?.(`[opteng] live exit ${key}: ${err.message}`);
      });
    }
    for (const w of this.working.values()) {
      if (w.occ === key) {
        w.bid = q.bid;
        w.ask = q.ask;
        w.mid = q.mid;
        touched = true;
        if (this.cfg.entryBidWalkEnabled !== false && !w.noWalk) {
          this._walkBuyFromQuote(w, q).catch((err) => {
            this.logger.warn?.(`[opteng] walk ${w.occ}: ${err.message}`);
          });
        }
      }
    }
    if (touched) this._dirty = true;
  }

  onBrokerOrder(ev = {}) {
    const rec = this.pendingBook?.get(ev.orderId) || this.pendingBook?.getForOcc(ev.symbol);
    if (rec?.kind === 'equity') return;
    const w = this.working.get(ev.orderId)
      || (rec ? this.working.get(rec.orderId) : null)
      || [...this.working.values()].find((row) => row.occ === String(ev.symbol || '').toUpperCase());
    if (ev.type === 'replaced' || (ev.event === 'new' && ev.replaces)) {
      const oldId = ev.replaces || ev.orderId;
      const newId = ev.event === 'new' ? ev.orderId : (ev.replacedBy || ev.order?.replaced_by);
      if (oldId && newId) {
        this.pendingBook?.remap(oldId, newId);
        const live = this.working.get(oldId);
        if (live) {
          this.working.delete(oldId);
          live.orderId = newId;
          this.working.set(newId, live);
        }
      }
      return;
    }
    if (!w) {
      if (ev.type === 'fill' || ev.type === 'partial_fill') {
        const buySide = String(ev.side || rec?.side || '').toLowerCase() !== 'sell';
        if (rec?.kind === 'option' && buySide) {
          const ghost = { ...rec, occ: rec.occ, underlying: rec.symbol, qty: rec.qty, limitPrice: rec.limitPx, bid: 0, mid: 0, ask: 0 };
          this._applyBuyFill(ghost, { filledQty: ev.filledQty, avg: ev.filledAvgPrice, status: ev.status, orderId: ev.orderId });
        } else {
          const asset = String(ev.assetClass || '').toLowerCase();
          const ghostKind = rec?.kind || (asset === 'us_option' ? 'option' : 'equity');
          this.fillLedger?.noteFill({
            orderId: ev.orderId,
            fillPx: ev.filledAvgPrice,
            filledQty: ev.filledQty,
            status: ev.status,
            symbol: rec?.symbol || ev.symbol,
            occ: rec?.occ || (asset === 'us_option' ? ev.symbol : null),
            side: ev.side || rec?.side,
            kind: ghostKind,
            assetClass: ev.assetClass,
          });
        }
      }
      return;
    }
    if (ev.type === 'cancelled' || ev.type === 'rejected' || ev.type === 'expired') {
      if (this.pendingBook?.consumeReplaceCancel(ev.orderId)) return;
      this._dropWorking(w, 'broker_' + ev.type);
      return;
    }
    if (ev.type === 'fill') {
      this._applyBuyFill(w, {
        filledQty: ev.filledQty, avg: ev.filledAvgPrice, status: ev.status, orderId: ev.orderId,
      });
    } else if (ev.type === 'partial_fill' && ev.filledQty > 0) {
      w.qty = Math.max(w.qty, ev.filledQty);
    }
  }

  // ─── order reconciliation (every tick) ────────────────────────────────────

  async _tick() {
    if (!this.running || this._busy) return;
    this._busy = true;
    try {
      if (this.paperClient?.enabled) {
        await this._reconcileBuys();
        await this._reconcileSells();
        const syncMs = Math.max(15000, Number(this.cfg.cliSyncMs) || 60000);
        const now = Date.now();
        if (now - (this._lastBrokerSyncMs || 0) >= syncMs) {
          this._lastBrokerSyncMs = now;
          await this.syncFromBroker().catch((err) => {
            this.logger.warn?.(`[opteng] broker sync: ${err.message}`);
          });
        }
      }
      await this._refreshStaleMarks();
      if (this._dirty) this._broadcast();
    } finally {
      this._busy = false;
    }
  }

  async _refreshStaleMarks() {
    if (!this.positions.size) return;
    let touched = false;
    for (const p of this.positions.values()) {
      const stale = !p.markAt || Date.now() - p.markAt > 4000;
      if (!stale) continue;
      const q = await this._quoteFor(p.occ, p.underlying);
      if (!q) continue;
      this._applyQuote(p, q, Boolean(q.live));
      touched = true;
    }
    if (touched) this._dirty = true;
  }

  async _reconcileBuys() {
    for (const w of [...this.working.values()]) {
      let order;
      try {
        order = await this.paperClient.getOrder(w.orderId);
      } catch (err) {
        this.logger.warn?.(`[opteng] getOrder buy ${w.occ}: ${err.message}`);
        continue;
      }
      const status = String(order?.status || '');
      const filledQty = Number(order?.filled_qty || 0);
      const avg = Number(order?.filled_avg_price || 0) || null;
      if (status === 'filled' || (filledQty > 0 && !OPEN_ORDER_STATUSES.has(status))) {
        this._applyBuyFill(w, { filledQty, avg, status, orderId: w.orderId });
        continue;
      }
      if (['canceled', 'cancelled', 'rejected', 'expired'].includes(status)) {
        if (this.pendingBook?.consumeReplaceCancel(w.orderId)) continue;
        this._dropWorking(w, 'broker_' + status);
        continue;
      }
      const now = Date.now();
      const started = w.startedAt || w.placedAt;
      const lastPeg = w.lastPegAt || w.placedAt;
      const cancelMs = (Number(this.cfg.cancelAfterSec) || 20) * 1000;
      const walkMs = Number(this.cfg.walkMs) || 10000;
      if (now - started >= cancelMs) {
        await this._cancelBuy(w, 'unfilled_timeout');
        continue;
      }
      if (!w.noWalk && this.cfg.entryBidWalkEnabled === false && w.peg !== 'ask' && now - lastPeg >= walkMs) {
        await this._chaseBuy(w);
      }
    }
  }

  _applyBuyFill(w, { filledQty, avg, status, orderId } = {}) {
    const id = orderId || w.orderId;
    if (!w || !id) return;
    if (this._seenFill?.has(id)) return;
    this._seenFill = this._seenFill || new Set();
    this._seenFill.add(id);
    this.working.delete(w.orderId);
    this.pendingBook?.release(w.orderId);
    const q = filledQty || w.qty;
    const px = avg || w.limitPrice;
    const existing = this.positions.get(w.occ);
    if (existing) {
      const tot = (existing.qty || 0) + q;
      const avgFill = tot > 0
        ? (((existing.fillPrice || 0) * (existing.qty || 0) + (px || 0) * q) / tot)
        : px;
      existing.qty = tot;
      existing.fillPrice = avgFill;
      existing.layers = (existing.layers || 1) + 1;
      if (px > existing.peakBid) existing.peakBid = px;
    } else {
      this.positions.set(w.occ, {
        occ: w.occ,
        underlying: w.underlying,
        qty: q,
        fillPrice: px,
        entryTs: Date.now(),
        entryIv: w.entryIv,
        entrySpot: w.entrySpot,
        peakBid: px,
        lastBid: Number(w.bid) || px,
        lastMid: Number(w.mid) || 0,
        lastAsk: Number(w.ask) || 0,
        lastIv: w.entryIv,
        play: w.play,
        session: w.session,
        lockArmed: false,
        layers: 1,
        sellOrderId: null,
        sellPlacedAt: 0,
        sellStartedAt: 0,
        sellLastPegAt: 0,
        sellChases: 0,
        sellPegIndex: 0,
        sellReason: null,
        sellLimit: null,
      });
    }
    this.fillLedger?.noteFill({
      orderId: orderId || w.orderId, fillPx: px, filledQty: q, status: status || 'filled',
      bid: w.bid, mid: w.mid, ask: w.ask,
      symbol: w.underlying, occ: w.occ, side: 'buy', kind: 'option',
    });
    this._journal('opt_buy_fill', {
      symbol: w.underlying, occ: w.occ, qty: q, avg: px, orderId: orderId || w.orderId, peg: w.peg, dca: Boolean(w.dca),
    });
    this.logger.info?.(`[opteng] FILL BUY ${w.occ} x${q} @ $${px} peg=${w.peg || ''}`);
    this._cancelSiblingBuys(w.underlying, orderId || w.orderId).catch(() => {});
    try { this.onUnderlyingFill?.({ symbol: w.underlying, occ: w.occ, qty: q, avg: px }); } catch (_) { /* */ }
    this._saveState();
    this._broadcast(true);
  }

  _dropWorking(w, reason) {
    this.working.delete(w.orderId);
    this.pendingBook?.release(w.orderId);
    this.fillLedger?.noteCancel({ orderId: w.orderId, reason });
    this._journal('opt_buy_cancel', { symbol: w.underlying, occ: w.occ, orderId: w.orderId, reason });
    try { this.onUnderlyingCancel?.({ symbol: w.underlying, reason }); } catch (_) { /* */ }
    this._broadcast(true);
  }

  async _cancelSiblingBuys(underlying, keepOrderId) {
    for (const w of [...this.working.values()]) {
      if (w.underlying !== underlying || w.orderId === keepOrderId) continue;
      this.pendingBook?.noteReplaceCancel(w.orderId);
      await this.paperClient?.cancelOrder?.(w.orderId).catch(() => {});
      this.working.delete(w.orderId);
      this.pendingBook?.release(w.orderId);
    }
  }

  async _cancelBuy(w, reason) {
    const res = await this.paperClient.cancelOrder(w.orderId).catch(() => null);
    this.working.delete(w.orderId);
    this.pendingBook?.release(w.orderId);
    this.fillLedger?.noteCancel({ orderId: w.orderId, reason });
    this.gate?.cooldown(w.underlying, this.cfg.symbolCooldownSec, reason);
    this._journal('opt_buy_cancel', {
      symbol: w.underlying, occ: w.occ, orderId: w.orderId,
      reason, ageSec: Math.round((Date.now() - (w.startedAt || w.placedAt)) / 1000),
      cancelled: res == null ? true : Boolean(res?.success),
    });
    try { this.onUnderlyingCancel?.({ symbol: w.underlying, reason }); } catch (_) { /* */ }
  }

  async _walkBuyFromQuote(w, quote) {
    if (!w || w._walkBusy) return;
    if (w.peg === 'ask') return; // ask-pegged orders rest at the top of the book — never walk them down
    const walkMs = Number(this.cfg.walkMs) || 10000;
    if (Date.now() - (w.lastPegAt || w.placedAt || 0) < walkMs) return;
    const tape = this.stockTape?.getStrength?.(w.underlying);
    if (tape?.fresh) {
      if (w.side === 'put') {
        const bounced = w.entrySpot > 0 && tape.last > w.entrySpot * 1.003;
        const notWeak = tape.upRatio != null && tape.upRatio > 0.55;
        if (bounced || notWeak) {
          await this._cancelBuy(w, 'tape_not_weak');
          return;
        }
      } else {
        const faded = w.entrySpot > 0 && tape.last < w.entrySpot * 0.997;
        const weak = tape.upRatio != null && tape.upRatio < 0.45;
        if (faded || weak) {
          await this._cancelBuy(w, 'tape_faded');
          return;
        }
      }
    }
    const rec = this.pendingBook?.get(w.orderId);
    if (!rec || !this.pendingBook) return;
    const q = {
      bid: Number(quote?.bid) || Number(w.bid) || 0,
      ask: Number(quote?.ask) || Number(w.ask) || 0,
      mid: Number(quote?.mid) || Number(w.mid) || 0,
    };
    const want = this.pendingBook.nextOptionPx(rec, q, this.cfg);
    if (!(want > 0)) return;
    const chase = this.gate
      ? this.gate.evaluateChase({ symbol: w.underlying, quote: q, proposedPeg: 'walk', proposedPx: want, et: etNow() })
      : { ok: true, limitPx: want };
    if (!chase.ok) {
      await this._cancelBuy(w, chase.reason);
      return;
    }
    const px = chase.limitPx || want;
    w._walkBusy = true;
    try {
      const next = await this.pendingBook.replaceLimit(rec, px);
      if (!next) return;
      if (next.orderId !== w.orderId) {
        // Alpaca issues a new order id on replace — close the old ledger row
        // or order history shows a phantom "working" order forever.
        this.fillLedger?.noteCancel?.({ orderId: w.orderId, reason: 'replaced' });
        this.working.delete(w.orderId);
        this.working.set(next.orderId, {
          ...w,
          orderId: next.orderId,
          limitPrice: next.limitPx,
          lastPegAt: Date.now(),
          peg: 'walk',
          _walkBusy: false,
        });
      } else {
        w.limitPrice = next.limitPx;
        w.lastPegAt = Date.now();
      }
      this.fillLedger?.noteReplace?.({
        orderId: next.orderId, limitPx: px, peg: 'walk',
        symbol: w.underlying, occ: w.occ, side: 'buy', qty: w.qty,
        bid: q.bid, mid: q.mid, ask: q.ask,
      });
      this._journal('opt_buy_chase', {
        symbol: w.underlying, occ: w.occ, peg: 'walk', limitPx: px, orderId: next.orderId,
      });
    } finally {
      w._walkBusy = false;
    }
  }

  async _chaseBuy(w) {
    const ladder = this.fillLedger?.buyPegLadder() || BUY_PEGS;
    const idx = Math.max(0, Number(w.pegIndex) || 0) + 1;
    const maxSteps = Math.max(1, Number(this.cfg.maxChaseSteps) || 3);
    const snap = await this._quoteFor(w.occ, w.underlying) || {};
    if (idx >= Math.min(ladder.length, maxSteps)) {
      w.lastPegAt = Date.now();
      return;
    }
    const peg = ladder[idx];
    const chase = this.gate
      ? this.gate.evaluateChase({ symbol: w.underlying, quote: snap, proposedPeg: peg, proposedPx: limitFromPeg(snap, peg), et: etNow() })
      : { ok: true, limitPx: limitFromPeg(snap, peg) };
    if (!chase.ok) {
      await this._cancelBuy(w, chase.reason);
      return;
    }
    const px = chase.limitPx;
    if (!(px > 0)) return;
    const rec = this.pendingBook?.get(w.orderId);
    if (rec && this.pendingBook) {
      const next = await this.pendingBook.replaceLimit(rec, px);
      if (next && next.orderId !== w.orderId) {
        this.fillLedger?.noteCancel?.({ orderId: w.orderId, reason: 'replaced' });
        this.working.delete(w.orderId);
        this.working.set(next.orderId, {
          ...w, orderId: next.orderId, limitPrice: next.limitPx, lastPegAt: Date.now(), peg, pegIndex: idx,
          bid: snap.bid, mid: snap.mid, ask: snap.ask,
        });
      } else if (next) {
        w.limitPrice = next.limitPx;
        w.lastPegAt = Date.now();
        w.peg = peg;
        w.pegIndex = idx;
      }
      this.fillLedger?.noteReplace?.({
        orderId: next?.orderId || w.orderId, limitPx: px, peg,
        symbol: w.underlying, occ: w.occ, side: 'buy', qty: w.qty,
        bid: snap.bid, mid: snap.mid, ask: snap.ask,
      });
      this._journal('opt_buy_chase', { symbol: w.underlying, occ: w.occ, peg, limitPx: px, orderId: next?.orderId || w.orderId });
      return;
    }
    this.pendingBook?.noteReplaceCancel(w.orderId);
    await this.paperClient.cancelOrder(w.orderId).catch(() => {});
    this.working.delete(w.orderId);
    try {
      const order = await this.optionsClient.placeOptionBuy(w.occ, w.qty, { limitPrice: px });
      this.fillLedger?.noteReplace({ orderId: w.orderId, limitPx: px, peg, bid: snap.bid, mid: snap.mid, ask: snap.ask });
      this._registerWorking(order, w.occ, w.qty, px, snap, peg, {
        symbol: w.underlying, spot: w.entrySpot, play: w.play, session: w.session, dca: w.dca, entryIv: w.entryIv,
      });
      const live = this.working.get(order.id);
      if (live) {
        live.startedAt = w.startedAt || w.placedAt;
        live.pegIndex = idx;
      }
      this._journal('opt_buy_chase', { symbol: w.underlying, occ: w.occ, peg, limitPx: px, orderId: order.id });
    } catch (err) {
      this.lastError = err.message;
      this._journal('opt_buy_error', { symbol: w.underlying, occ: w.occ, error: err.message, chase: idx });
    }
  }

  async _reconcileSells() {
    for (const p of [...this.positions.values()]) {
      if (!p.sellOrderId) continue;
      let order;
      try {
        order = await this.paperClient.getOrder(p.sellOrderId);
      } catch (err) {
        this.logger.warn?.(`[opteng] getOrder sell ${p.occ}: ${err.message}`);
        continue;
      }
      const status = String(order?.status || '');
      const filledQty = Number(order?.filled_qty || 0);
      const avg = Number(order?.filled_avg_price || 0) || null;
      if (status === 'filled' || (filledQty > 0 && !OPEN_ORDER_STATUSES.has(status))) {
        this.fillLedger?.noteFill({
          orderId: p.sellOrderId, fillPx: avg || p.sellLimit, filledQty: filledQty || p.qty, status,
          bid: p.lastBid, mid: p.lastMid, ask: p.lastAsk,
          symbol: p.underlying, occ: p.occ, side: 'sell', kind: 'option',
        });
        this._closePosition(p, avg || p.sellLimit || p.lastBid, filledQty || p.qty);
        continue;
      }
      if (['canceled', 'cancelled', 'rejected', 'expired'].includes(status)) {
        this._journal('opt_sell_cancel', { symbol: p.underlying, occ: p.occ, orderId: p.sellOrderId, reason: 'broker_' + status });
        p.sellOrderId = null;
        p.sellPlacedAt = 0;
        p.sellStartedAt = 0;
        p.sellLastPegAt = 0;
        p._selling = false;
        this._broadcast(true);
        continue;
      }
      // walk: re-peg on cadence until max steps; cancelAfter → market
      const now = Date.now();
      const started = p.sellStartedAt || p.sellPlacedAt;
      const lastPeg = p.sellLastPegAt || p.sellPlacedAt;
      const cancelMs = (Number(this.cfg.sellCancelAfterSec) || Number(this.cfg.sellChaseSec) || 25) * 1000;
      const walkMs = Number(this.cfg.walkMs) || 4000;
      const maxSteps = Math.max(1, Number(this.cfg.maxChaseSteps) || 3);
      if (now - started >= cancelMs) {
        await this._chaseSell(p, { forceMarket: true });
        continue;
      }
      if (now - lastPeg >= walkMs && (p.sellChases || 0) < maxSteps) {
        await this._chaseSell(p);
      }
    }
  }

  async _chaseSell(p, { forceMarket = false } = {}) {
    await this.paperClient.cancelOrder(p.sellOrderId).catch(() => {});
    this.fillLedger?.noteCancel({ orderId: p.sellOrderId, reason: forceMarket ? 'sell_timeout' : 'sell_chase' });
    p.sellOrderId = null;
    p.sellPlacedAt = 0;
    const snap = await this._quoteFor(p.occ, p.underlying) || {};
    const bid = Number(snap.bid) || 0;
    const ask = Number(snap.ask) || 0;
    const mid = Number(snap.mid) || 0;
    this._applyQuote(p, snap, Boolean(snap.live));
    const now = Date.now();
    if (forceMarket) {
      try {
        const order = await this.optionsClient.placeOptionSell(p.occ, p.qty, {});
        p.sellOrderId = order.id;
        p.sellPlacedAt = now;
        p.sellLastPegAt = now;
        p.sellLimit = null;
        this.fillLedger?.noteSubmit({
          kind: 'option', side: 'sell', symbol: p.underlying, occ: p.occ, qty: p.qty,
          orderId: order.id, peg: 'market', bid, mid, ask, feed: this.optionsClient?.feed, ...this._acctSnap(),
        });
        this._journal('opt_sell_chase', {
          symbol: p.underlying, occ: p.occ, orderId: order.id, chase: p.sellChases, type: 'market', reason: p.sellReason,
        });
      } catch (err) {
        this.lastError = err.message;
        this._journal('opt_sell_error', { symbol: p.underlying, occ: p.occ, error: err.message, chase: p.sellChases });
      }
      return;
    }
    p.sellChases += 1;
    const ladder = this._sellPegLadder(p);
    const peg = ladder[Math.min(p.sellChases, ladder.length - 1)];
    const px = limitFromPeg(snap, peg);
    try {
      const order = await this.optionsClient.placeOptionSell(p.occ, p.qty, { limitPrice: px > 0 ? px : undefined });
      p.sellOrderId = order.id;
      p.sellPlacedAt = now;
      p.sellLastPegAt = now;
      p.sellLimit = px > 0 ? px : null;
      p.sellPeg = peg;
      this.fillLedger?.noteSubmit({
        kind: 'option', side: 'sell', symbol: p.underlying, occ: p.occ, qty: p.qty,
        orderId: order.id, limitPx: px, peg, bid, mid, ask, feed: this.optionsClient?.feed, ...this._acctSnap(),
      });
      this._journal('opt_sell_chase', {
        symbol: p.underlying, occ: p.occ, orderId: order.id, chase: p.sellChases, peg, limitPx: p.sellLimit, reason: p.sellReason,
      });
    } catch (err) {
      this.lastError = err.message;
      this._journal('opt_sell_error', { symbol: p.underlying, occ: p.occ, error: err.message, chase: p.sellChases });
    }
  }

  _closePosition(p, sellPrice, qty) {
    const px = Number(sellPrice) || p.fillPrice;
    const sold = Math.max(0, Math.floor(Number(qty) || p.qty || 0));
    const held = Math.max(0, Math.floor(Number(p.qty) || 0));
    const closeQty = sold > 0 ? Math.min(sold, held || sold) : held;
    const pnl = (px - p.fillPrice) * closeQty * 100;
    const orderId = p.sellOrderId;
    const reason = p.sellReason;
    this._rollDay();
    this.dailyPnl += pnl;
    this._refreshLossLock();
    const remaining = held > closeQty ? held - closeQty : 0;
    p.sellOrderId = null;
    p.sellPlacedAt = 0;
    p.sellStartedAt = 0;
    p.sellLastPegAt = 0;
    p.sellChases = 0;
    p._selling = false;
    this._journal('opt_sell_fill', {
      symbol: p.underlying, occ: p.occ, qty: closeQty, remaining, avg: px,
      orderId, reason, pnl: Math.round(pnl * 100) / 100,
      dailyPnl: Math.round(this.dailyPnl * 100) / 100,
      heldSec: Math.round((Date.now() - p.entryTs) / 1000),
    });
    this.logger.info?.(`[opteng] FILL SELL ${p.occ} x${closeQty}${remaining ? ` (${remaining} left)` : ''} @ $${px} pnl $${pnl.toFixed(2)} (${reason})`);
    if (remaining > 0) {
      p.qty = remaining;
      this.gate?.cooldown(p.underlying, Math.max(30, Math.floor((Number(this.cfg.symbolCooldownSec) || 120) / 2)), 'partial_close');
      this._saveState();
      this._broadcast(true);
      return;
    }
    this.gate?.cooldown(p.underlying, Math.max(30, Math.floor((Number(this.cfg.symbolCooldownSec) || 120) / 2)), 'position_closed');
    this.positions.delete(p.occ);
    if (typeof this.onVectorFlat === 'function') {
      try { this.onVectorFlat({ symbol: p.underlying, occ: p.occ, reason: reason || 'opt_closed' }); } catch (_) {}
    }
    this._saveState();
    this._broadcast(true);
  }

  // ─── exit evaluation ──────────────────────────────────────────────────────

  async _evalExits() {
    if (!this.running || this._exitBusy || !this.positions.size) return;
    const et = etNow();
    this._rollDay(et);
    if (et.mins < RTH_START_MIN || et.mins >= RTH_END_MIN) return; // options: RTH only
    this._exitBusy = true;
    try {
      const flattenOn = this.cfg.sessionFlattenEnabled === true;
      const flattenAt = Vol10sConfig.parseHHMM(this.cfg.flattenEt) ?? (15 * 60 + 59);
      for (const p of [...this.positions.values()]) {
        if (flattenOn && et.mins >= flattenAt && !p.sellOrderId) {
          await this._startSell(p, 'session_flatten');
          continue;
        }
        await this._evalPosition(p, et);
      }
    } finally {
      this._exitBusy = false;
    }
  }

  async _evalPosition(p, et = etNow(), { force = false, structure = false } = {}) {
    if (p.sellOrderId || p._selling) return;
    if (!force && (et.mins < RTH_START_MIN || et.mins >= RTH_END_MIN)) return;
    const fresh = p.markAt && Date.now() - p.markAt < 2500 && p.liveMark;
    if (!fresh) {
      const q = await this._quoteFor(p.occ, p.underlying);
      if (!q) return;
      this._applyQuote(p, q, Boolean(q.live));
    }
    await this._checkExits(p, et, { force, structure });
  }

  async _checkExits(p, et = etNow(), { force = false, structure = false } = {}) {
    if (p.sellOrderId || p._selling) return;
    if (!force && (et.mins < RTH_START_MIN || et.mins >= RTH_END_MIN)) return;
    const bid = Number(p.lastBid) || 0;
    const mark = bid || Number(p.lastMid) || 0;
    const iv = Number.isFinite(Number(p.lastIv)) ? Number(p.lastIv) : null;
    if (!(mark > 0) || !(p.fillPrice > 0)) return;

    const heldSec = (Date.now() - p.entryTs) / 1000;
    const fill = p.fillPrice;
    const cfg = this.cfg;
    const pnlUsd = (mark - fill) * p.qty * 100;
    const pnlPct = (mark - fill) / fill;
    // VECTOR options: stop = flip_reverse (tape signal). Profit = giveback_trail.
    // Every other exit is a named flag and defaults off.
    const givebackOn = cfg.fastExitsEnabled === true;
    const profitLockOn = cfg.exitProfitLock10s === true;
    const lockUsd = Number(cfg.lockArmUsd) || 200;
    const lockPct = Number(cfg.lockArmPct) || 0.15;

    const closedOpt10s = bid > 0 ? this._noteOpt10sBid(p, bid, et) : null;
    if (profitLockOn && heldSec >= (Number(cfg.minHoldSec) || 15)) {
      const plHit = this._evalOptProfitLock10s(p, closedOpt10s, cfg);
      if (plHit) {
        this._journal('opt_exit_signal', {
          symbol: p.underlying, occ: p.occ, reason: 'profit_lock_10s', ...plHit,
        });
        return this._startSell(p, 'profit_lock_10s', plHit);
      }
    }

    if (cfg.askProfitExitEnabled === true && heldSec >= (Number(cfg.minHoldSec) || 15)) {
      const ask = Number(p.lastAsk) || 0;
      const askPct = this._askPnlPct(p);
      const bidPct = this._bidPnlPct(p);
      const minAsk = Math.max(0.01, (Number(cfg.askProfitExitMinPct) || 10) / 100);
      const maxBid = Math.max(0, (Number(cfg.askProfitExitBidStalePct) ?? 5) / 100);
      const bidStale = bidPct == null || bidPct < maxBid;
      if (ask > 0 && askPct != null && askPct >= minAsk && bidStale) {
        const extra = {
          ask,
          askPct: Math.round(askPct * 1000) / 10,
          bidPct: bidPct != null ? Math.round(bidPct * 1000) / 10 : null,
          pegLadder: ['ask', 'mid', 'bid'],
        };
        this._journal('opt_exit_signal', {
          symbol: p.underlying, occ: p.occ, reason: 'ask_profit_exit', ...extra,
        });
        return this._startSell(p, 'ask_profit_exit', extra);
      }
    }

    if (cfg.instantProfitEnabled === true && !profitLockOn
      && mark >= fill * (1 + cfg.instantProfitPct) && heldSec >= cfg.minHoldSec) {
      return this._startSell(p, 'instant_profit', { bid: mark, heldSec: Math.round(heldSec) });
    }

    if (givebackOn) {
      if (pnlUsd >= lockUsd || pnlPct >= lockPct) p.lockArmed = true;
      if (p.lockArmed && p.peakBid > 0 && bid <= p.peakBid * (1 - cfg.givebackPct)) {
        if (mark >= fill || this._lossCutAllowed(et)) {
          return this._startSell(p, 'giveback_trail', { bid, peakBid: p.peakBid, pnlUsd: Math.round(pnlUsd) });
        }
      }
    }

    if (structure && cfg.volDeathExitEnabled === true && heldSec >= (Number(cfg.minHoldSec) || 15)) {
      return this._startSell(p, 'structure_break', { bid: mark, heldSec: Math.round(heldSec) });
    }

    const cat = Number(cfg.catastrophePct) || 0.35;
    if (cfg.catastropheEnabled === true && mark <= fill * (1 - cat) && heldSec >= cfg.lossMinHoldSec) {
      return this._startSell(p, 'catastrophe_stop', { bid: mark, heldSec: Math.round(heldSec) });
    }

    if (cfg.bidStopEnabled === true && bid <= fill * (1 - cfg.lossStopPct) && heldSec >= cfg.lossMinHoldSec && this._lossCutAllowed(et)) {
      return this._startSell(p, 'bid_stop', { bid, heldSec: Math.round(heldSec) });
    }

    if (cfg.ivCrushEnabled === true && p.entryIv > 0 && iv != null && iv <= p.entryIv * (1 - cfg.ivCrushPct)) {
      if (mark >= fill || this._lossCutAllowed(et)) {
        return this._startSell(p, 'iv_crush', { bid: mark, iv, entryIv: p.entryIv });
      }
    }
  }

  async _startSell(p, reason, extra = {}) {
    if (p.sellOrderId || p._selling) return;
    p._selling = true;
    const live = this.optStream?.getQuote(p.occ, 2500);
    if (live) this._applyQuote(p, live, true);
    if (Array.isArray(extra.pegLadder) && extra.pegLadder.length) {
      p.sellPegLadder = extra.pegLadder.map((x) => String(x).toLowerCase()).filter(Boolean);
    } else {
      p.sellPegLadder = null;
    }
    const ladder = p.sellPegLadder;
    const peg = ladder?.length
      ? ladder[0]
      : (this.fillLedger?.nextSellPeg(this.cfg.sellPeg) || this.cfg.sellPeg || 'ask');
    const quote = { bid: p.lastBid || 0, mid: p.lastMid || 0, ask: p.lastAsk || 0 };
    const px = limitFromPeg(quote, peg) || p.lastBid || p.lastMid || null;
    const sellQty = extra.qty ? Math.min(p.qty, extra.qty) : p.qty;
    try {
      const order = await this.optionsClient.placeOptionSell(p.occ, sellQty, { limitPrice: px || undefined });
      p.sellOrderId = order.id;
      p.sellPlacedAt = Date.now();
      p.sellStartedAt = p.sellStartedAt || p.sellPlacedAt;
      p.sellLastPegAt = p.sellPlacedAt;
      p.sellChases = 0;
      p.sellReason = reason;
      p.sellLimit = px;
      p.sellPeg = peg;
      this.fillLedger?.noteSubmit({
        kind: 'option', side: 'sell', symbol: p.underlying, occ: p.occ, qty: sellQty,
        orderId: order.id, limitPx: px, peg, ...quote, feed: this.optStream?.feed || this.optionsClient?.feed, ...this._acctSnap(),
      });
      this._journal('opt_sell_sent', {
        symbol: p.underlying, occ: p.occ, qty: sellQty, orderId: order.id, limitPx: px, peg, reason, ...extra,
      });
      this.logger.info?.(`[opteng] SELL ${p.occ} x${sellQty} ${reason} peg=${peg}${px ? ' @ $' + px : ' mkt'} ${order.id}`);
      this._broadcast(true);
    } catch (err) {
      this.lastError = err.message;
      this._journal('opt_sell_error', { symbol: p.underlying, occ: p.occ, error: err.message, reason });
      this.logger.error?.(`[opteng] SELL ${p.occ}: ${err.message}`);
    } finally {
      if (!p.sellOrderId) p._selling = false;
    }
  }

  async flattenAll(reason = 'manual') {
    for (const w of [...this.working.values()]) {
      await this.paperClient?.cancelOrder?.(w.orderId).catch(() => {});
      this.working.delete(w.orderId);
      this.pendingBook?.release(w.orderId);
      this._journal('opt_buy_cancel', { symbol: w.underlying, occ: w.occ, orderId: w.orderId, reason: 'flatten_' + reason });
    }
    for (const p of [...this.positions.values()]) {
      if (!p.sellOrderId) await this._startSell(p, 'flatten_' + reason);
    }
    this._journal('system', { note: `options flatten ${reason}`, n: this.positions.size });
    this._saveState();
    this._broadcast(true);
    return this.getState();
  }

  // ─── CLI reconciliation (hackathon CLI requirement) ───────────────────────

  _cliExec(args) {
    const bin = process.env.VOL10S_ALPACA_CLI_BIN || 'alpaca';
    return new Promise((resolve) => {
      execFile(bin, args, { timeout: 15000, env: alpacaCliEnv() }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  }

  async _cliSync() {
    if (String(process.env.VOL10S_ALPACA_CLI || '').toLowerCase() !== 'true') return;
    const [pos, acct] = await Promise.all([
      this._cliExec(['position', 'list', '--quiet']),
      this._cliExec(['account', 'get', '--quiet']),
    ]);
    try {
      if (pos.err) throw new Error(`position list: ${pos.err.message}`);
      if (acct.err) throw new Error(`account get: ${acct.err.message}`);
      const posJson = JSON.parse(pos.stdout || '[]');
      const acctJson = JSON.parse(acct.stdout || '{}');
      const posCount = Array.isArray(posJson) ? posJson.length : (Array.isArray(posJson?.positions) ? posJson.positions.length : 0);
      const equity = Number(acctJson?.equity ?? acctJson?.portfolio_value ?? acctJson?.cash) || null;
      this.lastCliSyncAt = etNow().iso;
      this._journal('cli_sync', { positions: posCount, equity, note: 'alpaca cli ok' });
    } catch (err) {
      this._journal('cli_sync_error', { error: err.message.slice(0, 300) });
      this.logger.warn?.(`[opteng] cli_sync_error: ${err.message}`);
    }
  }
}

module.exports = OptionsPlayEngine;
