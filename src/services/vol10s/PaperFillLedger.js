'use strict';

/**
 * Append-only paper fill ledger + tiny learner.
 * Classifies each fill vs bid/mid/ask at send so we can peg the next order
 * and size up only when large paper lots still print inside the spread.
 */

const fs = require('fs');
const path = require('path');

const BUY_PEGS = ['bid', 'mid', 'ask'];
const SELL_PEGS = ['ask', 'mid', 'bid'];
const QTY_BUCKETS = [
  { id: '1-10', lo: 1, hi: 10 },
  { id: '11-50', lo: 11, hi: 50 },
  { id: '51-100', lo: 51, hi: 100 },
  { id: '101-500', lo: 101, hi: 500 },
];
const TAIL = 80;
const ORDER_TAIL = 500;
const MODEL_MIN_FILLS = 3;
/** Fills before this instant train neither peg nor size (incident 2026-08-28). */
const MODEL_AFTER_MS = Date.parse('2026-08-29T00:00:00.000Z');

function qtyBucket(qty) {
  const n = Math.max(1, Math.floor(Number(qty) || 1));
  for (const b of QTY_BUCKETS) {
    if (n >= b.lo && n <= b.hi) return b.id;
  }
  return '101-500';
}

function parseOcc(occ) {
  const m = /^([A-Z][A-Z0-9]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(String(occ || '').toUpperCase());
  if (!m) return null;
  return {
    underlying: m[1],
    occ: m[0],
    side: m[5] === 'P' ? 'put' : 'call',
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
  };
}

function etToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function identFrom(raw = {}) {
  let occ = raw.occ ? String(raw.occ).toUpperCase() : null;
  let symbol = raw.symbol ? String(raw.symbol).toUpperCase() : null;
  if (occ && !parseOcc(occ)) occ = null;
  const fromSym = symbol ? parseOcc(symbol) : null;
  if (!occ && fromSym) {
    occ = fromSym.occ;
    symbol = fromSym.underlying;
  } else if (occ) {
    const p = parseOcc(occ);
    if (p && (!symbol || parseOcc(symbol))) symbol = p.underlying;
  }
  const asset = String(raw.assetClass || raw.asset_class || '').toLowerCase();
  // Require OCC (or us_option asset class) for option — bare kind:"option" was mis-tagging equity.
  const kind = (occ || asset === 'us_option') ? 'option' : 'equity';
  return { occ, symbol, kind, key: occ || symbol || 'unknown' };
}

function classify(fillPx, bid, mid, ask) {
  const f = Number(fillPx);
  const b = Number(bid) || 0;
  const m = Number(mid) || 0;
  const a = Number(ask) || 0;
  if (!(f > 0)) return 'unknown';
  const spread = a > 0 && b > 0 ? a - b : 0;
  const near = (x) => x > 0 && Math.abs(f - x) <= Math.max(0.01, spread * 0.15 || 0.02);
  if (near(b)) return 'at_bid';
  if (near(a)) return 'at_ask';
  if (near(m)) return 'at_mid';
  if (b > 0 && a > 0 && f > b && f < a) {
    return f <= m ? 'inside' : 'inside_ask';
  }
  if (b > 0 && f < b) return 'through_bid';
  if (a > 0 && f > a) return 'through_ask';
  return 'unknown';
}

function insideForBuy(cls) {
  return cls === 'at_bid' || cls === 'inside' || cls === 'at_mid';
}

function insideForSell(cls) {
  return cls === 'at_ask' || cls === 'inside_ask' || cls === 'at_mid';
}

class PaperFillLedger {
  constructor({ dataDir, log } = {}) {
    this.log = log || console;
    this.dataDir = dataDir || null;
    this.fillsPath = this.dataDir ? path.join(this.dataDir, 'fills.jsonl') : null;
    this.modelPath = this.dataDir ? path.join(this.dataDir, 'fill-model.json') : null;
    this.events = [];
    this.model = this._emptyModel();
    this._pending = new Map();
    this._filledIds = new Set(); // orderIds fully filled
    this._filledQtyByOrder = new Map(); // cumulative qty recorded per order
    this._load();
    for (const e of this.events) {
      if (!e || e.event !== 'fill' || !e.orderId) continue;
      const q = Math.floor(Number(e.filledQty) || 0);
      if (q > 0) this._filledQtyByOrder.set(e.orderId, (this._filledQtyByOrder.get(e.orderId) || 0) + q);
      const st = String(e.status || '').toLowerCase();
      if (st !== 'partially_filled' && st !== 'partial_fill') this._filledIds.add(e.orderId);
    }
  }

  _emptyModel() {
    return {
      updatedAt: null,
      fillCount: 0,
      recommendedBuyPeg: 'bid',
      recommendedSellPeg: 'ask',
      sizeMultiplier: 1,
      probeLots: 10,
      buckets: {},
    };
  }

  _load() {
    try {
      if (this.modelPath && fs.existsSync(this.modelPath)) {
        const raw = JSON.parse(fs.readFileSync(this.modelPath, 'utf8'));
        if (raw && typeof raw === 'object') this.model = { ...this._emptyModel(), ...raw };
      }
    } catch (err) {
      this.log.warn?.(`[fills] model load: ${err.message}`);
    }
    try {
      if (!this.fillsPath || !fs.existsSync(this.fillsPath)) return;
      const lines = fs.readFileSync(this.fillsPath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.events.push(JSON.parse(line)); } catch (_) {}
      }
      if (this.events.length > 5000) this.events = this.events.slice(-4000);
      this._hydrateIdentity();
      this.log.info?.(`[fills] loaded ${this.events.length} events from ${this.fillsPath}`);
    } catch (err) {
      this.log.warn?.(`[fills] jsonl load: ${err.message}`);
    }
  }

  _append(ev) {
    this.events.push(ev);
    if (this.events.length > 5000) this.events = this.events.slice(-4000);
    if (!this.fillsPath) return;
    try {
      fs.mkdirSync(path.dirname(this.fillsPath), { recursive: true });
      fs.appendFileSync(this.fillsPath, JSON.stringify(ev) + '\n');
    } catch (err) {
      this.log.warn?.(`[fills] append: ${err.message}`);
    }
  }

  _rewrite() {
    if (!this.fillsPath) return;
    try {
      fs.mkdirSync(path.dirname(this.fillsPath), { recursive: true });
      const tmp = `${this.fillsPath}.tmp`;
      fs.writeFileSync(tmp, this.events.map((e) => JSON.stringify(e)).join('\n') + (this.events.length ? '\n' : ''));
      fs.renameSync(tmp, this.fillsPath);
    } catch (err) {
      this.log.warn?.(`[fills] rewrite: ${err.message}`);
    }
  }

  _hydrateIdentity() {
    let dirty = false;
    for (const e of this.events) {
      if (!e || (e.event !== 'fill' && e.event !== 'submit' && e.event !== 'replace')) continue;
      const ident = identFrom(e);
      if (ident.occ && e.occ !== ident.occ) { e.occ = ident.occ; dirty = true; }
      if (ident.symbol && e.symbol !== ident.symbol) { e.symbol = ident.symbol; dirty = true; }
      if (ident.kind && e.kind !== ident.kind) { e.kind = ident.kind; dirty = true; }
    }
    if (dirty) this._rewrite();
  }

  _enrichFill(orderId, patch = {}) {
    const ident = identFrom(patch);
    const side = patch.side === 'sell' || patch.side === 'buy' ? patch.side : null;
    const epoch = Number(patch.epoch) || (patch.ts ? Date.parse(patch.ts) : 0);
    let dirty = false;
    for (const e of this.events) {
      if (!e || e.orderId !== orderId) continue;
      if (e.event !== 'fill' && e.event !== 'submit' && e.event !== 'replace') continue;
      if (ident.occ && !e.occ) { e.occ = ident.occ; dirty = true; }
      if (ident.symbol && !e.symbol) { e.symbol = ident.symbol; dirty = true; }
      if (ident.kind && e.kind !== ident.kind) { e.kind = ident.kind; dirty = true; }
      if (side && e.side !== side) { e.side = side; dirty = true; }
      if (epoch > 0 && e.event === 'fill' && Number(e.epoch) !== epoch) {
        e.epoch = epoch;
        e.ts = patch.ts || new Date(epoch).toISOString();
        dirty = true;
      }
    }
    if (dirty) this._rewrite();
    return dirty;
  }

  ingestBrokerOrders(orders = []) {
    let added = 0;
    let patched = 0;
    const list = Array.isArray(orders) ? orders : [];
    for (const o of list) {
      if (!o || !o.id) continue;
      const filledQty = Number(o.filled_qty || o.filledQty || 0);
      const fillPx = Number(o.filled_avg_price || o.filledAvgPrice || 0);
      if (!(filledQty > 0 && fillPx > 0)) continue;
      const ident = identFrom({
        symbol: o.symbol,
        occ: o.occ || o.symbol,
        kind: o.kind,
        assetClass: o.asset_class || o.assetClass,
      });
      const side = String(o.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
      const filledAt = o.filled_at || o.filledAt || o.updated_at || o.submitted_at || o.created_at;
      const epoch = filledAt ? Date.parse(filledAt) : NaN;
      const ts = Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
      const patch = {
        symbol: ident.symbol,
        occ: ident.occ,
        kind: ident.kind,
        side,
        assetClass: o.asset_class || o.assetClass,
        ts,
        epoch: Number.isFinite(epoch) ? epoch : undefined,
      };
      if (this._filledIds.has(o.id)) {
        if (this._enrichFill(o.id, patch)) patched += 1;
        continue;
      }
      this.noteFill({
        orderId: o.id,
        fillPx,
        filledQty,
        status: o.status || 'filled',
        ...patch,
      });
      added += 1;
    }
    if (patched) this.log.info?.(`[fills] broker backfill patched ${patched} fill(s)`);
    if (added) this.log.info?.(`[fills] broker backfill added ${added} fill(s)`);
    return { added, patched, scanned: list.length };
  }

  _saveModel() {
    if (!this.modelPath) return;
    try {
      fs.mkdirSync(path.dirname(this.modelPath), { recursive: true });
      const tmp = `${this.modelPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.model, null, 2));
      fs.renameSync(tmp, this.modelPath);
    } catch (err) {
      this.log.warn?.(`[fills] model save: ${err.message}`);
    }
  }

  noteSubmit({
    kind, side, symbol, occ, qty, orderId, limitPx, peg,
    bid, mid, ask, bidSz, askSz, feed, cash, equity, dailyPnl, openPremium,
  } = {}) {
    const now = Date.now();
    const ident = identFrom({ kind, symbol, occ });
    const ev = {
      ts: new Date(now).toISOString(),
      epoch: now,
      event: 'submit',
      kind: ident.kind || kind || (ident.occ ? 'option' : 'equity'),
      side: side || 'buy',
      symbol: ident.symbol,
      occ: ident.occ,
      qty: Math.floor(Number(qty) || 0),
      orderId: orderId || null,
      limitPx: Number(limitPx) || null,
      peg: peg || null,
      bid: Number(bid) || 0,
      mid: Number(mid) || 0,
      ask: Number(ask) || 0,
      bidSz: bidSz != null ? Number(bidSz) : null,
      askSz: askSz != null ? Number(askSz) : null,
      spreadPct: this._spreadPct(bid, ask, mid),
      feed: feed || null,
      cash: cash != null ? Number(cash) : null,
      equity: equity != null ? Number(equity) : null,
      dailyPnl: dailyPnl != null ? Number(dailyPnl) : null,
      openPremium: openPremium != null ? Number(openPremium) : null,
    };
    this._append(ev);
    if (orderId) this._pending.set(orderId, { ...ev, submittedAt: now });
    return ev;
  }

  noteReplace({ orderId, limitPx, peg, bid, mid, ask, kind, side, symbol, occ, qty } = {}) {
    const prev = this._pending.get(orderId) || {};
    const ev = {
      ts: new Date().toISOString(),
      epoch: Date.now(),
      event: 'replace',
      orderId,
      kind: kind || prev.kind || (prev.occ ? 'option' : 'equity'),
      side: side || prev.side,
      symbol: symbol || prev.symbol,
      occ: occ || prev.occ,
      qty: qty != null ? qty : prev.qty,
      limitPx: Number(limitPx) || null,
      peg: peg || prev.peg,
      bid: Number(bid) || prev.bid || 0,
      mid: Number(mid) || prev.mid || 0,
      ask: Number(ask) || prev.ask || 0,
    };
    this._append(ev);
    if (orderId) {
      this._pending.set(orderId, {
        ...prev,
        ...ev,
        submittedAt: prev.submittedAt || Date.now(),
      });
    }
    return ev;
  }

  noteFill({
    orderId, fillPx, filledQty, status, bid, mid, ask,
    symbol, occ, side, kind, assetClass, ts, epoch,
  } = {}) {
    const prev = this._pending.get(orderId) || {};
    const stat = String(status || '').toLowerCase();
    const isPartial = stat === 'partially_filled' || stat === 'partial_fill';
    const cum = Math.floor(Number(filledQty) || 0);
    const prevCum = orderId ? (this._filledQtyByOrder.get(orderId) || 0) : 0;
    const delta = orderId && cum > prevCum ? cum - prevCum : Math.floor(Number(filledQty) || prev.qty || 0);
    if (orderId && this._filledIds.has(orderId) && delta <= 0) {
      this._enrichFill(orderId, { symbol, occ, side, kind, assetClass, ts, epoch });
      return null;
    }
    if (!(delta > 0)) return null;
    const ident = identFrom({
      symbol: symbol || prev.symbol,
      occ: occ || prev.occ,
      kind: kind || prev.kind,
      assetClass,
    });
    const now = Date.now();
    const at = Number(epoch) || (ts ? Date.parse(ts) : 0);
    const when = at > 0 ? at : now;
    const fill = Number(fillPx);
    const b = Number(bid) || prev.bid || 0;
    const m = Number(mid) || prev.mid || 0;
    const a = Number(ask) || prev.ask || 0;
    const cls = classify(fill, b, m, a);
    const spread = a > 0 && b > 0 ? a - b : 0;
    const ev = {
      ts: new Date(when).toISOString(),
      epoch: when,
      event: 'fill',
      orderId,
      kind: ident.kind || prev.kind || (ident.occ || prev.occ ? 'option' : 'equity'),
      side: side || prev.side || 'buy',
      symbol: ident.symbol,
      occ: ident.occ,
      qty: prev.qty || delta,
      filledQty: delta,
      limitPx: prev.limitPx || null,
      peg: prev.peg || null,
      fillPx: fill || null,
      bid: b,
      mid: m,
      ask: a,
      vsBid: fill > 0 && b > 0 ? Math.round((fill - b) * 10000) / 10000 : null,
      vsMid: fill > 0 && m > 0 ? Math.round((fill - m) * 10000) / 10000 : null,
      vsAsk: fill > 0 && a > 0 ? Math.round((fill - a) * 10000) / 10000 : null,
      vsSpreadPct: fill > 0 && spread > 0 ? Math.round(((fill - b) / spread) * 1000) / 10 : null,
      class: cls,
      latencyMs: prev.submittedAt ? now - prev.submittedAt : null,
      status: status || 'filled',
      bucket: qtyBucket(delta || prev.qty),
    };
    this._append(ev);
    if (orderId) this._filledQtyByOrder.set(orderId, prevCum + delta);
    if (!isPartial) {
      this._pending.delete(orderId);
      this._filledIds.add(orderId);
    }
    this._rebuildModel();
    return ev;
  }

  noteCancel({ orderId, reason } = {}) {
    const prev = this._pending.get(orderId) || {};
    const ev = {
      ts: new Date().toISOString(),
      epoch: Date.now(),
      event: 'cancel',
      orderId,
      kind: prev.kind || (prev.occ ? 'option' : 'equity'),
      side: prev.side,
      symbol: prev.symbol,
      occ: prev.occ,
      qty: prev.qty,
      peg: prev.peg,
      reason: reason || null,
    };
    this._append(ev);
    this._pending.delete(orderId);
    return ev;
  }

  _spreadPct(bid, ask, mid) {
    const b = Number(bid) || 0;
    const a = Number(ask) || 0;
    const m = Number(mid) || 0;
    if (!(b > 0 && a > 0 && m > 0)) return null;
    return Math.round(((a - b) / m) * 1000) / 10;
  }

  _rebuildModel() {
    const fills = this.events.filter((e) => {
      if (e.event !== 'fill' || !(e.fillPx > 0)) return false;
      const t = Date.parse(e.ts || '') || Number(e.epoch) || 0;
      return t >= MODEL_AFTER_MS;
    });
    const buckets = {};
    for (const f of fills) {
      const side = f.side === 'sell' ? 'sell' : 'buy';
      const peg = f.peg || 'unknown';
      const bucket = f.bucket || qtyBucket(f.filledQty || f.qty);
      const key = `${side}|${peg}|${bucket}`;
      if (!buckets[key]) buckets[key] = { n: 0, inside: 0, classes: {} };
      buckets[key].n += 1;
      const ok = side === 'buy' ? insideForBuy(f.class) : insideForSell(f.class);
      if (ok) buckets[key].inside += 1;
      buckets[key].classes[f.class || 'unknown'] = (buckets[key].classes[f.class || 'unknown'] || 0) + 1;
    }
    const buyFills = fills.filter((f) => f.side !== 'sell');
    const sellFills = fills.filter((f) => f.side === 'sell');
    const buyInsideRate = buyFills.length
      ? buyFills.filter((f) => insideForBuy(f.class)).length / buyFills.length
      : 0;
    const sellInsideRate = sellFills.length
      ? sellFills.filter((f) => insideForSell(f.class)).length / sellFills.length
      : 0;

    let recommendedBuyPeg = 'bid';
    if (buyFills.length >= MODEL_MIN_FILLS && buyInsideRate < 0.35) recommendedBuyPeg = 'mid';
    if (buyFills.length >= MODEL_MIN_FILLS && buyInsideRate < 0.15) recommendedBuyPeg = 'ask';

    let recommendedSellPeg = 'ask';
    if (sellFills.length >= MODEL_MIN_FILLS && sellInsideRate < 0.35) recommendedSellPeg = 'mid';
    if (sellFills.length >= MODEL_MIN_FILLS && sellInsideRate < 0.15) recommendedSellPeg = 'bid';

    const large = fills.filter((f) => (f.filledQty || f.qty || 0) >= 50);
    const largeInside = large.length
      ? large.filter((f) => (f.side === 'sell' ? insideForSell(f.class) : insideForBuy(f.class))).length / large.length
      : 0;
    let sizeMultiplier = 1;
    if (buyFills.length < MODEL_MIN_FILLS) sizeMultiplier = 1;
    else if (buyInsideRate >= 0.6 && largeInside >= 0.5) sizeMultiplier = 10;
    else if (buyInsideRate >= 0.45) sizeMultiplier = 5;
    else if (buyInsideRate >= 0.3) sizeMultiplier = 2;
    else sizeMultiplier = 1;

    this.model = {
      updatedAt: new Date().toISOString(),
      fillCount: fills.length,
      buyFillCount: buyFills.length,
      sellFillCount: sellFills.length,
      buyInsideRate: Math.round(buyInsideRate * 1000) / 10,
      sellInsideRate: Math.round(sellInsideRate * 1000) / 10,
      recommendedBuyPeg,
      recommendedSellPeg,
      sizeMultiplier,
      probeLots: 10,
      buckets,
    };
    this._saveModel();
  }

  nextBuyPeg(cfgPeg) {
    if (this.model.fillCount < MODEL_MIN_FILLS) return cfgPeg || 'bid';
    return this.model.recommendedBuyPeg || cfgPeg || 'bid';
  }

  nextSellPeg(cfgPeg) {
    if (this.model.sellFillCount < MODEL_MIN_FILLS) return cfgPeg || 'ask';
    return this.model.recommendedSellPeg || cfgPeg || 'ask';
  }

  nextQty(baseQty) {
    const base = Math.max(1, Math.floor(Number(baseQty) || 10));
    if (this.model.fillCount < MODEL_MIN_FILLS) return Math.min(10, base);
    const mult = Number(this.model.sizeMultiplier) || 1;
    return Math.max(1, Math.min(500, Math.floor(base * (mult >= 5 ? 1 : 1) * (this.model.fillCount < 6 ? Math.min(mult, 5) : mult))));
  }

  buyPegLadder() { return BUY_PEGS; }
  sellPegLadder() { return SELL_PEGS; }

  getSummary() {
    const fills = this.events.filter((e) => e.event === 'fill').slice(-TAIL).reverse();
    const counts = { at_bid: 0, inside: 0, at_mid: 0, inside_ask: 0, at_ask: 0, other: 0 };
    for (const f of fills) {
      if (counts[f.class] != null) counts[f.class] += 1;
      else counts.other += 1;
    }
    const positions = this._positionSummaries();
    const stats = this._ledgerStats(positions);
    return {
      ok: true,
      type: 'fill_ledger',
      model: this.model,
      counts,
      recent: fills.slice(0, 24),
      orders: this.getOrders(ORDER_TAIL),
      pending: this._pending.size,
      positions,
      stats,
    };
  }

  _fillEvents() {
    return this.events
      .filter((e) => e && e.event === 'fill' && Number(e.fillPx) > 0)
      .slice()
      .sort((a, b) => {
        const ae = Number(a.epoch) || Date.parse(a.ts || '') || 0;
        const be = Number(b.epoch) || Date.parse(b.ts || '') || 0;
        return ae - be;
      });
  }

  _occRoot(occ) {
    const m = /^([A-Z][A-Z0-9]{0,5})\d{6}[CP]\d{8}$/.exec(String(occ || ''));
    return m ? m[1] : null;
  }

  /** FIFO P&L per OCC / symbol, latest activity first. */
  _positionSummaries() {
    const books = new Map();
    const fills = this._fillEvents();
    for (const e of fills) {
      const ident = identFrom(e);
      const occ = ident.occ;
      const symbol = ident.symbol;
      const key = ident.key;
      const qty = Math.floor(Number(e.filledQty || e.qty) || 0);
      const px = Number(e.fillPx) || 0;
      const option = ident.kind === 'option';
      const mult = option ? 100 : 1;
      if (!(qty > 0 && px > 0)) continue;
      let rec = books.get(key);
      if (!rec) {
        rec = {
          key,
          occ: occ || null,
          symbol: symbol || this._occRoot(occ),
          kind: option ? 'option' : 'equity',
          lots: [],
          realizedPnl: 0,
          buyQty: 0,
          sellQty: 0,
          unmatchedSellQty: 0,
          buyNotional: 0,
          sellNotional: 0,
          fillCount: 0,
          firstTs: e.ts || null,
          lastTs: e.ts || null,
          lastEpoch: Number(e.epoch) || Date.parse(e.ts || '') || 0,
        };
        books.set(key, rec);
      }
      rec.fillCount += 1;
      rec.lastTs = e.ts || rec.lastTs;
      rec.lastEpoch = Number(e.epoch) || Date.parse(e.ts || '') || rec.lastEpoch;
      if (!rec.occ && occ) rec.occ = occ;
      if (!rec.symbol && symbol) rec.symbol = symbol;
      if (e.side === 'sell') {
        rec.sellQty += qty;
        rec.sellNotional += qty * px;
        let left = qty;
        while (left > 0 && rec.lots.length) {
          const lot = rec.lots[0];
          const take = Math.min(lot.qty, left);
          rec.realizedPnl += (px - lot.px) * take * (lot.mult || mult);
          lot.qty -= take;
          left -= take;
          if (lot.qty <= 0) rec.lots.shift();
        }
        if (left > 0) rec.unmatchedSellQty += left;
      } else {
        rec.buyQty += qty;
        rec.buyNotional += qty * px;
        rec.lots.push({ qty, px, mult });
      }
    }
    const todayEt = etToday();
    for (const rec of books.values()) {
      const exp = rec.occ ? (parseOcc(rec.occ) || {}).expiry : null;
      if (!(rec.kind === 'option' && exp && exp < todayEt && rec.lots.length)) continue;
      // Past-expiry leftover lots are almost always a replaced/duplicate buy, not
      // inventory the broker still holds. Drop them without a fake $0 sale so FIFO
      // does not invent losses the account never took.
      while (rec.lots.length) {
        const lot = rec.lots.shift();
        rec.expiredQty = (rec.expiredQty || 0) + lot.qty;
      }
    }
    const round4 = (n) => Math.round(n * 10000) / 10000;
    return [...books.values()].map((r) => {
      const openQty = r.lots.reduce((s, lot) => s + lot.qty, 0);
      const openCost = r.lots.reduce((s, lot) => s + lot.qty * lot.px, 0);
      const unmatched = r.unmatchedSellQty > 0;
      const missingBuy = unmatched && !(r.buyQty > 0);
      return {
        key: r.key,
        occ: r.occ,
        symbol: r.symbol,
        kind: r.kind,
        status: openQty > 0 ? 'open' : (missingBuy ? 'unmatched' : 'closed'),
        fillCount: r.fillCount,
        buyQty: r.buyQty,
        sellQty: r.sellQty,
        unmatchedSellQty: r.unmatchedSellQty,
        unmatched,
        expiredQty: r.expiredQty || 0,
        openQty,
        avgEntry: r.buyQty > 0 ? round4(r.buyNotional / r.buyQty) : null,
        avgExit: r.sellQty > 0 ? round4(r.sellNotional / r.sellQty) : null,
        avgOpen: openQty > 0 ? round4(openCost / openQty) : null,
        realizedPnl: missingBuy ? null : Math.round(r.realizedPnl * 100) / 100,
        lastTs: r.lastTs,
        lastEpoch: r.lastEpoch,
        firstTs: r.firstTs,
      };
    }).sort((a, b) => (b.lastEpoch || 0) - (a.lastEpoch || 0));
  }

  _ledgerStats(positions = this._positionSummaries()) {
    const fills = this._fillEvents();
    let startEquity = 100000;
    for (const e of this.events) {
      const eq = Number(e && e.equity);
      const cash = Number(e && e.cash);
      if (eq > 0) { startEquity = eq; break; }
      if (cash > 0) { startEquity = cash; break; }
    }
    const realized = positions.reduce((s, p) => {
      if (p.realizedPnl == null) return s;
      return s + (Number(p.realizedPnl) || 0);
    }, 0);
    return {
      fillCount: fills.length,
      realizedPnl: Math.round(realized * 100) / 100,
      positionCount: positions.length,
      openCount: positions.filter((p) => p.status === 'open').length,
      startEquity,
      firstTs: this.events[0] && this.events[0].ts,
      lastFillTs: fills.length ? fills[fills.length - 1].ts : null,
    };
  }

  /** One row per order (latest first): submit → replace → fill | cancel. */
  getOrders(limit = ORDER_TAIL) {
    const byId = new Map();
    for (const e of this.events) {
      if (!e || typeof e !== 'object') continue;
      const id = e.orderId || `anon-${e.epoch || e.ts}`;
      const row = byId.get(id) || { orderId: e.orderId || null };
      if (e.event === 'submit') {
        row.submittedAt = e.ts;
        row.side = e.side;
        row.symbol = e.symbol;
        row.occ = e.occ;
        row.qty = e.qty;
        row.limitPx = e.limitPx;
        row.peg = e.peg;
        row.kind = e.kind;
      }
      if (e.event === 'replace') {
        row.limitPx = e.limitPx != null ? e.limitPx : row.limitPx;
        row.peg = e.peg || row.peg;
      }
      if (e.event === 'fill') {
        row.status = 'filled';
        row.fillPx = e.fillPx;
        row.filledQty = e.filledQty;
        row.class = e.class;
        row.latencyMs = e.latencyMs;
        row.side = e.side || row.side;
        row.symbol = e.symbol || row.symbol;
        row.occ = e.occ || row.occ;
        row.qty = e.filledQty || e.qty || row.qty;
      }
      if (e.event === 'cancel' && row.status !== 'filled') {
        row.status = 'canceled';
        row.cancelReason = e.reason || null;
      }
      row.lastTs = e.ts;
      row.lastEpoch = e.epoch;
      row.lastEvent = e.event;
      byId.set(id, row);
    }
    for (const [id] of this._pending) {
      const row = byId.get(id);
      if (row && !row.status) row.status = 'working';
    }
    const rows = [...byId.values()].map((r) => {
      let status = r.status;
      let cancelReason = r.cancelReason;
      if (!status) {
        if (r.lastEvent === 'replace') {
          status = 'canceled';
          cancelReason = cancelReason || 'replaced';
        } else if (r.lastEvent === 'cancel') {
          status = 'canceled';
        } else if (r.orderId && this._pending.has(r.orderId)) {
          status = 'working';
        } else {
          status = 'canceled';
        }
      }
      return { ...r, status, cancelReason };
    });
    rows.sort((a, b) => (b.lastEpoch || 0) - (a.lastEpoch || 0));
    return rows.slice(0, limit);
  }
}

function limitFromPeg(quote, peg) {
  const bid = Number(quote?.bid) || 0;
  const ask = Number(quote?.ask) || 0;
  const mid = Number(quote?.mid) || 0;
  if (peg === 'bid' && bid > 0) return bid;
  if (peg === 'ask' && ask > 0) return ask;
  if (peg === 'mid' && mid > 0) return mid;
  return ask || mid || bid || 0;
}

module.exports = PaperFillLedger;
module.exports.limitFromPeg = limitFromPeg;
module.exports.classify = classify;
module.exports.BUY_PEGS = BUY_PEGS;
module.exports.SELL_PEGS = SELL_PEGS;
module.exports.qtyBucket = qtyBucket;
