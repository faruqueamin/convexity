'use strict';

/**
 * One working ENTRY per underlying across PULSE stock and VECTOR options.
 * Serializes replace. PATCH first, cancel+place on failure.
 */

function roundPx(n) {
  const x = Number(n);
  if (!(x > 0)) return 0;
  if (x >= 1) return Math.round(x * 100) / 100;
  return Math.round(x * 10000) / 10000;
}

function midOf(q) {
  const bid = Number(q?.bid ?? q?.bp) || 0;
  const ask = Number(q?.ask ?? q?.ap) || 0;
  if (bid > 0 && ask > 0) return roundPx((bid + ask) / 2);
  if (q?.mid > 0) return roundPx(q.mid);
  return bid || ask || 0;
}

class PendingOrderBook {
  constructor({ alpaca, logger } = {}) {
    this.alpaca = alpaca || null;
    this.logger = logger || console;
    this.byOrderId = new Map();
    this.locks = new Set();
    this._ops = new Map();
    this._replaceCancels = new Set();
    this._hold = { equity: null, options: null };
  }

  setHoldChecks({ equity, options } = {}) {
    if (typeof equity === 'function') this._hold.equity = equity;
    if (typeof options === 'function') this._hold.options = options;
  }

  _sym(s) { return String(s || '').toUpperCase(); }

  tryLock(symbol) {
    const sym = this._sym(symbol);
    if (!sym) return false;
    if (this.locks.has(sym) || this.getForSymbol(sym)) return false;
    this.locks.add(sym);
    return true;
  }

  /** Lock for a new entry attempt — fails if already locked or working. */
  acquire(symbol) {
    const sym = this._sym(symbol);
    if (!sym) return false;
    if (this.getForSymbol(sym)) return false;
    if (this.locks.has(sym)) return false;
    this.locks.add(sym);
    return true;
  }

  isLocked(symbol) {
    return this.locks.has(this._sym(symbol));
  }

  unlock(symbol) {
    this.locks.delete(this._sym(symbol));
  }

  hasWorking(symbol) {
    const sym = this._sym(symbol);
    if (!sym) return false;
    if (this.locks.has(sym) || this.getForSymbol(sym)) return true;
    return false;
  }

  slotTaken(symbol) {
    const sym = this._sym(symbol);
    if (this.hasWorking(sym)) return true;
    try { if (this._hold.equity?.(sym)) return true; } catch (_) { /* */ }
    try { if (this._hold.options?.(sym)) return true; } catch (_) { /* */ }
    return false;
  }

  register(rec) {
    if (!rec?.orderId) return;
    const row = {
      orderId: rec.orderId,
      symbol: this._sym(rec.symbol),
      occ: rec.occ ? String(rec.occ).toUpperCase() : null,
      kind: rec.kind === 'option' ? 'option' : 'equity',
      side: rec.side === 'sell' ? 'sell' : 'buy',
      qty: Number(rec.qty) || 0,
      limitPx: roundPx(rec.limitPx),
      peg: rec.peg || 'bid',
      pegCount: Number(rec.pegCount) || 0,
      startedAt: rec.startedAt || Date.now(),
      lastReplaceAt: rec.lastReplaceAt || 0,
      replaceAttempts: Number(rec.replaceAttempts) || 0,
      replaceMinMs: Number(rec.replaceMinMs) || 1500,
      maxChaseSteps: Number.isFinite(Number(rec.maxChaseSteps)) ? Number(rec.maxChaseSteps) : 8,
      placeFn: typeof rec.placeFn === 'function' ? rec.placeFn : null,
    };
    this.byOrderId.set(row.orderId, row);
    this.unlock(row.symbol);
    return row;
  }

  get(orderId) {
    return this.byOrderId.get(orderId) || null;
  }

  getForSymbol(symbol) {
    const sym = this._sym(symbol);
    for (const rec of this.byOrderId.values()) {
      if (rec.symbol === sym && rec.side === 'buy') return rec;
    }
    return null;
  }

  getForOcc(occ) {
    const key = String(occ || '').toUpperCase();
    for (const rec of this.byOrderId.values()) {
      if (rec.occ === key) return rec;
    }
    return null;
  }

  remap(oldId, newId, extra = {}) {
    const rec = this.byOrderId.get(oldId);
    if (!rec || !newId) return rec || null;
    this.byOrderId.delete(oldId);
    rec.orderId = newId;
    if (extra.limitPx > 0) rec.limitPx = roundPx(extra.limitPx);
    rec.lastReplaceAt = Date.now();
    rec.replaceAttempts = (rec.replaceAttempts || 0) + 1;
    this.byOrderId.set(newId, rec);
    return rec;
  }

  release(orderId) {
    const rec = this.byOrderId.get(orderId);
    if (rec) this.byOrderId.delete(orderId);
    return rec || null;
  }

  noteReplaceCancel(orderId) {
    if (orderId) this._replaceCancels.add(orderId);
  }

  consumeReplaceCancel(orderId) {
    if (!orderId) return false;
    const hit = this._replaceCancels.has(orderId);
    if (hit) this._replaceCancels.delete(orderId);
    return hit;
  }

  runOp(symbol, fn) {
    const sym = this._sym(symbol);
    const prev = this._ops.get(sym) || Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    this._ops.set(sym, next.catch(() => {}));
    return next;
  }

  walkCeiling(kind, quote, cfg = {}) {
    const bid = Number(quote?.bid ?? quote?.bp) || 0;
    const ask = Number(quote?.ask ?? quote?.ap) || 0;
    const mid = midOf(quote);
    const mode = String(kind === 'equity'
      ? (cfg.equityBidWalkCeilingMode || cfg.bidWalkCeilingMode || 'mid')
      : (cfg.bidWalkCeilingMode || 'bid_slip')).toLowerCase();
    if (mode === 'mid') return mid || ask || bid;
    const slipPct = Number(cfg.bidWalkMaxSlipPct) || 8;
    const maxCents = Number(cfg.bidWalkMaxCents) || 0.05;
    if (!(bid > 0)) return mid || ask;
    const slip = bid * (slipPct / 100);
    return roundPx(bid + Math.min(slip, maxCents));
  }

  nextEquityRung(rec, quote, cfg = {}, { allowAsk = true } = {}) {
    const bid = roundPx(quote?.bid ?? quote?.bp);
    const ask = roundPx(quote?.ask ?? quote?.ap);
    const mid = midOf(quote);
    const limit = roundPx(rec.limitPx);
    if (!(bid > 0)) return null;
    let ceiling = this.walkCeiling('equity', quote, cfg);
    if (allowAsk && ask > 0) ceiling = Math.max(ceiling || 0, ask);
    if (bid > limit + 0.0001) {
      return roundPx(Math.min(bid, ceiling || bid));
    }
    const nearBid = Math.abs(limit - bid) <= Math.abs(limit - (mid || bid)) + 0.0001;
    if (nearBid && bid + 0.0001 < limit && (!mid || limit + 0.0001 < mid)) {
      return roundPx(Math.min(bid, ceiling || bid));
    }
    if (ask > 0 && limit > ask + 0.0001) {
      return roundPx(Math.min(ask, ceiling || ask));
    }
    const rungs = [bid];
    if (mid > bid) rungs.push(mid);
    if (allowAsk && ask > (mid || bid)) rungs.push(ask);
    for (const r of rungs) {
      if (r > limit + 0.0001 && (!ceiling || r <= ceiling + 0.0001)) return roundPx(r);
    }
    return null;
  }

  nextOptionPx(rec, quote, cfg = {}) {
    const bid = roundPx(quote?.bid);
    const limit = roundPx(rec.limitPx);
    if (!(bid > 0)) return null;
    const ceiling = this.walkCeiling('option', quote, cfg);
    const cent = Number(cfg.walkCent) || 0.01;
    if (bid + 0.0001 < limit) return roundPx(Math.min(bid, ceiling || bid));
    const want = roundPx(limit + cent);
    const cap = ceiling || want;
    if (want <= limit + 0.00001) return null;
    if (want > cap + 0.00001) {
      if (cap > limit + 0.00001) return roundPx(cap);
      return null;
    }
    return want;
  }

  async replaceLimit(rec, newPx) {
    const want = roundPx(newPx);
    if (!rec || !(want > 0)) return rec;
    if (Math.abs(want - rec.limitPx) < 0.001) return rec;
    const minMs = Number(rec.replaceMinMs) || 1500;
    if (rec.lastReplaceAt && Date.now() - rec.lastReplaceAt < minMs) return rec;
    const maxSteps = Number.isFinite(Number(rec.maxChaseSteps)) ? Number(rec.maxChaseSteps) : 8;
    if ((rec.replaceAttempts || 0) >= maxSteps) return rec;
    return this.runOp(rec.symbol, async () => {
      const live = this.get(rec.orderId) || this.getForSymbol(rec.symbol);
      if (!live) return rec;
      if (live.lastReplaceAt && Date.now() - live.lastReplaceAt < minMs) return live;
      if (Math.abs(want - live.limitPx) < 0.001) return live;
      try {
        const next = await this.alpaca.replaceOrder(live.orderId, { limitPrice: want });
        const newId = next?.id || live.orderId;
        if (newId !== live.orderId) {
          this.noteReplaceCancel(live.orderId);
          this.remap(live.orderId, newId, { limitPx: want });
        } else {
          live.limitPx = want;
          live.lastReplaceAt = Date.now();
          live.replaceAttempts = (live.replaceAttempts || 0) + 1;
        }
        this.logger.info?.(`[pending] REPLACE ${live.symbol} ${live.occ || ''} $${want} ${String(newId).slice(0, 8)}`);
        return this.get(newId) || live;
      } catch (err) {
        this.logger.warn?.(`[pending] PATCH ${live.symbol}: ${err.message}`);
        if (typeof live.placeFn !== 'function') throw err;
        this.noteReplaceCancel(live.orderId);
        await this.alpaca.cancelOrder(live.orderId).catch(() => {});
        const placed = await live.placeFn(want);
        const newId = placed?.id;
        if (!newId) throw new Error('cancel+place returned no id');
        this.remap(live.orderId, newId, { limitPx: Number(placed.limit_price) || want });
        this.logger.info?.(`[pending] CANCEL+PLACE ${live.symbol} ${live.occ || ''} $${want} ${String(newId).slice(0, 8)}`);
        return this.get(newId);
      }
    });
  }
}

module.exports = PendingOrderBook;
module.exports.roundPx = roundPx;
module.exports.midOf = midOf;
