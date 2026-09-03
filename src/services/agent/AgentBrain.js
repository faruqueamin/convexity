'use strict';

/**
 * AgentBrain — the always-on intelligence layer above the options engine.
 *
 * A deterministic observe → analyze → act loop (no LLM required) built from
 * named guard skills. Each skill inspects live engine state and may emit
 * findings and bounded actions. The brain executes actions only within its
 * authority envelope and journals every decision with reasons + metrics.
 *
 * Authority envelope (all reversible except flatten/disarm, which require
 * hard-breach conditions):
 *   pause_entries / resume_entries   — options cfg entriesPaused
 *   veto_symbol                      — RiskGate per-symbol veto
 *   flatten_all                      — only on hard drawdown breach
 *   disarm                           — only on catastrophe breach
 *
 * Optional Ollama narration turns decisions into plain English when the local
 * model is up; the guard skills act with or without it.
 *
 * Skills cover what a fill-path model cannot: the loss lock is mark-to-bid
 * (realized + unrealized), churn storms pause entries, and toxic books get
 * vetoed before size builds.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CFG = {
  enabled: true,
  intervalSec: 15,
  narrate: true,
  narrateMinGapMin: 10,
  auto: {
    drawdownGuard: true,     // pause entries as day pnl approaches the cap
    flattenOnHardBreach: true,
    disarmOnCatastrophe: false, // opt-in: disarm at 1.5× daily cap
    liquidityGuard: true,    // veto symbols whose quotes keep failing the gate
    churnGuard: true,        // pause entries on cancel/chase storms
    exposureGuard: true,
    consistencyGuard: true,  // broker error patterns
  },
  drawdownWarnPct: 0.6,      // of dailyMaxLossUsd
  drawdownPausePct: 0.8,
  hardBreachMult: 1.25,      // × daily cap → flatten
  catastropheMult: 1.5,      // × daily cap → disarm (if enabled)
  vetoMinutes: 30,
  churnWindowMin: 15,
  churnCancelLimit: 12,      // buy cancels+chases in window → pause
  pauseCooldownMin: 10,      // auto-resume evaluation cadence
};

const JOURNAL_MAX = 300;

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

class AgentBrain {
  constructor({ optionsEngine, optionsClient, equityEngine, fillLedger, ollama, log, dataDir, eventLog } = {}) {
    this.optionsEngine = optionsEngine || null;
    this.optionsClient = optionsClient || null;
    this.equityEngine = equityEngine || null;
    this.fillLedger = fillLedger || null;
    this.eventLog = eventLog || null;
    this.ollama = ollama || null;
    this.log = log || console;
    this.dataDir = dataDir || null;
    this.cfgPath = this.dataDir ? path.join(this.dataDir, 'brain-config.json') : null;
    this.statePath = this.dataDir ? path.join(this.dataDir, 'brain-state.json') : null;
    this.cfg = this._loadCfg();
    this.journal = [];
    this.skillState = {};      // id -> { level, msg, at }
    this.pausedByBrain = false;
    this.pauseReason = null;
    this.pauseUntil = 0;
    this.lastNarrationAt = 0;
    this.lastNarration = null;
    this.ollamaUp = false;
    this.running = false;
    this._timer = null;
    this._busy = false;
    this._loadState();
  }

  // ─── persistence ──────────────────────────────────────────────────────────

  _loadCfg() {
    try {
      if (this.cfgPath && fs.existsSync(this.cfgPath)) {
        const raw = JSON.parse(fs.readFileSync(this.cfgPath, 'utf8'));
        return { ...DEFAULT_CFG, ...raw, auto: { ...DEFAULT_CFG.auto, ...(raw.auto || {}) } };
      }
    } catch (_) {}
    return JSON.parse(JSON.stringify(DEFAULT_CFG));
  }

  _saveCfg() {
    if (!this.cfgPath) return;
    try {
      fs.mkdirSync(path.dirname(this.cfgPath), { recursive: true });
      const tmp = `${this.cfgPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2));
      fs.renameSync(tmp, this.cfgPath);
    } catch (err) {
      this.log.warn?.(`[brain] cfg save: ${err.message}`);
    }
  }

  _loadState() {
    try {
      if (!this.statePath || !fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      const incoming = Array.isArray(raw.journal) ? raw.journal : [];
      this.journal = this._pruneDecisionJournal(incoming);
      this.pausedByBrain = Boolean(raw.pausedByBrain);
      this.pauseReason = raw.pauseReason || null;
      this.pauseUntil = Number(raw.pauseUntil) || 0;
      if (this.journal.length !== incoming.length) this._saveState();
    } catch (_) {}
  }

  _pruneDecisionJournal(rows) {
    const out = [];
    for (const j of rows || []) {
      if (j && j.skill === 'consistency' && /recent errors in journal/i.test(String(j.decision || ''))) continue;
      const prev = out[out.length - 1];
      const sameSkill = prev && prev.skill === j.skill && !prev.actionTaken && !j.actionTaken;
      const sameText = prev && prev.decision === j.decision;
      const sameGuard = prev && prev.skill === 'consistency' && j.skill === 'consistency' && prev.level === j.level;
      if (sameSkill && (sameText || sameGuard)) {
        prev.repeats = (Number(prev.repeats) || 1) + (Number(j.repeats) || 1);
        continue;
      }
      out.push({ ...j, repeats: Number(j.repeats) || 1 });
    }
    return out.slice(0, JOURNAL_MAX);
  }

  _saveState() {
    if (!this.statePath) return;
    try {
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        journal: this.journal.slice(-JOURNAL_MAX),
        pausedByBrain: this.pausedByBrain,
        pauseReason: this.pauseReason,
        pauseUntil: this.pauseUntil,
        savedAt: new Date().toISOString(),
      }, null, 2));
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      this.log.warn?.(`[brain] state save: ${err.message}`);
    }
  }

  setConfig(patch = {}) {
    const { auto, ...rest } = patch || {};
    this.cfg = { ...this.cfg, ...rest, auto: { ...this.cfg.auto, ...(auto || {}) } };
    this._saveCfg();
    this._decide('config', 'info', 'brain config updated', { patch: Object.keys(patch || {}) }, null);
    return this.getState();
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  start() {
    if (this.running) return;
    this.running = true;
    const ms = Math.max(5, n(this.cfg.intervalSec, 15)) * 1000;
    this._timer = setInterval(() => this.tick().catch((err) => this.log.warn?.(`[brain] tick: ${err.message}`)), ms);
    this._timer.unref?.();
    this.tick().catch(() => {});
    this.log.info?.(`[brain] started (every ${ms / 1000}s, guards=${Object.entries(this.cfg.auto).filter(([, v]) => v).map(([k]) => k).join(',')})`);
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
    this._timer = null;
    this._saveState();
  }

  // ─── decision journal ─────────────────────────────────────────────────────

  _decide(skill, level, decision, metrics = {}, actionTaken = null) {
    const last = this.journal.find((j) => j.skill === skill);
    const ageOk = last && Date.now() - Date.parse(last.ts) < 10 * 60000;
    const sameMsg = last && last.decision === decision && last.level === level;
    const sameGuard = last && skill === 'consistency' && last.level === level && !last.actionTaken;
    if (!actionTaken && last && ageOk && (sameMsg || sameGuard)) {
      last.repeats = (Number(last.repeats) || 1) + 1;
      last.decision = decision;
      last.metrics = metrics;
      last.level = level;
      this.skillState[skill] = { level, msg: decision, at: last.ts };
      return last;
    }
    const ev = {
      ts: new Date().toISOString(),
      skill, level, decision,
      metrics,
      actionTaken,
    };
    this.journal.unshift(ev);
    if (this.journal.length > JOURNAL_MAX) this.journal.length = JOURNAL_MAX;
    this.skillState[skill] = { level, msg: decision, at: ev.ts };
    if (actionTaken || level === 'warn' || level === 'crit') {
      this.eventLog?.record('brain_decision', {
        kind: 'decision', skill, decision, actionTaken, level, note: actionTaken || decision,
      });
    }
    if (level !== 'ok') this._saveState();
    return ev;
  }

  // ─── bounded actions ──────────────────────────────────────────────────────

  async _pauseEntries(reason, cooldownMin) {
    const eng = this.optionsEngine;
    if (!eng) return null;
    this.pausedByBrain = true;
    this.pauseReason = reason;
    this.pauseUntil = Date.now() + Math.max(1, n(cooldownMin, this.cfg.pauseCooldownMin)) * 60000;
    if (eng.cfg.entriesPaused !== true) await eng.setConfig({ entriesPaused: true });
    return 'entries_paused';
  }

  async _maybeResumeEntries() {
    const eng = this.optionsEngine;
    if (!eng || !this.pausedByBrain) return null;
    if (Date.now() < this.pauseUntil) return null;
    // Only auto-resume if the triggering condition cleared: day pnl back above pause line.
    const cap = Math.abs(n(eng.cfg.dailyMaxLossUsd, 2000));
    const dayTotal = n(eng.dailyPnl) + n(eng._unrealizedPnl ? eng._unrealizedPnl() : 0);
    if (dayTotal <= -cap * this.cfg.drawdownPausePct) return null; // still hot
    this.pausedByBrain = false;
    this.pauseReason = null;
    this.pauseUntil = 0;
    await eng.setConfig({ entriesPaused: false });
    return 'entries_resumed';
  }

  // ─── guard skills ─────────────────────────────────────────────────────────

  _skillDrawdown(obs) {
    const cap = Math.abs(n(obs.dailyMaxLossUsd, 2000));
    const total = obs.dayPnlTotal;
    const ratio = cap > 0 ? -total / cap : 0;
    const m = { dayPnlTotal: Math.round(total), cap, ratio: Math.round(ratio * 100) / 100 };
    if (total <= -cap * this.cfg.catastropheMult) {
      return { level: 'crit', msg: `catastrophe: day pnl $${Math.round(total)} = ${(ratio * 100) | 0}% of cap`, metrics: m, action: 'disarm' };
    }
    if (total <= -cap * this.cfg.hardBreachMult) {
      return { level: 'crit', msg: `hard breach: day pnl $${Math.round(total)} beyond ${this.cfg.hardBreachMult}× cap`, metrics: m, action: 'flatten' };
    }
    if (total <= -cap * this.cfg.drawdownPausePct) {
      return { level: 'warn', msg: `drawdown ${(ratio * 100) | 0}% of daily cap — pausing entries`, metrics: m, action: 'pause' };
    }
    if (total <= -cap * this.cfg.drawdownWarnPct) {
      return { level: 'warn', msg: `drawdown watch: ${(ratio * 100) | 0}% of daily cap`, metrics: m };
    }
    return { level: 'ok', msg: `day pnl $${Math.round(total)} (${(ratio * 100) | 0}% of cap)`, metrics: m };
  }

  _skillLiquidity(obs) {
    const fails = obs.gateRecent.filter((v) => v && v.ok === false);
    const spreadFails = fails.filter((v) => String(v.reason || '').includes('spread'));
    const bySymbol = {};
    for (const v of spreadFails) {
      if (!v.symbol) continue;
      bySymbol[v.symbol] = (bySymbol[v.symbol] || 0) + 1;
    }
    const toxic = Object.entries(bySymbol).filter(([, c]) => c >= 3).map(([s]) => s);
    const m = { feed: obs.feed, gateFails: fails.length, spreadFails: spreadFails.length, toxic };
    if (obs.feed !== 'opra') {
      return {
        level: toxic.length ? 'warn' : 'info',
        msg: toxic.length
          ? `indicative feed; toxic books vetoed: ${toxic.join(', ')}`
          : 'indicative feed — quotes are not actionable markets; tightened caps active',
        metrics: m,
        vetoSymbols: toxic,
      };
    }
    if (toxic.length) return { level: 'warn', msg: `toxic books vetoed: ${toxic.join(', ')}`, metrics: m, vetoSymbols: toxic };
    return { level: 'ok', msg: 'liquidity ok', metrics: m };
  }

  _skillChurn(obs) {
    const cutoff = obs.now - this.cfg.churnWindowMin * 60000;
    const churny = obs.journalRecent.filter((j) => {
      if (!/opt_buy_(cancel|chase)/.test(String(j.type || ''))) return false;
      const t = Date.parse(j.ts || '');
      return Number.isFinite(t) && t >= cutoff;
    });
    const m = { cancelsInWindow: churny.length, windowMin: this.cfg.churnWindowMin, limit: this.cfg.churnCancelLimit };
    if (churny.length >= this.cfg.churnCancelLimit) {
      return { level: 'warn', msg: `churn storm: ${churny.length} cancels/chases in ${this.cfg.churnWindowMin}m — pausing entries`, metrics: m, action: 'pause' };
    }
    return { level: 'ok', msg: `churn ${churny.length}/${this.cfg.churnCancelLimit}`, metrics: m };
  }

  _skillExposure(obs) {
    const cap = Math.abs(n(obs.maxOpenPremiumUsd, 5000));
    const open = n(obs.openPremium);
    const ratio = cap > 0 ? open / cap : 0;
    const m = { openPremium: Math.round(open), cap, positions: obs.openPositions, working: obs.workingOrders };
    if (ratio >= 0.95) return { level: 'warn', msg: `exposure $${Math.round(open)} ≈ cap $${cap} — pausing entries`, metrics: m, action: 'pause' };
    return { level: 'ok', msg: `exposure $${Math.round(open)} / $${cap}`, metrics: m };
  }

  _skillConsistency(obs) {
    const brokerTypes = new Set([
      'opt_buy_error', 'opt_sell_error', 'cli_sync_error', 'buy_error', 'sell_error',
    ]);
    const parseTs = (ts) => {
      const s = String(ts || '');
      if (!s) return NaN;
      const iso = s.includes('T') ? s : s.replace(' ', 'T');
      const stamped = /Z|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}-04:00`;
      const d = Date.parse(stamped);
      return Number.isFinite(d) ? d : NaN;
    };
    const errs = (obs.journalRecent || []).filter((j) => {
      const t = String(j.type || '');
      if (brokerTypes.has(t)) return true;
      return /403/.test(String(j.error || j.note || ''));
    });
    const m = { recentErrors: errs.length, lastError: obs.lastError ? String(obs.lastError).slice(0, 160) : null };
    const newest = errs[0];
    const ts = newest ? parseTs(newest.ts) : NaN;
    const ageMs = Number.isFinite(ts) ? Date.now() - ts : Infinity;
    const FRESH_MS = 10 * 60 * 1000;
    if (obs.lastError && /403|available/i.test(String(obs.lastError)) && ageMs < FRESH_MS) {
      return { level: 'warn', msg: `Broker guard — latest reject on file (${m.lastError})`, metrics: m };
    }
    if (newest && ageMs < FRESH_MS) {
      return { level: 'warn', msg: `Broker guard — new reject this session (${newest.type || 'order error'})`, metrics: m };
    }
    if (errs.length) {
      return { level: 'ok', msg: `Broker guard idle — ${errs.length} old reject(s) on file, none this cycle`, metrics: m };
    }
    return { level: 'ok', msg: 'Broker guard idle — no rejects', metrics: m };
  }

  // ─── main loop ────────────────────────────────────────────────────────────

  async tick() {
    if (!this.running || this._busy || !this.cfg.enabled) return;
    const eng = this.optionsEngine;
    if (!eng) return;
    this._busy = true;
    try {
      const st = eng.getState();
      const obs = {
        now: Date.now(),
        feed: st.feed || this.optionsClient?.feed || 'indicative',
        armed: st.armed, enabled: st.enabled, entriesPaused: st.entriesPaused,
        dailyPnl: n(st.dailyPnl), unrealizedPnl: n(st.unrealizedPnl),
        dayPnlTotal: n(st.dayPnlTotal, n(st.dailyPnl) + n(st.unrealizedPnl)),
        dailyMaxLossUsd: st.cfg?.dailyMaxLossUsd,
        maxOpenPremiumUsd: st.cfg?.maxOpenPremiumUsd,
        openPremium: n(st.openPremium),
        openPositions: (st.open || []).length,
        workingOrders: (st.working || []).length,
        gateRecent: st.gate?.recent || [],
        journalRecent: (st.journal || []).slice(0, 120),
        lastError: st.lastError,
      };

      const findings = [];
      findings.push(['drawdown', this._skillDrawdown(obs)]);
      findings.push(['liquidity', this._skillLiquidity(obs)]);
      findings.push(['churn', this._skillChurn(obs)]);
      findings.push(['exposure', this._skillExposure(obs)]);
      findings.push(['consistency', this._skillConsistency(obs)]);

      for (const [skill, f] of findings) {
        if (!f) continue;
        this.skillState[skill] = { level: f.level, msg: f.msg, at: new Date().toISOString() };
        const autoKey = { drawdown: 'drawdownGuard', liquidity: 'liquidityGuard', churn: 'churnGuard', exposure: 'exposureGuard', consistency: 'consistencyGuard' }[skill];
        if (f.level === 'ok' || (f.level === 'info' && !f.vetoSymbols?.length)) continue;

        // symbol vetoes (liquidity guard)
        if (f.vetoSymbols?.length && this.cfg.auto[autoKey] !== false) {
          for (const sym of f.vetoSymbols) {
            eng.gate?.veto(sym, this.cfg.vetoMinutes, `brain:${skill}`);
          }
          this._decide(skill, f.level, f.msg, f.metrics, `vetoed ${f.vetoSymbols.join(', ')} ${this.cfg.vetoMinutes}m`);
          continue;
        }

        if (!f.action || this.cfg.auto[autoKey] === false) {
          this._decide(skill, f.level, f.msg, f.metrics, null);
          continue;
        }
        if (f.action === 'pause') {
          const taken = await this._pauseEntries(`${skill}: ${f.msg}`, this.cfg.pauseCooldownMin);
          if (taken) this._decide(skill, f.level, f.msg, f.metrics, taken);
        } else if (f.action === 'flatten' && this.cfg.auto.flattenOnHardBreach) {
          await this._pauseEntries(`${skill}: ${f.msg}`, 240);
          await eng.flattenAll('brain_hard_breach').catch(() => {});
          this._decide(skill, f.level, f.msg, f.metrics, 'flatten_all + entries_paused');
        } else if (f.action === 'disarm' && this.cfg.auto.disarmOnCatastrophe) {
          await eng.flattenAll('brain_catastrophe').catch(() => {});
          eng.setArmed(false);
          this._decide(skill, f.level, f.msg, f.metrics, 'DISARMED + flatten_all');
        } else {
          this._decide(skill, f.level, f.msg, f.metrics, null);
        }
      }

      const resumed = await this._maybeResumeEntries();
      if (resumed) this._decide('drawdown', 'info', 'conditions cleared — entries resumed', {}, resumed);

      await this._maybeNarrate(findings);
    } finally {
      this._busy = false;
    }
  }

  async _maybeNarrate(findings) {
    if (!this.cfg.narrate || !this.ollama || !this.ollamaUp) return;
    const interesting = findings.filter(([, f]) => f && (f.level === 'warn' || f.level === 'crit'));
    if (!interesting.length) return;
    if (Date.now() - this.lastNarrationAt < this.cfg.narrateMinGapMin * 60000) return;
    this.lastNarrationAt = Date.now();
    try {
      const lines = interesting.map(([s, f]) => `- [${s}] ${f.msg} (${JSON.stringify(f.metrics || {})})`).join('\n');
      const res = await this.ollama.chat([
        { role: 'system', content: 'You are the risk officer of a paper options trading desk. In 2-3 plain sentences, explain the current guard findings to the desk operator and what the automated guards did about it. No jargon, no lists.' },
        { role: 'user', content: lines },
      ]);
      this.lastNarration = { ts: new Date().toISOString(), text: String(res.content || '').trim().slice(0, 800) };
      this._saveState();
    } catch (err) {
      this.log.warn?.(`[brain] narrate: ${err.message}`);
    }
  }

  getState() {
    return {
      ok: true,
      type: 'agent_brain',
      enabled: this.cfg.enabled,
      running: this.running,
      intervalSec: this.cfg.intervalSec,
      ollamaUp: this.ollamaUp,
      pausedByBrain: this.pausedByBrain,
      pauseReason: this.pauseReason,
      pauseLeftSec: Math.max(0, Math.ceil((this.pauseUntil - Date.now()) / 1000)),
      skills: Object.entries({
        drawdown: 'Day PnL vs daily cap (realized + unrealized, mark-to-bid)',
        liquidity: 'Feed quality + toxic-book vetoes from gate rejects',
        churn: 'Cancel/chase storm detection',
        exposure: 'Open premium vs cap',
        consistency: 'Broker reject watch — new order errors only, not a live fault counter',
      }).map(([id, description]) => ({
        id, description,
        auto: this.cfg.auto[{ drawdown: 'drawdownGuard', liquidity: 'liquidityGuard', churn: 'churnGuard', exposure: 'exposureGuard', consistency: 'consistencyGuard' }[id]] !== false,
        ...(this.skillState[id] || { level: 'idle', msg: 'waiting for first tick', at: null }),
      })),
      lastNarration: this.lastNarration,
      journal: this.journal.slice(0, 60),
      cfg: this.cfg,
    };
  }
}

module.exports = AgentBrain;
module.exports.DEFAULT_CFG = DEFAULT_CFG;
