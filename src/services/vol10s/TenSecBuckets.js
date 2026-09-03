'use strict';

/**
 * Build closed 10-second OHLC buckets from live prints, aligned to ET.
 * Used for PULSE/VECTOR entry (close vs coil) and 10s exit guards.
 */

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmt(date, sec) {
  const s = ((Number(sec) % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${date} ${pad(h)}:${pad(m)}:${pad(ss)}`;
}

class TenSecBuckets {
  constructor({ etNow, onClosed } = {}) {
    this.etNow = typeof etNow === 'function' ? etNow : null;
    this.onClosed = typeof onClosed === 'function' ? onClosed : null;
    this.open = new Map();
  }

  push(symbol, price, size, tMs) {
    const p = Number(price);
    const sym = String(symbol || '').toUpperCase();
    if (!(p > 0) || !sym || !this.etNow) return;
    const et = this.etNow(new Date(tMs || Date.now()));
    const start = Math.floor((et.mins * 60 + et.s) / 10) * 10;
    const t = fmt(et.date, start);
    const prev = this.open.get(sym);
    if (prev && prev.t !== t) {
      this._close(sym, prev);
      if (this.open.get(sym) === prev) this.open.delete(sym);
    }
    let b = this.open.get(sym);
    if (!b || b.t !== t) {
      b = { t, o: p, h: p, l: p, c: p, vol: 0 };
      this.open.set(sym, b);
    }
    if (p > b.h) b.h = p;
    if (p < b.l) b.l = p;
    b.c = p;
    b.vol += Number(size) || 0;
  }

  flushClock(now = new Date()) {
    if (!this.etNow) return;
    const et = this.etNow(now);
    const forming = Math.floor((et.mins * 60 + et.s) / 10) * 10;
    const formingTs = fmt(et.date, forming);
    for (const [sym, b] of [...this.open]) {
      const barDate = String(b.t).slice(0, 10);
      if (b.t < formingTs || barDate < et.date) {
        this._close(sym, b);
        if (this.open.get(sym) === b) this.open.delete(sym);
      }
    }
  }

  _close(symbol, bar) {
    try { this.onClosed?.(symbol, bar); } catch (_) { /* */ }
  }
}

module.exports = TenSecBuckets;
