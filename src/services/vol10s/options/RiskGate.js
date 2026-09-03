'use strict';

/**
 * RiskGate — the single mandatory pre-trade checkpoint for every option entry.
 *
 * Every entry path (equity-signal mirror, DCA add, agent trade, manual buy)
 * must pass through evaluateEntry() BEFORE an order is staged. The gate
 * re-validates the live quote at order time — never trust a quote that was
 * fetched more than a few seconds ago.
 *
 * Hard rules:
 *   - Spread cap applies on every DTE path, including 0DTE.
 *   - Indicative quotes are not actionable markets: tighter spread cap
 *     and a size haircut, or block entirely when the quote is one-sided.
 *   - Sizing and notional caps use the ASK (what you actually pay), not mid.
 *   - One working order per symbol, period — including DCA adds.
 *   - The daily loss lock counts realized + unrealized (mark-to-bid).
 */

const { resolveSpreadCaps, resolveEntryIvBand, openSpreadMult } = require('../OpenWindow');

const DEFAULTS = {
  maxSpreadPct: 20,            // hard cap on OPRA feed
  indicativeMaxSpreadPct: 15,  // hard cap when feed is indicative
  zeroDteMaxSpreadPct: 12,     // extra cap for 0DTE contracts
  openStartEt: '09:30',
  openEndEt: '09:45',
  openSpreadMult: 2,           // multiply spread caps during open window
  allow0dte: false,            // 0DTE entries require explicit opt-in
  zeroDteSizeMult: 0.5,        // 0DTE size haircut
  minPremium: 0.50,            // ask-price band
  maxPremium: 25,
  minIv: 0.10,
  maxIv: 2.0,                  // IV ceiling when greeks exist (200%)
  openMinIv: 0.10,
  openMaxIv: 3.0,
  minDelta: 0.30,
  minDte: 1,                   // weekly mode floor
  maxDte: 45,
  maxPremiumUsd: 2000,         // worst-case $ per position (qty × ask × 100)
  maxOpenPremiumUsd: 5000,     // worst-case $ across open + working
  dailyMaxLossUsd: 2000,       // realized + unrealized
  maxConcurrent: 8,
  maxEntriesPerSymbolPerDay: 3,
  symbolCooldownSec: 120,      // after cancel / close / gate reject-storm
  chaseMaxSpreadPct: 30,       // abort a chase if the book widened past this
  maxChaseAboveMidPct: 35,     // never pay more than mid × (1 + x) on a chase
};

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function spreadPctOf(q) {
  const bid = n(q?.bid), ask = n(q?.ask), mid = n(q?.mid) || (bid > 0 && ask > 0 ? (bid + ask) / 2 : 0);
  if (!(bid > 0) || !(ask > 0) || !(mid > 0)) return null;
  return ((ask - bid) / mid) * 100;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function etYmd(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function expiryOf(c = {}) {
  const direct = String(c.expiry || c.expiration_date || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const occ = String(c.occ || c.symbol || '').toUpperCase();
  const m = /^([A-Z][A-Z0-9]{0,5})(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(occ);
  if (!m) return null;
  return `${2000 + parseInt(m[2], 10)}-${m[3]}-${m[4]}`;
}

function dteFromExpiry(expiry, now = new Date()) {
  const exp = String(expiry || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return null;
  if (exp === etYmd(now)) return 0;
  const ms = Date.parse(`${exp}T20:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((ms - now.getTime()) / DAY_MS));
}

function resolveDte(c = {}, now = new Date()) {
  if (c.dte != null && c.dte !== '' && Number.isFinite(Number(c.dte))) return Math.round(Number(c.dte));
  return dteFromExpiry(expiryOf(c), now);
}

class RiskGate {
  constructor({ config, feed, log } = {}) {
    this.cfg = { ...DEFAULTS, ...(config || {}) };
    this.feed = feed || 'indicative';
    this.log = log || console;
    this.cooldowns = new Map();      // symbol -> ms epoch until
    this.entriesToday = new Map();   // symbol -> count
    this.entriesDate = null;
    this.vetoedSymbols = new Map();  // symbol -> { until, reason } (brain vetoes)
    this.recent = [];                // last N verdicts for the UI
  }

  setConfig(patch = {}) { this.cfg = { ...this.cfg, ...patch }; }
  setFeed(feed) { this.feed = feed === 'opra' ? 'opra' : 'indicative'; }

  rollDay(dateStr) {
    if (this.entriesDate !== dateStr) {
      this.entriesDate = dateStr;
      this.entriesToday.clear();
    }
  }

  cooldown(symbol, sec, reason = 'cooldown') {
    const until = Date.now() + Math.max(5, n(sec, this.cfg.symbolCooldownSec)) * 1000;
    this.cooldowns.set(symbol, until);
    this._record({ ok: false, reason: `cooldown_set:${reason}`, symbol, until });
  }

  veto(symbol, minutes, reason = 'brain_veto') {
    this.vetoedSymbols.set(symbol, { until: Date.now() + minutes * 60000, reason });
  }

  noteEntry(symbol) {
    this.entriesToday.set(symbol, (this.entriesToday.get(symbol) || 0) + 1);
  }

  _cooldownLeft(symbol) {
    const until = this.cooldowns.get(symbol) || 0;
    return Math.max(0, until - Date.now());
  }

  _vetoLeft(symbol) {
    const v = this.vetoedSymbols.get(symbol);
    if (!v) return 0;
    if (v.until <= Date.now()) { this.vetoedSymbols.delete(symbol); return 0; }
    return v.until - Date.now();
  }

  _record(verdict) {
    this.recent.unshift({ ts: new Date().toISOString(), ...verdict });
    if (this.recent.length > 60) this.recent.length = 60;
  }

  /**
   * @param {object} a
   *   symbol, side ('call'|'put'), contract {bid,ask,mid,delta,iv,dte,occ,spreadPct},
   *   spot, et {date,mins,iso}, dca (bool),
   *   ctx: { enabled, armed, entriesPaused, inWindow, dailyPnl, unrealizedPnl,
   *          openPremiumUsd, openPositions, workingOrders, workingOnSymbol,
   *          sellingOnSymbol, existingPosition, requestedQty }
   * @returns {{ok:boolean, reason:string, checks:Array, maxQty:number, spreadPct:number|null}}
   */
  evaluateEntry(a = {}) {
    const cfg = this.cfg;
    const ctx = a.ctx || {};
    const c = a.contract || {};
    const symbol = String(a.symbol || '').toUpperCase();
    const checks = [];
    const fail = (id, detail) => { checks.push({ id, ok: false, detail }); };
    const pass = (id, detail) => { checks.push({ id, ok: true, detail }); };

    // ── engine / session state ──────────────────────────────────────────────
    if (!ctx.enabled || !ctx.armed) fail('engine_armed', `enabled=${!!ctx.enabled} armed=${!!ctx.armed}`);
    else pass('engine_armed');
    if (ctx.entriesPaused) fail('entries_paused', 'supervisor/brain paused entries'); else pass('entries_paused');
    if (!ctx.inWindow) fail('entry_window', `et=${a.et?.iso || ''}`); else pass('entry_window');

    // ── loss lock: realized + unrealized, mark-to-bid ───────────────────────
    const dayTotal = n(ctx.dailyPnl) + n(ctx.unrealizedPnl);
    const lossCap = Math.abs(n(cfg.dailyMaxLossUsd, DEFAULTS.dailyMaxLossUsd));
    if (dayTotal <= -lossCap) fail('daily_loss_lock', `day pnl $${Math.round(dayTotal)} ≤ -$${lossCap} (incl. unrealized)`);
    else pass('daily_loss_lock', `day pnl $${Math.round(dayTotal)}`);

    // ── concurrency / one-order-per-symbol ──────────────────────────────────
    if (ctx.sellingOnSymbol) fail('exit_in_progress', 'sell order working on this symbol'); else pass('exit_in_progress');
    if (ctx.workingOnSymbol) fail('order_working', 'already a working order on this symbol'); else pass('order_working');
    if (!ctx.existingPosition && n(ctx.openPositions) + n(ctx.workingOrders) >= n(cfg.maxConcurrent, 8)) {
      fail('max_concurrent', `${n(ctx.openPositions)} open + ${n(ctx.workingOrders)} working ≥ ${cfg.maxConcurrent}`);
    } else pass('max_concurrent');

    // ── cooldowns / vetoes / churn ──────────────────────────────────────────
    const cd = this._cooldownLeft(symbol);
    if (cd > 0) fail('symbol_cooldown', `${Math.ceil(cd / 1000)}s left`); else pass('symbol_cooldown');
    const vt = this._vetoLeft(symbol);
    if (vt > 0) fail('brain_veto', `${Math.ceil(vt / 60000)}m left`); else pass('brain_veto');
    const todayN = this.entriesToday.get(symbol) || 0;
    if (!ctx.existingPosition && todayN >= n(cfg.maxEntriesPerSymbolPerDay, 3)) {
      fail('symbol_churn', `${todayN} entries today ≥ ${cfg.maxEntriesPerSymbolPerDay}`);
    } else pass('symbol_churn', `${todayN} today`);

    // ── quote quality ───────────────────────────────────────────────────────
    // A non-live (REST snapshot) quote is treated as indicative quality even
    // when the stream feed is OPRA — it gets the tighter indicative spread cap.
    const feed = a.quoteLive === false ? 'indicative' : this.feed;
    const bid = n(c.bid), ask = n(c.ask), mid = n(c.mid) || (bid > 0 && ask > 0 ? (bid + ask) / 2 : 0);
    if (!(ask > 0)) fail('quote_valid', 'no ask — contract not tradeable'); else pass('quote_valid');
    if (!(bid > 0)) fail('quote_one_sided', 'no bid — cannot mark or exit'); else pass('quote_one_sided');

    const spreadPct = spreadPctOf(c);
    const dte = resolveDte(c, a.now);
    const is0dte = dte === 0;
    const etMins = a.et?.mins;
    const spreadResolved = resolveSpreadCaps(cfg, etMins, { feed, is0dte });
    const spreadCap = spreadResolved.cap;
    const openTag = spreadResolved.open ? `, open×${spreadResolved.mult}` : '';
    if (spreadPct == null) fail('spread_unknown', 'cannot compute spread');
    else if (spreadPct > spreadCap) fail('spread_too_wide', `${spreadPct.toFixed(1)}% > ${spreadCap.toFixed(1)}% cap (feed=${feed}${is0dte ? ', 0DTE' : ''}${openTag})`);
    else pass('spread_too_wide', `${spreadPct.toFixed(1)}% ≤ ${spreadCap.toFixed(1)}%${openTag}`);

    // ── DTE policy ──────────────────────────────────────────────────────────
    if (dte == null) fail('dte_known', 'contract has no dte');
    else if (is0dte && !cfg.allow0dte) fail('dte_policy', '0DTE disabled (set options.allow0dte=true to opt in)');
    else if (!is0dte && dte < n(cfg.minDte, 1)) fail('dte_policy', `dte ${dte} < min ${cfg.minDte}`);
    else if (dte > n(cfg.maxDte, 14)) fail('dte_policy', `dte ${dte} > max ${cfg.maxDte}`);
    else pass('dte_policy', `dte ${dte}${is0dte ? ' (0DTE opt-in)' : ''}`);

    // ── premium band at ASK (what we actually pay) ──────────────────────────
    if (!a.trustPoolGate) {
      if (ask > 0) {
        if (ask < n(cfg.minPremium, DEFAULTS.minPremium)) fail('premium_band', `ask $${ask} < min $${cfg.minPremium}`);
        else if (ask > n(cfg.maxPremium, DEFAULTS.maxPremium)) fail('premium_band', `ask $${ask} > max $${cfg.maxPremium}`);
        else pass('premium_band', `ask $${ask}`);
      }

      // ── IV band (when greeks exist) ────────────────────────────────────────
      const iv = Number(c.iv);
      if (Number.isFinite(iv)) {
        const ivBand = resolveEntryIvBand(cfg, etMins);
        const minIv = n(ivBand.minIv, DEFAULTS.minIv);
        const openIvTag = ivBand.open ? ' (open)' : '';
        if (iv < minIv) fail('iv_floor', `IV ${(iv * 100).toFixed(0)}% < ${(minIv * 100).toFixed(0)}%${openIvTag}`);
        else if (ivBand.maxIv != null && iv > ivBand.maxIv) fail('iv_ceiling', `IV ${(iv * 100).toFixed(0)}% > ${(ivBand.maxIv * 100).toFixed(0)}%${openIvTag}`);
        else pass('iv_floor', `IV ${(iv * 100).toFixed(0)}%${openIvTag}`);
      }

      // ── delta floor (when greeks exist) ────────────────────────────────────
      const delta = Number.isFinite(Number(c.delta)) ? Math.abs(Number(c.delta)) : null;
      if (delta != null) {
        if (delta < n(cfg.minDelta, DEFAULTS.minDelta)) fail('delta_floor', `|Δ| ${delta.toFixed(2)} < ${cfg.minDelta}`);
        else pass('delta_floor', `|Δ| ${delta.toFixed(2)}`);
      }
    } else {
      pass('pool_gate_trusted', 'IV/premium validated at pool attach');
    }

    // ── worst-case notional at ask ──────────────────────────────────────────
    let maxQty = Infinity;
    if (ask > 0) {
      const perCap = Math.abs(n(cfg.maxPremiumUsd, DEFAULTS.maxPremiumUsd));
      maxQty = Math.max(0, Math.floor(perCap / (ask * 100)));
      const open = n(ctx.openPremiumUsd);
      const openCap = Math.abs(n(cfg.maxOpenPremiumUsd, DEFAULTS.maxOpenPremiumUsd));
      const roomQty = Math.max(0, Math.floor((openCap - open) / (ask * 100)));
      maxQty = Math.min(maxQty, roomQty);
      if (maxQty < 1) fail('notional_cap', `open $${Math.round(open)} of $${openCap}, position cap $${perCap} @ ask $${ask}`);
      else pass('notional_cap', `maxQty ${maxQty} @ ask $${ask}`);
    } else {
      maxQty = 0;
    }
    if (is0dte && Number.isFinite(maxQty)) maxQty = Math.floor(maxQty * n(cfg.zeroDteSizeMult, 0.5));

    const firstFail = checks.find((x) => !x.ok);
    const verdict = {
      ok: !firstFail,
      reason: firstFail ? firstFail.id : 'ok',
      detail: firstFail ? firstFail.detail : 'all checks passed',
      symbol,
      checks,
      maxQty: Number.isFinite(maxQty) ? Math.max(0, maxQty) : 0,
      spreadPct: spreadPct != null ? Math.round(spreadPct * 10) / 10 : null,
      feed,
      dte,
    };
    this._record(verdict);
    return verdict;
  }

  /**
   * Chase guard — called on every re-peg of a working buy. Returns
   * { ok:true, limitPx } to continue the chase, or { ok:false, reason } to
   * cancel + cool down instead of walking into a toxic book.
   */
  evaluateChase({ symbol, quote, proposedPeg, proposedPx, et } = {}) {
    const cfg = this.cfg;
    const spreadPct = spreadPctOf(quote);
    const mult = openSpreadMult(cfg, et?.mins);
    const cap = n(cfg.chaseMaxSpreadPct, DEFAULTS.chaseMaxSpreadPct) * mult;
    if (spreadPct != null && spreadPct > cap) {
      return { ok: false, reason: 'chase_book_widened', spreadPct: Math.round(spreadPct * 10) / 10, cap };
    }
    const ask = n(quote?.ask), mid = n(quote?.mid);
    let px = n(proposedPx);
    if (ask > 0 && px > ask) px = ask; // never cross above the ask
    if (mid > 0 && px > mid * (1 + n(cfg.maxChaseAboveMidPct, DEFAULTS.maxChaseAboveMidPct) / 100)) {
      return { ok: false, reason: 'chase_above_mid_cap', px, mid, capPct: cfg.maxChaseAboveMidPct };
    }
    if (!(px > 0)) return { ok: false, reason: 'chase_no_price' };
    return { ok: true, limitPx: Math.round(px * 100) / 100, spreadPct: spreadPct != null ? Math.round(spreadPct * 10) / 10 : null };
  }

  getState() {
    const now = Date.now();
    return {
      feed: this.feed,
      cfg: this.cfg,
      cooldowns: [...this.cooldowns.entries()]
        .map(([symbol, until]) => ({ symbol, leftSec: Math.max(0, Math.ceil((until - now) / 1000)) }))
        .filter((x) => x.leftSec > 0),
      vetoes: [...this.vetoedSymbols.entries()]
        .map(([symbol, v]) => ({ symbol, leftSec: Math.max(0, Math.ceil((v.until - now) / 1000)), reason: v.reason }))
        .filter((x) => x.leftSec > 0),
      entriesToday: Object.fromEntries(this.entriesToday),
      recent: this.recent.slice(0, 25),
    };
  }
}

module.exports = RiskGate;
module.exports.DEFAULTS = DEFAULTS;
module.exports.resolveDte = resolveDte;
module.exports.dteFromExpiry = dteFromExpiry;

// Map the persisted options config onto gate knobs (sanitized values only).
module.exports.configFromOptions = function configFromOptions(cfg = {}) {
  const pick = (k) => (cfg[k] != null ? cfg[k] : undefined);
  const out = {};
  for (const k of [
    'maxSpreadPct', 'indicativeMaxSpreadPct', 'zeroDteMaxSpreadPct', 'zeroDteSizeMult',
    'openStartEt', 'openEndEt', 'openSpreadMult',
    'minPremium', 'maxPremium', 'minIv', 'maxIv', 'openMinIv', 'openMaxIv',
    'poolMinIv', 'poolMaxIv', 'openPoolMinIv', 'openPoolMaxIv',
    'minDelta', 'minDte', 'maxDte',
    'maxPremiumUsd', 'maxOpenPremiumUsd', 'dailyMaxLossUsd', 'maxConcurrent',
    'maxEntriesPerSymbolPerDay', 'symbolCooldownSec', 'chaseMaxSpreadPct', 'maxChaseAboveMidPct',
  ]) {
    const v = pick(k);
    if (v != null && Number.isFinite(Number(v))) out[k] = Number(v);
  }
  if (cfg.allow0dte != null) out.allow0dte = Boolean(cfg.allow0dte);
  if (String(cfg.dteMode || '').toLowerCase() === '0dte' && cfg.allow0dte == null) out.allow0dte = true;
  if (cfg.openStartEt != null) out.openStartEt = String(cfg.openStartEt);
  if (cfg.openEndEt != null) out.openEndEt = String(cfg.openEndEt);
  return out;
};
