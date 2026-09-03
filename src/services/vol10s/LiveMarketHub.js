'use strict';

/**
 * Owns the two live sockets and the wanted-set:
 *   stock  = pool / working / open underlyings + SPY  (SIP 4 AM–8 PM ET, BOATS overnight)
 *   OCC    = working + open + ATM call + ATM put per live name + SPY heartbeat (OPRA)
 *
 * SPY is never unsubscribed. Options socket stays open via a 0DTE SPY heartbeat
 * OCC so Alpaca does not idle-kill an empty subscribe.
 *
 * Coalesces ticks (~100ms) for the desk WS. REST is only a watchdog when
 * a subscribed contract goes silent.
 */

const StockTapeWs = require('./StockTapeWs');
const OptionStreamWs = require('./OptionStreamWs');
const TenSecBuckets = require('./TenSecBuckets');
const Vol10sConfig = require('./Vol10sConfig');
const { etNow } = require('./marketClock');

const WATCH_MS = 5000;
const TICK_MS = 100;
const CURVE_MS = 1000;
const STOCK_HARD_CAP = 30;
const OCC_HARD_CAP = 60;
const STATUS_RANK = {
  pending_sell: 0,
  pending_buy: 1,
  long: 2,
  one_green: 3,
  coiled: 4,
  pinned: 5,
};

class LiveMarketHub {
  constructor({
    equityEngine, optionsEngine, optionsClient, poolAttacher, fillLedger,
    key, secret, optKey, optSecret, boatsKey, boatsSecret, boatsEnabled,
    log, onTick,
  } = {}) {
    this.equityEngine = equityEngine || null;
    this.optionsEngine = optionsEngine || null;
    this.optionsClient = optionsClient || null;
    this.poolAttacher = poolAttacher || null;
    this.fillLedger = fillLedger || null;
    this._heartbeatOcc = null;
    this.log = log || console;
    this.onTick = typeof onTick === 'function' ? onTick : null;
    const stockKey = key;
    const stockSecret = secret;
    this.stockTape = new StockTapeWs({ key: stockKey, secret: stockSecret, log: this.log });
    this.optStream = new OptionStreamWs({
      key: optKey || stockKey,
      secret: optSecret || stockSecret,
      log: this.log,
    });
    this.boatsKey = boatsKey || stockKey;
    this.boatsSecret = boatsSecret || stockSecret;
    this.boatsEnabled = boatsEnabled !== false && Boolean(this.boatsKey && this.boatsSecret);
    this.activeMarketDataSession = null;
    this.pnlSeries = [];
    this._stockBuf = new Map();
    this._occBuf = new Map();
    this._tickTimer = null;
    this._watchTimer = null;
    this._curveTimer = null;
    this._sessionTimer = null;
    this._healthTimer = null;
    this._hbTimer = null;
    this._stopped = false;
    this._flushing = false;

    this.spyYesterdaysClose = null;
    this._cachedSpyState = null;
    this._spyStateDirty = true;
    this._spyLastPrice = null;
    this._spy4pmResetDone = false;
    this.tenBuckets = new TenSecBuckets({
      etNow,
      onClosed: (sym, bar) => {
        try { this.equityEngine?.onLiveTenClosed?.(sym, bar); } catch (_) { /* */ }
      },
    });
  }

  start() {
    if (this._running) {
      this._syncWanted();
      return;
    }
    this._running = true;
    this._stopped = false;
    if (this.equityEngine) this.equityEngine.stockTape = this.stockTape;
    if (this.optionsEngine) {
      this.optionsEngine.stockTape = this.stockTape;
      this.optionsEngine.optStream = this.optStream;
    }
    if (this.poolAttacher) {
      this.poolAttacher.stockTape = this.stockTape;
      this.poolAttacher.optStream = this.optStream;
    }

    this.stockTape.onTick = (sym, rec) => {
      this._stockBuf.set(sym, { sym, p: rec.p, s: rec.s, t: rec.t, kind: 't' });
      this.equityEngine?.applyTapeTrade?.(sym, rec);
      this.tenBuckets?.push(sym, rec.p, rec.s, rec.t);
      if (sym === 'SPY' && rec.p > 0) this._onSpyPx(rec.p);
    };
    this.stockTape.onQuote = (sym, q) => {
      const mid = q.bp > 0 && q.ap > 0 ? (q.bp + q.ap) / 2 : (q.bp || q.ap || 0);
      const prev = this._stockBuf.get(sym) || { sym };
      this._stockBuf.set(sym, {
        ...prev,
        bid: q.bp,
        ask: q.ap,
        p: prev.kind === 't' && prev.p > 0 ? prev.p : (mid || prev.p),
        t: q.t,
        kind: prev.kind === 't' ? 't' : 'q',
      });
      this.equityEngine?.applyTapeQuote?.(sym, q);
      if (sym === 'SPY' && q.bp > 0 && q.ap > 0) {
        this._onSpyPx((q.bp + q.ap) / 2);
      }
    };
    this.optStream.onQuote = (occ, q) => {
      this._occBuf.set(occ, q);
      this.optionsEngine?.applyStreamQuote?.(occ, q);
      this.poolAttacher?.applyStreamQuote?.(occ, q);
      this.equityEngine?.flipMonitor?.applyStreamQuote?.(occ, q);
    };

    this._syncWanted();
    this._applyMarketDataSession(true);
    this.optStream.start();
    this.warmOptionTape().catch((err) => this.log.warn?.(`[hub] option tape: ${err.message}`));
    this._loadSpyRef().catch((err) => this.log.warn?.(`[hub] SPY ref: ${err.message}`));
    this._refreshSilentMarks().catch((err) => this.log.warn?.(`[hub] silent mark: ${err.message}`));
    this._watchTimer = setInterval(() => this._syncWanted(), WATCH_MS);
    this._tickTimer = setInterval(() => this._flushTicks(), TICK_MS);
    this._tenTimer = setInterval(() => this.tenBuckets?.flushClock(), 1000);
    this._curveTimer = setInterval(() => this._pushCurve(), CURVE_MS);
    this._sessionTimer = setInterval(() => this._applyMarketDataSession(false), 30000);
    this._healthTimer = setInterval(() => this._healSubscriptions(), 30000);
    this._hbTimer = setInterval(() => {
      this.warmOptionTape().catch((err) => this.log.warn?.(`[hub] option tape: ${err.message}`));
    }, 15 * 60 * 1000);
    this._watchTimer.unref?.();
    this._tickTimer.unref?.();
    this._tenTimer.unref?.();
    this._curveTimer.unref?.();
    this._sessionTimer.unref?.();
    this._healthTimer.unref?.();
    this._hbTimer.unref?.();
    this.log.info?.(`[hub] live stock + OPRA wanted-set streams starting (SPY always on; BOATS overnight; caps pool=${this._caps().poolMax} ws=${this._caps().liveWsCap} opra=${this._caps().opraCap} dual=${this._dualLeg() ? 'call+put' : 'one'})`);
  }

  stop() {
    this._running = false;
    this._stopped = true;
    clearInterval(this._watchTimer);
    clearInterval(this._tickTimer);
    clearInterval(this._tenTimer);
    clearInterval(this._curveTimer);
    clearInterval(this._sessionTimer);
    clearInterval(this._healthTimer);
    clearInterval(this._hbTimer);
    this.stockTape.stop();
    this.optStream.stop();
  }

  async _loadSpyRef() {
    const client = this.optionsClient;
    if (!client?.enabled) return;
    try {
      const snap = await client.getPrevClose('SPY');
      if (snap?.prevClose > 0) {
        this.spyYesterdaysClose = snap.prevClose;
        this._spyStateDirty = true;
        this.log.info?.(`[hub] SPY prev close $${snap.prevClose}`);
      }
      if (this._spyLastPrice == null && snap?.last > 0) this._onSpyPx(snap.last);
    } catch (err) {
      this.log.warn?.(`[hub] SPY snapshot: ${err.message}`);
    }
  }

  _onSpyPx(price) {
    const p = Math.round(Number(price) * 100) / 100;
    if (!(p > 0) || p === this._spyLastPrice) return;
    this._spyLastPrice = p;
    this._spyStateDirty = true;
  }

  getSpyState() {
    if (!this._spyStateDirty && this._cachedSpyState) return this._cachedSpyState;
    const currentPrice = this._spyLastPrice;
    const yesterdaysClose = this.spyYesterdaysClose;
    const changePct = (currentPrice != null && yesterdaysClose > 0)
      ? ((currentPrice - yesterdaysClose) / yesterdaysClose) * 100
      : null;
    this._cachedSpyState = {
      currentPrice,
      yesterdaysClose: yesterdaysClose ?? null,
      changePct,
      session: this.activeMarketDataSession,
    };
    this._spyStateDirty = false;
    return this._cachedSpyState;
  }

  _isRegularSession() {
    const hour = etNow().h;
    return hour >= 4 && hour < 20;
  }

  _checkSpy4pmReset() {
    const { mins } = etNow();
    const inWindow = mins >= 960 && mins < 962;
    if (inWindow && !this._spy4pmResetDone) {
      this._spy4pmResetDone = true;
      if (this._spyLastPrice > 0) {
        this.log.info?.(`[hub] SPY 4 PM ET ref $${this.spyYesterdaysClose} → $${this._spyLastPrice}`);
        this.spyYesterdaysClose = this._spyLastPrice;
      }
      this._cachedSpyState = null;
      this._spyStateDirty = true;
    } else if (!inWindow) {
      this._spy4pmResetDone = false;
    }
  }

  _applyMarketDataSession(force) {
    if (this._stopped) return;
    this._checkSpy4pmReset();
    const regular = this._isRegularSession();
    const wantBoats = this.boatsEnabled && !this.stockTape.boatsDenied && !regular;
    const desired = wantBoats ? 'boats' : 'sip';
    if (!force && desired === this.activeMarketDataSession) return;
    if (desired === 'boats') {
      this.log.info?.('[hub] market data → BOATS (overnight 8 PM–4 AM ET); SPY stays subscribed');
      this.stockTape.switchEndpoint({
        wsUrl: 'wss://stream.data.alpaca.markets/v1beta1/boats',
        feed: 'boats',
        key: this.boatsKey,
        secret: this.boatsSecret,
        label: 'v1beta1/boats (overnight)',
      });
      this.activeMarketDataSession = 'boats';
    } else {
      this.log.info?.('[hub] market data → SIP/IEX (4 AM–8 PM ET); SPY stays subscribed');
      this.stockTape.switchEndpoint({
        feed: this.stockTape._rthFeed || 'sip',
        key: this.stockTape.key,
        secret: this.stockTape.secret,
        label: `v2/${this.stockTape._rthFeed || 'sip'}`,
      });
      this.activeMarketDataSession = this.stockTape.feed || 'sip';
    }
    this.stockTape.watchNow('SPY');
  }

  _healSubscriptions() {
    if (this._stopped) return;
    this.stockTape.watchNow('SPY');
    this.stockTape.healSubscriptions();
    this.optStream.healSubscriptions();
    this._refreshSilentMarks().catch((err) => this.log.warn?.(`[hub] silent mark: ${err.message}`));
    const regular = this._isRegularSession();
    const stockAge = this.stockTape.stats.lastTickAt
      ? Date.now() - Date.parse(this.stockTape.stats.lastTickAt)
      : Infinity;
    if (regular && this.stockTape.authed && stockAge > 45000) {
      this.log.warn?.('[hub] SPY/tape silent 45s in RTH — force re-subscribe');
      this.stockTape.forceResubscribe();
    }
    const optAge = this.optStream.stats.lastTickAt
      ? Date.now() - Date.parse(this.optStream.stats.lastTickAt)
      : Infinity;
    if (this.optStream.authed && this.optStream.wanted.size && optAge > 90000) {
      this.optStream.forceResubscribe();
    }
  }

  /** BOATS is thin overnight — if a live name never ticks, stamp the SIP snapshot so the desk isn't stuck on yesterday's close. */
  async _refreshSilentMarks() {
    const oc = this.optionsClient;
    if (!oc || this._stopped) return;
    const now = Date.now();
    if (now - (this._silentMarkAt || 0) < 15000) return;
    this._silentMarkAt = now;
    const live = this._wanted().live || [];
    for (const sym of live) {
      const q = this.stockTape.getQuote?.(sym, 8000);
      const tr = this.stockTape.getTrade?.(sym, 15000);
      if (q || tr) continue;
      let mark = null;
      if (typeof oc.getUnderlyingMark === 'function') {
        mark = await oc.getUnderlyingMark(sym).catch(() => null);
      }
      const px = Number(mark?.mid || mark?.last) || Number(await oc.getUnderlyingSpot?.(sym).catch(() => 0)) || 0;
      if (!(px > 0)) continue;
      this.equityEngine?.applyTapeTrade?.(sym, { p: Number(mark?.last) || px, s: 0, t: now });
      if (Number(mark?.bid) > 0 || Number(mark?.ask) > 0) {
        this.equityEngine?.applyTapeQuote?.(sym, { bp: Number(mark.bid) || 0, ap: Number(mark.ask) || 0, t: now });
      }
      this._stockBuf.set(sym, {
        sym, p: px, bid: Number(mark?.bid) || 0, ask: Number(mark?.ask) || 0, t: now, kind: 'rest',
      });
    }
  }

  async warmOptionTape() {
    const client = this.optionsClient;
    if (!client?.enabled) return;
    try {
      const spot = await client.getUnderlyingSpot('SPY');
      const pick = await client.attachZeroDteItm('SPY', spot, 'call');
      const occ = pick?.ok && pick.contract?.occ ? String(pick.contract.occ).toUpperCase() : null;
      if (!occ) {
        this.log.warn?.(`[hub] SPY heartbeat skipped: ${pick?.reason || 'no contract'}`);
        return;
      }
      this._heartbeatOcc = occ;
      this.optStream.watchNow(occ);
      this.log.info?.(`[hub] options tape heartbeat ${occ} dte=${pick.contract.dte} ${pick.contract.side || 'call'}`);
    } catch (err) {
      this.log.warn?.(`[hub] options tape heartbeat: ${err.message}`);
    }
  }

  _caps() {
    const cfg = this.equityEngine?.cfg || {};
    const n = (k, d, hi = STOCK_HARD_CAP) => {
      const v = Math.floor(Number(cfg[k]));
      if (!Number.isFinite(v)) return d;
      return Math.max(1, Math.min(hi, v));
    };
    return {
      poolMax: n('poolMax', 20, 80),
      liveWsCap: n('liveWsCap', 10),
      opraCap: n('opraCap', 20, OCC_HARD_CAP),
    };
  }

  _dualLeg() {
    return Vol10sConfig.opraDualLegOn(this.equityEngine?.cfg || {});
  }

  liveSymbols() {
    return this._wanted().live;
  }

  /** True when underlying is in the ranked live SIP tier (positions/working always qualify). */
  isLiveUnderlying(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return false;
    return this._wanted().live.includes(sym);
  }

  liveTierMeta() {
    const { live } = this._wanted();
    const caps = this._caps();
    return {
      cap: caps.liveWsCap,
      poolMax: caps.poolMax,
      opraCap: caps.opraCap,
      opraDualLeg: this._dualLeg(),
      occPerName: this._dualLeg() ? 2 : 1,
      live,
    };
  }

  _wanted() {
    const { liveWsCap, opraCap } = this._caps();
    const ranked = [];
    const seen = new Set();
    const push = (s) => {
      const u = String(s || '').toUpperCase();
      if (!u || u === 'SPY' || seen.has(u)) return;
      seen.add(u);
      ranked.push(u);
    };
    const oe = this.optionsEngine;
    if (oe?.positions) {
      for (const p of oe.positions.values()) push(p.underlying);
    }
    if (oe?.working) {
      for (const w of oe.working.values()) push(w.underlying);
    }
    const pool = typeof this.equityEngine?._poolRows === 'function'
      ? this.equityEngine._poolRows()
      : [];
    const sorted = [...pool].sort((a, b) => {
      const ra = STATUS_RANK[a.phase ?? a.status] ?? 9;
      const rb = STATUS_RANK[b.phase ?? b.status] ?? 9;
      if (ra !== rb) return ra - rb;
      return (Number(b.watchScore) || 0) - (Number(a.watchScore) || 0);
    });
    for (const r of sorted) push(r.symbol);
    const live = ranked.slice(0, Math.min(STOCK_HARD_CAP, liveWsCap));
    const liveSet = new Set(live);

    const occs = [];
    const occSeen = new Set();
    const cap = Math.min(OCC_HARD_CAP, opraCap);
    const addOcc = (occ) => {
      const u = String(occ || '').toUpperCase();
      if (!u || occSeen.has(u)) return false;
      occSeen.add(u);
      occs.push(u);
      return true;
    };
    const addGroup = (list, { force = false } = {}) => {
      const fresh = [...new Set((list || []).map((x) => String(x || '').toUpperCase()).filter(Boolean))]
        .filter((u) => !occSeen.has(u));
      if (!fresh.length) return;
      if (!force && occs.length + fresh.length > cap) return;
      for (const u of fresh) addOcc(u);
    };
    if (oe?.positions) {
      for (const p of oe.positions.values()) {
        if (p.occ) addGroup([p.occ], { force: true });
      }
    }
    if (oe?.working) {
      for (const w of oe.working.values()) {
        if (w.occ) addGroup([w.occ], { force: true });
      }
    }
    const dual = this._dualLeg();
    const legsOf = (att) => {
      if (!att) return [];
      if (dual && (att.callOcc || att.putOcc)) return [att.callOcc, att.putOcc];
      return att.occ ? [att.occ] : [];
    };
    if (this.poolAttacher?.bySymbol) {
      for (const [sym, att] of this.poolAttacher.bySymbol) {
        if (!liveSet.has(String(sym).toUpperCase())) continue;
        addGroup(legsOf(att));
      }
    }
    if (this.equityEngine?.book) {
      for (const sym of live) {
        const st = this.equityEngine.book.get(sym);
        addGroup(legsOf(st));
      }
    }
    const occLive = occs.slice(0, cap);
    const hb = this._heartbeatOcc && !occLive.includes(this._heartbeatOcc)
      ? [this._heartbeatOcc]
      : [];
    return {
      stocks: ['SPY', ...live],
      occs: [...hb, ...occLive],
      live,
    };
  }

  _syncWanted() {
    if (this._stopped) return;
    try {
      const { stocks, occs } = this._wanted();
      this.stockTape.setWatched(stocks);
      this.optStream.setWatched(occs);
      if (this.optionsEngine?.gate && this.optStream.feed) {
        this.optionsEngine.gate.setFeed(this.optStream.feed);
      }
    } catch (err) {
      this.log.warn?.(`[hub] wanted-set: ${err.message}`);
    }
  }

  poolPnl() {
    const stats = this.fillLedger?.getSummary?.()?.stats || {};
    const realized = Number(stats.realizedPnl) || 0;
    let unrealized = Number(this.optionsEngine?._unrealizedPnl?.()) || 0;
    const seen = new Set();
    const book = this.equityEngine?.book;
    if (book && typeof book.values === 'function') {
      for (const st of book.values()) {
        if (!st || st.viaOptions) continue;
        if (!(st.status === 'long' || st.status === 'pending_sell')) continue;
        const qty = Number(st.qty) || 0;
        const entry = Number(st.avgEntry) || 0;
        const last = Number(st.lastC) || Number(st.lastBid) || 0;
        if (qty > 0 && entry > 0 && last > 0) {
          unrealized += (last - entry) * qty;
          seen.add(String(st.symbol || '').toUpperCase());
        }
      }
    }
    for (const p of this.equityEngine?.brokerPositions || []) {
      const sym = String(p.symbol || '').toUpperCase();
      if (!sym || seen.has(sym)) continue;
      const qty = Number(p.qty) || 0;
      const entry = Number(p.avg) || 0;
      const last = Number(p.current_price) || 0;
      if (qty > 0 && entry > 0 && last > 0) unrealized += (last - entry) * qty;
    }
    const eq = Number(this.equityEngine?.paperAccount?.equity);
    const start = Number(stats.startEquity) || 100000;
    const brokerTotal = Number.isFinite(eq) ? Math.round((eq - start) * 100) / 100 : null;
    const ledgerTotal = Math.round((realized + unrealized) * 100) / 100;
    return {
      realized: Math.round(realized * 100) / 100,
      unrealized: Math.round(unrealized * 100) / 100,
      total: brokerTotal != null ? brokerTotal : ledgerTotal,
      ledgerTotal,
      brokerTotal,
    };
  }

  _slimPositions() {
    const oe = this.optionsEngine;
    if (!oe?.positions) return [];
    return [...oe.positions.values()].map((p) => {
      const mark = Number(p.lastBid) || Number(p.lastMid) || 0;
      const pnl = mark > 0 && p.fillPrice > 0 ? (mark - p.fillPrice) * p.qty * 100 : null;
      return {
        occ: p.occ,
        underlying: p.underlying,
        qty: p.qty,
        fillPrice: p.fillPrice,
        bid: p.lastBid,
        mid: p.lastMid,
        ask: p.lastAsk,
        pnl: pnl != null ? Math.round(pnl * 100) / 100 : null,
        pnlPct: mark > 0 && p.fillPrice > 0 ? Math.round(((mark - p.fillPrice) / p.fillPrice) * 1000) / 10 : null,
        liveMark: Boolean(p.liveMark),
        markAgeMs: p.markAt ? Date.now() - p.markAt : null,
        lockArmed: p.lockArmed,
        layers: p.layers || 1,
        exiting: Boolean(p.sellOrderId),
        ageSec: Math.max(0, Math.round((Date.now() - p.entryTs) / 1000)),
        peakBid: p.peakBid,
      };
    });
  }

  _slimWorking() {
    const oe = this.optionsEngine;
    if (!oe?.working) return [];
    return [...oe.working.values()].map((w) => ({
      orderId: w.orderId,
      occ: w.occ,
      underlying: w.underlying,
      qty: w.qty,
      limitPrice: w.limitPrice,
      peg: w.peg,
      bid: w.bid,
      ask: w.ask,
      mid: w.mid,
      ageSec: Math.max(0, Math.round((Date.now() - (w.startedAt || w.placedAt)) / 1000)),
    }));
  }

  _poolTapeSymbols() {
    const pool = typeof this.equityEngine?._poolRows === 'function'
      ? this.equityEngine._poolRows()
      : [];
    return pool.map((r) => String(r.symbol || '').toUpperCase()).filter(Boolean);
  }

  tickPayload() {
    const pool = this.poolPnl();
    const wanted = this._wanted();
    const caps = this._caps();
    const poolTape = this._poolTapeSymbols();
    return {
      type: 'tick',
      ts: Date.now(),
      et: etNow().iso,
      pool,
      poolTape,
      positions: this._slimPositions(),
      working: this._slimWorking(),
      pnlPoint: { t: Date.now(), pnl: pool.total },
      tape: this.stockTape.tape(16),
      optTicks: this.optStream.ticks(16),
      ticks: [...this._stockBuf.values()].slice(-24),
      occQuotes: [...this._occBuf.entries()].slice(-24).map(([occ, q]) => ({ occ, ...q })),
      spy: this.getSpyState(),
      streams: {
        stock: {
          feed: this.stockTape.feed,
          session: this.activeMarketDataSession,
          connected: this.stockTape.connected,
          authed: this.stockTape.authed,
          watched: this.stockTape.wanted.size,
          lastTickAt: this.stockTape.stats.lastTickAt,
        },
        options: {
          feed: this.optStream.feed,
          connected: this.optStream.connected,
          authed: this.optStream.authed,
          watched: this.optStream.wanted.size,
          lastTickAt: this.optStream.stats.lastTickAt,
        },
        tape: {
          ...caps,
          live: wanted.live,
          spyKeepalive: true,
          opraDualLeg: this._dualLeg(),
          occPerName: this._dualLeg() ? 2 : 1,
          occWatched: wanted.occs.length,
        },
      },
    };
  }

  _flushTicks() {
    if (this._stopped || this._flushing) return;
    if (!this._stockBuf.size && !this._occBuf.size) return;
    this._flushing = true;
    try {
      if (this.onTick) this.onTick(this.tickPayload());
    } catch (err) {
      this.log.warn?.(`[hub] tick: ${err.message}`);
    } finally {
      this._stockBuf.clear();
      this._occBuf.clear();
      this._flushing = false;
    }
  }

  _pushCurve() {
    const pool = this.poolPnl();
    this.pnlSeries.push({ t: Date.now(), pnl: pool.total });
    if (this.pnlSeries.length > 7200) this.pnlSeries.splice(0, this.pnlSeries.length - 7200);
    if (!this.onTick) return;
    try { this.onTick(this.tickPayload()); } catch (err) {
      this.log.warn?.(`[hub] curve: ${err.message}`);
    }
  }

  getState() {
    return {
      ok: true,
      type: 'streams',
      stock: this.stockTape.getState(),
      options: this.optStream.getState(),
      spy: this.getSpyState(),
      tape: {
        ...this._caps(),
        live: this._wanted().live,
        opraDualLeg: this._dualLeg(),
        occPerName: this._dualLeg() ? 2 : 1,
        occWatched: this._wanted().occs.length,
      },
      pnlSeries: this.pnlSeries.slice(-1200),
      pool: this.poolPnl(),
    };
  }
}

module.exports = LiveMarketHub;
