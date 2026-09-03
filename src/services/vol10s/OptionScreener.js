'use strict';

/**
 * Options screener — Alpaca optionable assets ranked by day volume,
 * scanned for nearest-expiry OTM option flow via snapshots.
 *
 *   - refreshUniverse(): optionable assets ∩ CH metrics, ranked by the
 *     greatest avg_1m_vol field DESC, capped at universeCap.
 *   - scan(): per symbol, spot → nearest non-0DTE expiry ≤ maxDte → the
 *     otmLegs nearest OTM calls + puts → snapshot volume/OI/greeks.
 *   - Latest result persisted to ${dataDir}/options-scan.json (tmp+rename),
 *     reloaded on boot when < 24h old. start()/stop() run scan on a timer.
 */

const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const VOL_FIELDS = ['avg_1m_vol_overnight', 'avg_1m_vol_premarket', 'avg_1m_vol_market', 'avg_1m_vol_post'];
const { resolveOpenInterest } = require('./OptionsClient');

function parseSecurityTypes(raw, fallback = null) {
  if (Array.isArray(raw) && raw.length) {
    return raw.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean);
  }
  const env = String(process.env.VOL10S_OPT_SECURITY_TYPES || '').trim();
  if (env) {
    return env.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  }
  return fallback;
}

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function atomicSave(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, filePath);
}

class OptionScreener {
  constructor(opts = {}) {
    this.optionsClient = opts.optionsClient;
    this.ch = opts.clickhouse;
    this.log = opts.log || console;
    this.dataDir = opts.dataDir || path.resolve(__dirname, '../../data/vol10s-paper');
    const cfg = opts.config || {};
    this.config = {
      universeCap: Number(cfg.universeCap) || intEnv('VOL10S_OPT_UNIVERSE_CAP', 150),
      scanConcurrency: Number(cfg.scanConcurrency) || intEnv('VOL10S_OPT_SCAN_CONCURRENCY', 12),
      otmLegs: Number(cfg.otmLegs) || 5,
      maxDte: Number(cfg.maxDte) || intEnv('VOL10S_OPT_MAX_DTE', 28),
      refreshMs: Number(cfg.refreshMs) || 120000,
      minPrice: Number(cfg.minPrice) || 5,
      maxPrice: Number(cfg.maxPrice) || 500,
      securityTypes: parseSecurityTypes(cfg.securityTypes),
    };

    this.universe = [];
    this.rows = [];
    this.scanning = false;
    this.scanned = 0;
    this.failed = 0;
    this.lastScanAt = null;
    this.lastScanMs = null;
    this._timer = null;
    this.onBroadcast = null; // wired by the server to WS
    this._cacheFile = path.join(this.dataDir, 'options-scan.json');
    this._loadCache();
  }

  _loadCache() {
    try {
      if (!fs.existsSync(this._cacheFile)) return;
      const ageMs = Date.now() - fs.statSync(this._cacheFile).mtimeMs;
      if (ageMs >= DAY_MS) return;
      const data = JSON.parse(fs.readFileSync(this._cacheFile, 'utf8'));
      if (!Array.isArray(data.rows)) return;
      this.rows = data.rows;
      this.scanned = data.scanned || data.rows.length;
      this.failed = data.failed || 0;
      this.lastScanAt = data.lastScanAt || null;
      this.lastScanMs = data.lastScanMs || null;
      this.log.info?.(`[optscan] loaded cached scan (${this.rows.length} rows from ${this.lastScanAt})`);
    } catch (err) {
      this.log.warn?.(`[optscan] cache load failed: ${err.message}`);
    }
  }

  _saveCache() {
    try {
      atomicSave(this._cacheFile, {
        lastScanAt: this.lastScanAt,
        lastScanMs: this.lastScanMs,
        scanned: this.scanned,
        failed: this.failed,
        rows: this.rows,
      });
    } catch (err) {
      this.log.warn?.(`[optscan] cache save failed: ${err.message}`);
    }
  }

  // Optionable Alpaca assets ranked by day volume from stock snapshots.
  async refreshUniverse() {
    const assets = await this.optionsClient.listOptionableAssets();
    const rows = [];
    const cap = this.config.universeCap;
    for (const a of (assets || []).slice(0, cap * 4)) {
      if (rows.length >= cap) break;
      try {
        const snap = await this.optionsClient.getStockSnapshot(a.symbol);
        const last = Number(snap?.last) || 0;
        if (last < this.config.minPrice || last > this.config.maxPrice) continue;
        rows.push({
          symbol: a.symbol,
          name: a.name,
          exchange: a.exchange,
          lastClose: last,
          metrics: { day_volume: snap?.dayVolume || 0 },
          rankVol: snap?.dayVolume || 0,
        });
      } catch (_) { /* skip */ }
    }
    rows.sort((a, b) => b.rankVol - a.rankVol);
    this.universe = rows.slice(0, cap);
    return this.universe;
  }

  async _scanSymbol(u) {
    const oc = this.optionsClient;
    const spot = await oc.getUnderlyingSpot(u.symbol);
    if (!(spot > 0)) throw new Error('no spot');

    const today = new Date().toISOString().slice(0, 10);
    const gte = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10); // skip 0DTE
    const lte = new Date(Date.now() + this.config.maxDte * DAY_MS).toISOString().slice(0, 10);
    const contracts = await oc.listContracts(u.symbol, { expirationGte: gte, expirationLte: lte });
    if (!contracts.length) throw new Error('no chain in window');

    const expiry = contracts[0].expiration_date;
    const atExp = contracts.filter((c) => c.expiration_date === expiry);
    const dte = Math.max(1, Math.round((Date.parse(`${expiry}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS));

    const calls = atExp
      .filter((c) => c.type === 'call' && parseFloat(c.strike_price) > spot)
      .sort((a, b) => parseFloat(a.strike_price) - parseFloat(b.strike_price))
      .slice(0, this.config.otmLegs);
    const puts = atExp
      .filter((c) => c.type === 'put' && parseFloat(c.strike_price) < spot)
      .sort((a, b) => parseFloat(b.strike_price) - parseFloat(a.strike_price))
      .slice(0, this.config.otmLegs);

    const snaps = await oc.getSnapshotsByUnderlying(u.symbol, { spot });
    const leg = (c) => {
      const s = snaps[c.symbol] || {};
      return {
        occ: c.symbol,
        strike: parseFloat(c.strike_price),
        side: c.type,
        bid: s.bid || 0,
        ask: s.ask || 0,
        mid: s.mid || 0,
        iv: s.iv ?? null,
        delta: s.delta ?? null,
        oi: resolveOpenInterest(c, s),
        volume: s.volume || 0,
      };
    };
    const callLegs = calls.map(leg);
    const putLegs = puts.map(leg);
    const callVolume = callLegs.reduce((t, l) => t + (l.volume || 0), 0);
    const putVolume = putLegs.reduce((t, l) => t + (l.volume || 0), 0);

    return {
      symbol: u.symbol,
      name: u.name,
      lastClose: u.lastClose,
      spot,
      securityType: u.securityType,
      metrics: u.metrics,
      expiry,
      dte,
      calls: callLegs,
      puts: putLegs,
      totalVolume: callVolume + putVolume,
      callVolume,
      putVolume,
      callPutRatio: putVolume > 0 ? Math.round((callVolume / putVolume) * 100) / 100 : null,
      scannedAt: new Date().toISOString(),
    };
  }

  // Concurrency-limited worker pool over the universe. Symbols whose spot or
  // chain fetch fails are skipped and counted.
  async scan(onProgress) {
    if (this.scanning) return this.getState();
    this.scanning = true;
    const t0 = Date.now();
    this.scanned = 0;
    this.failed = 0;
    const rows = [];
    try {
      await this.refreshUniverse();
      const items = this.universe;
      let idx = 0;
      const worker = async () => {
        while (idx < items.length) {
          const u = items[idx];
          idx += 1;
          try {
            const row = await this._scanSymbol(u);
            rows.push(row);
            this.scanned += 1;
          } catch (err) {
            this.failed += 1;
          }
          if (onProgress) onProgress({ done: this.scanned + this.failed, total: items.length, symbol: u.symbol });
        }
      };
      const n = Math.min(this.config.scanConcurrency, items.length || 1);
      await Promise.all(Array.from({ length: n }, () => worker()));

      rows.sort((a, b) => b.totalVolume - a.totalVolume);
      this.rows = rows;
      this.lastScanAt = new Date().toISOString();
      this.lastScanMs = Date.now() - t0;
      this._saveCache();
      const state = this.getState();
      if (typeof this.onBroadcast === 'function') this.onBroadcast(state);
      this.log.info?.(`[optscan] scan done in ${this.lastScanMs}ms — ${this.scanned} scanned, ${this.failed} failed, universe ${this.universe.length}`);
      return state;
    } finally {
      this.scanning = false;
    }
  }

  getState() {
    return {
      universeSize: this.universe.length,
      scanned: this.scanned,
      failed: this.failed,
      lastScanAt: this.lastScanAt,
      lastScanMs: this.lastScanMs,
      scanning: this.scanning,
      rows: this.rows,
    };
  }

  start() {
    if (this._timer) return;
    if (!this.rows.length) {
      this.scan().catch((err) => this.log.warn?.(`[optscan] scan failed: ${err.message}`));
    } else {
      this.log.info?.(`[optscan] using cached rows (${this.rows.length}); auto-scan every ${Math.round(this.config.refreshMs / 1000)}s — Scan now for a fresh pass`);
    }
    this._timer = setInterval(() => {
      this.scan().catch((err) => this.log.warn?.(`[optscan] scan failed: ${err.message}`));
    }, this.config.refreshMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = OptionScreener;
