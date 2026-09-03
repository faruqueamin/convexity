'use strict';

/**
 * XGBoost-style GBDT ranker for option setups.
 *
 * Scores a contract from public quote/tape features. It does not detect setups
 * and never sends orders — RiskGate still owns the fill path.
 *
 * Trees are a compact JSON booster (same shape as an xgboost dump). Swap
 * `xgbModel.json` for one you trained, or leave the bundled heuristic booster.
 */

const fs = require('fs');
const path = require('path');

const FEATURES = [
  'spreadPct', 'iv', 'absDelta', 'dte', 'logOi', 'logVol', 'premium', 'rvol', 'absRet5',
];

function sigmoid(x) {
  if (x > 20) return 1;
  if (x < -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function log1p(v) {
  return Math.log(1 + Math.max(0, n(v)));
}

function evalTree(nodes, feats) {
  let i = 0;
  for (let step = 0; step < 32; step += 1) {
    const node = nodes[i];
    if (!node) return 0;
    if (node.leaf != null) return Number(node.leaf) || 0;
    const val = feats[node.f] ?? 0;
    i = val < Number(node.t) ? node.left : node.right;
  }
  return 0;
}

function defaultBooster() {
  // Hand-built trees: prefer tight books, listed IV, moderate delta, weekly DTE, some size.
  return {
    featureNames: FEATURES,
    baseScore: -0.35,
    trees: [
      { nodes: [{ f: 0, t: 12, left: 1, right: 2 }, { leaf: 0.55 }, { f: 0, t: 22, left: 3, right: 4 }, { leaf: 0.12 }, { leaf: -0.55 }] },
      { nodes: [{ f: 2, t: 0.28, left: 1, right: 2 }, { leaf: -0.25 }, { f: 2, t: 0.62, left: 3, right: 4 }, { leaf: 0.42 }, { leaf: -0.15 }] },
      { nodes: [{ f: 3, t: 1.5, left: 1, right: 2 }, { leaf: -0.4 }, { f: 3, t: 21, left: 3, right: 4 }, { leaf: 0.28 }, { leaf: 0.05 }] },
      { nodes: [{ f: 1, t: 0.18, left: 1, right: 2 }, { leaf: -0.2 }, { f: 1, t: 0.95, left: 3, right: 4 }, { leaf: 0.22 }, { leaf: -0.3 }] },
      { nodes: [{ f: 6, t: 0.45, left: 1, right: 2 }, { leaf: -0.18 }, { f: 6, t: 8, left: 3, right: 4 }, { leaf: 0.3 }, { leaf: -0.22 }] },
      { nodes: [{ f: 7, t: 1.2, left: 1, right: 2 }, { leaf: -0.12 }, { f: 7, t: 3.5, left: 3, right: 4 }, { leaf: 0.35 }, { leaf: 0.1 }] },
      { nodes: [{ f: 4, t: 4.5, left: 1, right: 2 }, { leaf: -0.15 }, { leaf: 0.2 }] },
      { nodes: [{ f: 5, t: 3.0, left: 1, right: 2 }, { leaf: -0.1 }, { leaf: 0.18 }] },
    ],
  };
}

function loadBooster(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) { /* bundled booster */ }
  const bundled = path.join(__dirname, 'xgbModel.json');
  try {
    if (fs.existsSync(bundled)) return JSON.parse(fs.readFileSync(bundled, 'utf8'));
  } catch (_) { /* */ }
  return defaultBooster();
}

class XgbScorer {
  constructor({ modelPath, log } = {}) {
    this.log = log || console;
    this.model = loadBooster(modelPath || process.env.VOL10S_XGB_MODEL);
    this.featureNames = this.model.featureNames || FEATURES;
  }

  featuresFrom(row = {}) {
    return [
      n(row.spreadPct),
      n(row.iv),
      Math.abs(n(row.delta, row.absDelta)),
      n(row.dte, 7),
      log1p(row.oi),
      log1p(row.volume || row.optVolume),
      n(row.premium, row.ask || row.mid),
      n(row.rvol, 1),
      Math.abs(n(row.ret5)),
    ];
  }

  score(row = {}) {
    const feats = this.featuresFrom(row);
    let raw = n(this.model.baseScore);
    for (const tree of this.model.trees || []) {
      raw += evalTree(tree.nodes || [], feats);
    }
    const p = sigmoid(raw);
    return {
      model: 'xgboost',
      score: Math.round(p * 1000) / 1000,
      raw: Math.round(raw * 1000) / 1000,
      features: Object.fromEntries(this.featureNames.map((k, i) => [k, feats[i]])),
    };
  }
}

module.exports = { XgbScorer, FEATURES, defaultBooster };
