'use strict';

/**
 * Public setup scanner — Alpaca market data only.
 *
 * Universe = optionable Alpaca assets. Each name is ranked by XGBoost
 * (contract book) + NTSM (1m tape). Nothing here is the private detector.
 */

const { SetupRanker } = require('../ml/SetupRanker');
const { resolveOpenInterest } = require('./OptionsClient');

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function spreadPct(bid, ask) {
  const mid = (n(bid) + n(ask)) / 2;
  if (!(bid > 0) || !(ask > 0) || !(mid > 0)) return 100;
  return ((ask - bid) / mid) * 100;
}

class SetupScanner {
  constructor({ optionsClient, ranker, log, universeCap, minScore } = {}) {
    this.optionsClient = optionsClient;
    this.ranker = ranker || new SetupRanker({ log });
    this.log = log || console;
    this.universeCap = Math.max(10, Math.min(200, Number(universeCap) || 40));
    this.minScore = n(minScore, 0.52);
    this.universe = [];
    this.lastScanAt = null;
    this.lastError = null;
  }

  async refreshUniverse() {
    const assets = await this.optionsClient.listOptionableAssets();
    const picked = (assets || []).slice(0, this.universeCap * 3);
    const rows = [];
    for (const a of picked) {
      if (rows.length >= this.universeCap) break;
      try {
        const snap = await this.optionsClient.getStockSnapshot(a.symbol);
        const last = n(snap?.last);
        if (!(last >= 5 && last <= 500)) continue;
        rows.push({
          symbol: a.symbol,
          name: a.name,
          exchange: a.exchange,
          lastClose: last,
          dayVolume: snap?.dayVolume || 0,
          rankVol: snap?.dayVolume || 0,
        });
      } catch (_) { /* skip name */ }
    }
    rows.sort((a, b) => (b.rankVol || 0) - (a.rankVol || 0));
    this.universe = rows.slice(0, this.universeCap);
    return this.universe;
  }

  async _contractFor(symbol, spot, side) {
    const today = new Date().toISOString().slice(0, 10);
    const gte = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const lte = new Date(Date.now() + 21 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const contracts = await this.optionsClient.listContracts(symbol, {
      expirationGte: gte,
      expirationLte: lte,
    });
    if (!contracts.length) return null;
    const expiry = contracts[0].expiration_date;
    const atExp = contracts.filter((c) => c.expiration_date === expiry && String(c.type) === side);
    if (!atExp.length) return null;
    const atm = [...atExp].sort((a, b) => Math.abs(parseFloat(a.strike_price) - spot) - Math.abs(parseFloat(b.strike_price) - spot))[0];
    const snaps = await this.optionsClient.getSnapshotsByUnderlying(symbol, { spot });
    const s = snaps[atm.symbol] || {};
    const dte = Math.max(1, Math.round((Date.parse(`${expiry}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000));
    return {
      occ: atm.symbol,
      strike: parseFloat(atm.strike_price),
      side,
      expiry,
      dte,
      bid: s.bid || 0,
      ask: s.ask || 0,
      mid: s.mid || 0,
      iv: s.iv ?? null,
      delta: s.delta ?? null,
      oi: resolveOpenInterest(atm, s),
      volume: s.volume || 0,
      spreadPct: spreadPct(s.bid, s.ask),
    };
  }

  async scoreSymbol(u) {
    const bars = await this.optionsClient.getStockBars(u.symbol, { timeframe: '1Min', limit: 30 }).catch(() => []);
    const last = n(bars[bars.length - 1]?.close, u.lastClose);
    const first = n(bars[Math.max(0, bars.length - 6)]?.close, last);
    const ret5 = last > 0 && first > 0 ? (last - first) / first : 0;
    const vols = bars.map((b) => n(b.volume));
    const avgVol = vols.length ? vols.reduce((s, x) => s + x, 0) / vols.length : 0;
    const rvol = avgVol > 0 ? n(bars[bars.length - 1]?.volume) / avgVol : 1;
    const ntsmHint = this.ranker.ntsm.score(bars);
    const side = ntsmHint.side || 'call';
    const contract = await this._contractFor(u.symbol, last, side);
    if (!contract) return null;
    contract.rvol = rvol;
    contract.ret5 = ret5;
    const ranked = this.ranker.rank({ contract, bars });
    return {
      symbol: u.symbol,
      name: u.name,
      px: last,
      rvol,
      ret5,
      occ: contract.occ,
      side: ranked.side,
      dte: contract.dte,
      spreadPct: contract.spreadPct,
      iv: contract.iv,
      xgbScore: ranked.xgb,
      ntsmScore: ranked.ntsm,
      score: ranked.blend,
      models: ranked.models,
    };
  }

  async scan(limit = 12) {
    if (!this.universe.length) await this.refreshUniverse();
    const out = [];
    const batch = this.universe.slice(0, this.universeCap);
    for (const u of batch) {
      try {
        const row = await this.scoreSymbol(u);
        if (row && row.score >= this.minScore) out.push(row);
      } catch (err) {
        this.lastError = err.message;
      }
    }
    out.sort((a, b) => b.score - a.score);
    this.lastScanAt = new Date().toISOString();
    return out.slice(0, limit);
  }
}

module.exports = SetupScanner;
