'use strict';

/**
 * Paper Alpaca client with the same equity order types as parabolic-hft-server:
 *   - Regular hours (9:30–16:00 ET weekdays): market buy / market sell
 *   - Overnight / pre / post / weekend: limit + extended_hours
 *     buy  ≈ last * 1.002 (HFT bid-or-last*1.001/1.002)
 *     sell ≈ last * 0.98  (HFT aggressive extended-hours market-sell conversion)
 */

const https = require('https');
const { URL } = require('url');

const BUY_PAD = 1.002;
const SELL_PAD = 0.98;

function assertPaper(baseUrl, key) {
  const u = String(baseUrl || '').toLowerCase();
  if (!u.includes('paper-api.alpaca.markets')) {
    throw new Error('Vol10s paper client refuses non-paper Alpaca URL');
  }
  if (String(key || '').startsWith('AK')) {
    throw new Error('Vol10s paper client refuses live-looking Alpaca key (AK…)');
  }
}

function roundLimitPrice(px) {
  const n = Number(px);
  if (!(n > 0)) return 0;
  if (n >= 1) return Math.round(n * 100) / 100;
  return Math.round(n * 10000) / 10000;
}

function limitPriceStr(px) {
  const n = roundLimitPrice(px);
  if (!(n > 0)) return null;
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

function isMarketHoursReject(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('extended')
    || msg.includes('outside of market')
    || msg.includes('market orders')
    || msg.includes('not eligible')
    || msg.includes('overnight')
    || msg.includes('pre-market')
    || msg.includes('after hours')
    || msg.includes('after-hours');
}

class PaperAlpacaClient {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || process.env.VOL10S_ALPACA_BASE_URL || '').replace(/\/+$/, '').replace(/\/v2$/i, '');
    this.key = opts.key || process.env.VOL10S_ALPACA_KEY || '';
    this.secret = opts.secret || process.env.VOL10S_ALPACA_SECRET || '';
    this.timeoutMs = parseInt(opts.timeoutMs || '15000', 10);
    this.enabled = Boolean(this.baseUrl && this.key && this.secret);
    if (this.enabled) assertPaper(this.baseUrl, this.key);
  }

  /**
   * Alpaca rejects market orders outside 9:30 AM – 4:00 PM ET (and all weekend).
   * Copied from parabolic-hft-server TradingClient.isExtendedHours.
   */
  isExtendedHours(now = new Date()) {
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = et.getHours();
    const minute = et.getMinutes();
    const day = et.getDay();
    if (day === 0 || day === 6) return true;
    const isRegular = (hour > 9 || (hour === 9 && minute >= 30)) && hour < 16;
    return !isRegular;
  }

  hoursLabel(now = new Date()) {
    if (!this.isExtendedHours(now)) return 'rth';
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const mins = et.getHours() * 60 + et.getMinutes();
    if (mins >= 4 * 60 && mins < 9 * 60 + 30) return 'pre';
    if (mins >= 16 * 60 && mins < 20 * 60) return 'post';
    return 'overnight';
  }

  buyLimitPrice(refPrice) {
    return roundLimitPrice(Number(refPrice) * BUY_PAD);
  }

  sellLimitPrice(refPrice) {
    return roundLimitPrice(Number(refPrice) * SELL_PAD);
  }

  _req(method, path, body) {
    if (!this.enabled) return Promise.reject(new Error('paper Alpaca keys not configured'));
    const url = new URL(path, `${this.baseUrl}/`);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'APCA-API-KEY-ID': this.key,
      'APCA-API-SECRET-KEY': this.secret,
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: this.timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch (_) { parsed = { raw: data }; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          const msg = parsed?.message || parsed?.error || data.slice(0, 200);
          const err = new Error(`Alpaca paper ${res.statusCode}: ${msg}`);
          err.status = res.statusCode;
          err.body = parsed;
          reject(err);
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Alpaca paper timeout')); });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  getAccount() { return this._req('GET', '/v2/account'); }
  getPositions() { return this._req('GET', '/v2/positions'); }
  getOpenOrders() { return this._req('GET', '/v2/orders?status=open&nested=true'); }
  getOrder(id) { return this._req('GET', `/v2/orders/${encodeURIComponent(id)}`); }

  async getFilledOrders({ limit = 500 } = {}) {
    const n = Math.min(500, Math.max(1, Number(limit) || 500));
    const orders = await this._req('GET', `/v2/orders?status=closed&nested=true&limit=${n}&direction=desc`);
    if (!Array.isArray(orders)) return [];
    return orders.filter((o) => {
      const st = String(o.status || '').toLowerCase();
      return st === 'filled' && Number(o.filled_qty || 0) > 0 && Number(o.filled_avg_price || 0) > 0;
    });
  }

  async getOpenOrdersForSymbol(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const orders = await this._req('GET', `/v2/orders?status=open&symbols=${encodeURIComponent(sym)}&limit=50`);
    return Array.isArray(orders) ? orders : [];
  }

  async cancelOrder(orderId) {
    if (!orderId) return { success: true };
    try {
      await this._req('DELETE', `/v2/orders/${encodeURIComponent(orderId)}`);
      return { success: true };
    } catch (err) {
      const msg = String(err.message || '');
      if (err.status === 404 || msg.includes('404') || /already|filled|canceled|cancelled/i.test(msg)) {
        return { success: true, skipped: true };
      }
      return { success: false, error: err.message };
    }
  }

  async cancelAllOrdersForSymbol(symbol) {
    const orders = await this.getOpenOrdersForSymbol(symbol).catch(() => []);
    let cancelled = 0;
    for (const order of orders) {
      const res = await this.cancelOrder(order.id);
      if (res.success) cancelled += 1;
    }
    return { success: true, cancelled };
  }

  async replaceOrder(orderId, { qty, limitPrice, timeInForce } = {}) {
    const patch = {};
    if (qty != null) patch.qty = String(qty);
    if (limitPrice != null) {
      const s = limitPriceStr(limitPrice);
      if (!s) throw new Error('replace needs a valid limit price');
      patch.limit_price = s;
    }
    if (timeInForce) patch.time_in_force = timeInForce;
    const order = await this._req('PATCH', `/v2/orders/${encodeURIComponent(orderId)}`, patch);
    return this._wrap(order);
  }

  _wrap(order, extras = {}) {
    if (!order || !order.id) throw new Error('No order ID returned');
    return {
      id: order.id,
      client_order_id: order.client_order_id || null,
      symbol: order.symbol,
      side: order.side,
      qty: Number(order.qty || extras.qty || 0),
      filled_qty: Number(order.filled_qty || 0),
      filled_avg_price: Number(order.filled_avg_price || 0) || null,
      status: order.status,
      type: order.type,
      limit_price: order.limit_price != null ? Number(order.limit_price) : (extras.limitPrice || null),
      time_in_force: order.time_in_force,
      extended_hours: Boolean(order.extended_hours),
      hours: extras.hours || this.hoursLabel(),
      raw: order,
    };
  }

  async placeBuyOrder(symbol, quantity, limitPrice) {
    const lp = limitPriceStr(limitPrice);
    if (!lp) throw new Error(`limit buy ${symbol}: no price`);
    const order = await this._req('POST', '/v2/orders', {
      symbol,
      qty: String(quantity),
      side: 'buy',
      type: 'limit',
      limit_price: lp,
      time_in_force: 'day',
      extended_hours: true,
    });
    return this._wrap(order, { qty: quantity, limitPrice: Number(lp), hours: this.hoursLabel() });
  }

  async placeSellOrder(symbol, quantity, limitPrice) {
    const lp = limitPriceStr(limitPrice);
    if (!lp) throw new Error(`limit sell ${symbol}: no price`);
    const order = await this._req('POST', '/v2/orders', {
      symbol,
      qty: String(quantity),
      side: 'sell',
      type: 'limit',
      limit_price: lp,
      time_in_force: 'day',
      extended_hours: true,
    });
    return this._wrap(order, { qty: quantity, limitPrice: Number(lp), hours: this.hoursLabel() });
  }

  async placeMarketBuy(symbol, quantity) {
    const order = await this._req('POST', '/v2/orders', {
      symbol,
      qty: String(quantity),
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
    });
    return this._wrap(order, { qty: quantity, hours: 'rth' });
  }

  /**
   * Market sell in RTH; 2% aggressive limit + extended_hours outside RTH.
   * Copied from parabolic-hft-server TradingClient.placeMarketSell.
   */
  async placeMarketSell(symbol, quantity, currentPrice = null) {
    if (this.isExtendedHours()) {
      const px = Number(currentPrice);
      if (!(px > 0)) throw new Error(`Extended hours: no price available for limit sell conversion (${symbol})`);
      return this.placeSellOrder(symbol, quantity, this.sellLimitPrice(px));
    }
    const order = await this._req('POST', '/v2/orders', {
      symbol,
      qty: String(quantity),
      side: 'sell',
      type: 'market',
      time_in_force: 'day',
    });
    return this._wrap(order, { qty: quantity, hours: 'rth' });
  }

  /**
   * Session-aware buy: market in RTH, limit+extended_hours otherwise.
   * If Alpaca still rejects a market order, fall back to limit like HFT.
   */
  async submitBuy(symbol, quantity, refPrice) {
    const hours = this.hoursLabel();
    if (!this.isExtendedHours()) {
      try {
        return await this.placeMarketBuy(symbol, quantity);
      } catch (err) {
        if (!isMarketHoursReject(err) || !(Number(refPrice) > 0)) throw err;
      }
    }
    const px = Number(refPrice);
    if (!(px > 0)) throw new Error(`Extended hours: no price available for limit buy conversion (${symbol})`);
    const order = await this.placeBuyOrder(symbol, quantity, this.buyLimitPrice(px));
    order.hours = hours === 'rth' ? 'extended' : hours;
    return order;
  }

  /**
   * Session-aware sell: market in RTH, aggressive limit otherwise.
   * Falls back to limit if a market sell is rejected.
   */
  async submitSell(symbol, quantity, refPrice) {
    const hours = this.hoursLabel();
    if (!this.isExtendedHours()) {
      try {
        return await this.placeMarketSell(symbol, quantity, refPrice);
      } catch (err) {
        if (!isMarketHoursReject(err) || !(Number(refPrice) > 0)) throw err;
      }
    }
    const px = Number(refPrice);
    if (!(px > 0)) throw new Error(`Extended hours: no price available for limit sell conversion (${symbol})`);
    const order = await this.placeSellOrder(symbol, quantity, this.sellLimitPrice(px));
    order.hours = hours === 'rth' ? 'extended' : hours;
    return order;
  }

  marketBuy(symbol, qty, refPrice) { return this.submitBuy(symbol, qty, refPrice); }
  marketSell(symbol, qty, refPrice) { return this.submitSell(symbol, qty, refPrice); }
}

module.exports = PaperAlpacaClient;
module.exports.roundLimitPrice = roundLimitPrice;
module.exports.BUY_PAD = BUY_PAD;
module.exports.SELL_PAD = SELL_PAD;
