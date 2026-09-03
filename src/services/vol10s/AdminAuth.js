'use strict';

const crypto = require('crypto');

const COOKIE = 'convexity_admin';
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_MAX = 8;

function parseCookies(req) {
  const out = {};
  const raw = String((req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  }
  return out;
}

function clientIp(req) {
  const xf = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || '';
}

function isHttps(req) {
  const proto = String((req.headers && req.headers['x-forwarded-proto']) || '').toLowerCase();
  return proto === 'https';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

class AdminAuth {
  constructor() {
    this.password = String(process.env.VOL10S_ADMIN_PASSWORD || '');
    this.secret = String(process.env.VOL10S_ADMIN_SECRET || this.password);
    this.ttlSec = parseInt(process.env.VOL10S_ADMIN_TTL_SEC || '43200', 10);
    this.fails = new Map();
  }

  enabled() {
    return Boolean(this.password && this.secret);
  }

  _sign(exp) {
    return crypto.createHmac('sha256', this.secret).update(`admin.${exp}`).digest('hex');
  }

  _token(exp = Date.now() + this.ttlSec * 1000) {
    return `${exp}.${this._sign(exp)}`;
  }

  isAuthed(req) {
    if (!this.enabled()) return false;
    const tok = parseCookies(req)[COOKIE];
    if (!tok) return false;
    const dot = tok.indexOf('.');
    if (dot < 1) return false;
    const exp = Number(tok.slice(0, dot));
    const sig = tok.slice(dot + 1);
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    return safeEqual(sig, this._sign(exp));
  }

  _rateOk(req) {
    const ip = clientIp(req) || 'unknown';
    const now = Date.now();
    const rec = this.fails.get(ip);
    if (!rec || now - rec.t > FAIL_WINDOW_MS) {
      this.fails.set(ip, { n: 0, t: now });
      return true;
    }
    return rec.n < FAIL_MAX;
  }

  _fail(req) {
    const ip = clientIp(req) || 'unknown';
    const rec = this.fails.get(ip) || { n: 0, t: Date.now() };
    rec.n += 1;
    rec.t = rec.t || Date.now();
    this.fails.set(ip, rec);
  }

  login(req, password) {
    if (!this.enabled()) return { ok: false, error: 'admin_disabled' };
    if (!this._rateOk(req)) return { ok: false, error: 'too_many_attempts' };
    if (!safeEqual(String(password || ''), this.password)) {
      this._fail(req);
      return { ok: false, error: 'bad_password' };
    }
    this.fails.delete(clientIp(req) || 'unknown');
    return { ok: true, token: this._token() };
  }

  setCookieHeader(token, req) {
    const parts = [
      `${COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${this.ttlSec}`,
    ];
    if (isHttps(req)) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookieHeader(req) {
    const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (isHttps(req)) parts.push('Secure');
    return parts.join('; ');
  }
}

module.exports = AdminAuth;
