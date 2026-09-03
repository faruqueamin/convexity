'use strict';

/**
 * AgentTools — the tool registry the LLM agent can call.
 *
 * Every tool gets strict arg validation (allowlisted fields/ops, clamped
 * limits ≤ 50 rows) and a 15s per-tool timeout. alpaca_cli is a HARD
 * read-only whitelist — order create/cancel never passes through here.
 * place_option_trade is gated by config agent.trade_enabled plus the options
 * engine's own enabled+armed gates and goes through engine.agentEntry().
 */

const { execFile } = require('child_process');
const { alpacaCliEnv } = require('../vol10s/alpacaCliEnv');
const { resolveOpenInterest } = require('../vol10s/OptionsClient');

const TOOL_TIMEOUT_MS = 15000;
const MAX_ROWS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const METRIC_COLUMNS = [
  'symbol', 'security_type', 'last_close', 'maint_margin_pct',
  'avg_1m_vol_overnight', 'avg_1m_vol_premarket', 'avg_1m_vol_market', 'avg_1m_vol_post',
  'overnight_allowed', 'trade_date',
];
const FILTER_OPS = new Set(['gte', 'lte', 'gt', 'lt', 'eq', 'neq', 'between', 'in']);
const SYM_RE = /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/;
const CLI_WHITELIST = {
  account: ['get'],
  position: ['list'],
  order: ['list'],
  clock: [],
  calendar: [],
};

function sqlLit(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function clampLimit(v, fallback = 20) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_ROWS, n);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

class AgentTools {
  constructor({ optionsClient, equityEngine, optionScreener, optionsEngine, getConfig, log } = {}) {
    this.optionsClient = optionsClient || null;
    this.equityEngine = equityEngine || null;
    this.optionScreener = optionScreener || null;
    this.optionsEngine = optionsEngine || null;
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.log = log || console;
  }

  // ─── definitions (rendered into the system prompt) ────────────────────────

  definitions() {
    return [
      {
        name: 'query_stock_metrics',
        description: 'Alpaca optionable universe snapshot: symbol, last, day volume. Filters: last_close, day_volume.',
        args: {
          filters: 'array of {field, op, value} — fields: symbol, last_close, day_volume. op in gte/lte/gt/lt/eq',
          limit: 'max rows, <= 50 (default 20)',
        },
      },
      {
        name: 'query_bars',
        description: 'Latest N OHLCV bars for one symbol from the Alpaca Market Data API.',
        args: { symbol: 'ticker, e.g. AAPL', timeframe: '1m | 5m | 15m', limit: 'bars, <= 50 (default 20)' },
      },
      {
        name: 'get_options_screener',
        description: 'Top rows from the options screener: nearest-expiry OTM call/put volume ranked across the optionable universe.',
        args: { limit: 'rows, <= 50 (default 10)' },
      },
      {
        name: 'get_option_chain',
        description: 'Nearest non-0DTE option chain for one symbol with bid/ask/mid/delta/IV/OI/volume per strike.',
        args: { symbol: 'underlying ticker, e.g. AAPL' },
      },
      {
        name: 'get_engine_state',
        description: 'Equity engine + options engine state: armed flags, open positions, working orders, daily P&L.',
        args: {},
      },
      {
        name: 'alpaca_cli',
        description: 'READ-ONLY hackathon paper account queries via the alpaca CLI. command account→args ["get"]; position→["list"]; order→["list"]; clock→[]; calendar→[]. No order create/cancel, ever.',
        args: { command: 'account | position | order | clock | calendar', args: 'subcommand array, read-only only' },
      },
      {
        name: 'place_option_trade',
        description: 'Buy a paper option contract through the options engine (all its risk gates apply). Only works when agent trade mode is enabled AND the options engine is enabled+armed. Never claim a trade happened unless the tool result has ok:true.',
        args: { symbol: 'underlying ticker', side: 'call | put', qty: 'contracts 1..10', reason: 'short why' },
      },
    ];
  }

  // ─── dispatch ─────────────────────────────────────────────────────────────

  async execute(name, args = {}) {
    const fn = {
      query_stock_metrics: () => this._queryStockMetrics(args),
      query_bars: () => this._queryBars(args),
      get_options_screener: () => this._getOptionsScreener(args),
      get_option_chain: () => this._getOptionChain(args),
      get_engine_state: () => this._getEngineState(),
      alpaca_cli: () => this._alpacaCli(args),
      place_option_trade: () => this._placeOptionTrade(args),
    }[name];
    if (!fn) return { ok: false, error: `unknown_tool: ${name}` };
    try {
      return await withTimeout(fn(), TOOL_TIMEOUT_MS, name);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ─── Alpaca universe / bars ──────────────────────────────────────────────

  async _queryStockMetrics(args) {
    if (!this.optionsClient?.enabled) return { ok: false, error: 'alpaca_disabled' };
    const assets = await this.optionsClient.listOptionableAssets();
    const limit = clampLimit(args.limit, 20);
    const filters = Array.isArray(args.filters) ? args.filters : [];
    const rows = [];
    for (const a of assets.slice(0, 80)) {
      if (rows.length >= limit) break;
      try {
        const snap = await this.optionsClient.getStockSnapshot(a.symbol);
        const row = {
          symbol: a.symbol,
          last_close: snap?.last || 0,
          day_volume: snap?.dayVolume || 0,
        };
        let ok = true;
        for (const f of filters) {
          const field = String(f.field || '');
          const op = String(f.op || 'gte');
          const val = f.value;
          const cur = row[field];
          if (field === 'symbol' && op === 'eq' && String(val).toUpperCase() !== row.symbol) ok = false;
          if (typeof cur === 'number' && val != null && val !== '') {
            const n = Number(val);
            if (op === 'gte' && !(cur >= n)) ok = false;
            if (op === 'lte' && !(cur <= n)) ok = false;
            if (op === 'gt' && !(cur > n)) ok = false;
            if (op === 'lt' && !(cur < n)) ok = false;
            if (op === 'eq' && cur !== n) ok = false;
          }
        }
        if (ok) rows.push(row);
      } catch (_) { /* skip */ }
    }
    rows.sort((a, b) => b.day_volume - a.day_volume);
    return { ok: true, count: rows.length, rows: rows.slice(0, limit) };
  }

  async _queryBars(args) {
    const symbol = String(args.symbol || '').toUpperCase();
    if (!SYM_RE.test(symbol)) return { ok: false, error: 'bad_symbol' };
    if (!this.optionsClient?.enabled) return { ok: false, error: 'alpaca_disabled' };
    const tfMap = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '1min': '1Min' };
    const tf = tfMap[String(args.timeframe || '1m').toLowerCase()] || '1Min';
    const limit = clampLimit(args.limit, 20);
    const rows = await this.optionsClient.getStockBars(symbol, { timeframe: tf, limit });
    return { ok: true, symbol, timeframe: tf, count: rows.length, rows };
  }

  // ─── options screener / chain ─────────────────────────────────────────────

  async _getOptionsScreener(args) {
    if (!this.optionScreener) return { ok: false, error: 'screener_unavailable' };
    const limit = clampLimit(args.limit, 10);
    const st = this.optionScreener.getState();
    const rows = (st.rows || []).slice(0, limit).map((r) => ({
      symbol: r.symbol,
      name: r.name,
      spot: r.spot,
      lastClose: r.lastClose,
      expiry: r.expiry,
      dte: r.dte,
      totalVolume: r.totalVolume,
      callVolume: r.callVolume,
      putVolume: r.putVolume,
      callPutRatio: r.callPutRatio,
      metrics: r.metrics,
    }));
    return { ok: true, lastScanAt: st.lastScanAt, scanning: st.scanning, universeSize: st.universeSize, count: rows.length, rows };
  }

  async _getOptionChain(args) {
    const symbol = String(args.symbol || '').toUpperCase();
    if (!SYM_RE.test(symbol)) return { ok: false, error: 'bad_symbol' };
    if (!this.optionsClient?.enabled) return { ok: false, error: 'options_client_disabled' };
    const spot = await this.optionsClient.getUnderlyingSpot(symbol);
    if (!(spot > 0)) return { ok: false, error: `no_spot: ${symbol}` };
    const maxDte = Number(this.optionScreener?.config?.maxDte) || 28;
    const gte = new Date(Date.now() + DAY_MS).toISOString().slice(0, 10); // skip 0DTE
    const lte = new Date(Date.now() + maxDte * DAY_MS).toISOString().slice(0, 10);
    const contracts = await this.optionsClient.listContracts(symbol, { expirationGte: gte, expirationLte: lte });
    if (!contracts.length) return { ok: false, error: 'no_chain_in_window', symbol, expirationGte: gte, expirationLte: lte };
    const expiry = contracts[0].expiration_date;
    const today = new Date().toISOString().slice(0, 10);
    const dte = Math.max(1, Math.round((Date.parse(`${expiry}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY_MS));
    const snaps = await this.optionsClient.getSnapshotsByUnderlying(symbol, { spot });
    const rows = contracts
      .filter((c) => c.expiration_date === expiry)
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
          volume: s.volume || 0,
          spreadPct: s.bid > 0 && s.ask > 0 && mid > 0 ? Math.round(((s.ask - s.bid) / mid) * 1000) / 10 : null,
        };
      })
      .sort((a, b) => (a.strike - b.strike) || (a.side === b.side ? 0 : (a.side === 'call' ? -1 : 1)));
    return { ok: true, symbol, spot, expiry, dte, contracts: rows.slice(0, MAX_ROWS) };
  }

  // ─── engine state ─────────────────────────────────────────────────────────

  async _getEngineState() {
    const out = { ok: true, equity: null, options: null };
    if (this.equityEngine) {
      const s = this.equityEngine.snapshot();
      out.equity = {
        armed: s.armed,
        paperOk: s.paperOk,
        paperAccount: s.paperAccount ? {
          account_number: s.paperAccount.account_number,
          status: s.paperAccount.status,
          cash: s.paperAccount.cash,
          equity: s.paperAccount.equity,
          buying_power: s.paperAccount.buying_power,
        } : null,
        inSession: s.inSession,
        activeSession: s.activeSession ? s.activeSession.id : null,
        openCount: s.openCount,
        poolCount: s.poolCount,
        universe: s.universe,
        lastScanAt: s.lastScanAt,
        stats: s.stats,
        brokerPositions: (s.brokerPositions || []).slice(0, MAX_ROWS).map((p) => ({
          symbol: p.symbol, qty: p.qty, avg_entry_price: p.avg_entry_price,
          current_price: p.current_price, unrealized_pl: p.unrealized_pl,
        })),
      };
    }
    if (this.optionsEngine) {
      const s = this.optionsEngine.getState();
      out.options = {
        running: s.running,
        enabled: s.enabled,
        armed: s.armed,
        open: s.open,
        working: s.working,
        dailyPnl: s.dailyPnl,
        dailyLossLocked: s.dailyLossLocked,
        lastError: s.lastError,
      };
    }
    return out;
  }

  // ─── alpaca CLI (read-only hard whitelist) ────────────────────────────────

  _alpacaCli(args) {
    const command = String(args.command || '').toLowerCase();
    const subs = CLI_WHITELIST[command];
    if (!subs) {
      return Promise.resolve({ ok: false, error: `bad_command: ${command} (allowed: ${Object.keys(CLI_WHITELIST).join(', ')})` });
    }
    const reqArgs = Array.isArray(args.args) ? args.args.map((a) => String(a).toLowerCase()) : [];
    const sub = reqArgs.find((a) => subs.includes(a)) || subs[0];
    if (reqArgs.some((a) => !subs.includes(a))) {
      return Promise.resolve({ ok: false, error: `bad_args: only [${subs.join(', ') || '(none)'}] allowed for ${command}` });
    }
    const bin = process.env.VOL10S_ALPACA_CLI_BIN || 'alpaca';
    const argv = sub ? [command, sub, '--quiet'] : [command, '--quiet'];
    return new Promise((resolve) => {
      execFile(bin, argv, { timeout: TOOL_TIMEOUT_MS, env: alpacaCliEnv() }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: `${err.message}${stderr ? ' — ' + String(stderr).slice(0, 200) : ''}` });
          return;
        }
        const raw = String(stdout || '').trim();
        try {
          let parsed = JSON.parse(raw || 'null');
          if (Array.isArray(parsed)) parsed = parsed.slice(0, MAX_ROWS);
          resolve({ ok: true, command: argv.slice(0, -1).join(' '), result: parsed });
        } catch (_) {
          resolve({ ok: true, command: argv.slice(0, -1).join(' '), result: raw.slice(0, 4000) });
        }
      });
    });
  }

  // ─── gated trade ──────────────────────────────────────────────────────────

  async _placeOptionTrade(args) {
    const cfg = this.getConfig() || {};
    if (cfg.trade_enabled !== true) return { ok: false, reason: 'trade_disabled' };
    if (!this.optionsEngine) return { ok: false, reason: 'options_engine_unavailable' };
    if (!this.optionsEngine.enabled || !this.optionsEngine.armed) {
      return { ok: false, reason: 'engine_not_armed', enabled: this.optionsEngine.enabled, armed: this.optionsEngine.armed };
    }
    const symbol = String(args.symbol || '').toUpperCase();
    if (!SYM_RE.test(symbol)) return { ok: false, reason: 'bad_symbol' };
    const side = String(args.side || 'call').toLowerCase() === 'put' ? 'put' : 'call';
    const qty = Math.max(1, Math.min(500, Math.floor(Number(args.qty) || 1)));
    const reason = `agent: ${String(args.reason || 'chat request').slice(0, 200)}`;
    const res = await this.optionsEngine.agentEntry(symbol, side, qty, reason);
    return res && typeof res === 'object' ? res : { ok: false, reason: 'no_result' };
  }
}

module.exports = AgentTools;
