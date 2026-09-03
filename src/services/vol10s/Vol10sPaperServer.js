'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PUBLIC_DIR = path.join(__dirname, 'public');
const APEX_HTML = fs.existsSync(path.join(PUBLIC_DIR, 'desk.min.html'))
  ? path.join(PUBLIC_DIR, 'desk.min.html')
  : path.join(PUBLIC_DIR, 'advanced.html');
const LANDING_DIR = path.join(PUBLIC_DIR, 'landing');
const LANDING_HTML = path.join(LANDING_DIR, 'index.html');
const Vol10sConfig = require('./Vol10sConfig');
const AdminAuth = require('./AdminAuth');
const { resolveOpenInterest, contractOpenInterestDate } = require('./OptionsClient');

function sendHtml(res, filePath, extraHeaders = {}) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendNotFound(res) {
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  });
  res.end('Not found');
}

function sendRedirect(res, location) {
  res.writeHead(301, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function sendApex(res, extraHeaders = {}) {
  sendHtml(res, APEX_HTML, extraHeaders);
}

/** Old operator URLs — keep bookmarks working, always land on Apex. */
const LEGACY_DESK_PAGES = new Set([
  '/index.html',
  '/vol-10s-play',
  '/engine',
  '/options',
  '/agent',
  '/advanced',
  '/advanced.html',
]);

const APEX_PAGES = new Set([
  '/desk',
  '/desk.html',
]);

function normalizeBase(base) {
  if (base.length > 1 && base.endsWith('/')) return base.slice(0, -1);
  return base;
}

const STATIC_MIME = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const LANDING_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.pdf': 'application/pdf',
};

// Convexity landing page (Vite build in public/landing). Served at /landing/*
// always, and at / when the request Host is the convexity subdomain.
function sendLandingAsset(res, urlPath) {
  let rel = urlPath.replace(/^\/landing\/?/, '');
  if (rel === urlPath) {
    // root-mode asset (host-based landing at /): /assets/*, /logo-*, /favicon.ico
    rel = urlPath.replace(/^\//, '');
  }
  if (!rel || rel.includes('..') || rel.startsWith('.') || rel.includes('\0')) return false;
  const abs = path.join(LANDING_DIR, rel);
  if (!abs.startsWith(LANDING_DIR + path.sep)) return false;
  const ext = path.extname(abs).toLowerCase();
  const mime = LANDING_MIME[ext];
  if (!mime || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
  const body = fs.readFileSync(abs);
  const cache = (ext === '.pdf' || ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.woff2')
    ? 'public, max-age=86400'
    : 'no-store';
  const headers = {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Cache-Control': cache,
  };
  if (ext === '.pdf') headers['Content-Disposition'] = 'inline; filename="convexity-thesis.pdf"';
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

function requestHosts(req) {
  const raw = [
    req.headers && req.headers.host,
    req.headers && req.headers['x-forwarded-host'],
  ];
  return raw
    .filter(Boolean)
    .map((h) => String(h).toLowerCase().split(',')[0].trim().split(':')[0]);
}

function isLandingHost(req) {
  return requestHosts(req).some((h) => h.startsWith('convexity.'));
}

/** Dev-only operator when no admin password is set. */
function isLocalOperatorHost(req) {
  const names = requestHosts(req);
  const h = names[0] || '';
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

const WS_OBSERVER_ACTIONS = new Set([
  'set_page', 'get_state', 'ping', 'get_options', 'get_options_engine',
]);

/** Internal engine events — never shown on the public decision stream. */
const INTERNAL_JOURNAL_TYPES = new Set([
  'all10s_skip', 'climax_skip', 'ignition_block', 'setup_reset', 'pool_skip',
  'skip_buy', 'skip_sell', 'tape_check', 'opt_skip', 'opt_tape_check', 'opt_bid_confirm',
  'opt_pick_fail', 'opt_rest_quote', 'opt_buy_chase', 'opt_sell_chase', 'opt_buy_cancel',
  'opt_sell_cancel', 'opt_exit_ignore', 'opt_buy_error', 'opt_sell_error', 'opt_sync_working',
  'opt_sync_flat', 'sync_pending', 'sync_flat', 'order_replaced', 'order_cancelled',
  'buy_signal_disarmed', 'sell_signal_disarmed', 'cli_sync', 'cli_sync_error',
  'supervisor_parse_error', 'supervisor_error', 'opt_sync_working',
]);

function sendPublicAsset(res, urlPath) {
  const leaf = path.basename(urlPath);
  if (!leaf || leaf.startsWith('.') || leaf.includes('..')) return false;
  const abs = path.join(PUBLIC_DIR, leaf);
  if (path.dirname(abs) !== PUBLIC_DIR) return false;
  const mime = STATIC_MIME[path.extname(leaf).toLowerCase()];
  if (!mime || !fs.existsSync(abs)) return false;
  const body = fs.readFileSync(abs);
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
  return true;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readJson(req, maxBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function pathBase(url) {
  const i = (url || '/').indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

class Vol10sPaperServer {
  constructor({ engine, logger, port, bind, optionScreener, optionsClient, optionsEngine, agentService, fillLedger, brain, liveHub, eventLog, flipScanLog, flipReplay }) {
    this.engine = engine;
    this.logger = logger || console;
    this.brain = brain || null;
    this.optionScreener = optionScreener || null;
    this.optionsClient = optionsClient || null;
    this.optionsEngine = optionsEngine || null;
    this.agentService = agentService || null;
    this.fillLedger = fillLedger || null;
    this.eventLog = eventLog || null;
    this.liveHub = liveHub || null;
    this.flipScanLog = flipScanLog || null;
    this.flipReplay = flipReplay || null;
    this.admin = new AdminAuth();
    this.port = parseInt(port || process.env.VOL10S_PAPER_PORT || '8977', 10);
    this.bind = bind || process.env.VOL10S_BIND || '0.0.0.0';
    this.httpServer = null;
    this.wss = null;
    this.clients = new Set();
    this._pingTimer = null;
  }

  _riskPayload() {
    const options = this.optionsEngine ? this.optionsEngine.getConfig() : {};
    const equity = this.engine ? this.engine.getConfig() : {};
    return {
      ok: true,
      config: Vol10sConfig.toRiskDesk(options, equity),
      gate: this.optionsEngine?.gate?.getState?.() || null,
    };
  }

  _publicRiskPayload() {
    const full = this._riskPayload();
    const c = full.config || {};
    return {
      ok: true,
      public: true,
      config: {
        risk: {
          maxPremiumUsd: c.risk?.maxPremiumUsd,
          maxOpenPremiumUsd: c.risk?.maxOpenPremiumUsd,
          dailyMaxLossUsd: c.risk?.dailyMaxLossUsd,
          maxConcurrent: c.risk?.maxConcurrent,
        },
        exits: { flattenEt: c.exits?.flattenEt },
        engine: {
          entriesMarketOnly: c.engine?.entriesMarketOnly !== false,
          rthVectorOnly: c.engine?.rthVectorOnly !== false,
        },
      },
    };
  }

  async _applyRiskDesk(patch = {}) {
    const equity = this.engine ? this.engine.getConfig() : {};
    const options = this.optionsEngine ? this.optionsEngine.getConfig() : {};
    const { optionsPatch, equityPatch } = Vol10sConfig.fromRiskDesk(patch, { equity, options });
    if (this.optionsEngine && Object.keys(optionsPatch).length) {
      await this.optionsEngine.setConfig(optionsPatch);
    }
    if (this.engine && Object.keys(equityPatch).length) {
      if (this.optionsEngine) equityPatch.options = this.optionsEngine.getConfig();
      await this.engine.setConfig(equityPatch);
    } else if (this.engine && this.optionsEngine) {
      this.engine.cfg.options = this.optionsEngine.getConfig();
    }
    try { this.liveHub?._syncWanted(); } catch (_) { /* */ }
    return this._riskPayload();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        this._handle(req, res).catch((err) => {
          this.logger.error?.(`[vol10s-http] ${err.message}`);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
        });
      });
      this.wss = new WebSocket.Server({ server: this.httpServer });
      this.wss.on('connection', (ws, req) => this._onSocket(ws, req));
      this._pingTimer = setInterval(() => {
        for (const ws of this.clients) {
          if (ws.readyState !== WebSocket.OPEN) continue;
          try { ws.ping(); } catch (_) {}
        }
      }, 20000);
      this.httpServer.on('error', reject);
      this.httpServer.listen(this.port, this.bind, () => {
        this.logger.info?.(`[vol10s] HTTP+WS ${this.bind}:${this.port} (isolated paper — not live HFT)`);
        resolve();
      });
    });
  }

  stop() {
    if (this._pingTimer) clearInterval(this._pingTimer);
    for (const ws of this.clients) {
      try { ws.close(); } catch (_) {}
    }
    this.clients.clear();
    try { this.wss?.close(); } catch (_) {}
    try { this.httpServer?.close(); } catch (_) {}
  }

  _snap() {
    const snap = this.engine.snapshot();
    if (this.optionsEngine) {
      const st = this.optionsEngine.getState();
      snap.optionPnl = st.dailyPnl;
      snap.optionOpenPnl = (st.open || []).reduce((n, p) => n + (Number(p.pnl) || 0), 0);
      snap.unrealizedPnl = st.unrealizedPnl;
      snap.optionsArmed = st.armed;
      snap.optionsEnabled = st.enabled;
      snap.openPremium = st.openPremium;
      snap.optionsJournal = (this.optionsEngine.journal || []).slice(-120).reverse();
    }
    if (this.fillLedger) snap.fills = this.fillLedger.getSummary();
    if (this.eventLog) snap.deskEvents = this.eventLog.tail(80);
    if (this.optionsClient) snap.dataFeed = this.liveHub?.optStream?.feed || this.optionsClient.feed;
    if (this.liveHub) snap.streams = this.liveHub.tickPayload().streams;
    snap.journal = this._buildDisplayJournal(snap);
    delete snap.scanTape;
    delete snap.optionsJournal;
    return snap;
  }

  _journalPlay(j) {
    if (j.play === 'VECTOR' || j.play === 'PULSE') return j.play;
    const via = Boolean(j.viaOptions) || j.playName === 'VECTOR' || String(j.type || '').startsWith('opt_');
    return via ? 'VECTOR' : 'PULSE';
  }

  _publicJournalNote(kind, play, rawType, j) {
    if (kind === 'ai_found') return 'AI added to watchlist';
    if (kind === 'ai_fade') return 'AI dropped';
    if (kind === 'enter') return `${play} entered`;
    if (kind === 'in_play') return rawType === 'sync_long' || rawType === 'opt_sync_long'
      ? 'picked up from exchange'
      : `${play} in play`;
    if (kind === 'exit') return `${play} exit`;
    if (kind === 'decision') {
      if (rawType === 'kill_switch') return 'Safety halt';
      if (String(j.note || '').toLowerCase().includes('flatten')) return 'Desk flattened';
      if (j.skill) return `AI guard · ${j.skill}`;
      return 'AI decision';
    }
    if (kind === 'sync') return 'Desk sync';
    return `${play} ${kind}`;
  }

  _publicJournal(j) {
    const t = String(j?.type || '');
    if (INTERNAL_JOURNAL_TYPES.has(t)) return null;
    const play = this._journalPlay(j);
    const map = {
      one_green: 'ai_found', green2: 'ai_found', stamp: 'ai_found',
      break: 'enter', buy_signal: 'enter', buy_sent: 'enter',
      opt_buy_sent: 'enter',
      buy_fill: 'in_play', opt_buy_fill: 'in_play',
      sync_long: 'in_play', opt_sync_long: 'in_play',
      break_down: 'ai_fade', pool_evict: 'ai_fade',
      sell_signal: 'exit', sell_sent: 'exit', sell_fill: 'exit',
      opt_sell_sent: 'exit', opt_sell_fill: 'exit', opt_exit_signal: 'exit',
      fail_fast_10s: 'exit', profit_lock_10s: 'exit',
      vol_death: 'exit', red_run: 'exit', vol_rollover: 'exit', vol_1m_fade: 'exit',
      kill_switch: 'decision',
      supervisor: 'decision', supervisor_action: 'decision', brain_decision: 'decision',
      engine_start: 'sync',
    };
    let kind = map[t];
    if (t === 'system') {
      const note = String(j.note || '').toLowerCase();
      if (/kill|flatten|armed|disarmed|halt|paused/.test(note)) kind = 'decision';
      else return null;
    }
    if (!kind) return null;
    return {
      ts: j.ts,
      type: kind,
      symbol: j.symbol || '',
      play,
      repeats: Math.max(1, Number(j.repeats) || 1),
      note: this._publicJournalNote(kind, play, t, j),
    };
  }

  _rthOptionsFeed() {
    return Boolean(this.engine?._rthVectorOnly?.(this.engine._activeSession?.()));
  }

  _filterRthJournal(rows) {
    if (!this._rthOptionsFeed()) return rows;
    return (rows || []).filter((j) => {
      if (!j) return false;
      if (!j.play) return true;
      return j.play !== 'PULSE';
    });
  }

  _buildDisplayJournal(snap) {
    const desk = (snap.deskEvents || []).map((e) => this._publicDeskEvent(e)).filter(Boolean);
    if (desk.length) return this._filterRthJournal(this._coalescePublicJournal(desk)).slice(0, 80);
    const rows = [
      ...(snap.journal || []),
      ...(snap.optionsJournal || []),
    ];
    const mapped = rows.map((j) => this._publicJournal(j)).filter(Boolean);
    mapped.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    return this._filterRthJournal(this._coalescePublicJournal(mapped)).slice(0, 80);
  }

  _publicDeskEvent(e) {
    if (!e) return null;
    const play = e.play === 'VECTOR' || String(e.type || '').startsWith('opt_') ? 'VECTOR' : (e.play || 'PULSE');
    if (e.type === 'engine_start') {
      return { ts: e.ts, type: 'sync', symbol: '', play: '', note: e.note || 'engine start', repeats: 1, kind: 'sync' };
    }
    const kindMap = {
      pool: e.type === 'pool_evict' ? 'ai_fade' : 'ai_found',
      promote: 'enter',
      enter: 'in_play',
      exit: 'exit',
      pnl: 'exit',
      sync: String(e.type || '').includes('flat') ? 'ai_fade' : (e.symbol ? 'in_play' : 'sync'),
      decision: 'decision',
    };
    const type = kindMap[e.kind] || e.kind || e.type;
    let note = e.note || '';
    if (e.kind === 'pool' && e.type !== 'pool_evict') note = note || 'AI added to watchlist';
    if (e.kind === 'pool' && e.type === 'pool_evict') note = note || 'AI dropped';
    if (e.kind === 'promote') note = note || `${play} promoted`;
    if (e.kind === 'enter' && (e.type === 'sync_long' || e.type === 'opt_sync_long')) note = note || 'picked up from exchange';
    if (e.kind === 'enter' && !note) note = `${play} in play`;
    if (e.kind === 'pnl' && e.pnl != null) note = `P&L ${Number(e.pnl) >= 0 ? '+' : ''}${Number(e.pnl).toFixed(2)}`;
    if (e.kind === 'decision') note = e.skill ? `AI guard · ${e.skill}` : 'AI decision';
    if (note && /below_1m|10s_|ignition|coil|spread|premium_too|bid_frozen|gate_/.test(String(note))) {
      note = e.kind === 'pool' ? 'AI dropped' : 'AI decision';
    }
    return {
      ts: e.ts, type, symbol: e.symbol, play, note, repeats: 1, kind: e.kind, pnl: e.pnl,
    };
  }

  _coalescePublicJournal(rows) {
    const out = [];
    for (const j of rows || []) {
      const prev = out[out.length - 1];
      const n = Math.max(1, Number(j.repeats) || 1);
      if (prev && prev.play === j.play && prev.type === j.type && prev.symbol === j.symbol && prev.note === j.note) {
        prev.repeats = (Number(prev.repeats) || 1) + n;
        continue;
      }
      out.push({ ...j, repeats: n });
    }
    return out;
  }

  _publicSnap(full) {
    const snap = full || this._snap();
    const sess = snap.activeSession;
    const playName = sess?.playName || (sess?.id === 'market' ? 'VECTOR' : (sess?.id === 'am' || sess?.id === 'post' ? 'PULSE' : null));
    const sessPlay = playName;
    const pool = (snap.pool || []).map((r) => {
      const vectorSession = sess?.id === 'market';
      let phase = 'found';
      if (r.status === 'long' || r.status === 'pending_buy' || r.status === 'pending_sell') phase = 'in_play';
      else if (r.phase === 'coiled' || r.phase === 'one_green') phase = 'watching';
      const viaOptions = vectorSession && Boolean(r.viaOptions);
      const rowPlay = viaOptions ? 'VECTOR' : (r.playName || sessPlay);
      return {
        symbol: r.symbol,
        status: r.status,
        phase,
        lastC: r.lastC, px: r.px, qty: r.qty, avgEntry: r.avgEntry,
        lastVol: r.lastVol, avg1m: r.avg1m, sess1mAvg: r.sess1mAvg,
        rvol: r.rvol, lastColor: r.lastColor, stampColor: r.stampColor,
        coilHi: r.coilHi, coilLo: r.coilLo, stampTs: r.stampTs,
        greenCount: r.greenCount, coilFrozen: r.coilFrozen, watchScore: r.watchScore,
        viaOptions,
        watchLane: vectorSession ? (r.watchLane || null) : null,
        playName: rowPlay,
        option: (() => {
          if (!vectorSession) return null;
          const o = r.option;
          if (!o) return null;
          if (!o.occ) return { occ: null, reason: o.reason || null };
          return {
            occ: o.occ, side: o.side, strike: o.strike,
            expiry: o.expiry, dte: o.dte,
            bid: o.bid, mid: o.mid, ask: o.ask,
            delta: o.delta, iv: o.iv, qty: o.qty,
            pnl: o.pnl, pnlPct: o.pnlPct,
            reason: o.reason || null,
          };
        })(),
        lastUpdated: r.lastUpdated,
      };
    });
    const deskEvents = (snap.deskEvents || (this.eventLog ? this.eventLog.tail(80) : []))
      .map((e) => this._publicDeskEvent(e)).filter(Boolean);
    const journal = this._filterRthJournal(this._coalescePublicJournal(
      deskEvents.length ? deskEvents : (full.journal || snap.journal || [])
    )).slice(0, 80);
    const positions = pool.filter((r) => r.status !== 'flat');
    const streams = snap.streams ? {
      stock: snap.streams.stock ? {
        connected: Boolean(snap.streams.stock.connected),
        lastTickAt: snap.streams.stock.lastTickAt || null,
      } : null,
      options: snap.streams.options ? {
        connected: Boolean(snap.streams.options.connected),
        lastTickAt: snap.streams.options.lastTickAt || null,
      } : null,
      tape: snap.streams.tape ? {
        live: snap.streams.tape.live || [],
      } : null,
    } : null;
    return {
      type: 'vol10s_state',
      ok: true,
      public: true,
      isolated: true,
      paper: true,
      ts: snap.ts,
      armed: snap.armed,
      paperConfigured: snap.paperConfigured,
      paperOk: snap.paperOk,
      paperAccount: snap.paperAccount,
      et: snap.et,
      clock: snap.clock,
      inSession: snap.inSession,
      scanOnly: Boolean(snap.scanOnly),
      rthVectorOnly: Boolean(snap.rthVectorOnly),
      entriesAllowed: Boolean(snap.entriesAllowed),
      openSettle: Boolean(snap.openSettle),
      activeSession: sess ? {
        id: sess.id, label: sess.label, start: sess.start, end: sess.end, playName,
      } : null,
      config: {
        pollMs: snap.pollMs, poolMax: snap.config?.poolMax, poolLaneMax: snap.config?.poolLaneMax,
        liveWsCap: snap.config?.liveWsCap,
        notional: snap.notional,
      },
      notional: snap.notional,
      pollMs: snap.pollMs,
      universe: snap.universe,
      poolCount: pool.length,
      poolLanes: snap.poolLanes || null,
      sixSix: (snap.sixSix || []).filter((r) => {
        if (!snap.rthVectorOnly) return true;
        return r && r.lane !== 'equity';
      }).slice(0, 8).map((r) => ({
        symbol: r.symbol,
        minute: r.minute,
        px: r.px,
        inPool: Boolean(r.inPool),
        verdict: r.verdict || (r.inPool ? 'watching' : 'held'),
        code: r.code || null,
        reason: r.reason || null,
        playName: r.playName || (r.lane === 'options' ? 'VECTOR' : null),
        lane: r.lane || null,
        thought: (r.thought || []).map((t) => ({
          id: t.id, label: t.label, ok: Boolean(t.ok), note: t.note || '',
        })),
      })),
      sixSixAt: snap.sixSixAt || null,
      vectorScan: (snap.vectorScan || []).slice(0, 8).map((r) => ({
        symbol: r.symbol, minute: r.minute, px: r.px,
        inPool: Boolean(r.inPool), lane: r.lane || 'options',
      })),
      vectorScanAt: snap.vectorScanAt || null,
      vectorScanMeta: snap.vectorScanMeta ? {
        at: snap.vectorScanMeta.at, hits: snap.vectorScanMeta.hits,
        promoted: snap.vectorScanMeta.promoted, durationMs: snap.vectorScanMeta.durationMs,
      } : null,
      vectorHunter: (snap.vectorHunter || []).slice(0, 8).map((r) => ({
        symbol: r.symbol, minute: r.minute, px: r.px,
        peakRvol: r.peakRvol, score: r.score,
        gateOk: Boolean(r.gateOk), gateReason: r.gateReason || null,
        inPool: Boolean(r.inPool),
      })),
      vectorHunterAt: snap.vectorHunterAt || null,
      vectorHunterMeta: snap.vectorHunterMeta ? {
        at: snap.vectorHunterMeta.at, movers: snap.vectorHunterMeta.movers,
        gatePass: snap.vectorHunterMeta.gatePass, promoted: snap.vectorHunterMeta.promoted,
        top: snap.vectorHunterMeta.top || [],
      } : null,
      lastScanAt: snap.lastScanAt,
      lastScanMeta: snap.lastScanMeta ? {
        at: snap.lastScanMeta.at, universe: snap.lastScanMeta.universe,
        pool: snap.lastScanMeta.pool, reason: snap.lastScanMeta.reason === 'ok' ? 'ok' : 'idle',
      } : null,
      lastSess1mMeta: null,
      metricFields: [],
      metricEnums: {},
      stats: {
        scans: snap.stats?.scans || 0,
        buys: snap.stats?.buys || 0,
        sells: snap.stats?.sells || 0,
      },
      openCount: snap.openCount,
      pool,
      positions,
      brokerPositions: snap.brokerPositions,
      openOrders: snap.openOrders,
      sittingBuys: snap.sittingBuys,
      journal,
      deskEvents,
      fills: snap.fills,
      optionPnl: snap.optionPnl,
      optionOpenPnl: snap.optionOpenPnl,
      optionsArmed: snap.optionsArmed,
      optionsEnabled: snap.optionsEnabled,
      openPremium: snap.openPremium,
      dataFeed: snap.dataFeed ? 'LIVE' : null,
      streams,
      orderHours: snap.orderHours,
      extendedHours: snap.extendedHours,
    };
  }

  _snapFor(wsOrReq) {
    const observer = wsOrReq && (wsOrReq.readOnly === true || (wsOrReq.headers && this._isObserver(wsOrReq)));
    const full = this._snap();
    return observer ? this._publicSnap(full) : full;
  }

  broadcastTick(payload) {
    const body = JSON.stringify(payload || this.liveHub?.tickPayload?.() || { type: 'tick' });
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(body); } catch (_) {}
    }
  }

  broadcast(snapshot) {
    const full = snapshot || this._snap();
    const pub = this._publicSnap(full);
    const fullStr = JSON.stringify(full);
    const pubStr = JSON.stringify(pub);
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(ws.readOnly ? pubStr : fullStr); } catch (_) {}
    }
  }

  _screenerFor(ws, state) {
    const st = state || (this.optionScreener ? this.optionScreener.getState() : {}) || {};
    if (ws && ws.readOnly) {
      return {
        type: 'options_screener',
        scanning: st.scanning,
        scanned: st.scanned,
        lastScanAt: st.lastScanAt,
        rows: [],
      };
    }
    return { type: 'options_screener', ...st };
  }

  broadcastOptions(state) {
    const full = JSON.stringify(this._screenerFor({ readOnly: false }, state));
    const pub = JSON.stringify(this._screenerFor({ readOnly: true }, state));
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(ws.readOnly ? pub : full); } catch (_) {}
    }
  }

  broadcastOptionsEngine(state) {
    const payload = JSON.stringify({ type: 'options_engine', ...(state || {}) });
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try { ws.send(payload); } catch (_) {}
    }
  }

  broadcastFlipScan(event) {
    if (!event) return;
    const payload = JSON.stringify({ type: 'flip_scan', event });
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN || ws.readOnly) continue;
      try { ws.send(payload); } catch (_) { /* */ }
    }
  }

  broadcastFlipReplay(event) {
    if (!event) return;
    const payload = JSON.stringify({ type: 'flip_replay', event });
    for (const ws of this.clients) {
      if (ws.readyState !== WebSocket.OPEN || ws.readOnly) continue;
      try { ws.send(payload); } catch (_) { /* */ }
    }
  }

  _flipScannerStatus() {
    return { disabled: true, events: [], plays: [], hold: [], loop: {} };
  }

  async _optionScannerProbe() {
    throw new Error('option scanner is not part of the public desk');
  }

  async _optionScannerPromote() {
    throw new Error('option scanner is not part of the public desk');
  }

  _isOperator(req) {
    if (this.admin && this.admin.isAuthed(req)) return true;
    if (this.admin && this.admin.enabled()) return false;
    return isLocalOperatorHost(req);
  }

  _isObserver(req) {
    return !this._isOperator(req);
  }

  _onSocket(ws, req) {
    this.clients.add(ws);
    ws.readOnly = this._isObserver(req);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
    ws.on('message', (raw) => {
      this._handleWs(ws, raw).catch((err) => {
        this._sendWs(ws, { type: 'vol10s_error', error: err.message });
      });
    });
    this._sendWs(ws, {
      type: 'view',
      readOnly: Boolean(ws.readOnly),
      mode: ws.readOnly ? 'observer' : 'operator',
      authed: Boolean(this.admin && this.admin.isAuthed(req)),
      adminEnabled: this.admin ? this.admin.enabled() : false,
    });
    this._sendWs(ws, this._snapFor(ws));
    if (this.liveHub) this._sendWs(ws, this.liveHub.tickPayload());
  }

  _sendWs(ws, obj) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  async _handleWs(ws, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (_) { return; }
    const action = msg.action || msg.type;
    if (ws.readOnly && action && !WS_OBSERVER_ACTIONS.has(action)) {
      this._sendWs(ws, { type: 'vol10s_error', error: 'read_only' });
      return;
    }
    if (action === 'set_page' || action === 'get_state' || action === 'ping') {
      this._sendWs(ws, this._snapFor(ws));
      return;
    }
    if (action === 'arm') {
      this.engine.setArmed(Boolean(msg.armed));
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'sync') {
      await this.engine.syncBroker();
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'flatten') {
      await this.engine.flattenOurs('manual');
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'cancel_sitting') {
      await this.engine.cancelSittingBuys({ force: true });
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'scan') {
      await this.engine.scanOnce();
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'flush') {
      await this.engine.flushPool();
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'buy') {
      await this.engine.manualBuy(msg.symbol);
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'sell') {
      await this.engine.manualSell(msg.symbol);
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'add_pool') {
      await this.engine.addToPool(msg.symbol);
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'evict_pool') {
      const snap = await this.engine.evictFromWatchlist(msg.symbol);
      this._sendWs(ws, { type: 'evict_pool_ack', ok: true, symbol: String(msg.symbol || '').toUpperCase() });
      this._sendWs(ws, snap || this._snap());
      return;
    }
    if (action === 'scanner_probe') {
      const rec = await this._optionScannerProbe(msg.symbol);
      this._sendWs(ws, { type: 'scanner_probe_ack', ok: true, rec });
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'scanner_promote') {
      const rec = await this._optionScannerPromote(msg.symbol);
      this._sendWs(ws, { type: 'scanner_promote_ack', ok: true, rec });
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'buy_option') {
      if (!this.optionsEngine) {
        this._sendWs(ws, { type: 'vol10s_error', error: 'options engine not configured' });
        return;
      }
      const res = await this.optionsEngine.handleEntrySignal({
        symbol: msg.symbol, side: msg.side === 'put' ? 'put' : 'call', qty: msg.qty, reason: 'manual_engine',
      });
      this._sendWs(ws, { type: 'options_engine', ...this.optionsEngine.getState(), lastEntry: res });
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'flatten_option') {
      if (!this.optionsEngine) {
        this._sendWs(ws, { type: 'flatten_option_ack', ok: false, error: 'options engine not configured' });
        return;
      }
      const sym = String(msg.symbol || '').toUpperCase();
      const before = this.optionsEngine.getState().open || [];
      await this.optionsEngine.flattenSymbol(sym, 'manual');
      const after = this.optionsEngine.getState().open || [];
      const leg = after.find((p) => String(p.underlying || '').toUpperCase() === sym);
      const wasOpen = before.some((p) => String(p.underlying || '').toUpperCase() === sym);
      const ok = !wasOpen || Boolean(leg && leg.exiting) || !after.some((p) => String(p.underlying || '').toUpperCase() === sym);
      this._sendWs(ws, {
        type: 'flatten_option_ack',
        ok,
        symbol: sym,
        error: ok ? null : 'sell_not_started',
      });
      this._sendWs(ws, { type: 'options_engine', ...this.optionsEngine.getState() });
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'set_config' || action === 'config') {
      await this.engine.setConfig(msg.config || msg);
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'metrics') {
      await this.engine.loadMetricCatalog();
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'get_options_engine') {
      this._sendWs(ws, { type: 'options_engine', ...(this.optionsEngine ? this.optionsEngine.getState() : { ok: false, error: 'options engine not configured' }) });
      return;
    }
    if (action === 'options_engine_arm') {
      if (!this.optionsEngine) {
        this._sendWs(ws, { type: 'vol10s_error', error: 'options engine not configured' });
        return;
      }
      if (msg.armed) this.optionsEngine.setEnabled(true);
      this.optionsEngine.setArmed(Boolean(msg.armed));
      this._sendWs(ws, { type: 'options_engine', ...this.optionsEngine.getState() });
      this._sendWs(ws, this._snap());
      return;
    }
    if (action === 'options_engine_flatten') {
      if (!this.optionsEngine) {
        this._sendWs(ws, { type: 'vol10s_error', error: 'options engine not configured' });
        return;
      }
      await this.optionsEngine.flattenAll('manual');
      this._sendWs(ws, { type: 'options_engine', ...this.optionsEngine.getState() });
      return;
    }
    if (action === 'get_options') {
      this._sendWs(ws, this._screenerFor(ws));
      return;
    }
    if (action === 'options_engine_config') {
      if (!this.optionsEngine) {
        this._sendWs(ws, { type: 'vol10s_error', error: 'options engine not configured' });
        return;
      }
      const state = await this.optionsEngine.setConfig(msg.config || msg);
      this._sendWs(ws, { type: 'options_engine', ...state });
      return;
    }
    if (action === 'options_scan') {
      if (!this.optionScreener) {
        this._sendWs(ws, { type: 'options_scan_ack', ok: false, reason: 'screener_unavailable' });
        return;
      }
      if (this.optionScreener.scanning) {
        this._sendWs(ws, { type: 'options_scan_ack', ok: false, reason: 'already_scanning' });
        return;
      }
      this.optionScreener.scan().catch((err) => this.logger.warn?.(`[optscan] scan failed: ${err.message}`));
      this._sendWs(ws, { type: 'options_scan_ack', ok: true, started: true });
      return;
    }
  }

  async _handle(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    const base = pathBase(req.url || '/');
    const observer = this._isObserver(req);

    if (base === '/api/admin/login' && req.method === 'POST') {
      try {
        const body = await readJson(req);
        const result = this.admin.login(req, body.password);
        if (!result.ok) {
          sendJson(res, result.error === 'too_many_attempts' ? 429 : 401, result);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': this.admin.setCookieHeader(result.token, req),
        });
        res.end(JSON.stringify({ ok: true, mode: 'operator', readOnly: false }));
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (base === '/api/admin/logout' && req.method === 'POST') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': this.admin.clearCookieHeader(req),
      });
      res.end(JSON.stringify({ ok: true, mode: 'observer', readOnly: true }));
      return;
    }

    if (base === '/api/view' && isRead) {
      sendJson(res, 200, {
        ok: true,
        readOnly: observer,
        mode: observer ? 'observer' : 'operator',
        authed: Boolean(this.admin && this.admin.isAuthed(req)),
        adminEnabled: this.admin.enabled(),
        paper: true,
      });
      return;
    }

    if (observer && !isRead && req.method !== 'OPTIONS') {
      sendJson(res, 403, {
        ok: false,
        error: 'read_only',
        hint: 'Public desk is observe-only. Sign in as admin to control the engine.',
      });
      return;
    }

    // Convexity landing page: /landing/* always; root when Host is the convexity subdomain.
    if (isRead && base === '/landing') {
      res.writeHead(301, { Location: '/landing/' });
      res.end();
      return;
    }
    if (isRead && (base === '/landing/' || base === '/landing/index.html')) {
      sendHtml(res, LANDING_HTML);
      return;
    }
    if (isRead && base.startsWith('/landing/')) {
      if (sendLandingAsset(res, base)) return;
    }
    if (isRead && isLandingHost(req)) {
      if (base === '/' && fs.existsSync(LANDING_HTML)) {
        sendHtml(res, LANDING_HTML);
        return;
      }
      if (sendLandingAsset(res, base)) return;
    }

    const page = normalizeBase(base);
    if (isRead && LEGACY_DESK_PAGES.has(page)) {
      sendRedirect(res, '/desk');
      return;
    }

    if (isRead && APEX_PAGES.has(page)) {
      sendApex(res);
      return;
    }

    if (isRead && page === '/' && !isLandingHost(req)) {
      sendApex(res);
      return;
    }

    if (base === '/api/streams' && isRead) {
      sendJson(res, 200, this.liveHub ? this.liveHub.getState() : { ok: false, error: 'streams not started' });
      return;
    }

    if (base === '/api/brain/state' && isRead) {
      if (!this.brain) { sendJson(res, 503, { ok: false, error: 'brain not wired' }); return; }
      sendJson(res, 200, this.brain.getState());
      return;
    }

    if (base === '/api/brain/config' && req.method === 'POST') {
      if (!this.brain) { sendJson(res, 503, { ok: false, error: 'brain not wired' }); return; }
      try {
        const body = await readJson(req);
        sendJson(res, 200, this.brain.setConfig(body));
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (base === '/health' && isRead) {
      const snap = this._snap();
      sendJson(res, 200, {
        ok: true,
        isolated: true,
        paper: true,
        ws: true,
        readOnly: this._isObserver(req),
        port: this.port,
        armed: snap.armed,
        paperOk: snap.paperOk,
        paperAccount: snap.paperAccount
          ? {
              account_number: snap.paperAccount.account_number,
              status: snap.paperAccount.status,
            }
          : null,
        universe: snap.universe,
        openCount: snap.openCount,
        clients: this.clients.size,
        options: this.optionScreener ? {
          scanning: this.optionScreener.scanning,
          scanned: this.optionScreener.scanned,
          rows: this.optionScreener.rows.length,
          lastScanAt: this.optionScreener.lastScanAt,
        } : null,
      });
      return;
    }

    if ((base === '/api/vol10s-paper/state' || base === '/state') && isRead) {
      sendJson(res, 200, this._snapFor(req));
      return;
    }

    if ((base === '/api/vol10s-paper/arm' || base === '/arm') && req.method === 'POST') {
      const body = await readJson(req);
      const armed = this.engine.setArmed(Boolean(body.armed));
      sendJson(res, 200, { ok: true, armed, snapshot: this._snap() });
      return;
    }

    if ((base === '/api/vol10s-paper/sync' || base === '/sync') && req.method === 'POST') {
      await this.engine.syncBroker();
      sendJson(res, 200, { ok: true, lastSyncAt: this.engine.lastSyncAt, snapshot: this._snap() });
      return;
    }

    if ((base === '/api/vol10s-paper/flatten' || base === '/flatten') && req.method === 'POST') {
      await this.engine.flattenOurs('manual');
      sendJson(res, 200, { ok: true, snapshot: this._snap() });
      return;
    }

    if ((base === '/api/vol10s-paper/cancel_sitting' || base === '/cancel_sitting') && req.method === 'POST') {
      const result = await this.engine.cancelSittingBuys({ force: true });
      sendJson(res, 200, { ok: true, ...result, snapshot: this._snap() });
      return;
    }

    if ((base === '/api/vol10s-paper/scan' || base === '/scan') && req.method === 'POST') {
      await this.engine.scanOnce();
      sendJson(res, 200, { ok: true, lastScanAt: this.engine.lastScanAt, snapshot: this._snap() });
      return;
    }

    if ((base === '/api/vol10s-paper/flush' || base === '/flush') && req.method === 'POST') {
      const snapshot = await this.engine.flushPool();
      sendJson(res, 200, { ok: true, snapshot });
      return;
    }

    if ((base === '/api/vol10s-paper/buy' || base === '/buy') && req.method === 'POST') {
      const body = await readJson(req);
      const snapshot = await this.engine.manualBuy(body.symbol);
      sendJson(res, 200, { ok: true, snapshot });
      return;
    }

    if ((base === '/api/vol10s-paper/sell' || base === '/sell') && req.method === 'POST') {
      const body = await readJson(req);
      const snapshot = await this.engine.manualSell(body.symbol);
      sendJson(res, 200, { ok: true, snapshot });
      return;
    }

    if ((base === '/api/vol10s-paper/add_pool' || base === '/add_pool') && req.method === 'POST') {
      const body = await readJson(req);
      const snapshot = await this.engine.addToPool(body.symbol);
      sendJson(res, 200, { ok: true, snapshot });
      return;
    }

    if ((base === '/api/vol10s-paper/evict_pool' || base === '/evict_pool') && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const snapshot = await this.engine.evictFromWatchlist(body.symbol);
        sendJson(res, 200, { ok: true, snapshot });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if ((base === '/api/vol10s-paper/config' || base === '/config') && isRead) {
      sendJson(res, 200, { ok: true, config: this.engine.getConfig(), metricFields: this.engine.metricFields, metricEnums: this.engine.metricEnums });
      return;
    }

    if ((base === '/api/vol10s-paper/config' || base === '/config') && req.method === 'POST') {
      const body = await readJson(req);
      const snapshot = await this.engine.setConfig(body.config || body);
      sendJson(res, 200, { ok: true, snapshot });
      return;
    }

    if ((base === '/api/vol10s-paper/metrics' || base === '/metrics') && isRead) {
      await this.engine.loadMetricCatalog();
      sendJson(res, 200, { ok: true, metricFields: this.engine.metricFields, metricEnums: this.engine.metricEnums });
      return;
    }

    if (base === '/api/options/screener' && isRead) {
      if (!this.optionScreener) {
        sendJson(res, 503, { ok: false, error: 'options screener not configured' });
        return;
      }
      sendJson(res, 200, { ok: true, ...this.optionScreener.getState() });
      return;
    }

    if (base === '/api/options/scan' && req.method === 'POST') {
      if (!this.optionScreener) {
        sendJson(res, 503, { ok: false, error: 'options screener not configured' });
        return;
      }
      if (this.optionScreener.scanning) {
        sendJson(res, 200, { ok: false, reason: 'already_scanning' });
        return;
      }
      this.optionScreener.scan().catch((err) => this.logger.warn?.(`[optscan] scan failed: ${err.message}`));
      sendJson(res, 200, { ok: true, started: true });
      return;
    }

    if (base === '/api/kill' && req.method === 'POST') {
      // Operator host only. Nginx makes public requests look like loopback, so
      // Host — not socket IP — is the gate.
      if (this._isObserver(req)) {
        sendJson(res, 403, { ok: false, error: 'read_only' });
        return;
      }
      if (!this.optionsEngine) {
        sendJson(res, 503, { ok: false, error: 'options engine not configured' });
        return;
      }
      this.logger.warn?.('[vol10s] KILL SWITCH — disarming + flattening options engine');
      this.optionsEngine.journalEvent('kill_switch', { note: 'KILL SWITCH: options engine disarmed + flattened' });
      this.optionsEngine.setArmed(false);
      const state = await this.optionsEngine.flattenAll('kill_switch');
      sendJson(res, 200, { ok: true, armed: false, state });
      return;
    }

    if (base === '/api/fills' && isRead) {
      sendJson(res, 200, this.fillLedger ? this.fillLedger.getSummary() : { ok: false, error: 'no ledger' });
      return;
    }

    if (base === '/api/desk-events' && isRead) {
      sendJson(res, 200, { ok: true, events: this.eventLog ? this.eventLog.tail(200) : [] });
      return;
    }

    if (base === '/api/options/engine/buy' && req.method === 'POST') {
      if (!this.optionsEngine) {
        sendJson(res, 503, { ok: false, error: 'options engine not configured' });
        return;
      }
      const body = await readJson(req);
      const result = await this.optionsEngine.handleEntrySignal({
        symbol: body.symbol, side: body.side === 'put' ? 'put' : 'call', qty: body.qty, reason: 'manual_engine',
      });
      sendJson(res, 200, { ok: Boolean(result?.ok), result, state: this.optionsEngine.getState() });
      return;
    }

    if (base === '/api/options/engine/flatten-one' && req.method === 'POST') {
      if (!this.optionsEngine) {
        sendJson(res, 503, { ok: false, error: 'options engine not configured' });
        return;
      }
      const body = await readJson(req);
      const state = await this.optionsEngine.flattenSymbol(body.symbol, 'manual');
      sendJson(res, 200, { ok: true, state });
      return;
    }

    if (base === '/api/options/engine' && isRead) {
      if (!this.optionsEngine) {
        sendJson(res, 503, { ok: false, error: 'options engine not configured' });
        return;
      }
      sendJson(res, 200, this.optionsEngine.getState());
      return;
    }

    if (base === '/api/options/engine/arm' && req.method === 'POST') {
      if (!this.optionsEngine) {
        sendJson(res, 503, { ok: false, error: 'options engine not configured' });
        return;
      }
      const body = await readJson(req);
      if (body.armed) this.optionsEngine.setEnabled(true);
      const armed = this.optionsEngine.setArmed(Boolean(body.armed));
      sendJson(res, 200, { ok: true, armed, state: this.optionsEngine.getState() });
      return;
    }

    if (base === '/api/options/engine/flatten' && req.method === 'POST') {
      if (!this.optionsEngine) {
        sendJson(res, 503, { ok: false, error: 'options engine not configured' });
        return;
      }
      const state = await this.optionsEngine.flattenAll('manual');
      sendJson(res, 200, { ok: true, state });
      return;
    }

    if (base === '/api/flip/live' && isRead) {
      if (observer) {
        sendJson(res, 403, { ok: false, error: 'read_only' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        ...this._flipScannerStatus(),
        ...(this.flipScanLog ? this.flipScanLog.snapshot() : { events: [], plays: [] }),
      });
      return;
    }

    if ((base === '/api/option-scanner/probe' || base === '/api/flip/probe') && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const rec = await this._optionScannerProbe(body.symbol);
        sendJson(res, 200, { ok: true, rec });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if ((base === '/api/option-scanner/promote' || base === '/api/flip/promote') && req.method === 'POST') {
      const body = await readJson(req);
      try {
        const rec = await this._optionScannerPromote(body.symbol);
        sendJson(res, 200, { ok: true, rec });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }

    if (base === '/api/flip/replay' && req.method === 'POST') {
      if (!this.flipReplay) {
        sendJson(res, 503, { ok: false, error: 'replay not wired' });
        return;
      }
      const body = await readJson(req);
      try {
        const result = await this.flipReplay.replay(body, {
          onRow: (row) => this.broadcastFlipReplay(row),
        });
        sendJson(res, result.ok ? 200 : 400, result);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (base === '/api/risk/config' && isRead) {
      sendJson(res, 200, observer ? this._publicRiskPayload() : this._riskPayload());
      return;
    }

    if (base === '/api/risk/config' && req.method === 'POST') {
      const body = await readJson(req);
      const payload = await this._applyRiskDesk(body.config || body);
      sendJson(res, 200, payload);
      return;
    }

    if (base === '/api/options/engine/config' && req.method === 'POST') {
      if (!this.optionsEngine) {
        sendJson(res, 503, { ok: false, error: 'options engine not configured' });
        return;
      }
      const body = await readJson(req);
      const patch = body.config || body;
      if (Vol10sConfig.isRiskDeskPatch(patch)) {
        const payload = await this._applyRiskDesk(patch);
        sendJson(res, 200, { ok: true, ...payload, state: this.optionsEngine.getState() });
        return;
      }
      const state = await this.optionsEngine.setConfig(patch);
      sendJson(res, 200, { ok: true, state });
      return;
    }

    if (base === '/api/options/chain' && isRead) {
      if (!this.optionsClient || !this.optionsClient.enabled) {
        sendJson(res, 503, { ok: false, error: 'options client not configured' });
        return;
      }
      const symbol = String(new URL(req.url, 'http://localhost').searchParams.get('symbol') || '').toUpperCase();
      if (!symbol) {
        sendJson(res, 400, { ok: false, error: 'missing symbol' });
        return;
      }
      try {
        const spot = await this.optionsClient.getUnderlyingSpot(symbol);
        if (!(spot > 0)) throw new Error(`no spot for ${symbol}`);
        const maxDte = Number(this.optionScreener?.config?.maxDte) || 28;
        const DAY = 24 * 60 * 60 * 1000;
        const gte = new Date(Date.now() + DAY).toISOString().slice(0, 10); // skip 0DTE
        const lte = new Date(Date.now() + maxDte * DAY).toISOString().slice(0, 10);
        const contracts = await this.optionsClient.listContracts(symbol, { expirationGte: gte, expirationLte: lte });
        if (!contracts.length) {
          sendJson(res, 404, { ok: false, error: 'no_chain_in_window', symbol, expirationGte: gte, expirationLte: lte });
          return;
        }
        const expiry = contracts[0].expiration_date;
        const today = new Date().toISOString().slice(0, 10);
        const dte = Math.max(1, Math.round((Date.parse(`${expiry}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY));
        const atExp = contracts.filter((c) => c.expiration_date === expiry);
        const snaps = await this.optionsClient.getSnapshotsByUnderlying(symbol, { spot });
        const oiDates = atExp.map(contractOpenInterestDate).filter(Boolean).sort();
        const oiDate = oiDates.length ? oiDates[oiDates.length - 1] : null;
        const rows = atExp
          .map((c) => {
            const s = snaps[c.symbol] || {};
            const mid = s.mid || 0;
            return {
              occ: c.symbol,
              strike: parseFloat(c.strike_price),
              side: c.type,
              bid: s.bid || 0,
              ask: s.ask || 0,
              mid,
              delta: s.delta ?? null,
              iv: s.iv ?? null,
              oi: resolveOpenInterest(c, s),
              oiDate: contractOpenInterestDate(c),
              volume: s.volume || 0,
              spreadPct: s.bid > 0 && s.ask > 0 && mid > 0 ? Math.round(((s.ask - s.bid) / mid) * 1000) / 10 : null,
            };
          })
          .sort((a, b) => (a.strike - b.strike) || (a.side === b.side ? 0 : (a.side === 'call' ? -1 : 1)));
        sendJson(res, 200, { ok: true, symbol, spot, expiry, dte, oiDate, contracts: rows });
      } catch (err) {
        this.logger.warn?.(`[options] chain ${symbol} failed: ${err.message}`);
        sendJson(res, 500, { ok: false, error: err.message, symbol });
      }
      return;
    }

    if (base === '/api/agent/state' && isRead) {
      if (!this.agentService) {
        sendJson(res, 503, { ok: false, error: 'agent not configured' });
        return;
      }
      sendJson(res, 200, await this.agentService.getState());
      return;
    }

    if (base === '/api/agent/chat' && req.method === 'POST') {
      if (!this.agentService || this.agentService.cfg.enabled !== true) {
        sendJson(res, 503, { ok: false, error: 'agent_disabled' });
        return;
      }
      const body = await readJson(req);
      const message = String(body.message || '').trim();
      if (!message) {
        sendJson(res, 400, { ok: false, error: 'missing message' });
        return;
      }
      try {
        const { reply, trace } = await this.agentService.chat(message);
        sendJson(res, 200, { ok: true, reply, trace });
      } catch (err) {
        const down = this.agentService.ollamaUp === false || /Ollama/.test(err.message);
        sendJson(res, down ? 502 : 500, { ok: false, error: down ? 'ollama_down' : err.message });
      }
      return;
    }

    if (base === '/api/agent/config' && req.method === 'POST') {
      if (!this.agentService) {
        sendJson(res, 503, { ok: false, error: 'agent not configured' });
        return;
      }
      const body = await readJson(req);
      const state = await this.agentService.setConfig(body.config || body);
      sendJson(res, 200, state);
      return;
    }

    if (isRead && !base.startsWith('/api/')) {
      if (sendPublicAsset(res, base)) return;
      const leaf = path.basename(base);
      if (leaf.includes('.') && !leaf.endsWith('.html')) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      if (observer) {
        sendRedirect(res, '/desk');
        return;
      }
      sendApex(res, { 'X-Robots-Tag': 'noindex, nofollow' });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  }
}

module.exports = Vol10sPaperServer;
