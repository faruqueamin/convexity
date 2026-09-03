'use strict';

/**
 * Time-of-day open window — wider spread caps and IV band at the bell.
 * Used by RiskGate at order time.
 */

function parseHHMM(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minsInWindow(mins, start, end) {
  if (start == null || end == null || !Number.isFinite(mins)) return false;
  if (start <= end) return mins >= start && mins < end;
  return mins >= start || mins < end;
}

function isOpenWindow(etMins, cfg = {}) {
  const start = parseHHMM(cfg.openStartEt) ?? (9 * 60 + 30);
  const end = parseHHMM(cfg.openEndEt) ?? (9 * 60 + 45);
  return minsInWindow(etMins, start, end);
}

function openSpreadMult(cfg = {}, etMins) {
  if (!isOpenWindow(etMins, cfg)) return 1;
  const m = Number(cfg.openSpreadMult);
  return Number.isFinite(m) && m > 0 ? m : 2;
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

/**
 * Effective spread caps after open-window multiplier.
 * @returns {{ cap:number, maxSpreadPct:number, indicativeMaxSpreadPct:number, zeroDteMaxSpreadPct:number, open:boolean, mult:number }}
 */
function resolveSpreadCaps(cfg = {}, etMins, { feed = 'opra', is0dte = false } = {}) {
  const mult = openSpreadMult(cfg, etMins);
  const open = mult > 1;
  const maxSpread = n(cfg.maxSpreadPct, 20) * mult;
  const indicative = n(cfg.indicativeMaxSpreadPct, 15) * mult;
  const zeroDte = n(cfg.zeroDteMaxSpreadPct, 12) * mult;
  let cap = maxSpread;
  if (feed !== 'opra') cap = Math.min(cap, indicative);
  if (is0dte) cap = Math.min(cap, zeroDte);
  return {
    cap,
    maxSpreadPct: maxSpread,
    indicativeMaxSpreadPct: indicative,
    zeroDteMaxSpreadPct: zeroDte,
    open,
    mult,
  };
}

/**
 * IV band for entry risk gate.
 */
function resolveEntryIvBand(cfg = {}, etMins) {
  const open = isOpenWindow(etMins, cfg);
  const minIv = open ? n(cfg.openMinIv ?? cfg.minIv, 0.10) : n(cfg.minIv, 0.10);
  const maxRaw = open ? (cfg.openMaxIv ?? cfg.maxIv) : cfg.maxIv;
  const maxIv = maxRaw != null && Number.isFinite(Number(maxRaw)) && Number(maxRaw) > 0
    ? Number(maxRaw)
    : null;
  return { minIv, maxIv, open };
}

/**
 * IV band for pool admission (uses pool-specific floors/ceilings when set).
 */
function resolvePoolIvBand(cfg = {}, etMins) {
  const open = isOpenWindow(etMins, cfg);
  const baseMin = n(cfg.poolMinIv ?? cfg.minIv, 0.10);
  const baseMax = cfg.poolMaxIv ?? cfg.maxIv;
  const minIv = open ? n(cfg.openPoolMinIv ?? cfg.openMinIv ?? baseMin, baseMin) : baseMin;
  const maxRaw = open ? (cfg.openPoolMaxIv ?? cfg.openMaxIv ?? baseMax) : baseMax;
  const maxIv = maxRaw != null && Number.isFinite(Number(maxRaw)) && Number(maxRaw) > 0
    ? Number(maxRaw)
    : null;
  return { minIv, maxIv, open };
}

/** RTH VECTOR-only pool window — all watchlist slots options during the bell. */
function isVectorFocusWindow(etMins, cfg = {}) {
  if (cfg.vectorFocusOn === false) return false;
  const start = parseHHMM(cfg.vectorFocusStartEt) ?? (9 * 60 + 30);
  const end = parseHHMM(cfg.vectorFocusEndEt) ?? (9 * 60 + 45);
  return minsInWindow(etMins, start, end);
}

module.exports = {
  parseHHMM,
  minsInWindow,
  isOpenWindow,
  isVectorFocusWindow,
  openSpreadMult,
  resolveSpreadCaps,
  resolveEntryIvBand,
  resolvePoolIvBand,
};
