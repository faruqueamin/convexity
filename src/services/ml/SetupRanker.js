'use strict';

/**
 * Blends XGBoost (contract quality) with NTSM (tape continuation).
 * Plug in another scorer by replacing either class — the desk only needs
 * { blend, side, xgb, ntsm }.
 */

const { XgbScorer } = require('./XgbScorer');
const { NtsmScorer } = require('./NtsmScorer');

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

class SetupRanker {
  constructor({ log, xgbModel, ntsmModel, xgbWeight } = {}) {
    this.log = log || console;
    this.xgb = new XgbScorer({ modelPath: xgbModel, log });
    this.ntsm = new NtsmScorer({ modelPath: ntsmModel, log });
    this.xgbWeight = Math.min(0.9, Math.max(0.1, n(xgbWeight, 0.55)));
  }

  rank({ contract = {}, bars = [] } = {}) {
    const ntsm = this.ntsm.score(bars);
    const side = ntsm.side || (n(contract.delta) >= 0 ? 'call' : 'put');
    const xgb = this.xgb.score({
      ...contract,
      spreadPct: contract.spreadPct,
      iv: contract.iv,
      delta: contract.delta,
      dte: contract.dte,
      oi: contract.oi,
      volume: contract.volume,
      premium: contract.ask || contract.mid,
      rvol: contract.rvol,
      ret5: contract.ret5,
    });
    const tape = side === 'put' ? ntsm.putScore : ntsm.callScore;
    const w = this.xgbWeight;
    const blend = Math.round((w * xgb.score + (1 - w) * tape * ntsm.continuation) * 1000) / 1000;
    return {
      side,
      blend,
      xgb: xgb.score,
      ntsm: ntsm.continuation,
      ntsmCall: ntsm.callScore,
      ntsmPut: ntsm.putScore,
      models: ['xgboost', 'ntsm'],
    };
  }
}

module.exports = { SetupRanker };
