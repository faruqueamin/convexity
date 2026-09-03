'use strict';

/**
 * Per-OCC live option quotes/trades from Alpaca's options websocket.
 *
 *   wss://stream.data.alpaca.markets/v1beta1/{opra|indicative}
 *   MessagePack only — JSON is rejected (412).
 *
 * Packr MUST use useRecords:false. msgpackr's default record extension
 * silently unpacks Alpaca maps to {} and the socket looks dead.
 *
 * OPRA first; 409 (agreement unsigned) → indicative. Empty wanted-set
 * closes the socket (Alpaca idle-kills zero-sub connections).
 */

const WebSocket = require('ws');
const { Packr, Unpackr } = require('msgpackr');

const RING = 80;
const OPT_URL = 'wss://stream.data.alpaca.markets/v1beta1';

class OptionStreamWs {
  constructor({ key, secret, log, onQuote, onTrade } = {}) {
    this.key = key;
    this.secret = secret;
    this.log = log || console;
    this.onQuote = onQuote;
    this.onTrade = onTrade;
    this.enabled = Boolean(key && secret);
    this.feed = null;
    this.ws = null;
    this.connected = false;
    this.authed = false;
    this.wanted = new Set();
    this.subscribed = new Set();
    this.quotes = new Map();
    this.trades = new Map();
    this.tickRing = [];
    this.stats = { quotes: 0, trades: 0, reconnects: 0, lastTickAt: null };
    this._backoffMs = 1000;
    this._stopped = false;
    this._dormant = false;
    this._connecting = false;
    this._gen = 0;
    this._packr = new Packr({ useRecords: false });
    this._unpackr = new Unpackr({ useRecords: false, mapsAsObjects: true });
  }

  start() {
    if (!this.enabled || this._stopped) return;
    if (!this.wanted.size) {
      this._dormant = true;
      return;
    }
    this._connect(this.feed || 'opra');
  }

  stop() {
    this._stopped = true;
    try { this.ws?.terminate(); } catch (_) { /* */ }
  }

  watchNow(occ) {
    const s = String(occ || '').toUpperCase();
    if (!s) return;
    this.wanted.add(s);
    this._dormant = false;
    if (!this.enabled || this._stopped) return;
    if (!this.ws || (!this.connected && !this.authed && !this._connecting)) {
      this._connect(this.feed || 'opra');
      return;
    }
    if (this.authed && !this.subscribed.has(s)) {
      this._send({ action: 'subscribe', quotes: [s], trades: [s] });
    }
  }

  setWatched(occs) {
    const next = new Set((occs || []).map((s) => String(s).toUpperCase()).filter(Boolean));
    this.wanted = next;
    this._dormant = !next.size;
    if (!this.ws || (!this.connected && !this.authed && !this._connecting)) {
      if (next.size) this._connect(this.feed || 'opra');
      return;
    }
    if (!this.authed) return;
    const add = [...next].filter((s) => !this.subscribed.has(s));
    const del = [...this.subscribed].filter((s) => !next.has(s));
    if (add.length) this._send({ action: 'subscribe', quotes: add, trades: add });
    if (del.length) this._send({ action: 'unsubscribe', quotes: del, trades: del });
  }

  healSubscriptions() {
    if (!this.authed) return;
    const missing = [...this.wanted].filter((s) => !this.subscribed.has(s));
    if (missing.length) this._send({ action: 'subscribe', quotes: missing, trades: missing });
  }

  forceResubscribe() {
    if (!this.authed || !this.wanted.size) return;
    const syms = [...this.wanted];
    this._send({ action: 'unsubscribe', quotes: syms, trades: syms });
    this._send({ action: 'subscribe', quotes: syms, trades: syms });
  }

  _connect(feed) {
    if (!this.enabled || this._stopped || this._dormant) return;
    const gen = ++this._gen;
    this.feed = feed;
    this._connecting = true;
    try { this.ws?.terminate(); } catch (_) { /* */ }
    const url = `${OPT_URL}/${feed}`;
    this.ws = new WebSocket(url, {
      headers: { 'Content-Type': 'application/msgpack' },
    });
    this.ws.binaryType = 'nodebuffer';
    this.connected = false;
    this.authed = false;

    this.ws.on('open', () => {
      if (gen !== this._gen) return;
      this.connected = true;
      this._connecting = false;
      this._send({ action: 'auth', key: this.key, secret: this.secret });
    });
    this.ws.on('message', (d) => {
      if (gen !== this._gen) return;
      let msgs;
      try {
        const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
        msgs = this._unpackr.unpack(buf);
      } catch (_) { return; }
      for (const m of Array.isArray(msgs) ? msgs : [msgs]) this._onMsg(m, feed);
    });
    this.ws.on('error', () => {});
    this.ws.on('close', () => {
      if (gen !== this._gen) return;
      this.connected = false;
      this.authed = false;
      this._connecting = false;
      this.subscribed.clear();
      if (this._stopped || this._dormant) return;
      this.stats.reconnects += 1;
      const wait = this._backoffMs;
      this._backoffMs = Math.min(this._backoffMs * 2, 30000);
      setTimeout(() => {
        if (!this._stopped && !this._dormant && gen === this._gen) {
          this._connect(this.feed || 'indicative');
        }
      }, wait).unref?.();
    });
  }

  _send(obj) {
    try { this.ws?.send(this._packr.pack(obj)); } catch (_) { /* */ }
  }

  _onMsg(m, feed) {
    if (!m || typeof m !== 'object') return;
    if (m.T === 'error') {
      if (m.code === 409 && feed === 'opra') {
        this.log.warn?.('[optstream] OPRA not entitled — falling back to indicative');
        this.feed = 'indicative';
        this._backoffMs = 500;
        this._connect('indicative');
      } else {
        this.log.warn?.(`[optstream] error ${m.code}: ${m.msg}`);
      }
      return;
    }
    if (m.T === 'success' && m.msg === 'authenticated') {
      this.authed = true;
      this._backoffMs = 1000;
      this.log.info?.(`[optstream] options stream authed · feed=${this.feed}`);
      const syms = [...this.wanted];
      if (syms.length) this._send({ action: 'subscribe', quotes: syms, trades: syms });
      return;
    }
    if (m.T === 'subscription') {
      this.subscribed = new Set([...(m.quotes || []), ...(m.trades || [])]);
      return;
    }
    if (m.T === 'q') {
      const occ = String(m.S || '').toUpperCase();
      const bid = Number(m.bp) || 0;
      const ask = Number(m.ap) || 0;
      const rec = {
        bid,
        ask,
        mid: bid > 0 && ask > 0 ? Math.round(((bid + ask) / 2) * 100) / 100 : (bid || ask || 0),
        bidSz: Number(m.bs) || 0,
        askSz: Number(m.as) || 0,
        t: Date.parse(m.t) || Date.now(),
        live: true,
      };
      this.quotes.set(occ, rec);
      this.stats.quotes += 1;
      this.stats.lastTickAt = new Date().toISOString();
      this.tickRing.unshift({ occ, bid: rec.bid, ask: rec.ask, t: rec.t });
      if (this.tickRing.length > RING) this.tickRing.length = RING;
      try { this.onQuote?.(occ, rec); } catch (_) { /* */ }
      return;
    }
    if (m.T === 't') {
      const occ = String(m.S || '').toUpperCase();
      const rec = { p: Number(m.p) || 0, s: Number(m.s) || 0, t: Date.parse(m.t) || Date.now() };
      this.trades.set(occ, rec);
      this.stats.trades += 1;
      try { this.onTrade?.(occ, rec); } catch (_) { /* */ }
    }
  }

  getQuote(occ, maxAgeMs = 2500) {
    const q = this.quotes.get(String(occ || '').toUpperCase());
    if (!q) return null;
    if (Date.now() - q.t > maxAgeMs) return null;
    return q;
  }

  peekQuote(occ) { return this.quotes.get(String(occ || '').toUpperCase()) || null; }

  ticks(n = 18) { return this.tickRing.slice(0, n); }

  getState() {
    return {
      feed: this.feed,
      connected: this.connected,
      authed: this.authed,
      dormant: this._dormant,
      watched: this.wanted.size,
      subscribed: this.subscribed.size,
      stats: this.stats,
    };
  }
}

module.exports = OptionStreamWs;
