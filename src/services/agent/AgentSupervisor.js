'use strict';

/**
 * AgentSupervisor — periodic LLM risk review of the whole paper system (P5).
 *
 * Advisory-first: every agent.supervisor_interval_min minutes it gathers a
 * compact context (options engine state, equity engine summary, screener
 * top-10, paper account) and asks the local Ollama model for STRICT JSON:
 *
 *   {"assessment":"...","advisories":["..."],"pause_new_entries":bool,"tighten":bool}
 *
 * Every cycle is journaled on the options engine as 'supervisor' (trimmed);
 * unparseable replies journal 'supervisor_parse_error' and are skipped.
 *
 * Only when agent.supervisor_auto === true does it ACT, and only on these
 * two safe, reversible levers (never arms anything, never trades, never
 * raises a limit):
 *   pause_new_entries → options cfg entriesPaused = true
 *   tighten           → options cfg maxConcurrent -= 1 (floor 1)
 * Both persist through OptionsPlayEngine.setConfig and journal as
 * 'supervisor_action'. All timers unref'd; every cycle fully wrapped so the
 * supervisor can never crash or block the server.
 */

const FIRST_RUN_MS = 20000; // first cycle shortly after boot, then on interval

const SYSTEM_PROMPT = [
  'You are the risk supervisor of Convexity, an Alpaca PAPER-TRADING options desk (simulated funds).',
  'You receive one JSON snapshot: options engine (long-call momentum), equity engine,',
  'options screener top volume, and the paper account.',
  'Reply with EXACTLY ONE raw JSON object and NOTHING else — no markdown fences, no commentary:',
  '{"assessment":"one or two sentences","advisories":["short note"],"pause_new_entries":false,"tighten":false}',
  'Rules:',
  '- pause_new_entries=true only when opening new option positions looks unsafe',
  '  (daily loss near/at the lock, repeated errors, no RTH, disorderly tape).',
  '- tighten=true asks to reduce max concurrent option positions by one.',
  '- Base everything on the provided JSON; never invent numbers.',
  '- Keep the whole reply under 400 characters.',
].join('\n');

class AgentSupervisor {
  constructor({ ollama, tools, equityEngine, optionScreener, optionsEngine, paperClient, getConfig, log } = {}) {
    this.ollama = ollama;
    this.tools = tools || null;
    this.equityEngine = equityEngine || null;
    this.optionScreener = optionScreener || null;
    this.optionsEngine = optionsEngine || null;
    this.paperClient = paperClient || null;
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.log = log || console;
    this.last = null; // {ts, assessment, advisories, applied[]}
    this.running = false;
    this._timer = null;
    this._firstTimer = null;
    this._busy = false;
  }

  get cfg() {
    return this.getConfig() || {};
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._schedule();
    this.log.info?.(`[supervisor] started (enabled=${this.cfg.supervisor_enabled === true} interval=${this.cfg.supervisor_interval_min}min auto=${this.cfg.supervisor_auto === true})`);
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
    clearTimeout(this._firstTimer);
  }

  // Re-read config and re-arm the timer (called on agent config changes).
  configure() {
    if (this.running) this._schedule();
  }

  _schedule() {
    clearInterval(this._timer);
    clearTimeout(this._firstTimer);
    if (this.cfg.supervisor_enabled !== true) return;
    const intervalMs = Math.max(1, Number(this.cfg.supervisor_interval_min) || 5) * 60000;
    this._firstTimer = setTimeout(() => this._cycle(), FIRST_RUN_MS);
    this._firstTimer.unref?.();
    this._timer = setInterval(() => this._cycle(), intervalMs);
    this._timer.unref?.();
  }

  async _cycle() {
    if (this._busy || this.cfg.supervisor_enabled !== true) return;
    this._busy = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.log.warn?.(`[supervisor] cycle failed (continuing): ${err.message}`);
      try { this.optionsEngine?.journalEvent('supervisor_error', { error: err.message.slice(0, 200) }); } catch (_) {}
    } finally {
      this._busy = false;
    }
  }

  // ─── one supervisor cycle ─────────────────────────────────────────────────

  async runOnce() {
    const context = await this._buildContext();
    const res = await this.ollama.chat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Snapshot JSON:\n' + JSON.stringify(context) },
    ]);
    const parsed = this._parse(res.content);
    if (!parsed) {
      this.log.warn?.('[supervisor] unparseable reply — cycle journaled as parse error');
      this.optionsEngine?.journalEvent('supervisor_parse_error', { raw: String(res.content || '').slice(0, 300) });
      return null;
    }
    const applied = this.cfg.supervisor_auto === true ? await this._apply(parsed) : [];
    this.last = {
      ts: new Date().toISOString(),
      assessment: parsed.assessment,
      advisories: parsed.advisories,
      applied,
    };
    this.optionsEngine?.journalEvent('supervisor', {
      assessment: parsed.assessment.slice(0, 240),
      advisories: parsed.advisories.slice(0, 5).map((a) => a.slice(0, 160)),
      pause: parsed.pause_new_entries,
      tighten: parsed.tighten,
      auto: this.cfg.supervisor_auto === true,
      applied: applied.length ? applied : undefined,
    });
    this.log.info?.(`[supervisor] ${parsed.assessment.slice(0, 140)}${applied.length ? ' | applied: ' + applied.join(', ') : ''}`);
    return this.last;
  }

  // ─── context ──────────────────────────────────────────────────────────────

  async _buildContext() {
    const ctx = { ts: new Date().toISOString() };
    if (this.optionsEngine) {
      const s = this.optionsEngine.getState();
      ctx.options = {
        enabled: s.enabled,
        armed: s.armed,
        entriesPaused: s.entriesPaused === true,
        rth: s.rth,
        dailyPnl: s.dailyPnl,
        dailyLossLocked: s.dailyLossLocked,
        open: (s.open || []).slice(0, 10).map((p) => ({
          occ: p.occ, underlying: p.underlying, qty: p.qty,
          pnl: p.pnl, pnlPct: p.pnlPct, ageSec: p.ageSec,
        })),
        workingBuys: (s.working || []).length,
        limits: {
          maxConcurrent: s.cfg?.maxConcurrent,
          maxPositionNotional: s.cfg?.maxPositionNotional,
          dailyMaxLossUsd: s.cfg?.dailyMaxLossUsd,
        },
        lastError: s.lastError,
      };
    }
    if (this.equityEngine) {
      try {
        const s = this.equityEngine.snapshot();
        ctx.equity = {
          armed: s.armed,
          inSession: s.inSession,
          activeSession: s.activeSession ? s.activeSession.id : null,
          openCount: s.openCount,
          poolCount: s.poolCount,
          universe: s.universe,
          lastScanAt: s.lastScanAt,
        };
      } catch (err) {
        ctx.equity = { error: err.message };
      }
    }
    if (this.optionScreener) {
      try {
        const st = this.optionScreener.getState();
        ctx.screenerTop10 = (st.rows || [])
          .slice()
          .sort((a, b) => (Number(b.totalVolume) || 0) - (Number(a.totalVolume) || 0))
          .slice(0, 10)
          .map((r) => ({
            symbol: r.symbol, spot: r.spot, expiry: r.expiry, dte: r.dte,
            totalVolume: r.totalVolume, callPutRatio: r.callPutRatio,
          }));
        ctx.screenerLastScanAt = st.lastScanAt || null;
      } catch (err) {
        ctx.screenerTop10 = { error: err.message };
      }
    }
    ctx.account = await this._accountSnapshot();
    return ctx;
  }

  async _accountSnapshot() {
    if (this.paperClient?.enabled) {
      try {
        const a = await this.paperClient.getAccount();
        return { equity: a?.equity ?? null, cash: a?.cash ?? null, buying_power: a?.buying_power ?? null, status: a?.status ?? null };
      } catch (err) {
        return { error: `paperClient: ${err.message.slice(0, 120)}` };
      }
    }
    if (this.tools) {
      const res = await this.tools.execute('alpaca_cli', { command: 'account', args: ['get'] }).catch(() => null);
      if (res && res.ok) {
        const a = res.result || {};
        return { equity: a.equity ?? null, cash: a.cash ?? null, buying_power: a.buying_power ?? null, status: a.status ?? null };
      }
    }
    return null;
  }

  // ─── strict JSON parsing (defensive) ──────────────────────────────────────

  _parse(content) {
    const text = String(content || '').trim();
    if (!text) return null;
    // Tolerate a fenced block or prose around the object: first { to last }.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let obj;
    try {
      obj = JSON.parse(text.slice(start, end + 1));
    } catch (_) {
      return null;
    }
    if (!obj || typeof obj !== 'object') return null;
    const assessment = typeof obj.assessment === 'string' && obj.assessment.trim()
      ? obj.assessment.trim()
      : null;
    if (!assessment) return null;
    const advisories = (Array.isArray(obj.advisories) ? obj.advisories : [])
      .map((a) => String(a || '').trim())
      .filter(Boolean)
      .slice(0, 5);
    return {
      assessment,
      advisories,
      pause_new_entries: obj.pause_new_entries === true,
      tighten: obj.tighten === true,
    };
  }

  // ─── safe auto actions (only when supervisor_auto === true) ───────────────
  // Pause entries and reduce concurrency ONLY. Never arms, never trades,
  // never raises a limit, never unpauses.

  async _apply(parsed) {
    const applied = [];
    if (!this.optionsEngine) return applied;
    try {
      if (parsed.pause_new_entries === true && this.optionsEngine.cfg.entriesPaused !== true) {
        await this.optionsEngine.setConfig({ entriesPaused: true });
        applied.push('entriesPaused=true');
        this.optionsEngine.journalEvent('supervisor_action', { action: 'entriesPaused', value: true });
      }
      if (parsed.tighten === true) {
        const cur = Math.max(1, Number(this.optionsEngine.cfg.maxConcurrent) || 1);
        const next = Math.max(1, cur - 1);
        if (next < cur) {
          await this.optionsEngine.setConfig({ maxConcurrent: next });
          applied.push(`maxConcurrent ${cur}->${next}`);
          this.optionsEngine.journalEvent('supervisor_action', { action: 'maxConcurrent', from: cur, to: next });
        }
      }
    } catch (err) {
      this.log.warn?.(`[supervisor] apply failed: ${err.message}`);
      try { this.optionsEngine.journalEvent('supervisor_action', { action: 'apply_error', error: err.message.slice(0, 200) }); } catch (_) {}
    }
    return applied;
  }
}

module.exports = AgentSupervisor;
