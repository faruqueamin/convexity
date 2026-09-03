'use strict';

/**
 * Options data layer — trimmed port of parabolic-hft-server OptionsClient.
 *
 *   - Trading API (contracts list, orders)  → apiBase  (paper only, assertPaper)
 *   - Market data API (snapshots, spot)     → dataUrl  (https://data.alpaca.markets)
 *
 * Data REST may rotate extraCreds on 429 (open-burst snapshots). Trading API
 * stays on the paper key. OPRA websocket is wired separately in LiveMarketHub.
 *
 * Kept: pagination, 60s chain cache + in-flight coalescing, 1.5s snapshot cache,
 * retry on 429/502/503/504, local Black-Scholes fallback for missing greeks/IV
 * (Newton-Raphson from NBBO mid, r=0.043, min TTE 600s).
 */

const https = require('https');
const { URL } = require('url');

const DAY_MS = 24 * 60 * 60 * 1000;
const BS_RFR = 0.043;
const BS_MIN_TTE_SEC = 600;

function assertPaper(baseUrl, key) {
  const u = String(baseUrl || '').toLowerCase();
  if (!u.includes('paper-api.alpaca.markets')) {
    throw new Error('Vol10s options client refuses non-paper Alpaca URL');
  }
  if (String(key || '').startsWith('AK')) {
    throw new Error('Vol10s options client refuses live-looking Alpaca key (AK…)');
  }
}

function todayStr(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function atmCandidates(atExp, spot) {
  const px = Number(spot);
  return [...(atExp || [])].sort((a, b) => {
    const da = Math.abs(parseFloat(a.strike_price) - px);
    const db = Math.abs(parseFloat(b.strike_price) - px);
    if (da !== db) return da - db;
    return parseFloat(a.strike_price) - parseFloat(b.strike_price);
  });
}

function expiriesOf(contracts) {
  return [...new Set((contracts || []).map((c) => c.expiration_date).filter(Boolean))].sort();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** OI lives on Trading API contracts, not market-data snapshots (Alpaca design). */
function contractOpenInterest(c) {
  if (!c) return null;
  const raw = c.open_interest ?? c.openInterest;
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function contractOpenInterestDate(c) {
  if (!c) return null;
  const d = c.open_interest_date ?? c.openInterestDate;
  return d ? String(d) : null;
}

function resolveOpenInterest(c, snap) {
  const fromSnap = snap?.openInterest;
  if (fromSnap != null && Number.isFinite(Number(fromSnap))) return parseInt(fromSnap, 10);
  return contractOpenInterest(c);
}

// ─── Black-Scholes helpers (ported from reference; all pure) ─────────────────

function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

// Zelen & Severo rational approximation for Φ(x) (abs error < 7.5e-8).
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

function bsD1(S, K, T, r, q, sigma) {
  return (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
}

function bsPrice(S, K, T, r, q, sigma, isCall) {
  if (!(T > 0) || !(sigma > 0)) return Math.max(0, isCall ? S - K : K - S);
  const sqT = Math.sqrt(T);
  const d1 = bsD1(S, K, T, r, q, sigma);
  const d2 = d1 - sigma * sqT;
  const df = Math.exp(-r * T);
  const dq = Math.exp(-q * T);
  return isCall
    ? S * dq * normCdf(d1) - K * df * normCdf(d2)
    : K * df * normCdf(-d2) - S * dq * normCdf(-d1);
}

// Newton-Raphson IV from an option price. null when at/below intrinsic or diverged.
function impliedVol(price, S, K, T, r, q, isCall) {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const intrinsic = Math.max(0, isCall ? S - K : K - S);
  if (!(price > intrinsic + 1e-6)) return null;
  let sigma = 0.5;
  for (let i = 0; i < 60; i++) {
    const sqT = Math.sqrt(T);
    const d1 = bsD1(S, K, T, r, q, sigma);
    const vega = S * Math.exp(-q * T) * normPdf(d1) * sqT;
    const diff = bsPrice(S, K, T, r, q, sigma, isCall) - price;
    if (Math.abs(diff) < 1e-6) break;
    if (!(vega > 1e-10)) break;
    sigma -= diff / vega;
    if (!(sigma > 0)) sigma = 1e-4;
    if (sigma > 5) sigma = 5;
  }
  return (sigma > 0 && Number.isFinite(sigma)) ? sigma : null;
}

function bsGreeks(S, K, T, r, q, sigma, isCall) {
  const sqT = Math.sqrt(T);
  const d1 = bsD1(S, K, T, r, q, sigma);
  const d2 = d1 - sigma * sqT;
  const dq = Math.exp(-q * T);
  const df = Math.exp(-r * T);
  const pdf = normPdf(d1);
  const delta = isCall ? dq * normCdf(d1) : dq * (normCdf(d1) - 1);
  const gamma = dq * pdf / (S * sigma * sqT);
  const vega = S * dq * pdf * sqT / 100; // per 1 vol-point
  const theta = (
    -(S * dq * pdf * sigma) / (2 * sqT)
    - (isCall ? 1 : -1) * r * K * df * normCdf(isCall ? d2 : -d2)
    + (isCall ? 1 : -1) * q * S * dq * normCdf(isCall ? d1 : -d1)
  ) / 365; // per calendar day
  return { delta, gamma, theta, vega };
}

// ET wall-clock parts for an instant (DST-safe via Intl timeZone).
function etWallClock(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const get = (t) => parseInt(parts.find((p) => p.type === t)?.value, 10) || 0;
  let h = get('hour');
  if (h === 24) h = 0;
  return { y: get('year'), m: get('month'), d: get('day'), h, min: get('minute'), s: get('second') };
}

// OCC symbol decoder: ROOT(1-6) + YYMMDD + C/P + STRIKEx1000(8)
//   AAPL260530C00220000 → { underlying:'AAPL', expiry:'2026-05-30', side:'call', strike:220 }
function parseOcc(occ) {
  if (!occ || typeof occ !== 'string') return null;
  const m = /^([A-Z][A-Z0-9]{0,5})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ);
  if (!m) return null;
  const [, root, yy, mm, dd, sideChar, strikeStr] = m;
  return {
    underlying: root,
    expiry: `${2000 + parseInt(yy, 10)}-${mm}-${dd}`,
    side: sideChar === 'C' ? 'call' : 'put',
    strike: parseInt(strikeStr, 10) / 1000,
    occ,
  };
}

// Seconds until 4:00pm ET on the contract's expiration date (any DTE).
function secondsToExpiryET(occSymbol, now = new Date()) {
  const occ = parseOcc(occSymbol);
  if (!occ) return 0;
  const [ey, em, ed] = occ.expiry.split('-').map(Number);
  const cur = etWallClock(now);
  const dayDiff = Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(cur.y, cur.m - 1, cur.d)) / DAY_MS);
  const curSec = cur.h * 3600 + cur.min * 60 + cur.s;
  return Math.max(0, dayDiff * 86400 + 16 * 3600 - curSec);
}

// When live spot has moved ahead of a stale option NBBO, mid can sit below
// intrinsic and IV is unsolvable — bound spot so BS sees positive extrinsic.
function spotForIvSolve(spot, K, mid, isCall, eps = 0.01) {
  if (!(spot > 0) || !(mid > 0) || !(K > 0)) return spot;
  if (isCall) {
    if (spot > K && mid < spot - K + 1e-6) return Math.max(K + eps, K + mid - eps);
  } else if (spot < K && mid < K - spot + 1e-6) {
    return Math.min(K - eps, K - mid + eps);
  }
  return spot;
}

// Solve IV + greeks from live mid + spot for any DTE (sync, no network).
// Returns { iv, greeks:{delta,gamma,theta,vega}, local:true } or null.
function computeLocalGreeksFromMid({ occSymbol, mid, spot, r = BS_RFR, q = 0, minTteSec = BS_MIN_TTE_SEC }) {
  if (!(mid > 0) || !(spot > 0) || !occSymbol) return null;
  const occ = parseOcc(occSymbol);
  if (!occ) return null;
  const tteSec = Math.max(secondsToExpiryET(occSymbol), minTteSec);
  const T = tteSec / (365 * 24 * 3600);
  const isCall = occ.side === 'call';
  const K = occ.strike;
  let spotS = spot;
  let sigma = impliedVol(mid, spotS, K, T, r, q, isCall);
  if (sigma == null) {
    const adj = spotForIvSolve(spot, K, mid, isCall);
    if (adj !== spot) {
      spotS = adj;
      sigma = impliedVol(mid, spotS, K, T, r, q, isCall);
    }
  }
  if (sigma == null) {
    const itm = isCall ? spotS > K : spotS < K;
    return {
      iv: null,
      greeks: { delta: isCall ? (itm ? 1 : 0) : (itm ? -1 : 0), gamma: 0, theta: 0, vega: 0 },
      local: true,
    };
  }
  return { iv: sigma, greeks: bsGreeks(spotS, K, T, r, q, sigma, isCall), local: true };
}

// ─────────────────────────────────────────────────────────────────────────────

class OptionsClient {
  constructor(opts = {}) {
    this.apiBase = (opts.apiBase || process.env.VOL10S_ALPACA_BASE_URL || '').replace(/\/+$/, '').replace(/\/v2$/i, '');
    this.dataUrl = (opts.dataUrl || process.env.VOL10S_ALPACA_DATA_URL || 'https://data.alpaca.markets').replace(/\/+$/, '');
    this.key = opts.key || process.env.VOL10S_ALPACA_KEY || '';
    this.secret = opts.secret || process.env.VOL10S_ALPACA_SECRET || '';
    this.dataKey = opts.dataKey || process.env.VOL10S_DATA_ALPACA_KEY || this.key;
    this.dataSecret = opts.dataSecret || process.env.VOL10S_DATA_ALPACA_SECRET || this.secret;
    this.feed = String(opts.feed || process.env.VOL10S_ALPACA_OPTIONS_FEED || 'indicative').toLowerCase() === 'opra' ? 'opra' : 'indicative';
    this.log = opts.log || console;
    this.timeoutMs = parseInt(opts.timeoutMs || '15000', 10);
    this.enabled = Boolean(this.apiBase && this.key && this.secret);
    if (this.enabled) assertPaper(this.apiBase, this.key);

    // Data REST pool: paid OPRA key first, then extras. Round-robin + rotate
    // on 429 so snapshot bursts don't stall the screener. Never put the paper
    // trading key here — it is not OPRA-entitled and would 403 the probe.
    this._dataCreds = [];
    const pushData = (key, secret) => {
      if (!key || !secret) return;
      if (this._dataCreds.some((c) => c.key === key)) return;
      this._dataCreds.push({ key, secret });
    };
    pushData(this.dataKey, this.dataSecret);
    if (Array.isArray(opts.extraDataCreds)) {
      for (const c of opts.extraDataCreds) pushData(c && c.key, c && c.secret);
    }
    if (!this._dataCreds.length) this._dataCreds.push({ key: this.dataKey, secret: this.dataSecret });
    this._dataCredIdx = 0;
    if (this._dataCreds.length > 1) {
      this.log.info?.(`[options] REST rotation across ${this._dataCreds.length} data accounts (snapshots; trading stays paper)`);
    }

    this.chainTtlMs = parseInt(opts.chainTtlMs || '60000', 10);
    this.snapshotTtlMs = parseInt(opts.snapshotTtlMs || '1500', 10);
    this.assetsTtlMs = parseInt(opts.assetsTtlMs || String(6 * 3600 * 1000), 10);

    this._assetsCache = null;              // { rows, ts }
    this._chainCache = new Map();          // underlying -> { contracts, ts }
    this._snapshotCache = new Map();       // underlying -> { snaps, ts }
    this._inflightChain = new Map();       // underlying -> Promise
    this._inflightSnap = new Map();        // underlying -> Promise
  }

  _isDataUrl(fullUrl) {
    try { return (new URL(fullUrl).hostname || '').includes('data.alpaca.markets'); }
    catch (_) { return false; }
  }

  _nextDataCred() {
    const c = this._dataCreds[this._dataCredIdx % this._dataCreds.length];
    this._dataCredIdx = (this._dataCredIdx + 1) % this._dataCreds.length;
    return c;
  }

  _keysForUrl(fullUrl, credOverride) {
    if (credOverride && credOverride.key) return credOverride;
    if (this._isDataUrl(fullUrl)) {
      return this._dataCreds[0] || { key: this.dataKey, secret: this.dataSecret };
    }
    return { key: this.key, secret: this.secret };
  }

  async probeFeed() {
    const url = `${this.dataUrl}/v1beta1/options/snapshots/SPY?limit=1&feed=opra`;
    try {
      await this._req('GET', url);
      this.feed = 'opra';
      this.log.info?.('[options] data feed=opra');
    } catch (err) {
      this.feed = 'indicative';
      this.log.warn?.(`[options] OPRA unavailable (${err.status || ''} ${err.message || err}) — using indicative`);
    }
    return this.feed;
  }

  // Raw request: resolves { status, headers, body } — never throws on HTTP status.
  _raw(method, fullUrl, body, credOverride) {
    if (!this.enabled) return Promise.reject(new Error('paper Alpaca keys not configured'));
    const url = new URL(fullUrl);
    const creds = this._keysForUrl(fullUrl, credOverride);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'APCA-API-KEY-ID': creds.key,
      'APCA-API-SECRET-KEY': creds.secret,
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: this.timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, path: url.pathname }));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Alpaca options timeout')); });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // Retrying JSON wrapper: 429/502/503/504 backoff (max 3 retries), honors
  // Retry-After; other statuses throw immediately with err.status set.
  async _req(method, fullUrl, body) {
    const backoffsMs = [150, 400, 900];
    const maxAttempts = backoffsMs.length + 1;
    let attempt = 0;
    let lastErr;
    const dataUrl = this._isDataUrl(fullUrl);
    let cred = dataUrl
      ? (this._dataCreds[0] || { key: this.dataKey, secret: this.dataSecret })
      : { key: this.key, secret: this.secret };
    while (attempt < maxAttempts) {
      let resp;
      try {
        resp = await this._raw(method, fullUrl, body, cred);
      } catch (err) {
        lastErr = err;
        attempt += 1;
        if (attempt >= maxAttempts) throw err;
        if (dataUrl && this._dataCreds.length > 1) cred = this._nextDataCred();
        const waitMs = backoffsMs[Math.min(attempt - 1, backoffsMs.length - 1)];
        this.log.warn?.(`[options] transport error on ${method} ${String(fullUrl).split('?')[0]} — retry ${attempt}/${maxAttempts - 1} in ${waitMs}ms: ${err.message}`);
        await sleep(waitMs);
        continue;
      }

      if (resp.status >= 200 && resp.status < 300) {
        try { return resp.body ? JSON.parse(resp.body) : {}; } catch (err) {
          throw new Error(`OptionsClient: bad JSON from ${fullUrl}: ${err.message}`);
        }
      }

      const retryable = resp.status === 429 || resp.status === 502 || resp.status === 503 || resp.status === 504;
      if (!retryable || attempt >= maxAttempts - 1) {
        const err = new Error(`Alpaca options ${resp.status} from ${method} ${resp.path}: ${(resp.body || '').slice(0, 300)}`);
        err.status = resp.status;
        if (resp.status === 429) {
          err.rateLimited = true;
          err.waitMs = 400;
        }
        throw err;
      }
      if (resp.status === 429 && dataUrl && this._dataCreds.length > 1) {
        cred = this._nextDataCred();
        this.log.warn?.('[options] HTTP 429 — rotating data account for retry');
      }

      let waitMs = backoffsMs[Math.min(attempt, backoffsMs.length - 1)];
      const ra = resp.headers && resp.headers['retry-after'];
      if (ra) {
        const raNum = parseFloat(ra);
        if (Number.isFinite(raNum) && raNum >= 0) waitMs = Math.max(waitMs, Math.ceil(raNum * 1000));
        else {
          const t = Date.parse(ra);
          if (Number.isFinite(t)) waitMs = Math.max(waitMs, t - Date.now());
        }
      }
      waitMs = Math.min(waitMs, 1500);
      if (resp.status === 429) {
        const err429 = new Error(`Alpaca options 429 from ${method} ${resp.path}`);
        err429.status = 429;
        err429.rateLimited = true;
        err429.waitMs = waitMs;
        if (attempt >= maxAttempts - 1) throw err429;
      }
      this.log.warn?.(`[options] HTTP ${resp.status} on ${method} ${resp.path} — retry ${attempt + 1}/${maxAttempts - 1} in ${waitMs}ms`);
      await sleep(waitMs);
      attempt += 1;
    }
    throw lastErr || new Error('OptionsClient: retry budget exhausted');
  }

  // ─── listOptionableAssets ─────────────────────────────────────────────────
  // GET /v2/assets?status=active&asset_class=us_equity&attributes=has_options
  // Returns [{ symbol, name, exchange, optionable }] — 6h cache.
  async listOptionableAssets() {
    if (this._assetsCache && (Date.now() - this._assetsCache.ts) < this.assetsTtlMs) {
      return this._assetsCache.rows;
    }
    const url = `${this.apiBase}/v2/assets?status=active&asset_class=us_equity&attributes=has_options`;
    const res = await this._req('GET', url);
    const list = Array.isArray(res) ? res : [];
    const rows = list
      .filter((a) => a && Array.isArray(a.attributes) && a.attributes.includes('has_options'))
      .map((a) => ({
        symbol: String(a.symbol || '').toUpperCase(),
        name: a.name || '',
        exchange: a.exchange || '',
        optionable: true,
      }))
      .filter((a) => a.symbol);
    this._assetsCache = { rows, ts: Date.now() };
    return rows;
  }

  // ─── listContracts ────────────────────────────────────────────────────────
  // Full active chain for an underlying, paginated, sorted expiry→strike.
  // Cached 60s per underlying; concurrent callers share one fetch.
  async listContracts(underlying, opts = {}) {
    const sym = String(underlying || '').toUpperCase();
    if (!sym) return [];

    const cached = this._chainCache.get(sym);
    if (cached && (Date.now() - cached.ts) < this.chainTtlMs) {
      return this._filterContracts(cached.contracts, opts);
    }
    if (this._inflightChain.has(sym)) {
      const all = await this._inflightChain.get(sym);
      return this._filterContracts(all, opts);
    }

    const fetchPromise = (async () => {
      try {
        const all = [];
        const params = new URLSearchParams({
          underlying_symbols: sym,
          status: 'active',
          limit: '1000',
          // Alpaca silently defaults expiration_date_lte to ~next weekend when
          // omitted — monthly-only names would return zero rows. Pass a wide
          // window; callers narrow via opts.
          expiration_date_gte: todayStr(0),
          expiration_date_lte: todayStr(370),
        });
        let url = `${this.apiBase}/v2/options/contracts?${params.toString()}`;
        let page = 0;
        while (url) {
          const res = await this._req('GET', url);
          const rows = Array.isArray(res.option_contracts) ? res.option_contracts : [];
          all.push(...rows);
          page += 1;
          const tok = res.next_page_token;
          if (tok && all.length < 5000 && page < 20) {
            const np = new URLSearchParams(params);
            np.set('page_token', tok);
            url = `${this.apiBase}/v2/options/contracts?${np.toString()}`;
          } else {
            url = null;
          }
        }
        all.sort((a, b) => {
          if (a.expiration_date !== b.expiration_date) {
            return String(a.expiration_date).localeCompare(String(b.expiration_date));
          }
          return parseFloat(a.strike_price || 0) - parseFloat(b.strike_price || 0);
        });
        this._chainCache.set(sym, { contracts: all, ts: Date.now() });
        return all;
      } finally {
        this._inflightChain.delete(sym);
      }
    })();

    this._inflightChain.set(sym, fetchPromise);
    const all = await fetchPromise;
    return this._filterContracts(all, opts);
  }

  _filterContracts(contracts, opts = {}) {
    return contracts.filter((c) => {
      if (opts.side && c.type !== opts.side) return false;
      if (opts.expirationGte && c.expiration_date < opts.expirationGte) return false;
      if (opts.expirationLte && c.expiration_date > opts.expirationLte) return false;
      if (c.tradable === false) return false;
      return true;
    });
  }

  // ─── getSnapshotsByUnderlying ─────────────────────────────────────────────
  // GET {dataUrl}/v1beta1/options/snapshots/{underlying}?limit=1000 (paginated).
  // Returns map occSymbol → { bid, ask, mid, last, iv, delta, gamma, theta,
  // vega, openInterest, volume }. openInterest is usually null — use
  // contractOpenInterest() on listContracts rows for OI. 1.5s cache per underlying. When Alpaca omits
  // greeks/IV and opts.spot > 0, fills them via the local BS fallback.
  async getSnapshotsByUnderlying(underlying, opts = {}) {
    const sym = String(underlying || '').toUpperCase();
    if (!sym) return {};

    const spot = Number(opts.spot) || 0;
    const cached = this._snapshotCache.get(sym);
    if (cached && (Date.now() - cached.ts) < this.snapshotTtlMs) {
      return cached.snaps;
    }
    if (this._inflightSnap.has(sym)) {
      return this._inflightSnap.get(sym);
    }

    const p = (async () => {
      try {
        const out = {};
        const feedQ = this.feed === 'opra' ? 'opra' : 'indicative';
        let url = `${this.dataUrl}/v1beta1/options/snapshots/${encodeURIComponent(sym)}?limit=1000&feed=${feedQ}`;
        let page = 0;
        while (url) {
          const res = await this._req('GET', url);
          const snaps = res.snapshots || {};
          for (const [occ, snap] of Object.entries(snaps)) {
            out[occ] = this._flattenSnapshot(occ, snap, spot);
          }
          page += 1;
          const tok = res.next_page_token;
          if (tok && page < 20) {
            url = `${this.dataUrl}/v1beta1/options/snapshots/${encodeURIComponent(sym)}?limit=1000&feed=${feedQ}&page_token=${encodeURIComponent(tok)}`;
          } else {
            url = null;
          }
        }
        this._snapshotCache.set(sym, { snaps: out, ts: Date.now() });
        return out;
      } finally {
        this._inflightSnap.delete(sym);
      }
    })();

    this._inflightSnap.set(sym, p);
    return p;
  }

  _flattenSnapshot(occ, snap, spot) {
    const lq = snap.latestQuote || {};
    const lt = snap.latestTrade || {};
    const bid = parseFloat(lq.bp) || 0;
    const ask = parseFloat(lq.ap) || 0;
    const bidSz = parseFloat(lq.bs) || 0;
    const askSz = parseFloat(lq.as) || 0;
    const last = parseFloat(lt.p) || 0;
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid > 0 ? bid : (ask > 0 ? ask : last));

    const ivRaw = snap.impliedVolatility ?? snap.implied_volatility ?? null;
    let iv = ivRaw != null && Number.isFinite(parseFloat(ivRaw)) ? parseFloat(ivRaw) : null;
    const g = snap.greeks || null;
    let greeks = g ? {
      delta: Number.isFinite(parseFloat(g.delta)) ? parseFloat(g.delta) : null,
      gamma: Number.isFinite(parseFloat(g.gamma)) ? parseFloat(g.gamma) : null,
      theta: Number.isFinite(parseFloat(g.theta)) ? parseFloat(g.theta) : null,
      vega: Number.isFinite(parseFloat(g.vega)) ? parseFloat(g.vega) : null,
    } : null;

    // Local BS fallback when the vendor omits greeks/IV (free tier, premarket,
    // thin contracts). Needs a live mid and the underlying spot.
    let local = false;
    if ((iv == null || !greeks || greeks.delta == null) && spot > 0 && mid > 0) {
      const solved = computeLocalGreeksFromMid({ occSymbol: occ, mid, spot });
      if (solved) {
        local = true;
        if (iv == null) iv = solved.iv;
        if (!greeks || greeks.delta == null) greeks = solved.greeks;
      }
    }

    const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
    return {
      bid: r2(bid) || 0,
      ask: r2(ask) || 0,
      mid: r2(mid) || 0,
      last: r2(last) || 0,
      bidSz: bidSz || 0,
      askSz: askSz || 0,
      iv,
      delta: greeks ? greeks.delta : null,
      gamma: greeks ? greeks.gamma : null,
      theta: greeks ? greeks.theta : null,
      vega: greeks ? greeks.vega : null,
      openInterest: snap.openInterest != null ? parseInt(snap.openInterest, 10) : null,
      volume: snap.dailyBar && snap.dailyBar.v != null ? parseInt(snap.dailyBar.v, 10) : null,
      local,
    };
  }

  // ─── getUnderlyingSpot ────────────────────────────────────────────────────
  // GET {dataUrl}/v2/stocks/{symbol}/trades/latest, fallback to bars/latest.
  async getUnderlyingSpot(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return null;
    try {
      const res = await this._req('GET', `${this.dataUrl}/v2/stocks/${encodeURIComponent(sym)}/trades/latest`);
      const px = parseFloat(res?.trade?.p);
      if (px > 0) return px;
    } catch (err) {
      this.log.warn?.(`[options] latest trade for ${sym} failed (${err.message}) — trying latest bar`);
    }
    const res = await this._req('GET', `${this.dataUrl}/v2/stocks/${encodeURIComponent(sym)}/bars/latest`);
    const px = parseFloat(res?.bar?.c);
    return px > 0 ? px : null;
  }

  /**
   * Alpaca stock bars. timeframe: 1Min | 5Min | 15Min | 1Hour | 1Day
   * feed falls back to iex when SIP is not entitled.
   */
  async getStockBars(symbol, { timeframe = '1Min', limit = 40, feed } = {}) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return [];
    const tf = String(timeframe || '1Min');
    const lim = Math.max(1, Math.min(200, Math.floor(Number(limit) || 40)));
    const q = new URLSearchParams({ timeframe: tf, limit: String(lim), sort: 'asc' });
    if (feed) q.set('feed', feed);
    const url = `${this.dataUrl}/v2/stocks/${encodeURIComponent(sym)}/bars?${q.toString()}`;
    try {
      const res = await this._req('GET', url);
      return (res.bars || []).map((b) => ({
        t: b.t, open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v) || 0,
      }));
    } catch (err) {
      if (!feed && /sip|subscription|403/i.test(String(err.message))) {
        return this.getStockBars(sym, { timeframe: tf, limit: lim, feed: 'iex' });
      }
      throw err;
    }
  }

  async getStockSnapshot(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return null;
    const res = await this._req('GET', `${this.dataUrl}/v2/stocks/${encodeURIComponent(sym)}/snapshot`);
    return {
      symbol: sym,
      last: parseFloat(res?.latestTrade?.p) || parseFloat(res?.dailyBar?.c) || 0,
      prevClose: parseFloat(res?.prevDailyBar?.c) || 0,
      dayVolume: parseInt(res?.dailyBar?.v, 10) || 0,
      prevVolume: parseInt(res?.prevDailyBar?.v, 10) || 0,
    };
  }

  async getPrevClose(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return null;
    const res = await this._req('GET', `${this.dataUrl}/v2/stocks/${encodeURIComponent(sym)}/snapshot`);
    const prev = parseFloat(res?.prevDailyBar?.c);
    const daily = parseFloat(res?.dailyBar?.c);
    const last = parseFloat(res?.latestTrade?.p);
    return {
      prevClose: prev > 0 ? prev : (daily > 0 ? daily : null),
      last: last > 0 ? last : null,
    };
  }

  /** Live mark for UI / ATM pin — quote mid, else last trade. Not yesterday's official close. */
  async getUnderlyingMark(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return null;
    try {
      const res = await this._req('GET', `${this.dataUrl}/v2/stocks/${encodeURIComponent(sym)}/snapshot`);
      const bid = parseFloat(res?.latestQuote?.bp) || 0;
      const ask = parseFloat(res?.latestQuote?.ap) || 0;
      const last = parseFloat(res?.latestTrade?.p) || 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
      const px = mid || last || 0;
      if (px > 0) return { last: last || null, bid: bid || null, ask: ask || null, mid: px };
    } catch (_) { /* fall through */ }
    const last = Number(await this.getUnderlyingSpot(sym).catch(() => 0)) || 0;
    return last > 0 ? { last, bid: null, ask: null, mid: last } : null;
  }

  etTodayStr(offsetDays = 0) {
    const w = etWallClock();
    const dt = new Date(Date.UTC(w.y, w.m - 1, w.d + Number(offsetDays || 0)));
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  _dte(expiry) {
    if (!expiry) return null;
    const today = this.etTodayStr(0);
    if (String(expiry) === today) return 0;
    const ms = Date.parse(`${expiry}T20:00:00Z`);
    if (!Number.isFinite(ms)) return null;
    return Math.max(0, Math.round((ms - Date.now()) / DAY_MS));
  }

  _packContract(c, snap, spot) {
    const bid = Number(snap?.bid) || 0;
    const ask = Number(snap?.ask) || 0;
    const mid = Number(snap?.mid) || 0;
    const spreadPct = bid > 0 && ask > 0 && mid > 0 ? ((ask - bid) / mid) * 100 : null;
    const expiry = c.expiration_date;
    const dte = this._dte(expiry);
    return {
      occ: c.symbol,
      symbol: c.symbol,
      strike: parseFloat(c.strike_price),
      expiry,
      dte,
      side: c.type === 'put' ? 'put' : 'call',
      bid,
      ask,
      mid,
      last: Number(snap?.last) || 0,
      delta: snap?.delta ?? null,
      iv: snap?.iv ?? null,
      oi: resolveOpenInterest(c, snap),
      oiDate: contractOpenInterestDate(c),
      volume: snap?.volume ?? null,
      spreadPct: spreadPct != null ? Math.round(spreadPct * 10) / 10 : null,
      bidSz: Number(snap?.bidSz) || 0,
      askSz: Number(snap?.askSz) || 0,
      spot: Number(spot) || null,
    };
  }

  // First listed expiry (0DTE / weekly / monthly), ATM strike with a quote.
  async pickAtmNearest(underlying, spot, side = 'call', opts = {}) {
    const sym = String(underlying || '').toUpperCase();
    const px = Number(spot);
    const sd = side === 'put' ? 'put' : 'call';
    if (!sym || !(px > 0)) return { ok: false, reason: 'bad_args', detail: { underlying, spot } };

    const allow0 = opts.allow0dte !== false && opts.skipZeroDte !== true;
    const maxDte = Math.max(0, parseInt(opts.maxDte, 10) || 45);
    const expirationGte = this.etTodayStr(allow0 ? 0 : 1);
    const expirationLte = this.etTodayStr(Math.max(allow0 ? 0 : 1, maxDte));

    let contracts;
    try {
      contracts = await this.listContracts(sym, { side: sd, expirationGte, expirationLte });
    } catch (err) {
      return { ok: false, reason: 'list_contracts_failed', detail: { error: err.message, side: sd, maxDte } };
    }
    if (!contracts.length) {
      return { ok: false, reason: 'no_chain_in_window', detail: { side: sd, expirationGte, expirationLte } };
    }

    let snaps = {};
    try {
      snaps = await this.getSnapshotsByUnderlying(sym, { spot: px });
    } catch (err) {
      return { ok: false, reason: 'snapshot_failed', detail: { error: err.message, side: sd } };
    }

    for (const exp of expiriesOf(contracts)) {
      const atExp = contracts.filter((c) => c.expiration_date === exp);
      const ranked = atmCandidates(atExp, px);
      for (const cand of ranked.slice(0, 12)) {
        const packed = this._packContract(cand, snaps[cand.symbol] || {}, px);
        if (packed.bid > 0 || packed.mid > 0 || packed.ask > 0) {
          return { ok: true, contract: packed, feed: this.feed };
        }
      }
    }
    return { ok: false, reason: 'no_atm_quote', detail: { side: sd, expiries: expiriesOf(contracts) } };
  }

  /** ATM call + put on the same expiry/strike. Used for dual-leg OPRA subscribe. */
  async pickAtmPair(underlying, spot, opts = {}) {
    const sym = String(underlying || '').toUpperCase();
    const px = Number(spot);
    if (!sym || !(px > 0)) return { ok: false, reason: 'bad_args', detail: { underlying, spot } };

    const allow0 = opts.allow0dte !== false && opts.skipZeroDte !== true;
    const maxDte = Math.max(0, parseInt(opts.maxDte, 10) || 45);
    const expirationGte = this.etTodayStr(allow0 ? 0 : 1);
    const expirationLte = this.etTodayStr(Math.max(allow0 ? 0 : 1, maxDte));

    let contracts;
    try {
      contracts = await this.listContracts(sym, { expirationGte, expirationLte });
    } catch (err) {
      return { ok: false, reason: 'list_contracts_failed', detail: { error: err.message } };
    }
    if (!contracts.length) {
      return { ok: false, reason: 'no_chain_in_window', detail: { expirationGte, expirationLte } };
    }

    let snaps = {};
    try {
      snaps = await this.getSnapshotsByUnderlying(sym, { spot: px });
    } catch (err) {
      if (!opts.allowUnquoted) {
        return { ok: false, reason: 'snapshot_failed', detail: { error: err.message } };
      }
      snaps = {};
    }

    const typeOf = (c) => String(c.type || '').toLowerCase();
    const quoted = (packed) => packed && (Number(packed.bid) > 0 || Number(packed.mid) > 0 || Number(packed.ask) > 0);
    let fallback = null;

    for (const exp of expiriesOf(contracts)) {
      const atExp = contracts.filter((c) => c.expiration_date === exp);
      const strikes = [...new Set(atExp.map((c) => parseFloat(c.strike_price)).filter(Number.isFinite))]
        .sort((a, b) => Math.abs(a - px) - Math.abs(b - px) || a - b);
      for (const strike of strikes.slice(0, 8)) {
        const callRaw = atExp.find((c) => typeOf(c) === 'call' && Math.abs(parseFloat(c.strike_price) - strike) < 1e-4);
        const putRaw = atExp.find((c) => typeOf(c) === 'put' && Math.abs(parseFloat(c.strike_price) - strike) < 1e-4);
        if (!callRaw?.symbol || !putRaw?.symbol) continue;
        const call = this._packContract(callRaw, snaps[callRaw.symbol] || {}, px);
        const put = this._packContract(putRaw, snaps[putRaw.symbol] || {}, px);
        if (quoted(call) && quoted(put)) {
          return { ok: true, call, put, strike, expiry: exp, feed: this.feed };
        }
        if (opts.allowUnquoted && !fallback) {
          fallback = { ok: true, call, put, strike, expiry: exp, feed: this.feed, unquoted: true };
        }
      }
    }
    if (fallback) return fallback;
    return { ok: false, reason: 'no_atm_pair', detail: { expiries: expiriesOf(contracts) } };
  }

  // Alias — same ATM nearest-expiry picker (kept for heartbeat / older callers).
  async attachZeroDteItm(underlying, spot, side = 'call') {
    return this.pickAtmNearest(underlying, spot, side, { allow0dte: true, maxDte: 45 });
  }

  /** Sum chain volume + OI for the expiry pickContract would target. */
  async chainExpiryTotals(underlying, spot, opts = {}) {
    const sym = String(underlying || '').toUpperCase();
    const px = Number(spot);
    if (!sym || !(px > 0)) return { ok: false, reason: 'bad_args' };

    const allow0 = opts.allow0dte !== false && opts.skipZeroDte !== true;
    const maxDte = Math.max(0, parseInt(opts.maxDte, 10) || 45);
    const expirationGte = this.etTodayStr(allow0 ? 0 : 1);
    const expirationLte = this.etTodayStr(Math.max(allow0 ? 0 : 1, maxDte));

    let contracts;
    try {
      contracts = await this.listContracts(sym, { expirationGte, expirationLte });
    } catch (err) {
      return { ok: false, reason: 'list_contracts_failed', detail: { error: err.message } };
    }
    if (!contracts.length) {
      return { ok: false, reason: 'no_chain_in_window', detail: { expirationGte, expirationLte } };
    }

    let snaps = {};
    try {
      snaps = await this.getSnapshotsByUnderlying(sym, { spot: px });
    } catch (err) {
      return { ok: false, reason: 'snapshot_failed', detail: { error: err.message } };
    }

    const exps = expiriesOf(contracts);
    let targetExp = null;
    for (const exp of exps) {
      const atExp = contracts.filter((c) => c.expiration_date === exp);
      const ranked = atmCandidates(atExp, px);
      for (const cand of ranked.slice(0, 12)) {
        const packed = this._packContract(cand, snaps[cand.symbol] || {}, px);
        if (packed.bid > 0 || packed.mid > 0 || packed.ask > 0) {
          targetExp = exp;
          break;
        }
      }
      if (targetExp) break;
    }
    if (!targetExp) targetExp = exps[0];

    const atExp = contracts.filter((c) => c.expiration_date === targetExp);
    let totalVol = 0;
    let totalOi = 0;
    let callVol = 0;
    let putVol = 0;
    let callOi = 0;
    let putOi = 0;
    for (const c of atExp) {
      const s = snaps[c.symbol] || {};
      const vol = Number(s.volume) || 0;
      const oi = resolveOpenInterest(c, s) || 0;
      totalVol += vol;
      totalOi += oi;
      if (c.type === 'put') {
        putVol += vol;
        putOi += oi;
      } else {
        callVol += vol;
        callOi += oi;
      }
    }

    return {
      ok: true,
      expiry: targetExp,
      dte: this._dte(targetExp),
      totalVol,
      totalOi,
      callVol,
      putVol,
      callOi,
      putOi,
      contractCount: atExp.length,
    };
  }

  // ─── pickContract ─────────────────────────────────────────────────────────
  async pickContract(underlying, spot, side, opts = {}) {
    return this.pickAtmNearest(underlying, spot, side, opts);
  }

  parseOcc(sym) { return parseOcc(sym); }

  // ─── orders ───────────────────────────────────────────────────────────────
  // POST {apiBase}/v2/orders with the OCC symbol. qty = contracts (integer).
  // Limit when limitPrice given, else market. NO extended_hours (options 422
  // on it). A rejected market order (422/403) retries once as a limit at
  // ask*1.02 (buy) / bid*0.98 (sell) from a fresh snapshot.
  async placeOptionBuy(occ, qty, opts = {}) {
    return this._placeOptionOrder(occ, qty, 'buy', opts);
  }

  async placeOptionSell(occ, qty, opts = {}) {
    return this._placeOptionOrder(occ, qty, 'sell', opts);
  }

  async _placeOptionOrder(occ, qty, side, opts = {}) {
    const sym = String(occ || '').toUpperCase();
    if (!parseOcc(sym)) throw new Error(`placeOption${side}: bad OCC symbol ${occ}`);
    const n = Math.max(1, Math.floor(Number(qty) || 0));
    const lp = Number(opts.limitPrice);
    const body = {
      symbol: sym,
      qty: String(n),
      side,
      type: lp > 0 ? 'limit' : 'market',
      time_in_force: 'day',
    };
    if (body.type === 'limit') body.limit_price = lp.toFixed(2);

    try {
      return await this._req('POST', `${this.apiBase}/v2/orders`, body);
    } catch (err) {
      if (body.type !== 'market' || (err.status !== 422 && err.status !== 403)) throw err;
      const fallback = await this._marketFallbackLimit(sym, side);
      if (!(fallback > 0)) throw err;
      this.log.warn?.(`[options] ${side} market order for ${sym} rejected (${err.status}) — retrying as limit @ ${fallback.toFixed(2)}`);
      return this._req('POST', `${this.apiBase}/v2/orders`, {
        symbol: sym,
        qty: String(n),
        side,
        type: 'limit',
        limit_price: fallback.toFixed(2),
        time_in_force: 'day',
      });
    }
  }

  async _marketFallbackLimit(occ, side) {
    const parsed = parseOcc(occ);
    if (!parsed) return 0;
    const snaps = await this.getSnapshotsByUnderlying(parsed.underlying).catch(() => ({}));
    const snap = snaps[occ];
    if (!snap) return 0;
    const ref = side === 'buy' ? snap.ask : snap.bid;
    const pad = side === 'buy' ? 1.02 : 0.98;
    const px = Number(ref) * pad;
    return px > 0 ? Math.round(px * 100) / 100 : 0;
  }
}

module.exports = OptionsClient;
module.exports.parseOcc = parseOcc;
module.exports.atmCandidates = atmCandidates;
module.exports.expiriesOf = expiriesOf;
module.exports.computeLocalGreeksFromMid = computeLocalGreeksFromMid;
module.exports.assertPaper = assertPaper;
module.exports.contractOpenInterest = contractOpenInterest;
module.exports.contractOpenInterestDate = contractOpenInterestDate;
module.exports.resolveOpenInterest = resolveOpenInterest;
