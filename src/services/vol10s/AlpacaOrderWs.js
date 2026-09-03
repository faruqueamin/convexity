'use strict';

/**
 * Alpaca paper account stream — trade_updates only.
 * Fills / cancels / replaces land here; REST is the backstop.
 */

const WebSocket = require('ws');

function paperStreamUrl(baseUrl) {
  const u = String(baseUrl || process.env.VOL10S_ALPACA_BASE_URL || '').toLowerCase();
  if (u.includes('paper-api')) return 'wss://paper-api.alpaca.markets/stream';
  return process.env.VOL10S_ALPACA_ORDER_WS || 'wss://paper-api.alpaca.markets/stream';
}

class AlpacaOrderWs {
  constructor({
    baseUrl, key, secret, log, onEvent,
  } = {}) {
    this.url = paperStreamUrl(baseUrl);
    this.key = key || process.env.VOL10S_ALPACA_KEY || '';
    this.secret = secret || process.env.VOL10S_ALPACA_SECRET || '';
    this.log = log || console;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.enabled = Boolean(this.key && this.secret);
    this.ws = null;
    this.connected = false;
    this.authed = false;
    this._stopped = false;
    this._backoffMs = 1000;
    this._gen = 0;
  }

  start() {
    if (!this.enabled || this._stopped) return;
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._gen += 1;
    try { this.ws?.close(); } catch (_) { /* */ }
    this.ws = null;
    this.connected = false;
    this.authed = false;
  }

  _connect() {
    if (this._stopped) return;
    const gen = ++this._gen;
    try { this.ws?.removeAllListeners?.(); this.ws?.close(); } catch (_) { /* */ }
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      if (gen !== this._gen) return;
      this.connected = true;
      this.log.info?.('[order-ws] connected');
      ws.send(JSON.stringify({ action: 'auth', key: this.key, secret: this.secret }));
    });
    ws.on('message', (raw) => {
      if (gen !== this._gen) return;
      this._onMessage(raw);
    });
    ws.on('close', () => {
      if (gen !== this._gen) return;
      this.connected = false;
      this.authed = false;
      if (this._stopped) return;
      this.log.warn?.('[order-ws] closed, reconnecting');
      this._scheduleReconnect();
    });
    ws.on('error', (err) => {
      this.log.warn?.(`[order-ws] ${err.message}`);
    });
  }

  _scheduleReconnect() {
    const ms = this._backoffMs;
    this._backoffMs = Math.min(15000, this._backoffMs * 2);
    setTimeout(() => {
      if (!this._stopped) this._connect();
    }, ms).unref?.();
  }

  _onMessage(raw) {
    let data;
    try { data = JSON.parse(String(raw)); } catch (_) { return; }
    const frames = Array.isArray(data) ? data : [data];
    for (const frame of frames) this._onFrame(frame);
  }

  _onFrame(frame) {
    if (!frame) return;
    if (frame.stream === 'authorization' || frame.T === 'success' || frame.msg === 'connected') {
      if (frame.data?.status === 'authorized' || frame.msg === 'authenticated') {
        this.authed = true;
        this._backoffMs = 1000;
        this.log.info?.('[order-ws] authed · listening trade_updates');
        try {
          this.ws?.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
        } catch (_) { /* */ }
      }
      return;
    }
    if (frame.stream !== 'trade_updates') return;
    const update = frame.data || {};
    const event = String(update.event || '');
    const order = update.order || {};
    const payload = {
      type: event,
      event,
      orderId: order.id || null,
      symbol: order.symbol || null,
      side: order.side || null,
      status: order.status || null,
      assetClass: order.asset_class || null,
      qty: Number(order.qty) || 0,
      filledQty: Number(order.filled_qty) || 0,
      filledAvgPrice: order.filled_avg_price != null ? Number(order.filled_avg_price) : null,
      limitPrice: order.limit_price != null ? Number(order.limit_price) : null,
      replaces: order.replaces || null,
      replacedBy: order.replaced_by || null,
      order,
    };
    if (event === 'fill' || event === 'partial_fill') payload.type = event === 'partial_fill' ? 'partial_fill' : 'fill';
    else if (event === 'canceled' || event === 'cancelled') payload.type = 'cancelled';
    else if (event === 'replaced' || (event === 'new' && order.replaces)) payload.type = 'replaced';
    else if (event === 'rejected' || event === 'expired') payload.type = event;
    try { this.onEvent?.(payload); } catch (err) {
      this.log.warn?.(`[order-ws] handler: ${err.message}`);
    }
  }
}

module.exports = AlpacaOrderWs;
