'use strict';

/**
 * Append-only desk decision log (not ticks).
 * Pool add / promote / enter / exit / P&L / guard decisions survive restarts.
 */

const fs = require('fs');
const path = require('path');

const TAIL = 2000;
const POOL_DEBOUNCE_MS = 60 * 1000;

const TYPE_KIND = {
  stamp: 'pool',
  one_green: 'pool',
  green2: 'pool',
  one_red: 'pool',
  red2: 'pool',
  pool_evict: 'pool',
  buy_signal: 'promote',
  buy_signal_disarmed: 'promote',
  buy_sent: 'promote',
  break: 'promote',
  break_down: 'promote',
  opt_buy_sent: 'promote',
  buy_fill: 'enter',
  opt_buy_fill: 'enter',
  sync_long: 'enter',
  opt_sync_long: 'enter',
  sell_signal: 'exit',
  sell_sent: 'exit',
  opt_exit_signal: 'exit',
  opt_sell_sent: 'exit',
  sell_fill: 'pnl',
  opt_sell_fill: 'pnl',
  sync_pending: 'sync',
  opt_sync_working: 'sync',
  opt_sync_flat: 'sync',
  engine_start: 'sync',
  brain_decision: 'decision',
};

class DeskEventLog {
  constructor({ dataDir, log } = {}) {
    this.log = log || console;
    this.path = dataDir ? path.join(dataDir, 'desk-events.jsonl') : null;
    this.events = [];
    this._lastPool = new Map();
    this._load();
  }

  kindOf(type) {
    return TYPE_KIND[String(type || '')] || null;
  }

  _load() {
    if (!this.path || !fs.existsSync(this.path)) return;
    try {
      const lines = fs.readFileSync(this.path, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { this.events.push(JSON.parse(line)); } catch (_) { /* skip bad line */ }
      }
      if (this.events.length > TAIL) this.events = this.events.slice(-TAIL);
      this.log.info?.(`[desk-log] loaded ${this.events.length} events`);
    } catch (err) {
      this.log.warn?.(`[desk-log] load: ${err.message}`);
    }
  }

  record(type, extra = {}) {
    const kind = extra.kind || this.kindOf(type);
    if (!kind) return null;
    const symbol = extra.symbol ? String(extra.symbol).toUpperCase() : null;
    if (kind === 'pool' && symbol) {
      const key = `${type}|${symbol}`;
      const prev = this._lastPool.get(key) || 0;
      if (Date.now() - prev < POOL_DEBOUNCE_MS) return null;
      this._lastPool.set(key, Date.now());
    }
    const ev = {
      ts: extra.ts || new Date().toISOString(),
      kind,
      type: String(type || 'event'),
      symbol,
      occ: extra.occ || null,
      play: extra.play || extra.playName || null,
      note: extra.note || extra.reason || null,
      qty: extra.qty != null ? extra.qty : null,
      px: extra.avg != null ? extra.avg : (extra.px != null ? extra.px : extra.fillPx),
      pnl: extra.pnl != null ? extra.pnl : null,
      skill: extra.skill || null,
      decision: extra.decision || extra.actionTaken || null,
    };
    this.events.push(ev);
    if (this.events.length > TAIL) this.events = this.events.slice(-TAIL);
    if (!this.path) return ev;
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.appendFileSync(this.path, JSON.stringify(ev) + '\n');
    } catch (err) {
      this.log.warn?.(`[desk-log] append: ${err.message}`);
    }
    return ev;
  }

  tail(n = 80) {
    const lim = Math.max(1, Math.min(500, Number(n) || 80));
    return this.events.slice(-lim).reverse();
  }
}

module.exports = DeskEventLog;
module.exports.TYPE_KIND = TYPE_KIND;
