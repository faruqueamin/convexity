'use strict';

/**
 * Public desk engine — Alpaca Trading API + market data + CLI.
 * Watchlist is XGBoost + NTSM ranked names. No ClickHouse. No private scanner.
 */

const fs = require('fs');
const path = require('path');
const Vol10sConfig = require('./Vol10sConfig');
const { etNow, cashClock } = require('./marketClock');
const SetupScanner = require('./SetupScanner');
const { SetupRanker } = require('../ml/SetupRanker');

const JOURNAL_MAX = 400;

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

class DeskEngine {
  constructor({
    alpaca, optionsClient, logger, fillLedger, eventLog, pendingBook,
    statePath, configPath, scanner,
  } = {}) {
    this.alpaca = alpaca;
    this.optionsClient = optionsClient;
    this.logger = logger || console;
    this.fillLedger = fillLedger || null;
    this.eventLog = eventLog || null;
    this.pendingBook = pendingBook || null;
    this.statePath = statePath;
    this.configPath = configPath;
    this.onBroadcast = null;
    this.onEntrySignal = null;
    this.onExitSignal = null;
    this.onAutoArm = null;
    this.liveHub = null;
    this.ranker = new SetupRanker({ log: this.logger });
    this.scanner = scanner || new SetupScanner({
      optionsClient,
      ranker: this.ranker,
      log: this.logger,
    });
    this.cfg = Vol10sConfig.loadConfig(configPath);
    this.armed = String(process.env.VOL10S_ARMED || '').toLowerCase() === 'true';
    this.running = false;
    this.paperOk = false;
    this.paperAccount = null;
    this.brokerPositions = [];
    this.openOrders = [];
    this.book = new Map();
    this.universe = [];
    this.journal = [];
    this.metricFields = [];
    this.metricEnums = {};
    this.pollMs = parseInt(process.env.VOL10S_POLL_MS || '15000', 10);
    this.syncMs = parseInt(process.env.VOL10S_SYNC_MS || '15000', 10);
    this.universeMs = parseInt(process.env.VOL10S_UNIVERSE_MS || '300000', 10);
    this.lastScanAt = null;
    this.lastSyncAt = null;
    this.lastError = null;
    this.lastScanMeta = null;
    this.stats = { scans: 0, errors: 0, entries: 0 };
    this._scanTimer = null;
    this._syncTimer = null;
    this._univTimer = null;
  }

  _journal(type, extra = {}) {
    const row = { ts: Date.now(), type, ...extra };
    this.journal.push(row);
    if (this.journal.length > JOURNAL_MAX) this.journal.splice(0, this.journal.length - JOURNAL_MAX);
    try { this.eventLog?.append?.(row); } catch (_) { /* */ }
    return row;
  }

  _broadcast() {
    if (!this.onBroadcast) return;
    try { this.onBroadcast(this.snapshot()); } catch (err) {
      this.logger.warn?.(`[desk] broadcast: ${err.message}`);
    }
  }

  getConfig() {
    return this.cfg;
  }

  async setConfig(patch = {}) {
    this.cfg = Vol10sConfig.mergeConfig({ ...this.cfg, ...patch });
    if (this.configPath) {
      try { Vol10sConfig.saveConfig(this.configPath, this.cfg); } catch (err) {
        this.logger.warn?.(`[desk] config save: ${err.message}`);
      }
    }
    this._broadcast();
    return this.snapshot();
  }

  setArmed(armed) {
    this.armed = Boolean(armed);
    this._journal(this.armed ? 'armed' : 'disarmed');
    this._broadcast();
    return this.armed;
  }

  _activeSession(et = etNow()) {
    const clock = cashClock(et);
    if (clock.id === 'closed') return null;
    return {
      id: clock.id === 'market' ? 'market' : clock.id,
      label: clock.label,
      start: clock.id === 'market' ? '09:30' : '04:00',
      end: clock.id === 'market' ? '16:00' : '20:00',
    };
  }

  _publicPaperAccount() {
    const a = this.paperAccount;
    if (!a) return null;
    return {
      id: a.id || null,
      account_number: a.account_number || null,
      status: a.status || null,
      buying_power: a.buying_power || null,
      cash: a.cash || null,
      equity: a.equity || null,
      pattern_day_trader: Boolean(a.pattern_day_trader),
    };
  }

  _poolRows() {
    return [...this.book.values()].sort((a, b) => n(b.score) - n(a.score));
  }

  _openCount() {
    return [...this.book.values()].filter((r) => r.status === 'long' || r.status === 'pending_buy').length;
  }

  snapshot() {
    const et = etNow();
    const sess = this._activeSession(et);
    const clock = cashClock(et);
    const pool = this._poolRows();
    return {
      type: 'vol10s_state',
      ok: true,
      isolated: true,
      paper: true,
      ts: Date.now(),
      armed: this.armed,
      paperConfigured: Boolean(this.alpaca?.enabled),
      paperOk: this.paperOk,
      paperAccount: this._publicPaperAccount(),
      et: et.iso,
      clock: { id: clock.id, label: clock.label, dow: et.dow },
      inSession: Boolean(sess),
      scanOnly: !this.armed,
      rthVectorOnly: true,
      entriesAllowed: this.armed && clock.id === 'market',
      openSettle: false,
      activeSession: sess ? {
        id: sess.id,
        label: sess.label,
        start: sess.start,
        end: sess.end,
        playName: 'OPTIONS',
        playMode: 'xgboost_ntsm',
        entryRule: 'model_rank',
        exitRule: 'risk_stack',
      } : null,
      config: this.getConfig(),
      metricFields: this.metricFields,
      metricEnums: this.metricEnums,
      notional: n(this.cfg?.notional, 1000),
      maxConcurrent: n(this.cfg?.options?.maxConcurrent, 5),
      pollMs: this.pollMs,
      orderHours: this.alpaca?.hoursLabel?.() || null,
      extendedHours: Boolean(this.alpaca?.isExtendedHours?.()),
      universe: this.universe.length || this.scanner.universe.length,
      poolCount: pool.length,
      liveTierCap: 30,
      liveTier: pool.slice(0, 12).map((r) => r.symbol),
      opraDualLeg: false,
      occPerName: 1,
      poolLanes: { options: pool.length },
      lastScanAt: this.lastScanAt,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      lastScanMeta: this.lastScanMeta,
      stats: this.stats,
      openCount: this._openCount(),
      coiledCount: 0,
      oneGreenCount: 0,
      scanCount: pool.filter((r) => r.status === 'scan').length,
      thickCount: 0,
      pool,
      sixSix: pool.slice(0, 12),
      scannerHold: [],
      sixSixAt: this.lastScanAt,
      sixSixMeta: this.lastScanMeta,
      vectorScan: [],
      vectorHunter: [],
      positions: pool.filter((r) => r.status === 'long' || r.status === 'pending_buy'),
      brokerPositions: this.brokerPositions,
      openOrders: this.openOrders,
      sittingBuys: (this.openOrders || []).filter((o) => o.side === 'buy').length,
      journal: this.journal.slice(-120).reverse(),
      fills: this.fillLedger ? this.fillLedger.getSummary() : null,
      models: { xgboost: true, ntsm: true, llm: 'pluggable' },
    };
  }

  async loadMetricCatalog() {
    this.metricFields = [
      { name: 'symbol', kind: 'string' },
      { name: 'last_close', kind: 'number' },
      { name: 'day_volume', kind: 'number' },
    ];
    this.metricEnums = {};
  }

  async refreshUniverse() {
    this.universe = await this.scanner.refreshUniverse();
    this._journal('universe', { count: this.universe.length });
    return this.universe;
  }

  async scanOnce() {
    this.stats.scans += 1;
    const ranked = await this.scanner.scan(12);
    this.lastScanAt = this.scanner.lastScanAt;
    this.lastScanMeta = { models: ['xgboost', 'ntsm'], count: ranked.length };
    for (const row of ranked) {
      const prev = this.book.get(row.symbol) || {};
      this.book.set(row.symbol, {
        ...prev,
        symbol: row.symbol,
        name: row.name,
        status: prev.status === 'long' || prev.status === 'pending_buy' ? prev.status : 'scan',
        px: row.px,
        occ: row.occ,
        side: row.side,
        score: row.score,
        xgbScore: row.xgbScore,
        ntsmScore: row.ntsmScore,
        playName: 'OPTIONS',
        watchLane: 'options',
        viaOptions: true,
        wired: true,
      });
      this._journal('ai_found', { symbol: row.symbol, score: row.score, xgb: row.xgbScore, ntsm: row.ntsmScore, side: row.side });
      if (this.armed && this.onEntrySignal && row.score >= (this.scanner.minScore || 0.52)) {
        try {
          const res = await this.onEntrySignal({
            symbol: row.symbol,
            side: row.side,
            reason: 'xgboost_ntsm',
            play: 'OPTIONS',
            refPx: row.px,
            strength: row.score,
          });
          if (res?.ok) {
            this.stats.entries += 1;
            const rec = this.book.get(row.symbol);
            if (rec) rec.status = 'pending_buy';
          }
        } catch (err) {
          this.lastError = err.message;
        }
      }
    }
    this._broadcast();
    return this.snapshot();
  }

  async syncBroker() {
    if (!this.alpaca?.enabled) return;
    try {
      this.paperAccount = await this.alpaca.getAccount();
      this.paperOk = true;
      this.brokerPositions = await this.alpaca.getPositions().catch(() => []);
      this.openOrders = await this.alpaca.getOpenOrders?.().catch(() => []) || [];
      this.lastSyncAt = new Date().toISOString();
    } catch (err) {
      this.paperOk = false;
      this.lastError = err.message;
    }
    this._broadcast();
  }

  async flattenOurs(reason = 'manual') {
    this._journal('flatten', { reason });
    return this.snapshot();
  }

  async cancelSittingBuys() {
    return { ok: true, cancelled: 0 };
  }

  async flushPool() {
    this.book.clear();
    this._journal('flush');
    this._broadcast();
    return this.snapshot();
  }

  async addToPool(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return this.snapshot();
    this.book.set(sym, { symbol: sym, status: 'scan', playName: 'OPTIONS', watchLane: 'options' });
    this._journal('add_pool', { symbol: sym });
    this._broadcast();
    return this.snapshot();
  }

  async evictFromWatchlist(symbol) {
    this.book.delete(String(symbol || '').toUpperCase());
    this._broadcast();
    return this.snapshot();
  }

  async manualBuy(symbol) {
    if (this.onEntrySignal) {
      await this.onEntrySignal({ symbol, side: 'call', reason: 'manual', play: 'OPTIONS' });
    }
    return this.snapshot();
  }

  async manualSell(symbol) {
    if (this.onExitSignal) await this.onExitSignal({ symbol, reason: 'manual' });
    return this.snapshot();
  }

  markVectorFilled(sig = {}) {
    const rec = this.book.get(String(sig.symbol || '').toUpperCase());
    if (rec) rec.status = 'long';
    this._broadcast();
  }

  markVectorCancel(sig = {}) {
    const rec = this.book.get(String(sig.symbol || '').toUpperCase());
    if (rec) rec.status = 'scan';
  }

  markVectorFlat(sig = {}) {
    const rec = this.book.get(String(sig.symbol || '').toUpperCase());
    if (rec) rec.status = 'scan';
  }

  adoptOpenUnderlying() { return null; }
  pinDualOcc() { return null; }
  onAttacherGateFail() { return null; }
  reconcileVectorState() { return null; }
  _flipMode() { return false; }
  _poolRowsPublic() { return this._poolRows(); }
  _activeSessionPublic() { return this._activeSession(); }
  _rthVectorOnly() { return true; }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.loadMetricCatalog();
    await this.syncBroker().catch((err) => {
      this.lastError = err.message;
      this.logger.warn?.(`[desk] sync: ${err.message}`);
    });
    await this.refreshUniverse().catch((err) => {
      this.lastError = err.message;
      this.logger.warn?.(`[desk] universe: ${err.message}`);
    });
    await this.scanOnce().catch((err) => {
      this.lastError = err.message;
      this.logger.warn?.(`[desk] scan: ${err.message}`);
    });
    this._scanTimer = setInterval(() => {
      this.scanOnce().catch((err) => {
        this.stats.errors += 1;
        this.lastError = err.message;
      });
    }, this.pollMs);
    this._syncTimer = setInterval(() => {
      this.syncBroker().catch((err) => { this.lastError = err.message; });
    }, this.syncMs);
    this._univTimer = setInterval(() => {
      this.refreshUniverse().catch((err) => this.logger.warn?.(`[desk] universe: ${err.message}`));
    }, this.universeMs);
    this.logger.info?.('[desk] public engine started (Alpaca data · XGBoost + NTSM · pluggable LLM)');
  }

  stop() {
    this.running = false;
    clearInterval(this._scanTimer);
    clearInterval(this._syncTimer);
    clearInterval(this._univTimer);
  }
}

module.exports = { DeskEngine, etNow };
