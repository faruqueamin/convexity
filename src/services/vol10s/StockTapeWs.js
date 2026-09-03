'use strict';

/**
 * Live underlying tape from Alpaca stock websocket.
 *
 *   wss://stream.data.alpaca.markets/v2/{sip|iex}   JSON frames (4 AM–8 PM ET)
 *   wss://stream.data.alpaca.markets/v1beta1/boats  overnight (8 PM–4 AM ET)
 *
 * SIP first; 409 (not entitled) → IEX. BOATS 409 → stay on last RTH feed.
 * Wanted-set only. SPY is always kept so Alpaca does not idle-kill an empty socket.
 */

const WebSocket = require('ws');

const RING = 80;
const STOCK_URL = 'wss://stream.data.alpaca.markets/v2';
const BOATS_URL = 'wss://stream.data.alpaca.markets/v1beta1/boats';

class StockTapeWs {
  constructor({ key, secret, log, onTick, onQuote } = {}) {
    this.key = key;
    this.secret = secret;
    this.log = log || console;
    this.onTick = onTick;
    this.onQuote = onQuote;
    this.enabled = Boolean(key && secret);
    this.feed = null;
    this.ws = null;
    this.connected = false;
    this.authed = false;
    this.wanted = new Set(['SPY']);
    this.subscribed = new Set();
    this.lastTrade = new Map();
    this.lastQuote = new Map();
    this.ticks = [];
    this.momentum = new Map();
    this.stats = { trades: 0, quotes: 0, reconnects: 0, lastTickAt: null };
    this._backoffMs = 1000;
    this._stopped = false;
    this._connecting = false;
    this._gen = 0;
    this._overrideUrl = null;
    this._rthFeed = 'sip';
    this.boatsDenied = false;
  }

  _urlFor(feed) {
    if (this._overrideUrl) return this._overrideUrl;
    if (feed === 'boats') return BOATS_URL;
    return `${STOCK_URL}/${feed || this._rthFeed || 'sip'}`;
  }

  start() {
    if (!this.enabled || this._stopped) return;
    this._connect(this.feed || this._rthFeed || 'sip');
  }

  /**
   * Switch SIP/IEX ↔ BOATS. Re-auth, then re-subscribe the wanted-set (SPY stays).
   */
  switchEndpoint({ wsUrl, feed, key, secret, label } = {}) {
    if (key) this.key = key;
    if (secret) this.secret = secret;
    const nextFeed = String(feed || '').toLowerCase() || this.feed || 'sip';
    if (nextFeed === 'boats') {
      this._overrideUrl = wsUrl || BOATS_URL;
    } else {
      this._overrideUrl = wsUrl || null;
      if (nextFeed === 'sip' || nextFeed === 'iex') this._rthFeed = nextFeed;
    }
    this.feed = nextFeed;
    this._backoffMs = 400;
    this.log.info?.(`[tape] endpoint → ${label || nextFeed}`);
    this._connect(nextFeed);
  }

  healSubscriptions() {
    if (!this.authed) return;
    const missing = [...this.wanted].filter((s) => !this.subscribed.has(s));
    if (missing.length) {
      this._send({ action: 'subscribe', trades: missing, quotes: missing });
    }
  }

  forceResubscribe() {
    if (!this.authed || !this.wanted.size) return;
    const syms = [...this.wanted];
    this._send({ action: 'unsubscribe', trades: syms, quotes: syms });
    this._send({ action: 'subscribe', trades: syms, quotes: syms });
  }

  stop() {
    this._stopped = true;
    try { this.ws?.terminate(); } catch (_) { /* */ }
  }

  watchNow(symbol) {
    const s = String(symbol || '').toUpperCase();
    if (!s) return;
    this.wanted.add(s);
    if (!this.enabled || this._stopped) return;
    if (!this.ws || (!this.connected && !this.authed && !this._connecting)) {
      this._connect(this.feed || this._rthFeed || 'sip');
      return;
    }
    if (this.authed && !this.subscribed.has(s)) {
      this._send({ action: 'subscribe', trades: [s], quotes: [s] });
    }
  }

  setWatched(symbols) {
    const next = new Set((symbols || []).map((s) => String(s).toUpperCase()).filter(Boolean));
    next.add('SPY');
    this.wanted = next;
    if (!this.authed) return;
    const add = [...next].filter((s) => !this.subscribed.has(s));
    const del = [...this.subscribed].filter((s) => !next.has(s));
    if (add.length) this._send({ action: 'subscribe', trades: add, quotes: add });
    if (del.length) this._send({ action: 'unsubscribe', trades: del, quotes: del });
  }

  _connect(feed) {
    if (!this.enabled || this._stopped) return;
    const gen = ++this._gen;
    this.feed = feed;
    this._connecting = true;
    try { this.ws?.terminate(); } catch (_) { /* */ }
    const url = this._urlFor(feed);
    this.ws = new WebSocket(url);
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
      try { msgs = JSON.parse(d.toString()); } catch (_) { return; }
      for (const m of Array.isArray(msgs) ? msgs : [msgs]) this._onMsg(m, feed);
    });
    this.ws.on('error', () => {});
    this.ws.on('close', () => {
      if (gen !== this._gen) return;
      this.connected = false;
      this.authed = false;
      this._connecting = false;
      this.subscribed.clear();
      if (this._stopped) return;
      this.stats.reconnects += 1;
      const wait = this._backoffMs;
      this._backoffMs = Math.min(this._backoffMs * 2, 30000);
      setTimeout(() => {
        if (!this._stopped && gen === this._gen) this._connect(this.feed || this._rthFeed || 'iex');
      }, wait).unref?.();
    });
  }

  _send(obj) {
    try { this.ws?.send(JSON.stringify(obj)); } catch (_) { /* */ }
  }

  _onMsg(m, feed) {
    if (m.T === 'error') {
      if (m.code === 409 && feed === 'sip') {
        this.log.warn?.('[tape] SIP not entitled — falling back to IEX');
        this._rthFeed = 'iex';
        this.feed = 'iex';
        this._overrideUrl = null;
        this._backoffMs = 500;
        this._connect('iex');
      } else if (m.code === 409 && feed === 'boats') {
        this.log.warn?.('[tape] BOATS not entitled — staying on RTH feed');
        this.boatsDenied = true;
        this._overrideUrl = null;
        this._backoffMs = 500;
        this._connect(this._rthFeed || 'iex');
      } else {
        this.log.warn?.(`[tape] error ${m.code}: ${m.msg}`);
      }
      return;
    }
    if (m.T === 'success' && m.msg === 'authenticated') {
      this.authed = true;
      this._backoffMs = 1000;
      this.log.info?.(`[tape] stock stream authed · feed=${this.feed}`);
      const syms = [...this.wanted];
      if (syms.length) this._send({ action: 'subscribe', trades: syms, quotes: syms });
      return;
    }
    if (m.T === 'subscription') {
      // Replace, never union — ghost-subs from a stale ack would keep dead names.
      this.subscribed = new Set([...(m.trades || []), ...(m.quotes || [])]);
      return;
    }
    if (m.T === 't') {
      const sym = String(m.S || '').toUpperCase();
      const ts = Date.parse(m.t) || Date.now();
      const rec = { p: Number(m.p), s: Number(m.s) || 0, t: ts };
      this.lastTrade.set(sym, rec);
      this.stats.trades += 1;
      this.stats.lastTickAt = new Date().toISOString();
      let mo = this.momentum.get(sym);
      if (!mo) { mo = { up: 0, down: 0, last: 0 }; this.momentum.set(sym, mo); }
      if (mo.last > 0) {
        if (rec.p > mo.last) mo.up += 1;
        else if (rec.p < mo.last) mo.down += 1;
      }
      mo.last = rec.p;
      if (mo.up + mo.down > 40) {
        mo.up = Math.floor(mo.up / 2);
        mo.down = Math.floor(mo.down / 2);
      }
      this.ticks.unshift({ sym, ...rec });
      if (this.ticks.length > RING) this.ticks.length = RING;
      try { this.onTick?.(sym, rec); } catch (_) { /* */ }
      return;
    }
    if (m.T === 'q') {
      const sym = String(m.S || '').toUpperCase();
      const rec = {
        bp: Number(m.bp) || 0,
        ap: Number(m.ap) || 0,
        t: Date.parse(m.t) || Date.now(),
      };
      this.lastQuote.set(sym, rec);
      this.stats.quotes += 1;
      try { this.onQuote?.(sym, rec); } catch (_) { /* */ }
    }
  }

  getStrength(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const tr = this.lastTrade.get(sym);
    const q = this.lastQuote.get(sym);
    const mo = this.momentum.get(sym) || { up: 0, down: 0 };
    const ageMs = tr ? Date.now() - tr.t : Infinity;
    const tot = mo.up + mo.down;
    return {
      last: tr?.p ?? null,
      bid: q?.bp ?? null,
      ask: q?.ap ?? null,
      ageMs,
      fresh: ageMs < 15000,
      upTicks: mo.up,
      downTicks: mo.down,
      upRatio: tot > 4 ? mo.up / tot : null,
    };
  }

  getQuote(symbol, maxAgeMs = 2000) {
    const q = this.lastQuote.get(String(symbol || '').toUpperCase());
    if (!q) return null;
    if (Date.now() - q.t > maxAgeMs) return null;
    return q;
  }

  getTrade(symbol, maxAgeMs = 15000) {
    const t = this.lastTrade.get(String(symbol || '').toUpperCase());
    if (!t) return null;
    if (Date.now() - t.t > maxAgeMs) return null;
    return t;
  }

  tape(n = 18) { return this.ticks.slice(0, n); }

  getState() {
    return {
      feed: this.feed,
      connected: this.connected,
      authed: this.authed,
      watched: this.wanted.size,
      subscribed: this.subscribed.size,
      stats: this.stats,
      boatsDenied: this.boatsDenied,
    };
  }
}

module.exports = StockTapeWs;
