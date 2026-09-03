'use strict';

const fs = require('fs');
const path = require('path');

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$|^[0-9]+[A-Za-z_][A-Za-z0-9_]*$/;
const SKIP_FIELDS = new Set(['symbol', 'trade_date', 'loaded_at']);
const OPS = new Set(['gte', 'lte', 'eq', 'neq', 'between', 'in']);
const SESSION_VOL_FIELDS = new Set([
  'avg_1m_vol_overnight',
  'avg_1m_vol_premarket',
  'avg_1m_vol_market',
  'avg_1m_vol_post',
]);
const SESSION_1M_FIELD = 'session_1m_avg';
const VIRTUAL_FIELDS = new Set([SESSION_1M_FIELD]);
const PLAY_MODES = new Set(['vol10s', 'green2_1m', 'green_run']);
const ENTRY_VOL_VS = new Set(['hist', 'sess']);
const PLAY_TFS = ['10s', '30s', '1m', '5m', '15m'];
const ENTRY_RULES = new Set(['coil_break', 'green_run']);
const EXIT_RULES = new Set(['thick', 'vol_death', 'red_run']);
const RTH_PLAY_IDS = new Set(['am', 'market', 'post']);
const TF_SPEC = {
  '10s': { tf: '10s', view: 'market_data.polygon_aggregates_10s_view', sec: 10 },
  '30s': { tf: '30s', view: 'market_data.polygon_aggregates_30s_view', sec: 30 },
  '1m': { tf: '1m', view: 'market_data.polygon_aggregates_1m_view', sec: 60 },
  '5m': { tf: '5m', view: 'market_data.polygon_aggregates_5m_view', sec: 300 },
  '15m': { tf: '15m', view: 'market_data.polygon_aggregates_15m_view', sec: 900 },
};

function normalizeTf(v, fallback = '10s') {
  const t = String(v || '').toLowerCase();
  return PLAY_TFS.includes(t) ? t : fallback;
}

function tfMeta(tf, fallback = '10s') {
  return TF_SPEC[normalizeTf(tf, fallback)] || TF_SPEC[fallback] || TF_SPEC['10s'];
}

function normalizePlayMode(s = {}) {
  const raw = String(s.playMode || '').toLowerCase();
  if (raw === 'green_run' || raw === 'green2_1m') return 'green2_1m';
  if (raw === 'vol10s') return 'vol10s';
  if (String(s.entryRule || '').toLowerCase() === 'green_run') return 'green2_1m';
  return s.id === 'overnight' ? 'green2_1m' : 'vol10s';
}

function normalizeEntryRule(s = {}) {
  const r = String(s.entryRule || '').toLowerCase();
  if (ENTRY_RULES.has(r)) return r;
  return normalizePlayMode(s) === 'green2_1m' ? 'green_run' : 'coil_break';
}

function isRthPlay(id) {
  return RTH_PLAY_IDS.has(String(id || ''));
}

/** Public desk names. Internal recipe stays off the glass. */
function publicPlayName(sess) {
  const id = String(sess?.id || sess || '');
  if (id === 'market') return 'VECTOR';
  if (id === 'am' || id === 'post') return 'PULSE';
  return null;
}

function clampCount(v, lo, hi, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** Live name joins SIP + ATM call OCC + ATM put OCC. Default on. flipOpraDualLeg is a legacy alias. */
function resolveOpraDualLeg(raw = {}) {
  if (raw.opraDualLeg != null) return raw.opraDualLeg !== false;
  if (raw.flipOpraDualLeg != null) return raw.flipOpraDualLeg !== false;
  return true;
}

function opraDualLegOn(cfg = {}) {
  return resolveOpraDualLeg(cfg);
}

/** Child bars inside a 1m setup that must each beat unscaled 1m avg.
 *  Market options (VECTOR): confirmTf/confirmBars (2×30s).
 *  Market equity + all pre/post (PULSE): equityConfirmTf/Bars (6×10s). */
function confirmSpec(play, lane = null) {
  const market = String(play?.sessionId || play?.id || '') === 'market';
  const optionsLane = market && lane !== 'equity';
  const useEquity = !optionsLane;
  const tfFallback = useEquity ? '10s' : '30s';
  const tf = normalizeTf(useEquity ? (play?.equityConfirmTf || '10s') : play?.confirmTf, tfFallback);
  const meta = tfMeta(tf, tfFallback);
  const fallbackNeed = tf === '10s' ? 6 : (meta.sec >= 30 ? Math.max(1, Math.floor(60 / meta.sec)) : 6);
  const bars = useEquity ? play?.equityConfirmBars : play?.confirmBars;
  const needRaw = bars == null || bars === '' ? null : Math.floor(Number(bars));
  const need = Number.isFinite(needRaw) ? Math.max(1, Math.min(12, needRaw)) : fallbackNeed;
  return {
    tf: meta.tf,
    view: meta.view,
    sec: meta.sec,
    need,
    lane: useEquity ? 'equity' : 'options',
  };
}

function normalizeExitRule(s = {}) {
  const r = String(s.exitRule || '').toLowerCase();
  if (EXIT_RULES.has(r)) return r;
  if (normalizeEntryRule(s) === 'green_run') {
    return isRthPlay(s.id) ? 'red_run' : 'vol_death';
  }
  return 'thick';
}

function isGreen2Play(playOrSess = {}) {
  return normalizeEntryRule(playOrSess) === 'green_run';
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function formatHHMM(mins) {
  if (mins == null || !Number.isFinite(mins)) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

function clampRollover(v, fallback = 0.7) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.2, Math.min(0.95, n));
}

function clampLoc(v, fallback = 0.4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.1, Math.min(0.8, n));
}

function clampRefresh(v, fallback = 0.85) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.5, Math.min(0.99, n));
}

function defaultExitVol1mFade(id) {
  return id === 'am' || id === 'market' || id === 'post';
}

function normalizeSess1mFrom(s = {}) {
  const parsed = parseHHMM(s.sess1mFrom);
  if (parsed != null) return formatHHMM(parsed);
  return String(s.id || '') === 'market' ? '09:30' : null;
}

function sess1mFromTs(sess) {
  const bounds = sess?.bounds;
  if (!bounds?.startTs) return null;
  const fromMins = parseHHMM(sess.sess1mFrom);
  if (fromMins == null) return bounds.startTs;
  return `${bounds.startDate} ${formatHHMM(fromMins)}:00`;
}

function defaultFiltersFor(volFloorField, sessId) {
  const tag = sessId || 'sess';
  const vol = IDENT.test(volFloorField || '') ? volFloorField : 'avg_1m_vol_market';
  const sess1mVal = sessId === 'overnight' ? 5000 : (sessId === 'am' ? 25000 : (sessId === 'market' ? 10000 : ''));
  const pxMin = (sessId === 'am' || sessId === 'post') ? 1 : 5;
  return [
    { id: `f-sess1m-${tag}`, field: SESSION_1M_FIELD, op: 'gte', value: sess1mVal, enabled: true },
    { id: `f-px-${tag}`, field: 'last_close', op: 'between', min: pxMin, max: 500, enabled: true },
    { id: `f-maint-${tag}`, field: 'maint_margin_pct', op: 'gte', value: 30, enabled: true },
    { id: `f-vol-${tag}`, field: vol, op: 'gte', value: 10000, enabled: true },
    { id: `f-type-${tag}`, field: 'security_type', op: 'in', values: ['CS'], enabled: false },
  ];
}

function defaultFilters() {
  return defaultFiltersFor('avg_1m_vol_market', 'market');
}

function clampMult(v, fallback = 1) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0.1) return fallback;
  return Math.min(20, n);
}

function flag(v, fallback = false) {
  if (v == null || v === '') return fallback;
  return v === true || v === 'true' || v === 1 || v === '1';
}

function optNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function defaultSession({ id, label, start, end, enabled, volFloorField }) {
  const overnight = id === 'overnight';
  const rth = isRthPlay(id);
  const filters = defaultFiltersFor(volFloorField, id);
  if (overnight) {
    for (const f of filters) {
      if (f.field === SESSION_1M_FIELD) { f.op = 'gte'; f.value = 5000; }
      if (f.field === volFloorField) { f.op = 'gte'; f.value = 5000; }
    }
    if (!filters.some((f) => f.field === 'overnight_allowed')) {
      filters.push({ id: `f-on-allow-${id}`, field: 'overnight_allowed', op: 'eq', value: 1, enabled: true });
    }
  }
  if (id === 'am' || id === 'market') {
    const sess1mFloor = id === 'market' ? 10000 : 25000;
    for (const f of filters) {
      if (f.field === SESSION_1M_FIELD) { f.op = 'gte'; f.value = sess1mFloor; }
    }
  }
  return {
    id,
    label,
    start,
    end,
    enabled,
    volFloorField,
    notional: overnight ? 5000 : 1500,
    maxConcurrent: overnight || id === 'market' ? 30 : 10,
    stampVolMult: 1,
    buyVolMult: 1,
    sellVolMult: 1,
    sellProfitOnly: false,
    stampGrOnly: !overnight,
    buyCloseAboveCoil: true,
    playMode: overnight || rth ? 'green2_1m' : 'vol10s',
    entryRule: overnight || rth ? 'green_run' : 'coil_break',
    exitRule: rth ? 'red_run' : (overnight ? 'vol_death' : 'thick'),
    entryTf: overnight || rth ? '1m' : '10s',
    requireNoClimax10s: false,
    climax10sMult: 1,
    requireAll10sAbove: !!rth,
    all10sMult: 1,
    confirmTf: '30s',
    confirmBars: 2,
    equityConfirmTf: id === 'market' ? '10s' : null,
    equityConfirmBars: id === 'market' ? 6 : null,
    coilFreeze: !!(overnight || rth),
    entryGreenCount: rth ? 1 : 2,
    entryVolMult: 1,
    entryVolVs: 'hist',
    exitTf: overnight || rth ? '5m' : '10s',
    exitTfScale: false,
    exitVolMult: 1,
    exitAllInside: false,
    exitParentTf: '1m',
    exitRedCount: 2,
    exitVolRollover: id === 'am' || id === 'market',
    exitVolRolloverMult: 0.7,
    exitVol1mFade: defaultExitVol1mFade(id),
    exitVol1mFadeMult: 0.7,
    exitVol1mFadeLoc: 0.4,
    exitVol1mRefresh: 0.85,
    exitFailFast10s: rth,
    exitFailFast10sCount: 3,
    exitProfitLock10s: rth,
    exitProfitLock10sMinPct: 5,
    ignitionOn: rth,
    ignHistMult: 8,
    ignAvgMult: 8,
    ignMaxMult: 2.5,
    ignOverrideMult: 12,
    ignMinSessBars: 5,
    ignLookbackMin: 15,
    ignFollowMin: 15,
    ignWiggleOn: true,
    ignWigglePeakMult: 2.5,
    ignWiggleHistMult: 4,
    sess1mMin: overnight ? 5000 : (id === 'am' ? 25000 : (id === 'market' ? 10000 : null)),
    sess1mMax: null,
    sess1mFrom: id === 'market' ? '09:30' : null,
    universeCap: overnight ? 4000 : 1500,
    filters,
  };
}

function defaultSessions() {
  return [
    defaultSession({ id: 'overnight', label: 'Overnight', start: '20:00', end: '04:00', enabled: true, volFloorField: 'avg_1m_vol_overnight' }),
    defaultSession({ id: 'am', label: 'Premarket', start: '04:00', end: '09:30', enabled: true, volFloorField: 'avg_1m_vol_premarket' }),
    defaultSession({ id: 'market', label: 'Regular', start: '09:30', end: '16:00', enabled: true, volFloorField: 'avg_1m_vol_market' }),
    defaultSession({ id: 'post', label: 'Post-market', start: '16:00', end: '20:00', enabled: true, volFloorField: 'avg_1m_vol_post' }),
  ];
}

function cloneFiltersForSession(filters, volFloorField) {
  const out = [];
  let hasSessVol = false;
  for (const f of filters || []) {
    if (!f || !f.field) continue;
    if (SESSION_VOL_FIELDS.has(f.field) && f.field !== volFloorField) continue;
    const copy = sanitizeFilter({ ...f, id: uid('f') }, new Set([f.field]));
    if (!copy) continue;
    if (copy.field === volFloorField) hasSessVol = true;
    out.push(copy);
  }
  if (!hasSessVol && IDENT.test(volFloorField || '')) {
    out.push({ id: uid('f'), field: volFloorField, op: 'gte', value: 10000, enabled: true });
  }
  return out.length ? out : defaultFiltersFor(volFloorField);
}

function sess1mBoundsFromFilters(filters) {
  let min = null;
  let max = null;
  for (const f of filters || []) {
    if (!f || f.field !== SESSION_1M_FIELD || f.enabled === false) continue;
    if (f.op === 'between') {
      const lo = optNum(f.min);
      const hi = optNum(f.max);
      if (lo != null) min = min == null ? lo : Math.max(min, lo);
      if (hi != null) max = max == null ? hi : Math.min(max, hi);
    } else if (f.op === 'gte' || f.op === 'eq') {
      const v = optNum(f.value);
      if (v != null) min = min == null ? v : Math.max(min, v);
    } else if (f.op === 'lte') {
      const v = optNum(f.value);
      if (v != null) max = max == null ? v : Math.min(max, v);
    }
  }
  if (min != null && max != null && min > max) {
    const tmp = min;
    min = max;
    max = tmp;
  }
  return { min, max };
}

function ensureSess1mFilter(filters, min, max) {
  const list = Array.isArray(filters) ? filters.filter((f) => f && f.field) : [];
  if (list.some((f) => f.field === SESSION_1M_FIELD)) return list;
  const row = {
    id: uid('f-sess1m'),
    field: SESSION_1M_FIELD,
    enabled: true,
  };
  if (min != null && max != null) {
    row.op = 'between';
    row.min = min;
    row.max = max;
  } else if (max != null && min == null) {
    row.op = 'lte';
    row.value = max;
  } else {
    row.op = 'gte';
    row.value = min != null ? min : '';
  }
  return [row, ...list];
}

function sessionPlay(sess, cfg = {}) {
  const s = sess || {};
  const buyVolMult = clampMult(s.buyVolMult ?? s.stampVolMult ?? cfg.buyVolMult ?? cfg.stampVolMult, 1);
  const sellVolMult = clampMult(s.sellVolMult ?? s.buyVolMult ?? s.stampVolMult ?? cfg.sellVolMult ?? cfg.stampVolMult, buyVolMult);
  const fromFilt = sess1mBoundsFromFilters(s.filters);
  let sess1mMin = fromFilt.min ?? optNum(s.sess1mMin ?? cfg.sess1mMin);
  let sess1mMax = fromFilt.max ?? optNum(s.sess1mMax ?? cfg.sess1mMax);
  if (sess1mMin != null && sess1mMax != null && sess1mMin > sess1mMax) {
    const tmp = sess1mMin;
    sess1mMin = sess1mMax;
    sess1mMax = tmp;
  }
  const playMode = normalizePlayMode(s);
  const entryRule = normalizeEntryRule(s);
  const exitRule = normalizeExitRule(s);
  const greenRun = entryRule === 'green_run';
  const entryVolVs = ENTRY_VOL_VS.has(String(s.entryVolVs || '').toLowerCase())
    ? String(s.entryVolVs).toLowerCase()
    : 'hist';
  const entryVolMult = clampMult(s.entryVolMult ?? s.buyVolMult ?? cfg.entryVolMult, 1);
  const exitVolMult = clampMult(s.exitVolMult ?? s.sellVolMult ?? cfg.exitVolMult, exitRule === 'thick' ? buyVolMult : 1);
  const rth = isRthPlay(s.id);
  const exitTfScale = s.exitTfScale == null
    ? (greenRun && exitRule === 'vol_death' && !rth)
    : (s.exitTfScale !== false && s.exitTfScale !== 'false' && s.exitTfScale !== 0);
  const buyCloseAboveCoil = s.buyCloseAboveCoil !== false;
  return {
    notional: Math.max(100, Number(s.notional ?? cfg.notional) || 1500),
    maxConcurrent: Math.max(1, Number(s.maxConcurrent ?? cfg.maxConcurrent) || 10),
    stampVolMult: entryVolMult,
    buyVolMult: entryVolMult,
    sellVolMult: exitVolMult,
    sellProfitOnly: s.sellProfitOnly === true || s.sellProfitOnly === 'true' || s.sellProfitOnly === 1,
    stampGrOnly: s.stampGrOnly !== false,
    buyCloseAboveCoil,
    playMode: greenRun ? 'green2_1m' : 'vol10s',
    entryRule,
    exitRule,
    entryTf: normalizeTf(s.entryTf, greenRun ? '1m' : '10s'),
    entryGreenCount: clampCount(s.entryGreenCount, 1, 5, rth ? 1 : 2),
    entryVolMult,
    entryVolVs,
    requireNoClimax10s: flag(s.requireNoClimax10s, false),
    climax10sMult: clampMult(s.climax10sMult, 1),
    requireAll10sAbove: flag(s.requireAll10sAbove, rth && greenRun),
    all10sMult: clampMult(s.all10sMult ?? s.climax10sMult, 1),
    confirmTf: normalizeTf(s.confirmTf, '30s'),
    confirmBars: clampCount(s.confirmBars, 1, 12, normalizeTf(s.confirmTf, '30s') === '10s' ? 6 : 2),
    sessionId: String(s.id || ''),
    equityConfirmTf: String(s.id) === 'market' ? normalizeTf(s.equityConfirmTf, '10s') : null,
    equityConfirmBars: String(s.id) === 'market' ? clampCount(s.equityConfirmBars, 1, 12, 6) : null,
    coilFreeze: flag(s.coilFreeze, greenRun && buyCloseAboveCoil),
    exitTf: normalizeTf(s.exitTf, greenRun ? '5m' : '10s'),
    exitTfScale,
    exitVolMult,
    exitAllInside: flag(s.exitAllInside, false),
    exitParentTf: normalizeTf(s.exitParentTf, '1m'),
    exitRedCount: clampCount(s.exitRedCount, 1, 5, 2),
    exitVolRollover: flag(s.exitVolRollover, s.id === 'am' || s.id === 'market'),
    exitVolRolloverMult: clampRollover(s.exitVolRolloverMult, 0.7),
    exitVol1mFade: flag(s.exitVol1mFade, defaultExitVol1mFade(s.id)),
    exitVol1mFadeMult: clampRollover(s.exitVol1mFadeMult, 0.7),
    exitVol1mFadeLoc: clampLoc(s.exitVol1mFadeLoc, 0.4),
    exitVol1mRefresh: clampRefresh(s.exitVol1mRefresh, 0.85),
    exitFailFast10s: flag(s.exitFailFast10s, rth),
    exitFailFast10sCount: clampCount(s.exitFailFast10sCount, 1, 10, 3),
    exitProfitLock10s: flag(s.exitProfitLock10s, rth),
    exitProfitLock10sMinPct: clampCount(s.exitProfitLock10sMinPct, 1, 50, 5),
    ignitionOn: flag(s.ignitionOn, rth),
    ignHistMult: clampMult(s.ignHistMult, 8),
    ignAvgMult: clampMult(s.ignAvgMult, 8),
    ignMaxMult: clampMult(s.ignMaxMult, 2.5),
    ignOverrideMult: clampMult(s.ignOverrideMult, 12),
    ignMinSessBars: clampCount(s.ignMinSessBars, 1, 30, 5),
    ignLookbackMin: clampCount(s.ignLookbackMin, 5, 60, 15),
    ignFollowMin: clampCount(s.ignFollowMin, 1, 60, 15),
    ignWiggleOn: flag(s.ignWiggleOn, true),
    ignWigglePeakMult: clampMult(s.ignWigglePeakMult, 2.5),
    ignWiggleHistMult: clampMult(s.ignWiggleHistMult, 4),
    sess1mMin,
    sess1mMax,
    sess1mFrom: normalizeSess1mFrom(s),
    universeCap: Math.min(4000, Math.max(50, Number(s.universeCap ?? cfg.universeCap) || 1500)),
    filters: Array.isArray(s.filters) ? s.filters : (cfg.filters || []),
    volFloorField: IDENT.test(s.volFloorField || '') ? s.volFloorField : 'avg_1m_vol_market',
  };
}

function defaultOptions() {
  return {
    enabled: false,
    armed: false,
    entriesPaused: false,
    entryStartEt: '09:35',
    entryEndEt: '16:00',
    flattenEt: '15:59',
    maxConcurrent: 8,
    contracts: 5,
    boostContracts: 5,
    boostMinMult: 2.0,
    maxPositionNotional: 5000,
    maxPremiumUsd: 5000,
    maxOpenPremiumUsd: 30000,
    dailyMaxLossUsd: 2000,
    dteMode: '0dte',
    itmStrikes: 1,
    minDte: 0,
    maxDte: 45,
    minDelta: 0.40,
    minPremium: 0.50,
    minIv: 0.10,
    maxIv: 2.0,
    openStartEt: '09:30',
    openEndEt: '09:45',
    openSpreadMult: 2,
    openMinIv: 0.10,
    openMaxIv: 3.0,
    poolMinPremium: 0.50,
    poolMinIv: 0.10,
    poolMaxIv: 2.5,
    maxPremium: 25,
    maxSpreadPct: 20,
    allow0dte: true,
    indicativeMaxSpreadPct: 15,
    zeroDteMaxSpreadPct: 12,
    zeroDteSizeMult: 0.5,
    maxEntriesPerSymbolPerDay: 3,
    symbolCooldownSec: 120,
    chaseMaxSpreadPct: 30,
    maxChaseAboveMidPct: 35,
    cancelAfterSec: 20,
    buyChaseSec: 10,
    sellChaseSec: 10,
    walkMs: 10000,
    maxChaseSteps: 0,
    sellCancelAfterSec: 25,
    candidateCooldownSec: 300,
    oneWorkingPerUnderlying: true,
    cancelOpenBuysBeforeEntry: false,
    equityCancelOpenBuysBeforeEntry: true,
    entryBidWalkEnabled: false,
    vectorPoolEntry: true,
    poolStreamReGate: false,
    walkCent: 0.01,
    equityWalkRungMs: 2000,
    equityWalkAllowAsk: true,
    bidWalkCeilingMode: 'bid_slip',
    equityBidWalkCeilingMode: 'mid',
    bidWalkMaxSlipPct: 8,
    bidWalkMaxCents: 0.05,
    replaceMinMs: 1500,
    entryFillTimeoutSec: 10,
    entryMaxReplaceAttempts: 2,
    entryLiveQuoteWaitMs: 6000,
    entryBidConfirmEnabled: false,
    entryBidConfirmMs: 12000,
    entryBidMinMoveCents: 0.01,
    entryBidMinDistinct: 2,
    entryBidRequireLive: true,
    chunkQty: 100,
    dcaLayers: 1,
    dcaSkipPnlPct: 0.40,
    holdWhileStrong: true,
    lockArmUsd: 200,
    lockTightenDayPnlUsd: 4000,
    catastrophePct: 0.35,
    catastropheEnabled: false,
    instantProfitEnabled: false,
    instantProfitPct: 0.25,
    minHoldSec: 15,
    lockArmPct: 0.15,
    givebackPct: 0.30,
    lossStopPct: 0.35,
    bidStopEnabled: false,
    lossMinHoldSec: 20,
    exitProfitOnly: false,
    lossCutAfterEt: '09:45',
    earlyLossCutEnabled: true,
    ivCrushPct: 0.35,
    ivCrushEnabled: false,
    volDeathExitEnabled: false,
    sessionFlattenEnabled: false,
    buyPeg: 'ask',
    sellPeg: 'mid',
    fastExitsEnabled: true,
    exitProfitLock10s: false,
    exitProfitLock10sMinPct: 20,
    askProfitExitEnabled: false,
    askProfitExitMinPct: 10,
    askProfitExitBidStalePct: 5,
    exitPollMs: 3000,
    cliSyncMs: 60000,
  };
}

function defaultAgent() {
  return {
    enabled: true,
    trade_enabled: false,
    model: 'llama3.1',
    supervisor_enabled: false,
    supervisor_interval_min: 5,
    supervisor_auto: false,
  };
}

function sanitizeAgent(raw = {}) {
  const d = defaultAgent();
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: flag(r.enabled, d.enabled),
    trade_enabled: flag(r.trade_enabled, d.trade_enabled),
    model: String(r.model || d.model).trim().slice(0, 80) || d.model,
    supervisor_enabled: flag(r.supervisor_enabled, d.supervisor_enabled),
    supervisor_interval_min: clampCount(r.supervisor_interval_min, 1, 120, d.supervisor_interval_min),
    supervisor_auto: flag(r.supervisor_auto, d.supervisor_auto),
  };
}

function clampPct(v, fallback, lo = 0.001, hi = 5) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function clampUsd(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(1000000, n);
}

function hhmmOr(v, fallback) {
  const mins = parseHHMM(v);
  return mins == null ? fallback : formatHHMM(mins);
}

function sanitizeOptions(raw = {}) {
  const d = defaultOptions();
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: flag(r.enabled, d.enabled),
    armed: flag(r.armed, d.armed),
    entriesPaused: flag(r.entriesPaused, d.entriesPaused),
    entryStartEt: hhmmOr(r.entryStartEt, d.entryStartEt),
    entryEndEt: hhmmOr(r.entryEndEt, d.entryEndEt),
    flattenEt: hhmmOr(r.flattenEt, d.flattenEt),
    maxConcurrent: clampCount(r.maxConcurrent, 1, 50, d.maxConcurrent),
    contracts: clampCount(r.contracts, 1, 500, d.contracts),
    boostContracts: clampCount(r.boostContracts, 1, 500, d.boostContracts),
    boostMinMult: clampMult(r.boostMinMult, d.boostMinMult),
    maxPositionNotional: clampUsd(r.maxPositionNotional, d.maxPositionNotional),
    maxPremiumUsd: clampUsd(r.maxPremiumUsd, d.maxPremiumUsd),
    maxOpenPremiumUsd: clampUsd(r.maxOpenPremiumUsd, d.maxOpenPremiumUsd),
    dailyMaxLossUsd: clampUsd(r.dailyMaxLossUsd, d.dailyMaxLossUsd),
    dteMode: String(r.dteMode || d.dteMode).toLowerCase() === 'weekly' ? 'weekly' : '0dte',
    itmStrikes: clampCount(r.itmStrikes, 1, 5, d.itmStrikes),
    maxDte: clampCount(r.maxDte, 0, 120, d.maxDte),
    minDelta: clampPct(r.minDelta, d.minDelta, 0.05, 1),
    minPremium: clampUsd(r.minPremium, d.minPremium),
    minIv: clampPct(r.minIv ?? r.poolMinIv, d.minIv, 0.05, 5),
    maxIv: clampPct(r.maxIv, d.maxIv, 0.10, 10),
    openStartEt: hhmmOr(r.openStartEt, d.openStartEt),
    openEndEt: hhmmOr(r.openEndEt, d.openEndEt),
    openSpreadMult: clampPct(r.openSpreadMult, d.openSpreadMult, 1, 5),
    openMinIv: clampPct(r.openMinIv ?? r.minIv, d.openMinIv, 0.05, 5),
    openMaxIv: clampPct(r.openMaxIv ?? r.maxIv, d.openMaxIv, 0.10, 10),
    poolMinPremium: clampUsd(r.poolMinPremium ?? r.minPremium, d.poolMinPremium),
    poolMinIv: clampPct(r.poolMinIv ?? r.minIv, d.poolMinIv, 0.05, 5),
    poolMaxIv: clampPct(r.poolMaxIv ?? r.maxIv, d.poolMaxIv, 0.10, 10),
    maxPremium: clampUsd(r.maxPremium, d.maxPremium),
    maxSpreadPct: clampPct(r.maxSpreadPct, d.maxSpreadPct, 1, 100),
    cancelAfterSec: clampCount(r.cancelAfterSec, 2, 600, d.cancelAfterSec),
    buyChaseSec: clampCount(r.buyChaseSec, 2, 120, d.buyChaseSec),
    sellChaseSec: clampCount(r.sellChaseSec, 2, 300, d.sellChaseSec),
    walkMs: Math.max(500, Math.min(60000, Number(r.walkMs) || ((Number(r.buyChaseSec) > 0 ? Number(r.buyChaseSec) * 1000 : 0) || d.walkMs))),
    entryLiveQuoteWaitMs: Math.max(500, Math.min(30000, Number(r.entryLiveQuoteWaitMs) || d.entryLiveQuoteWaitMs)),
    entryBidConfirmEnabled: flag(r.entryBidConfirmEnabled, d.entryBidConfirmEnabled),
    entryBidConfirmMs: Math.max(3000, Math.min(30000, Number(r.entryBidConfirmMs) || d.entryBidConfirmMs)),
    entryBidMinMoveCents: Math.max(0.01, Math.min(0.50, Number(r.entryBidMinMoveCents) > 0 ? Number(r.entryBidMinMoveCents) : d.entryBidMinMoveCents)),
    entryBidMinDistinct: clampCount(r.entryBidMinDistinct, 1, 8, d.entryBidMinDistinct),
    entryBidRequireLive: flag(r.entryBidRequireLive, d.entryBidRequireLive),
    maxChaseSteps: clampCount(r.maxChaseSteps, 0, 8, d.maxChaseSteps),
    vectorPoolEntry: flag(r.vectorPoolEntry, d.vectorPoolEntry),
    poolStreamReGate: flag(r.poolStreamReGate, d.poolStreamReGate),
    sellCancelAfterSec: clampCount(r.sellCancelAfterSec ?? r.sellChaseSec, 2, 300, d.sellCancelAfterSec),
    candidateCooldownSec: clampCount(r.candidateCooldownSec, 0, 3600, d.candidateCooldownSec),
    oneWorkingPerUnderlying: flag(r.oneWorkingPerUnderlying, d.oneWorkingPerUnderlying),
    cancelOpenBuysBeforeEntry: flag(r.cancelOpenBuysBeforeEntry, d.cancelOpenBuysBeforeEntry),
    equityCancelOpenBuysBeforeEntry: flag(r.equityCancelOpenBuysBeforeEntry, d.equityCancelOpenBuysBeforeEntry),
    entryBidWalkEnabled: flag(r.entryBidWalkEnabled, d.entryBidWalkEnabled),
    walkCent: Math.max(0.01, Math.min(0.25, Number(r.walkCent) > 0 ? Number(r.walkCent) : d.walkCent)),
    equityWalkRungMs: Math.max(500, Math.min(30000, Number(r.equityWalkRungMs) > 0 ? Number(r.equityWalkRungMs) : d.equityWalkRungMs)),
    equityWalkAllowAsk: flag(r.equityWalkAllowAsk, d.equityWalkAllowAsk),
    bidWalkCeilingMode: String(r.bidWalkCeilingMode || d.bidWalkCeilingMode).toLowerCase() === 'mid' ? 'mid' : 'bid_slip',
    equityBidWalkCeilingMode: String(r.equityBidWalkCeilingMode || d.equityBidWalkCeilingMode).toLowerCase() === 'bid_slip' ? 'bid_slip' : 'mid',
    bidWalkMaxSlipPct: clampPct(r.bidWalkMaxSlipPct, d.bidWalkMaxSlipPct, 0.5, 50),
    bidWalkMaxCents: Math.max(0.01, Math.min(1, Number(r.bidWalkMaxCents) > 0 ? Number(r.bidWalkMaxCents) : d.bidWalkMaxCents)),
    replaceMinMs: Math.max(250, Math.min(15000, Number(r.replaceMinMs) > 0 ? Number(r.replaceMinMs) : d.replaceMinMs)),
    entryFillTimeoutSec: clampCount(r.entryFillTimeoutSec, 3, 120, d.entryFillTimeoutSec),
    entryMaxReplaceAttempts: clampCount(r.entryMaxReplaceAttempts, 0, 5, d.entryMaxReplaceAttempts),
    chunkQty: clampCount(r.chunkQty, 1, 200, d.chunkQty),
    dcaLayers: clampCount(r.dcaLayers, 1, 8, d.dcaLayers),
    dcaSkipPnlPct: clampPct(r.dcaSkipPnlPct, d.dcaSkipPnlPct, 0.05, 2),
    allow0dte: flag(r.allow0dte, d.allow0dte),
    minDte: clampCount(r.minDte, 0, 60, d.minDte),
    indicativeMaxSpreadPct: clampPct(r.indicativeMaxSpreadPct, d.indicativeMaxSpreadPct, 1, 100),
    zeroDteMaxSpreadPct: clampPct(r.zeroDteMaxSpreadPct, d.zeroDteMaxSpreadPct, 1, 100),
    zeroDteSizeMult: clampPct(r.zeroDteSizeMult, d.zeroDteSizeMult, 0.05, 1),
    maxEntriesPerSymbolPerDay: clampCount(r.maxEntriesPerSymbolPerDay, 1, 50, d.maxEntriesPerSymbolPerDay),
    symbolCooldownSec: clampCount(r.symbolCooldownSec, 0, 3600, d.symbolCooldownSec),
    chaseMaxSpreadPct: clampPct(r.chaseMaxSpreadPct, d.chaseMaxSpreadPct, 1, 200),
    maxChaseAboveMidPct: clampPct(r.maxChaseAboveMidPct, d.maxChaseAboveMidPct, 1, 200),
    holdWhileStrong: flag(r.holdWhileStrong, d.holdWhileStrong),
    lockArmUsd: clampUsd(r.lockArmUsd, d.lockArmUsd),
    lockTightenDayPnlUsd: clampUsd(r.lockTightenDayPnlUsd, d.lockTightenDayPnlUsd),
    catastrophePct: clampPct(r.catastrophePct, d.catastrophePct, 0.05, 0.95),
    catastropheEnabled: flag(r.catastropheEnabled, d.catastropheEnabled),
    instantProfitEnabled: flag(r.instantProfitEnabled, d.instantProfitEnabled),
    instantProfitPct: clampPct(r.instantProfitPct, d.instantProfitPct, 0.001, 5),
    minHoldSec: clampCount(r.minHoldSec, 0, 600, d.minHoldSec),
    lockArmPct: clampPct(r.lockArmPct, d.lockArmPct, 0.01, 5),
    givebackPct: clampPct(r.givebackPct, d.givebackPct, 0.05, 0.95),
    lossStopPct: clampPct(r.lossStopPct, d.lossStopPct, 0.01, 0.95),
    bidStopEnabled: flag(r.bidStopEnabled, d.bidStopEnabled),
    lossMinHoldSec: clampCount(r.lossMinHoldSec, 0, 3600, d.lossMinHoldSec),
    exitProfitOnly: flag(r.exitProfitOnly, d.exitProfitOnly),
    lossCutAfterEt: hhmmOr(r.lossCutAfterEt, d.lossCutAfterEt),
    earlyLossCutEnabled: flag(r.earlyLossCutEnabled, d.earlyLossCutEnabled),
    ivCrushPct: clampPct(r.ivCrushPct, d.ivCrushPct, 0.05, 0.95),
    ivCrushEnabled: flag(r.ivCrushEnabled, d.ivCrushEnabled),
    volDeathExitEnabled: flag(r.volDeathExitEnabled, d.volDeathExitEnabled),
    sessionFlattenEnabled: flag(r.sessionFlattenEnabled, d.sessionFlattenEnabled),
    buyPeg: ['bid', 'mid', 'ask'].includes(String(r.buyPeg || '')) ? String(r.buyPeg) : d.buyPeg,
    sellPeg: ['bid', 'mid', 'ask'].includes(String(r.sellPeg || '')) ? String(r.sellPeg) : d.sellPeg,
    fastExitsEnabled: flag(r.fastExitsEnabled, d.fastExitsEnabled),
    exitProfitLock10s: flag(r.exitProfitLock10s, d.exitProfitLock10s),
    exitProfitLock10sMinPct: clampCount(r.exitProfitLock10sMinPct, 1, 200, d.exitProfitLock10sMinPct),
    askProfitExitEnabled: flag(r.askProfitExitEnabled, d.askProfitExitEnabled),
    askProfitExitMinPct: clampCount(r.askProfitExitMinPct, 1, 200, d.askProfitExitMinPct),
    askProfitExitBidStalePct: clampCount(r.askProfitExitBidStalePct, 0, 100, d.askProfitExitBidStalePct),
    exitPollMs: Math.max(1000, Math.min(60000, Number(r.exitPollMs) || d.exitPollMs)),
    cliSyncMs: Math.max(15000, Math.min(3600000, Number(r.cliSyncMs) || d.cliSyncMs)),
  };
}

function defaultConfig() {
  return {
    version: 5,
    notional: 1500,
    maxConcurrent: 10,
    pollMs: 3000,
    stampVolMult: 1,
    flattenOnSessionEnd: true,
    universeCap: 1500,
    candidateCooldownSec: 300,
    poolMax: 20,
    poolLaneMax: 10,
    poolIdleSec: 300,
    poolHoldSec: 300,
    poolVol1mEvict: true,
    poolVol1mMult: 1,
    liveWsCap: 10,
    opraCap: 20,
    opraDualLeg: true,
    equityAvg1mMin: 10000,
    optionsAvg1mMin: 25000,
    poolChainVolMin: 50000,
    poolChainOiMin: 50000,
    poolChainGateOp: 'or',
    vectorFocusOn: true,
    vectorFocusStartEt: '09:30',
    vectorFocusEndEt: '09:45',
    autoArmOn: false,
    autoArmAtEt: '09:30',
    scanStartEt: '09:35',
    vectorScanOn: true,
    vectorScanSec: 12,
    vectorScanRotate: true,
    vectorDiscoverCap: 250,
    vectorHunterOn: true,
    vectorHunterSec: 30,
    vectorHunterLookbackMin: 20,
    vectorHunterMinRvol: 1.5,
    vectorHunterSkipIgnition: true,
    vectorPromoteSkipIgnition: true,
    volFlipScannerOn: false,
    volFlipScannerMinX: 1,
    flipEntryMode: 'off',
    flipGraceSec: 300,
    flipLookbackMin: 5,
    flipMaxCrosses5m: 1,
    flipExitOnReverse: false,
    flipOpraDualLeg: true,
    flipScanLoopMs: 2000,
    flipScanChLimit: 250,
    flipScanApiConcur: 12,
    flipHoldMax: 20,
    flipHoldRecheckSec: 30,
    flipHoldSec: 600,
    entriesMarketOnly: true,
    rthVectorOnly: true,
    sessions: defaultSessions(),
    options: defaultOptions(),
    agent: defaultAgent(),
  };
}

function parseHHMM(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Last-closed 1m must be at/after scanStartEt so 09:30–09:34 auction bars are skipped. */
function scanReady({ et, lastClosed, scanStartEt } = {}) {
  const start = parseHHMM(scanStartEt) ?? (9 * 60 + 35);
  const closed = parseHHMM(String(lastClosed || '').slice(11, 16));
  if (closed != null) return closed >= start;
  if (et && Number.isFinite(et.mins)) return et.mins >= start;
  return true;
}

function minsInWindow(mins, startMins, endMins) {
  if (startMins === endMins) return true;
  if (startMins < endMins) return mins >= startMins && mins < endMins;
  return mins >= startMins || mins < endMins;
}

function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function quoteIdent(name) {
  if (VIRTUAL_FIELDS.has(name)) return null;
  if (!IDENT.test(name) || SKIP_FIELDS.has(name)) return null;
  return `\`${name}\``;
}

function sqlLit(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function classifyType(chType) {
  const t = String(chType || '').toLowerCase();
  if (t.includes('enum') || t.includes('lowcardinality') || t.includes('string')) return 'string';
  if (t.includes('uint8') || t.includes('bool')) return 'bool';
  if (t.includes('date') || t.includes('time')) return 'time';
  return 'number';
}

function coerceBoolValue(v) {
  if (v === true || v === 1 || v === '1') return 1;
  if (v === false || v === 0 || v === '0') return 0;
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === 'y') return 1;
  if (s === 'false' || s === 'no' || s === 'n') return 0;
  return null;
}

function sanitizeFilter(f, catalog) {
  if (!f || !f.field) return null;
  if (VIRTUAL_FIELDS.has(f.field)) {
    const op = OPS.has(f.op) ? f.op : 'gte';
    const out = {
      id: f.id || uid('f'),
      field: f.field,
      op,
      enabled: f.enabled !== false,
    };
    if (op === 'between') {
      out.min = f.min == null || f.min === '' ? null : Number(f.min);
      out.max = f.max == null || f.max === '' ? null : Number(f.max);
    } else {
      out.value = f.value === '' ? '' : f.value;
    }
    return out;
  }
  if (!catalog.has(f.field) && !IDENT.test(f.field)) return null;
  const op = OPS.has(f.op) ? f.op : 'gte';
  const out = {
    id: f.id || uid('f'),
    field: f.field,
    op,
    enabled: f.enabled !== false,
  };
  if (op === 'between') {
    out.min = f.min == null || f.min === '' ? null : Number(f.min);
    out.max = f.max == null || f.max === '' ? null : Number(f.max);
  } else if (op === 'in') {
    const vals = Array.isArray(f.values) ? f.values : String(f.values || '').split(',').map((s) => s.trim()).filter(Boolean);
    out.values = vals.slice(0, 40);
  } else {
    out.value = f.value;
  }
  return out;
}

function sanitizeSession(s, fallback = {}) {
  if (!s) return null;
  const start = parseHHMM(s.start);
  const end = parseHHMM(s.end);
  if (start == null || end == null) return null;
  const volFloorField = IDENT.test(s.volFloorField || '') ? s.volFloorField : (fallback.volFloorField || 'avg_1m_vol_market');
  const play = sessionPlay(s, fallback);
  let filters;
  if (Array.isArray(s.filters)) {
    filters = s.filters.map((f) => sanitizeFilter(f, new Set([f && f.field]))).filter(Boolean);
  } else {
    filters = cloneFiltersForSession(fallback.filters || defaultFilters(), volFloorField);
  }
  const fromFilt = sess1mBoundsFromFilters(filters);
  const min = fromFilt.min ?? play.sess1mMin;
  const max = fromFilt.max ?? play.sess1mMax;
  filters = ensureSess1mFilter(filters, min, max);
  const bounds = sess1mBoundsFromFilters(filters);
  return {
    id: String(s.id || uid('sess')),
    label: String(s.label || s.id || 'Session').slice(0, 40),
    start: `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`,
    end: `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`,
    enabled: Boolean(s.enabled),
    volFloorField,
    notional: play.notional,
    maxConcurrent: play.maxConcurrent,
    stampVolMult: play.buyVolMult,
    buyVolMult: play.buyVolMult,
    sellVolMult: play.sellVolMult,
    sellProfitOnly: play.sellProfitOnly,
    stampGrOnly: play.stampGrOnly,
    buyCloseAboveCoil: play.buyCloseAboveCoil,
    playMode: play.playMode,
    entryRule: play.entryRule,
    exitRule: play.exitRule,
    entryTf: play.entryTf,
    entryGreenCount: play.entryGreenCount,
    entryVolMult: play.entryVolMult,
    entryVolVs: play.entryVolVs,
    requireNoClimax10s: play.requireNoClimax10s,
    climax10sMult: play.climax10sMult,
    requireAll10sAbove: play.requireAll10sAbove,
    all10sMult: play.all10sMult,
    confirmTf: play.confirmTf,
    confirmBars: play.confirmBars,
    equityConfirmTf: play.equityConfirmTf,
    equityConfirmBars: play.equityConfirmBars,
    coilFreeze: play.coilFreeze,
    exitTf: play.exitTf,
    exitTfScale: play.exitTfScale,
    exitVolMult: play.exitVolMult,
    exitAllInside: play.exitAllInside,
    exitParentTf: play.exitParentTf,
    exitRedCount: play.exitRedCount,
    exitVolRollover: play.exitVolRollover,
    exitVolRolloverMult: play.exitVolRolloverMult,
    exitVol1mFade: play.exitVol1mFade,
    exitVol1mFadeMult: play.exitVol1mFadeMult,
    exitVol1mFadeLoc: play.exitVol1mFadeLoc,
    exitVol1mRefresh: play.exitVol1mRefresh,
    exitFailFast10s: play.exitFailFast10s,
    exitFailFast10sCount: play.exitFailFast10sCount,
    exitProfitLock10s: play.exitProfitLock10s,
    exitProfitLock10sMinPct: play.exitProfitLock10sMinPct,
    ignitionOn: play.ignitionOn,
    ignHistMult: play.ignHistMult,
    ignAvgMult: play.ignAvgMult,
    ignMaxMult: play.ignMaxMult,
    ignOverrideMult: play.ignOverrideMult,
    ignMinSessBars: play.ignMinSessBars,
    ignLookbackMin: play.ignLookbackMin,
    ignFollowMin: play.ignFollowMin,
    ignWiggleOn: play.ignWiggleOn,
    ignWigglePeakMult: play.ignWigglePeakMult,
    ignWiggleHistMult: play.ignWiggleHistMult,
    sess1mMin: bounds.min,
    sess1mMax: bounds.max,
    sess1mFrom: play.sess1mFrom,
    universeCap: play.universeCap,
    filters,
  };
}

function mergeConfig(raw = {}) {
  const base = defaultConfig();
  const next = { ...base, ...raw };
  next.notional = Math.max(100, Number(next.notional) || 1500);
  next.maxConcurrent = Math.max(1, Number(next.maxConcurrent) || 10);
  next.pollMs = Math.max(1000, Number(next.pollMs) || 3000);
  next.stampVolMult = Math.max(0.1, Number(next.stampVolMult) || 1);
  next.flattenOnSessionEnd = next.flattenOnSessionEnd !== false;
  next.universeCap = Math.min(4000, Math.max(50, Number(next.universeCap) || 1500));
  next.poolMax = clampCount(next.poolMax, 1, 80, 20);
  next.poolLaneMax = clampCount(next.poolLaneMax, 1, 40, 10);
  next.poolIdleSec = clampCount(raw.poolIdleSec ?? next.poolIdleSec, 30, 3600, 300);
  next.poolHoldSec = clampCount(raw.poolHoldSec ?? next.poolHoldSec, 30, 3600, 300);
  next.poolVol1mEvict = raw.poolVol1mEvict !== false;
  next.poolVol1mMult = clampMult(raw.poolVol1mMult ?? next.poolVol1mMult, 1);
  next.liveWsCap = clampCount(next.liveWsCap, 1, 30, 10);
  next.opraDualLeg = resolveOpraDualLeg(raw);
  next.flipOpraDualLeg = next.opraDualLeg;
  const opraDefault = next.opraDualLeg ? Math.min(60, next.liveWsCap * 2) : 10;
  next.opraCap = clampCount(next.opraCap, 1, 60, opraDefault);
  next.equityAvg1mMin = clampCount(next.equityAvg1mMin, 0, 5000000, 10000);
  next.optionsAvg1mMin = clampCount(next.optionsAvg1mMin, 0, 5000000, 25000);
  next.poolChainVolMin = clampCount(raw.poolChainVolMin ?? next.poolChainVolMin, 0, 500000000, 50000);
  next.poolChainOiMin = clampCount(raw.poolChainOiMin ?? next.poolChainOiMin, 0, 500000000, 50000);
  next.poolChainGateOp = String(raw.poolChainGateOp ?? next.poolChainGateOp ?? 'or').toLowerCase() === 'and' ? 'and' : 'or';
  next.vectorFocusOn = raw.vectorFocusOn !== false;
  next.vectorFocusStartEt = hhmmOr(raw.vectorFocusStartEt, '09:30');
  next.vectorFocusEndEt = hhmmOr(raw.vectorFocusEndEt, '09:45');
  next.autoArmOn = raw.autoArmOn === true;
  next.autoArmAtEt = hhmmOr(raw.autoArmAtEt, '09:30');
  next.scanStartEt = hhmmOr(raw.scanStartEt, '09:35');
  next.vectorScanOn = raw.vectorScanOn !== false;
  next.vectorScanSec = clampCount(raw.vectorScanSec ?? next.vectorScanSec, 5, 120, 12);
  next.vectorScanRotate = raw.vectorScanRotate !== false;
  next.vectorDiscoverCap = clampCount(raw.vectorDiscoverCap ?? next.vectorDiscoverCap, 50, 800, 250);
  next.vectorHunterOn = raw.vectorHunterOn !== false;
  next.vectorHunterSec = clampCount(raw.vectorHunterSec ?? next.vectorHunterSec, 10, 300, 30);
  next.vectorHunterLookbackMin = clampCount(raw.vectorHunterLookbackMin ?? next.vectorHunterLookbackMin, 5, 120, 20);
  next.vectorHunterMinRvol = clampMult(raw.vectorHunterMinRvol ?? next.vectorHunterMinRvol, 1.5);
  next.vectorHunterSkipIgnition = raw.vectorHunterSkipIgnition !== false;
  next.vectorPromoteSkipIgnition = raw.vectorPromoteSkipIgnition !== false;
  next.volFlipScannerOn = raw.volFlipScannerOn === true;
  next.volFlipScannerMinX = Math.max(0.5, Math.min(5, Number(raw.volFlipScannerMinX ?? next.volFlipScannerMinX) || 1));
  const flipMode = String(raw.flipEntryMode ?? next.flipEntryMode ?? 'off').toLowerCase();
  next.flipEntryMode = flipMode === 'flip_coil' ? 'flip_coil' : 'off';
  next.flipGraceSec = clampCount(raw.flipGraceSec ?? next.flipGraceSec, 30, 900, 300);
  next.flipLookbackMin = clampCount(raw.flipLookbackMin ?? next.flipLookbackMin, 1, 15, 5);
  next.flipMaxCrosses5m = clampCount(raw.flipMaxCrosses5m ?? next.flipMaxCrosses5m, 0, 5, 1);
  next.flipExitOnReverse = raw.flipExitOnReverse === true;
  next.flipScanLoopMs = Math.max(750, Math.min(8000, Number(raw.flipScanLoopMs ?? next.flipScanLoopMs) || 2000));
  next.flipScanChLimit = clampCount(raw.flipScanChLimit ?? next.flipScanChLimit, 48, 800, 250);
  next.flipScanApiConcur = clampCount(raw.flipScanApiConcur ?? next.flipScanApiConcur, 1, 24, 12);
  next.flipHoldMax = clampCount(raw.flipHoldMax ?? next.flipHoldMax, 4, 40, 20);
  next.flipHoldRecheckSec = clampCount(raw.flipHoldRecheckSec ?? next.flipHoldRecheckSec, 10, 120, 30);
  next.flipHoldSec = clampCount(raw.flipHoldSec ?? next.flipHoldSec, 60, 1800, 600);
  next.entriesMarketOnly = raw.entriesMarketOnly !== false;
  next.rthVectorOnly = raw.rthVectorOnly !== false;
  const fallbackFilters = Array.isArray(raw.filters)
    ? raw.filters.map((f) => sanitizeFilter(f, new Set([f && f.field]))).filter(Boolean)
    : defaultFilters();
  const fallback = {
    notional: next.notional,
    maxConcurrent: next.maxConcurrent,
    stampVolMult: next.stampVolMult,
    buyVolMult: clampMult(raw.buyVolMult ?? next.stampVolMult, 1),
    sellVolMult: clampMult(raw.sellVolMult ?? raw.buyVolMult ?? next.stampVolMult, 1),
    sellProfitOnly: raw.sellProfitOnly === true,
    stampGrOnly: raw.stampGrOnly !== false,
    buyCloseAboveCoil: raw.buyCloseAboveCoil !== false,
    playMode: raw.playMode,
    entryRule: raw.entryRule,
    exitRule: raw.exitRule,
    entryTf: raw.entryTf,
    exitTf: raw.exitTf,
    entryVolMult: clampMult(raw.entryVolMult, 1),
    entryVolVs: raw.entryVolVs,
    entryGreenCount: raw.entryGreenCount,
    requireNoClimax10s: raw.requireNoClimax10s,
    climax10sMult: raw.climax10sMult,
    requireAll10sAbove: raw.requireAll10sAbove,
    all10sMult: raw.all10sMult,
    confirmTf: raw.confirmTf,
    confirmBars: raw.confirmBars,
    equityConfirmTf: raw.equityConfirmTf,
    equityConfirmBars: raw.equityConfirmBars,
    coilFreeze: raw.coilFreeze,
    exitTfScale: raw.exitTfScale,
    exitVolMult: clampMult(raw.exitVolMult, 1),
    exitAllInside: raw.exitAllInside,
    exitParentTf: raw.exitParentTf,
    exitRedCount: raw.exitRedCount,
    exitVolRollover: raw.exitVolRollover,
    exitVolRolloverMult: raw.exitVolRolloverMult,
    exitVol1mFade: raw.exitVol1mFade,
    exitVol1mFadeMult: raw.exitVol1mFadeMult,
    exitVol1mFadeLoc: raw.exitVol1mFadeLoc,
    exitVol1mRefresh: raw.exitVol1mRefresh,
    exitFailFast10s: raw.exitFailFast10s,
    exitFailFast10sCount: raw.exitFailFast10sCount,
    exitProfitLock10s: raw.exitProfitLock10s,
    exitProfitLock10sMinPct: raw.exitProfitLock10sMinPct,
    ignitionOn: raw.ignitionOn,
    sess1mMin: optNum(raw.sess1mMin),
    sess1mMax: optNum(raw.sess1mMax),
    sess1mFrom: raw.sess1mFrom,
    universeCap: next.universeCap,
    filters: fallbackFilters,
  };
  const sess = Array.isArray(raw.sessions) ? raw.sessions.map((s) => sanitizeSession(s, fallback)).filter(Boolean) : null;
  next.sessions = sess && sess.length ? sess : defaultSessions();
  return {
    version: 5,
    notional: next.notional,
    maxConcurrent: next.maxConcurrent,
    pollMs: next.pollMs,
    stampVolMult: next.stampVolMult,
    flattenOnSessionEnd: next.flattenOnSessionEnd,
    universeCap: next.universeCap,
    candidateCooldownSec: clampCount(raw.candidateCooldownSec ?? next.candidateCooldownSec, 0, 3600, 300),
    poolMax: next.poolMax,
    poolLaneMax: next.poolLaneMax,
    poolIdleSec: next.poolIdleSec,
    poolHoldSec: next.poolHoldSec,
    poolVol1mEvict: next.poolVol1mEvict,
    poolVol1mMult: next.poolVol1mMult,
    liveWsCap: next.liveWsCap,
    opraCap: next.opraCap,
    opraDualLeg: next.opraDualLeg,
    equityAvg1mMin: next.equityAvg1mMin,
    optionsAvg1mMin: next.optionsAvg1mMin,
    poolChainVolMin: next.poolChainVolMin,
    poolChainOiMin: next.poolChainOiMin,
    poolChainGateOp: next.poolChainGateOp,
    vectorFocusOn: next.vectorFocusOn,
    vectorFocusStartEt: next.vectorFocusStartEt,
    vectorFocusEndEt: next.vectorFocusEndEt,
    autoArmOn: next.autoArmOn,
    autoArmAtEt: next.autoArmAtEt,
    scanStartEt: next.scanStartEt,
    vectorScanOn: next.vectorScanOn,
    vectorScanSec: next.vectorScanSec,
    vectorScanRotate: next.vectorScanRotate,
    vectorDiscoverCap: next.vectorDiscoverCap,
    vectorHunterOn: next.vectorHunterOn,
    vectorHunterSec: next.vectorHunterSec,
    vectorHunterLookbackMin: next.vectorHunterLookbackMin,
    vectorHunterMinRvol: next.vectorHunterMinRvol,
    vectorHunterSkipIgnition: next.vectorHunterSkipIgnition,
    vectorPromoteSkipIgnition: next.vectorPromoteSkipIgnition,
    volFlipScannerOn: next.volFlipScannerOn,
    volFlipScannerMinX: next.volFlipScannerMinX,
    flipEntryMode: next.flipEntryMode,
    flipGraceSec: next.flipGraceSec,
    flipLookbackMin: next.flipLookbackMin,
    flipMaxCrosses5m: next.flipMaxCrosses5m,
    flipExitOnReverse: next.flipExitOnReverse,
    flipOpraDualLeg: next.flipOpraDualLeg,
    flipScanLoopMs: next.flipScanLoopMs,
    flipScanChLimit: next.flipScanChLimit,
    flipScanApiConcur: next.flipScanApiConcur,
    flipHoldMax: next.flipHoldMax,
    flipHoldRecheckSec: next.flipHoldRecheckSec,
    flipHoldSec: next.flipHoldSec,
    entriesMarketOnly: next.entriesMarketOnly,
    rthVectorOnly: next.rthVectorOnly,
    sessions: next.sessions,
    options: sanitizeOptions(raw.options),
    agent: sanitizeAgent(raw.agent),
  };
}

/** Risk UI shows percent points (8 = 8%). Engines store fractions (0.08). */
function _fracToPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1000) / 10;
}

function _pctToFrac(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n / 100;
}

function _marketSession(sessions) {
  return (sessions || []).find((s) => s && s.id === 'market') || (sessions || [])[0] || null;
}

function _pxFilter(sess) {
  return (sess?.filters || []).find((f) => f && f.field === 'last_close');
}

function _volFilter(sess) {
  return (sess?.filters || []).find((f) => f && f.field === SESSION_1M_FIELD);
}

function applyScannerToSessions(sessions, scanner = {}) {
  if (!scanner || typeof scanner !== 'object') return sessions;
  return (sessions || []).map((s) => {
    // Risk scanner knobs map onto Regular (RTH) — not overnight/post.
    if (s?.id && s.id !== 'market') return s;
    const sess = { ...s, filters: (s.filters || []).map((f) => ({ ...f })) };
    // Regular cash hours stay 09:30–16:00. sessionStart/End only delay VECTOR hunt + entries.
    if (scanner.minVolRatio != null && Number.isFinite(Number(scanner.minVolRatio))) {
      const m = clampMult(scanner.minVolRatio, 1);
      sess.entryVolMult = m;
      sess.buyVolMult = m;
      sess.stampVolMult = m;
    }
    if (scanner.requireGreen != null) sess.stampGrOnly = Boolean(scanner.requireGreen);
    if (scanner.minAvg1mVol != null && Number.isFinite(Number(scanner.minAvg1mVol))) {
      const v = Number(scanner.minAvg1mVol);
      sess.sess1mMin = v;
      for (const f of sess.filters) {
        if (f.field === SESSION_1M_FIELD) {
          f.op = 'gte'; f.value = v; f.enabled = true;
        }
      }
    }
    if (scanner.minPrice != null || scanner.maxPrice != null) {
      let px = sess.filters.find((f) => f.field === 'last_close');
      if (!px) {
        px = { id: `f-px-${sess.id || 'sess'}`, field: 'last_close', op: 'between', min: 5, max: 500, enabled: true };
        sess.filters.push(px);
      }
      px.op = 'between';
      px.enabled = true;
      if (scanner.minPrice != null && Number.isFinite(Number(scanner.minPrice))) px.min = Number(scanner.minPrice);
      if (scanner.maxPrice != null && Number.isFinite(Number(scanner.maxPrice))) px.max = Number(scanner.maxPrice);
    }
    return sess;
  });
}

function _histVolFilter(sess) {
  if (!sess?.volFloorField) return null;
  return (sess.filters || []).find((f) => f && f.field === sess.volFloorField && f.enabled !== false);
}

function _maintFilter(sess) {
  return (sess?.filters || []).find((f) => f && f.field === 'maint_margin_pct');
}

/** Desk-friendly session row for Scan Path UI. */
function sessionToDeskPlay(s) {
  if (!s) return null;
  const px = _pxFilter(s);
  const hv = _histVolFilter(s);
  const maint = _maintFilter(s);
  return {
    id: s.id,
    label: s.label,
    enabled: s.enabled !== false,
    start: s.start,
    end: s.end,
    volFloorField: s.volFloorField,
    histVolMin: hv?.value != null && hv.value !== '' ? Number(hv.value) : null,
    maintMarginMin: maint?.enabled === false ? null : (maint?.value != null && maint.value !== '' ? Number(maint.value) : null),
    universeCap: s.universeCap,
    sess1mMin: s.sess1mMin,
    sess1mMax: s.sess1mMax,
    sess1mFrom: s.sess1mFrom,
    minPrice: px?.min ?? null,
    maxPrice: px?.max ?? null,
    entryVolMult: Number(s.entryVolMult ?? s.buyVolMult ?? 1) || 1,
    stampGrOnly: s.stampGrOnly !== false,
    entryRule: s.entryRule,
    entryTf: s.entryTf,
    entryGreenCount: s.entryGreenCount,
    requireAll10sAbove: Boolean(s.requireAll10sAbove),
    all10sMult: s.all10sMult,
    confirmTf: s.confirmTf,
    confirmBars: s.confirmBars,
    equityConfirmTf: s.equityConfirmTf,
    equityConfirmBars: s.equityConfirmBars,
    requireNoClimax10s: Boolean(s.requireNoClimax10s),
    climax10sMult: s.climax10sMult,
    buyCloseAboveCoil: s.buyCloseAboveCoil !== false,
    coilFreeze: Boolean(s.coilFreeze),
    ignitionOn: Boolean(s.ignitionOn),
    ignWiggleOn: s.ignWiggleOn !== false,
    ignWigglePeakMult: s.ignWigglePeakMult,
    ignWiggleHistMult: s.ignWiggleHistMult,
    ignHistMult: s.ignHistMult,
    ignAvgMult: s.ignAvgMult,
    ignMaxMult: s.ignMaxMult,
    ignLookbackMin: s.ignLookbackMin,
    poolSplit: String(s.id || '') === 'market',
  };
}

function applySessionDeskPatch(sess, patch) {
  if (!sess || !patch) return sess;
  const base = { ...sess, filters: (sess.filters || []).map((f) => ({ ...f })) };
  const playKeys = [
    'enabled', 'start', 'end', 'volFloorField', 'universeCap', 'sess1mMin', 'sess1mMax', 'sess1mFrom',
    'stampGrOnly', 'entryRule', 'entryTf', 'entryGreenCount', 'requireAll10sAbove', 'all10sMult',
    'confirmTf', 'confirmBars', 'equityConfirmTf', 'equityConfirmBars',
    'requireNoClimax10s', 'climax10sMult', 'buyCloseAboveCoil', 'coilFreeze',
    'ignitionOn', 'ignWiggleOn', 'ignWigglePeakMult', 'ignWiggleHistMult',
    'ignHistMult', 'ignAvgMult', 'ignMaxMult', 'ignLookbackMin',
  ];
  for (const k of playKeys) {
    if (patch[k] !== undefined) base[k] = patch[k];
  }
  if (patch.entryVolMult != null && Number.isFinite(Number(patch.entryVolMult))) {
    const m = clampMult(patch.entryVolMult, 1);
    base.entryVolMult = m;
    base.buyVolMult = m;
    base.stampVolMult = m;
  }
  if (patch.sess1mMin != null || patch.sess1mMax != null) {
    if (patch.sess1mMin != null) base.sess1mMin = optNum(patch.sess1mMin);
    if (patch.sess1mMax != null) base.sess1mMax = optNum(patch.sess1mMax);
    base.filters = ensureSess1mFilter(base.filters, base.sess1mMin, base.sess1mMax);
  }
  if (patch.minPrice != null || patch.maxPrice != null) {
    let pxF = base.filters.find((f) => f.field === 'last_close');
    if (!pxF) {
      pxF = { id: uid('f-px'), field: 'last_close', op: 'between', enabled: true, min: 1, max: 500 };
      base.filters.push(pxF);
    }
    pxF.op = 'between';
    pxF.enabled = true;
    if (patch.minPrice != null && Number.isFinite(Number(patch.minPrice))) pxF.min = Number(patch.minPrice);
    if (patch.maxPrice != null && Number.isFinite(Number(patch.maxPrice))) pxF.max = Number(patch.maxPrice);
  }
  if (patch.histVolMin != null && IDENT.test(base.volFloorField || '')) {
    let vf = base.filters.find((f) => f.field === base.volFloorField);
    if (!vf) {
      vf = { id: uid('f-vol'), field: base.volFloorField, op: 'gte', enabled: true, value: patch.histVolMin };
      base.filters.push(vf);
    } else {
      vf.op = 'gte';
      vf.value = Number(patch.histVolMin);
      vf.enabled = true;
    }
  }
  if (patch.maintMarginMin != null) {
    let mf = base.filters.find((f) => f.field === 'maint_margin_pct');
    if (!mf) {
      mf = { id: uid('f-maint'), field: 'maint_margin_pct', op: 'gte', enabled: true, value: patch.maintMarginMin };
      base.filters.push(mf);
    } else {
      mf.op = 'gte';
      mf.value = Number(patch.maintMarginMin);
      mf.enabled = true;
    }
  }
  const fb = defaultSessions().find((d) => d.id === base.id) || defaultSessions()[0];
  return sanitizeSession(base, fb);
}

function applySessionDeskPatches(sessions, patches) {
  if (!Array.isArray(patches) || !patches.length) return sessions;
  const byId = new Map(patches.filter((p) => p && p.id).map((p) => [String(p.id), p]));
  return (sessions || []).map((s) => {
    const p = byId.get(String(s.id));
    return p ? applySessionDeskPatch(s, p) : s;
  });
}

/** Convexity Risk-page shape from live vol10s options + equity config. */
function toRiskDesk(optionsCfg = {}, equityCfg = {}) {
  const o = optionsCfg || {};
  const mkt = _marketSession(equityCfg.sessions);
  const px = _pxFilter(mkt);
  const vol = _volFilter(mkt);
  return {
    tape: {
      poolMax: clampCount(equityCfg.poolMax, 1, 80, 10),
      liveWsCap: clampCount(equityCfg.liveWsCap, 1, 30, 10),
      opraCap: clampCount(equityCfg.opraCap, 1, 60, 20),
      opraDualLeg: equityCfg.opraDualLeg !== false,
    },
    scanner: {
      minVolRatio: Number(mkt?.entryVolMult ?? mkt?.buyVolMult ?? 1) || 1,
      requireGreen: mkt?.stampGrOnly !== false,
      sessionStart: o.entryStartEt || equityCfg.scanStartEt || '09:35',
      sessionEnd: o.entryEndEt || '16:00',
      minPrice: px?.min ?? 5,
      maxPrice: px?.max ?? 500,
      minAvg1mVol: mkt?.sess1mMin ?? vol?.value ?? 10000,
      candidateCooldownSec: o.candidateCooldownSec ?? equityCfg.candidateCooldownSec ?? 300,
    },
    selector: {
      allow0dte: o.allow0dte === true,
      maxDte: o.maxDte,
      minDelta: o.minDelta,
      minPremium: o.minPremium,
      poolMinPremium: o.poolMinPremium,
      maxPremium: o.maxPremium,
    },
    execution: {
      contracts: o.contracts,
      walkMs: o.walkMs,
      maxChaseSteps: o.maxChaseSteps,
      cancelAfterSec: o.cancelAfterSec,
      sellCancelAfterSec: o.sellCancelAfterSec ?? o.sellChaseSec,
      oneWorkingPerUnderlying: o.oneWorkingPerUnderlying !== false,
      cancelOpenBuysBeforeEntry: o.cancelOpenBuysBeforeEntry === true,
      equityCancelOpenBuysBeforeEntry: o.equityCancelOpenBuysBeforeEntry !== false,
      entryBidWalkEnabled: o.entryBidWalkEnabled === true,
      vectorPoolEntry: o.vectorPoolEntry !== false,
      poolStreamReGate: o.poolStreamReGate === true,
      entryLiveQuoteWaitMs: o.entryLiveQuoteWaitMs,
      entryBidConfirmEnabled: o.entryBidConfirmEnabled !== false,
      entryBidConfirmMs: o.entryBidConfirmMs,
      entryBidMinMoveCents: o.entryBidMinMoveCents,
      entryBidMinDistinct: o.entryBidMinDistinct,
      entryBidRequireLive: o.entryBidRequireLive !== false,
      walkCent: o.walkCent,
      equityWalkRungMs: o.equityWalkRungMs,
      equityWalkAllowAsk: o.equityWalkAllowAsk !== false,
      bidWalkCeilingMode: o.bidWalkCeilingMode || 'bid_slip',
      equityBidWalkCeilingMode: o.equityBidWalkCeilingMode || 'mid',
      bidWalkMaxSlipPct: o.bidWalkMaxSlipPct,
      bidWalkMaxCents: o.bidWalkMaxCents,
      replaceMinMs: o.replaceMinMs,
      entryFillTimeoutSec: o.entryFillTimeoutSec,
      entryMaxReplaceAttempts: o.entryMaxReplaceAttempts,
      buyPeg: o.buyPeg,
      sellPeg: o.sellPeg,
    },
    risk: {
      maxSpreadPct: o.maxSpreadPct,
      indicativeMaxSpreadPct: o.indicativeMaxSpreadPct,
      zeroDteMaxSpreadPct: o.zeroDteMaxSpreadPct,
      openStartEt: o.openStartEt,
      openEndEt: o.openEndEt,
      openSpreadMult: o.openSpreadMult,
      minIv: o.minIv,
      maxIv: o.maxIv,
      openMinIv: o.openMinIv,
      openMaxIv: o.openMaxIv,
      poolMinIv: o.poolMinIv,
      poolMaxIv: o.poolMaxIv,
      maxPremiumUsd: o.maxPremiumUsd,
      maxOpenPremiumUsd: o.maxOpenPremiumUsd,
      dailyMaxLossUsd: o.dailyMaxLossUsd,
      maxConcurrent: o.maxConcurrent,
      maxEntriesPerSymbolPerDay: o.maxEntriesPerSymbolPerDay,
      symbolCooldownSec: o.symbolCooldownSec,
      chaseMaxSpreadPct: o.chaseMaxSpreadPct,
      maxChaseAboveMidPct: o.maxChaseAboveMidPct,
    },
    exits: {
      flipExitOnReverse: equityCfg.flipExitOnReverse === true,
      fastExitsEnabled: o.fastExitsEnabled === true,
      instantProfitEnabled: o.instantProfitEnabled === true,
      instantProfitPct: _fracToPct(o.instantProfitPct),
      exitProfitLock10s: o.exitProfitLock10s === true,
      exitProfitLock10sMinPct: o.exitProfitLock10sMinPct ?? 20,
      askProfitExitEnabled: o.askProfitExitEnabled === true,
      askProfitExitMinPct: o.askProfitExitMinPct ?? 10,
      askProfitExitBidStalePct: o.askProfitExitBidStalePct ?? 5,
      lockArmUsd: o.lockArmUsd,
      lockArmPct: _fracToPct(o.lockArmPct),
      givebackPct: _fracToPct(o.givebackPct),
      bidStopEnabled: o.bidStopEnabled === true,
      lossStopPct: _fracToPct(o.lossStopPct),
      catastropheEnabled: o.catastropheEnabled === true,
      ivCrushEnabled: o.ivCrushEnabled === true,
      volDeathExitEnabled: o.volDeathExitEnabled === true,
      sessionFlattenEnabled: o.sessionFlattenEnabled === true,
      lossMinHoldSec: o.lossMinHoldSec,
      flattenEt: o.flattenEt,
    },
    engine: {
      pollMs: equityCfg.pollMs,
      candidateCooldownSec: equityCfg.candidateCooldownSec ?? o.candidateCooldownSec ?? 300,
      flattenOnSessionEnd: equityCfg.flattenOnSessionEnd !== false,
      entriesMarketOnly: equityCfg.entriesMarketOnly !== false,
      rthVectorOnly: equityCfg.rthVectorOnly !== false,
      scanStartEt: equityCfg.scanStartEt || '09:35',
    },
    promote: {
      poolMax: equityCfg.poolMax,
      poolLaneMax: equityCfg.poolLaneMax,
      poolHoldSec: equityCfg.poolHoldSec,
      poolIdleSec: equityCfg.poolIdleSec,
      poolVol1mEvict: equityCfg.poolVol1mEvict !== false,
      poolVol1mMult: equityCfg.poolVol1mMult ?? 1,
      equityAvg1mMin: equityCfg.equityAvg1mMin,
      optionsAvg1mMin: equityCfg.optionsAvg1mMin,
      poolChainVolMin: equityCfg.poolChainVolMin,
      poolChainOiMin: equityCfg.poolChainOiMin,
      poolChainGateOp: equityCfg.poolChainGateOp || 'or',
      vectorFocusOn: equityCfg.vectorFocusOn !== false,
      vectorFocusStartEt: equityCfg.vectorFocusStartEt || '09:30',
      vectorFocusEndEt: equityCfg.vectorFocusEndEt || '09:45',
      vectorScanOn: equityCfg.vectorScanOn !== false,
      vectorScanSec: equityCfg.vectorScanSec ?? 12,
      vectorScanRotate: equityCfg.vectorScanRotate !== false,
      vectorDiscoverCap: equityCfg.vectorDiscoverCap ?? 250,
      vectorHunterOn: equityCfg.vectorHunterOn !== false,
      vectorHunterSec: equityCfg.vectorHunterSec ?? 30,
      vectorHunterMinRvol: equityCfg.vectorHunterMinRvol ?? 1.5,
    },
    sessions: (equityCfg.sessions || []).map(sessionToDeskPlay).filter(Boolean),
    watch: {
      liveWsCap: equityCfg.liveWsCap,
      opraCap: equityCfg.opraCap,
      opraDualLeg: equityCfg.opraDualLeg !== false,
      allow0dte: o.allow0dte === true,
      maxDte: o.maxDte,
      minDelta: o.minDelta,
      minPremium: o.minPremium,
      poolMinPremium: o.poolMinPremium,
      maxPremium: o.maxPremium,
      poolMinIv: o.poolMinIv,
      poolMaxIv: o.poolMaxIv,
    },
    buy: {
      entryStartEt: o.entryStartEt || '09:30',
      entryEndEt: o.entryEndEt || '16:00',
      entryLiveQuoteWaitMs: o.entryLiveQuoteWaitMs,
      entryBidConfirmEnabled: o.entryBidConfirmEnabled !== false,
      entryBidConfirmMs: o.entryBidConfirmMs,
      entryBidMinMoveCents: o.entryBidMinMoveCents,
      entryBidMinDistinct: o.entryBidMinDistinct,
      entryBidRequireLive: o.entryBidRequireLive !== false,
      maxSpreadPct: o.maxSpreadPct,
      indicativeMaxSpreadPct: o.indicativeMaxSpreadPct,
      zeroDteMaxSpreadPct: o.zeroDteMaxSpreadPct,
      minIv: o.minIv,
      maxIv: o.maxIv,
      poolMinIv: o.poolMinIv,
      poolMaxIv: o.poolMaxIv,
    },
  };
}

const SELECTOR_KEYS = ['allow0dte', 'maxDte', 'minDelta', 'minPremium', 'poolMinPremium', 'maxPremium'];
const EXEC_KEYS = [
  'contracts', 'walkMs', 'maxChaseSteps', 'cancelAfterSec', 'sellCancelAfterSec',
  'oneWorkingPerUnderlying', 'cancelOpenBuysBeforeEntry', 'equityCancelOpenBuysBeforeEntry',
  'entryBidWalkEnabled', 'entryLiveQuoteWaitMs', 'entryBidConfirmEnabled', 'entryBidConfirmMs',
  'entryBidMinMoveCents', 'entryBidMinDistinct', 'entryBidRequireLive',
  'walkCent', 'equityWalkRungMs', 'equityWalkAllowAsk',
  'bidWalkCeilingMode', 'equityBidWalkCeilingMode', 'bidWalkMaxSlipPct', 'bidWalkMaxCents',
  'replaceMinMs', 'entryFillTimeoutSec', 'entryMaxReplaceAttempts', 'buyPeg', 'sellPeg',
];
const RISK_KEYS = [
  'maxSpreadPct', 'indicativeMaxSpreadPct', 'zeroDteMaxSpreadPct',
  'openStartEt', 'openEndEt', 'openSpreadMult',
  'minIv', 'maxIv', 'openMinIv', 'openMaxIv', 'poolMinIv', 'poolMaxIv',
  'maxPremiumUsd', 'maxOpenPremiumUsd', 'dailyMaxLossUsd', 'maxConcurrent',
  'maxEntriesPerSymbolPerDay', 'symbolCooldownSec', 'chaseMaxSpreadPct', 'maxChaseAboveMidPct',
];

/** Nested Convexity Risk patch → options + equity patches for live engines. */
function fromRiskDesk(patch = {}, current = {}) {
  const optionsPatch = {};
  const equityPatch = {};
  const tape = patch.tape && typeof patch.tape === 'object' ? patch.tape : null;
  const scanner = patch.scanner && typeof patch.scanner === 'object' ? patch.scanner : null;
  const selector = patch.selector && typeof patch.selector === 'object' ? patch.selector : null;
  const execution = patch.execution && typeof patch.execution === 'object' ? patch.execution : null;
  const risk = patch.risk && typeof patch.risk === 'object' ? patch.risk : null;
  const exits = patch.exits && typeof patch.exits === 'object' ? patch.exits : null;
  const engine = patch.engine && typeof patch.engine === 'object' ? patch.engine : null;
  const promote = patch.promote && typeof patch.promote === 'object' ? patch.promote : null;
  const sessions = Array.isArray(patch.sessions) ? patch.sessions : null;
  const watch = patch.watch && typeof patch.watch === 'object' ? patch.watch : null;
  const buy = patch.buy && typeof patch.buy === 'object' ? patch.buy : null;

  if (tape) {
    if (tape.poolMax != null) equityPatch.poolMax = tape.poolMax;
    if (tape.liveWsCap != null) equityPatch.liveWsCap = tape.liveWsCap;
    if (tape.opraCap != null) equityPatch.opraCap = tape.opraCap;
    if (tape.opraDualLeg != null) equityPatch.opraDualLeg = Boolean(tape.opraDualLeg);
  }
  if (scanner) {
    if (scanner.sessionStart != null) {
      optionsPatch.entryStartEt = scanner.sessionStart;
      equityPatch.scanStartEt = scanner.sessionStart;
    }
    if (scanner.sessionEnd != null) optionsPatch.entryEndEt = scanner.sessionEnd;
    if (scanner.candidateCooldownSec != null) {
      optionsPatch.candidateCooldownSec = scanner.candidateCooldownSec;
      equityPatch.candidateCooldownSec = scanner.candidateCooldownSec;
    }
    const eq = current.equity || {};
    equityPatch.sessions = applyScannerToSessions(eq.sessions || [], scanner);
  }
  if (selector) {
    for (const k of SELECTOR_KEYS) {
      if (k in selector) optionsPatch[k] = selector[k];
    }
    if (selector.allow0dte === true) {
      optionsPatch.minDte = 0;
      optionsPatch.dteMode = '0dte';
    }
    if (selector.allow0dte === false && optionsPatch.minDte == null) optionsPatch.minDte = 1;
  }
  if (execution) {
    for (const k of EXEC_KEYS) {
      if (k in execution) optionsPatch[k] = execution[k];
    }
    if (execution.sellCancelAfterSec != null) optionsPatch.sellChaseSec = execution.sellCancelAfterSec;
  }
  if (risk) {
    for (const k of RISK_KEYS) {
      if (k in risk) optionsPatch[k] = risk[k];
    }
  }
  if (exits) {
    if (exits.flipExitOnReverse != null) equityPatch.flipExitOnReverse = Boolean(exits.flipExitOnReverse);
    if (exits.fastExitsEnabled != null) optionsPatch.fastExitsEnabled = Boolean(exits.fastExitsEnabled);
    if (exits.instantProfitEnabled != null) optionsPatch.instantProfitEnabled = Boolean(exits.instantProfitEnabled);
    if (exits.instantProfitPct != null) optionsPatch.instantProfitPct = _pctToFrac(exits.instantProfitPct);
    if (exits.lockArmUsd != null) optionsPatch.lockArmUsd = clampUsd(exits.lockArmUsd, 200);
    if (exits.lockArmPct != null) optionsPatch.lockArmPct = _pctToFrac(exits.lockArmPct);
    if (exits.givebackPct != null) optionsPatch.givebackPct = _pctToFrac(exits.givebackPct);
    if (exits.bidStopEnabled != null) optionsPatch.bidStopEnabled = Boolean(exits.bidStopEnabled);
    if (exits.lossStopPct != null) optionsPatch.lossStopPct = _pctToFrac(exits.lossStopPct);
    if (exits.catastropheEnabled != null) optionsPatch.catastropheEnabled = Boolean(exits.catastropheEnabled);
    if (exits.ivCrushEnabled != null) optionsPatch.ivCrushEnabled = Boolean(exits.ivCrushEnabled);
    if (exits.volDeathExitEnabled != null) optionsPatch.volDeathExitEnabled = Boolean(exits.volDeathExitEnabled);
    if (exits.sessionFlattenEnabled != null) optionsPatch.sessionFlattenEnabled = Boolean(exits.sessionFlattenEnabled);
    if (exits.lossMinHoldSec != null) optionsPatch.lossMinHoldSec = exits.lossMinHoldSec;
    if (exits.flattenEt != null) optionsPatch.flattenEt = exits.flattenEt;
    if (exits.exitProfitLock10s != null) optionsPatch.exitProfitLock10s = Boolean(exits.exitProfitLock10s);
    if (exits.exitProfitLock10sMinPct != null) {
      optionsPatch.exitProfitLock10sMinPct = clampCount(exits.exitProfitLock10sMinPct, 1, 200, 20);
    }
    if (exits.askProfitExitEnabled != null) optionsPatch.askProfitExitEnabled = Boolean(exits.askProfitExitEnabled);
    if (exits.askProfitExitMinPct != null) {
      optionsPatch.askProfitExitMinPct = clampCount(exits.askProfitExitMinPct, 1, 200, 10);
    }
    if (exits.askProfitExitBidStalePct != null) {
      optionsPatch.askProfitExitBidStalePct = clampCount(exits.askProfitExitBidStalePct, 0, 100, 5);
    }
  }
  if (engine) {
    if (engine.pollMs != null) equityPatch.pollMs = engine.pollMs;
    if (engine.flattenOnSessionEnd != null) equityPatch.flattenOnSessionEnd = Boolean(engine.flattenOnSessionEnd);
    if (engine.entriesMarketOnly != null) equityPatch.entriesMarketOnly = Boolean(engine.entriesMarketOnly);
    if (engine.rthVectorOnly != null) equityPatch.rthVectorOnly = Boolean(engine.rthVectorOnly);
    if (engine.scanStartEt != null) equityPatch.scanStartEt = engine.scanStartEt;
    if (engine.candidateCooldownSec != null) {
      equityPatch.candidateCooldownSec = engine.candidateCooldownSec;
      optionsPatch.candidateCooldownSec = engine.candidateCooldownSec;
    }
  }
  if (promote) {
    for (const k of [
      'poolMax', 'poolLaneMax', 'poolHoldSec', 'poolIdleSec',
      'poolVol1mEvict', 'poolVol1mMult',
      'vectorScanOn', 'vectorScanSec', 'vectorScanRotate', 'vectorDiscoverCap',
      'equityAvg1mMin', 'optionsAvg1mMin',
      'poolChainVolMin', 'poolChainOiMin', 'poolChainGateOp',
      'vectorFocusStartEt', 'vectorFocusEndEt',
    ]) {
      if (promote[k] != null) equityPatch[k] = promote[k];
    }
    if (promote.poolChainGateOp != null) {
      equityPatch.poolChainGateOp = String(promote.poolChainGateOp).toLowerCase() === 'and' ? 'and' : 'or';
    }
    if (promote.vectorFocusOn != null) equityPatch.vectorFocusOn = Boolean(promote.vectorFocusOn);
  }
  if (sessions) {
    const eq = current.equity || {};
    equityPatch.sessions = applySessionDeskPatches(eq.sessions || [], sessions);
  }
  if (watch) {
    if (watch.liveWsCap != null) equityPatch.liveWsCap = watch.liveWsCap;
    if (watch.opraCap != null) equityPatch.opraCap = watch.opraCap;
    if (watch.opraDualLeg != null) equityPatch.opraDualLeg = Boolean(watch.opraDualLeg);
    for (const k of SELECTOR_KEYS) {
      if (k in watch) optionsPatch[k] = watch[k];
    }
    if (watch.allow0dte === true) {
      optionsPatch.minDte = 0;
      optionsPatch.dteMode = '0dte';
    } else if (watch.allow0dte === false && optionsPatch.minDte == null) {
      optionsPatch.minDte = 1;
    }
    if (watch.poolMinIv != null) optionsPatch.poolMinIv = watch.poolMinIv;
    if (watch.poolMaxIv != null) optionsPatch.poolMaxIv = watch.poolMaxIv;
  }
  if (buy) {
    if (buy.entryStartEt != null) {
      optionsPatch.entryStartEt = buy.entryStartEt;
      if (equityPatch.scanStartEt == null) equityPatch.scanStartEt = buy.entryStartEt;
    }
    if (buy.entryEndEt != null) optionsPatch.entryEndEt = buy.entryEndEt;
    for (const k of [
      'entryLiveQuoteWaitMs', 'entryBidConfirmEnabled', 'entryBidConfirmMs',
      'entryBidMinMoveCents', 'entryBidMinDistinct', 'entryBidRequireLive',
      'maxSpreadPct', 'indicativeMaxSpreadPct', 'zeroDteMaxSpreadPct',
      'minIv', 'maxIv', 'poolMinIv', 'poolMaxIv',
    ]) {
      if (k in buy) optionsPatch[k] = buy[k];
    }
  }
  return { optionsPatch, equityPatch };
}

function isRiskDeskPatch(body = {}) {
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body.sessions) && body.sessions.length) return true;
  return ['tape', 'scanner', 'selector', 'execution', 'risk', 'exits', 'engine', 'promote', 'watch', 'buy'].some(
    (k) => body[k] && typeof body[k] === 'object',
  );
}

function loadConfig(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      return mergeConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    }
  } catch (_) {}
  return defaultConfig();
}

function saveConfig(filePath, cfg) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, filePath);
}

function securityTypesFromFilters(filters = []) {
  const f = (filters || []).find((x) => x && x.enabled && x.field === 'security_type' && x.op === 'in');
  const vals = (f?.values || []).map((v) => String(v || '').trim()).filter(Boolean);
  return vals.length ? vals : null;
}

/** SQL fragment: AND toString(col) IN ('CS', ...) from session filters, or empty. */
function securityTypeSql(filters = [], col = 'tm.security_type') {
  const types = securityTypesFromFilters(filters);
  if (!types?.length) return '';
  return `AND toString(${col}) IN (${types.map(sqlLit).join(',')})`;
}

function filterSql(filters, catalog, fields = []) {
  const kindBy = new Map((fields || []).map((f) => [f.name, f.kind]));
  const parts = [];
  for (const f of filters || []) {
    if (!f.enabled) continue;
    if (VIRTUAL_FIELDS.has(f.field)) continue;
    const ident = quoteIdent(f.field);
    if (!ident) continue;
    if (catalog && catalog.size && !catalog.has(f.field)) continue;
    const kind = kindBy.get(f.field);
    if (f.op === 'between') {
      if (f.min != null && Number.isFinite(Number(f.min))) parts.push(`${ident} >= ${sqlLit(Number(f.min))}`);
      if (f.max != null && Number.isFinite(Number(f.max))) parts.push(`${ident} <= ${sqlLit(Number(f.max))}`);
      continue;
    }
    if (f.op === 'in') {
      const vals = (f.values || []).filter((v) => v !== '' && v != null);
      if (!vals.length) continue;
      parts.push(`${ident} IN (${vals.map(sqlLit).join(',')})`);
      continue;
    }
    if (f.value == null || f.value === '') continue;
    let val = f.value;
    if (kind === 'bool') {
      const b = coerceBoolValue(val);
      if (b == null) continue;
      val = b;
    }
    const op = f.op === 'gte' ? '>=' : f.op === 'lte' ? '<=' : f.op === 'neq' ? '!=' : '=';
    parts.push(`${ident} ${op} ${sqlLit(val)}`);
  }
  return parts.length ? `AND ${parts.join('\n  AND ')}` : '';
}

function sessionBounds(et, sess) {
  const startMins = parseHHMM(sess.start);
  const endMins = parseHHMM(sess.end);
  const wraps = startMins > endMins;
  let startDate = et.date;
  if (wraps && et.mins < endMins) startDate = addDays(et.date, -1);
  const endDate = wraps ? addDays(startDate, 1) : startDate;
  const pad = (n) => String(n).padStart(2, '0');
  const startClock = `${pad(Math.floor(startMins / 60))}:${pad(startMins % 60)}:00`;
  const endClock = `${pad(Math.floor(endMins / 60))}:${pad(endMins % 60)}:00`;
  return {
    startMins,
    endMins,
    wraps,
    startDate,
    endDate,
    startTs: `${startDate} ${startClock}`,
    endTs: `${endDate} ${endClock}`,
    key: `${sess.id}:${startDate}`,
  };
}

const CASH_CLOCK_LABELS = {
  market: 'MARKET SESSION',
  premarket: 'PREMARKET',
  post: 'POST',
  overnight: 'OVERNIGHT',
  closed: 'CASH CLOSED',
};

function etDow(et) {
  if (et && Number.isFinite(Number(et.dow))) return Number(et.dow);
  const date = et && et.date;
  if (!date) return null;
  const [y, mo, d] = String(date).split('-').map(Number);
  if (!y || !mo || !d) return null;
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** US equity cash clock (ET): RTH, extended, overnight, or weekend closed. */
function cashClockId(et) {
  const dow = etDow(et);
  const mins = et && Number.isFinite(Number(et.mins)) ? Number(et.mins) : null;
  if (dow == null || mins == null) return 'closed';
  const H = (h, m = 0) => h * 60 + m;
  const inWin = (a, b) => mins >= a && mins < b;
  if (dow === 6) return 'closed';
  if (dow === 0 && mins < H(20)) return 'closed';
  if (dow === 5 && mins >= H(20)) return 'closed';
  if (dow >= 1 && dow <= 5) {
    if (inWin(H(4), H(9, 30))) return 'premarket';
    if (inWin(H(9, 30), H(16))) return 'market';
    if (inWin(H(16), H(20))) return 'post';
    if (mins < H(4) || mins >= H(20)) return 'overnight';
  }
  if (dow === 0 && mins >= H(20)) return 'overnight';
  return 'closed';
}

function cashClock(et) {
  const id = cashClockId(et);
  return { id, label: CASH_CLOCK_LABELS[id] || CASH_CLOCK_LABELS.closed };
}

function sessionOpenOnCalendar(sess, et) {
  const id = sess && sess.id;
  const clock = cashClockId(et);
  if (id === 'overnight') return clock === 'overnight';
  if (id === 'am') return clock === 'premarket';
  if (id === 'market') return clock === 'market';
  if (id === 'post') return clock === 'post';
  const dow = etDow(et);
  if (dow == null) return true;
  return dow >= 1 && dow <= 5;
}

function activeSession(et, sessions) {
  for (const sess of sessions || []) {
    if (!sess.enabled) continue;
    if (!sessionOpenOnCalendar(sess, et)) continue;
    const startMins = parseHHMM(sess.start);
    const endMins = parseHHMM(sess.end);
    if (startMins == null || endMins == null) continue;
    if (!minsInWindow(et.mins, startMins, endMins)) continue;
    return { ...sess, bounds: sessionBounds(et, sess) };
  }
  return null;
}

module.exports = {
  IDENT,
  SKIP_FIELDS,
  SESSION_1M_FIELD,
  VIRTUAL_FIELDS,
  PLAY_MODES,
  PLAY_TFS,
  ENTRY_VOL_VS,
  ENTRY_RULES,
  EXIT_RULES,
  RTH_PLAY_IDS,
  TF_SPEC,
  normalizePlayMode,
  normalizeTf,
  normalizeEntryRule,
  normalizeExitRule,
  tfMeta,
  confirmSpec,
  isGreen2Play,
  isRthPlay,
  clampCount,
  resolveOpraDualLeg,
  opraDualLegOn,
  classifyType,
  defaultConfig,
  defaultOptions,
  sanitizeOptions,
  defaultAgent,
  sanitizeAgent,
  mergeConfig,
  loadConfig,
  saveConfig,
  quoteIdent,
  filterSql,
  securityTypesFromFilters,
  securityTypeSql,
  parseHHMM,
  scanReady,
  minsInWindow,
  addDays,
  sessionBounds,
  CASH_CLOCK_LABELS,
  etDow,
  cashClockId,
  cashClock,
  sessionOpenOnCalendar,
  activeSession,
  sess1mFromTs,
  sanitizeFilter,
  sessionPlay,
  sess1mBoundsFromFilters,
  ensureSess1mFilter,
  uid,
  toRiskDesk,
  fromRiskDesk,
  isRiskDeskPatch,
  applyScannerToSessions,
  sessionToDeskPlay,
  applySessionDeskPatch,
  applySessionDeskPatches,
  publicPlayName,
};
