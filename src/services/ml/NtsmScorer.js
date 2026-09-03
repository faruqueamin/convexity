'use strict';

/**
 * NTSM — Neural Time-Series Model.
 *
 * A compact recurrent net over the last N 1-minute Alpaca bars. It scores
 * continuation (call vs put) from returns, range, and volume — not a
 * proprietary detector. Swap weights via ntsmModel.json, or keep the
 * bundled network.
 *
 * Any other time-series model can replace this class as long as it exposes
 * score(bars) → { callScore, putScore, continuation }.
 */

const fs = require('fs');
const path = require('path');

const HIDDEN = 8;
const IN = 4; // ret, rangePct, volZ, closeLoc

function tanh(x) {
  if (x > 8) return 1;
  if (x < -8) return -1;
  const e = Math.exp(2 * x);
  return (e - 1) / (e + 1);
}

function sigmoid(x) {
  if (x > 20) return 1;
  if (x < -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randn(rng) {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function defaultWeights() {
  const rng = mulberry32(20260902);
  const Wx = Array.from({ length: HIDDEN }, () => Array.from({ length: IN }, () => randn(rng) * 0.35));
  const Wh = Array.from({ length: HIDDEN }, () => Array.from({ length: HIDDEN }, () => randn(rng) * 0.2));
  const b = Array.from({ length: HIDDEN }, () => randn(rng) * 0.05);
  const Wo = Array.from({ length: 3 }, () => Array.from({ length: HIDDEN }, () => randn(rng) * 0.4));
  const bo = [0.1, 0.1, 0.0];
  return { in: IN, hidden: HIDDEN, Wx, Wh, b, Wo, bo };
}

function loadWeights(filePath) {
  const bundled = path.join(__dirname, 'ntsmModel.json');
  const p = filePath || process.env.VOL10S_NTSM_MODEL || bundled;
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { /* bundled */ }
  return defaultWeights();
}

function matVec(m, v) {
  return m.map((row) => row.reduce((s, w, i) => s + w * (v[i] || 0), 0));
}

function barFeatures(bars) {
  const rows = (bars || []).filter((b) => Number(b.close) > 0).slice(-20);
  if (rows.length < 3) return [];
  const vols = rows.map((b) => Number(b.volume) || 0);
  const mean = vols.reduce((s, x) => s + x, 0) / vols.length;
  const var_ = vols.reduce((s, x) => s + (x - mean) ** 2, 0) / vols.length;
  const sd = Math.sqrt(var_) || 1;
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = Number(rows[i - 1].close);
    const cur = Number(rows[i].close);
    const high = Number(rows[i].high) || cur;
    const low = Number(rows[i].low) || cur;
    const vol = Number(rows[i].volume) || 0;
    const ret = prev > 0 ? (cur - prev) / prev : 0;
    const rangePct = low > 0 ? (high - low) / low : 0;
    const volZ = (vol - mean) / sd;
    const loc = high > low ? (cur - low) / (high - low) : 0.5;
    out.push([ret, rangePct, volZ, loc]);
  }
  return out;
}

class NtsmScorer {
  constructor({ modelPath, log } = {}) {
    this.log = log || console;
    this.w = loadWeights(modelPath);
  }

  score(bars = []) {
    const seq = barFeatures(bars);
    if (!seq.length) {
      return { model: 'ntsm', callScore: 0.5, putScore: 0.5, continuation: 0.5, bars: 0 };
    }
    let h = Array(this.w.hidden).fill(0);
    for (const x of seq) {
      const lin = matVec(this.w.Wx, x);
      const rec = matVec(this.w.Wh, h);
      h = lin.map((v, i) => tanh(v + rec[i] + (this.w.b[i] || 0)));
    }
    const logits = matVec(this.w.Wo, h).map((v, i) => v + (this.w.bo[i] || 0));
    const callScore = sigmoid(logits[0]);
    const putScore = sigmoid(logits[1]);
    const continuation = sigmoid(logits[2]);
    return {
      model: 'ntsm',
      callScore: Math.round(callScore * 1000) / 1000,
      putScore: Math.round(putScore * 1000) / 1000,
      continuation: Math.round(continuation * 1000) / 1000,
      side: callScore >= putScore ? 'call' : 'put',
      bars: seq.length,
    };
  }
}

module.exports = { NtsmScorer, defaultWeights };
