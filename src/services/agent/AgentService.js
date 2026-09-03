'use strict';

/**
 * AgentService — chat loop over the local Ollama model with prompt-protocol
 * tool calling (gemma3:12b has no native tools support on this box).
 *
 * The system prompt instructs the model to emit exactly one fenced block
 *     ```json {"tool":"name","args":{...}} ```
 * when it wants a tool. We parse it, execute via AgentTools, append the
 * result as a user message, and loop (max 6 rounds). If the model ever does
 * emit native message.tool_calls, those are honored too.
 *
 * In-memory history only (last ~20 messages); nothing is persisted.
 */

const MAX_ROUNDS = 6;
const HISTORY_MAX = 20;
const TOOL_RESULT_MAX = 6000;
const PING_TTL_MS = 5000;

class AgentService {
  constructor({ ollama, tools, log, config, persistConfig, supervisor } = {}) {
    this.ollama = ollama;
    this.tools = tools;
    this.log = log || console;
    this.cfg = config && typeof config === 'object' ? { ...config } : { enabled: true, trade_enabled: false };
    this.persistConfig = typeof persistConfig === 'function' ? persistConfig : null;
    this.supervisor = supervisor || null;
    this.history = []; // [{role, content}] completed turns only
    this.ollamaUp = null; // null = unknown, bool after first ping/chat
    this._lastPingAt = 0;
  }

  // ─── system prompt ────────────────────────────────────────────────────────

  _systemPrompt() {
    const toolLines = this.tools.definitions().map((d) => {
      const args = Object.entries(d.args || {}).map(([k, v]) => `    "${k}": ${v}`).join('\n');
      return `- ${d.name}: ${d.description}\n  args: {\n${args || '    (none)'}\n  }`;
    }).join('\n');
    return [
      'You are the analyst inside Convexity, an Alpaca PAPER-TRADING options desk (simulated funds).',
      'Tape and option chains come from the Alpaca Market Data API. Orders go only to the paper Trading API.',
      'Account/position checks use the Alpaca CLI (read-only).',
      'Setups are ranked by XGBoost (contract quality) and NTSM (1-minute tape). RiskGate still owns every order.',
      '',
      'DATA AVAILABLE:',
      '- Alpaca optionable assets and stock snapshots (last, day volume).',
      '- Alpaca 1m / 5m / 15m bars.',
      '- Options screener and live chains (bid/ask/greeks/IV).',
      '- Options engine state and a read-only Alpaca CLI.',
      '',
      'TOOLS:',
      toolLines,
      '',
      'TOOL CALLING PROTOCOL (mandatory):',
      '- To call a tool, reply with EXACTLY ONE fenced block and NOTHING else:',
      '  ```json {"tool":"<name>","args":{...}} ```',
      '- After each tool call you receive the result as a user message starting with "Tool result".',
      '- You may chain up to 6 tool calls. When you have enough data, answer in plain prose with NO fenced block.',
      '- Never invent data: only report numbers that appear in tool results.',
      '- "optionable" means security_type in (CS, ETF, ADRC) — filter with op "in".',
      '',
      'SAFETY:',
      '- All money is paper. Never claim a trade happened unless place_option_trade returned ok:true.',
      '- If a tool returns ok:false (e.g. trade_disabled), tell the user plainly and do NOT pretend it worked.',
      '- alpaca_cli is read-only; you cannot create or cancel orders through it.',
      '- Keep answers concise. Use $ and commas for money, compact numbers for volume.',
    ].join('\n');
  }

  // ─── protocol parsing ─────────────────────────────────────────────────────

  // First fenced ```json {...}``` block with a string "tool" field → {name,args}.
  _extractToolCall(content) {
    const m = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(content || '');
    if (!m) return null;
    try {
      const obj = JSON.parse(m[1]);
      if (obj && typeof obj.tool === 'string' && obj.tool) {
        return { name: obj.tool, args: obj.args && typeof obj.args === 'object' ? obj.args : {} };
      }
    } catch (_) {}
    return null;
  }

  // ─── chat loop ────────────────────────────────────────────────────────────

  async chat(userText) {
    const text = String(userText || '').trim().slice(0, 4000);
    if (!text) return { reply: '', trace: [] };
    const trace = [];
    const messages = [
      { role: 'system', content: this._systemPrompt() },
      ...this.history,
      { role: 'user', content: text },
    ];

    let reply = '';
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let res;
      try {
        res = await this.ollama.chat(messages);
        this.ollamaUp = true;
      } catch (err) {
        this.ollamaUp = false;
        throw err;
      }
      const calls = res.toolCalls.length ? res.toolCalls : [];
      const proto = calls.length ? null : this._extractToolCall(res.content);
      if (!calls.length && !proto) {
        reply = res.content.trim();
        break;
      }
      const batch = calls.length ? calls : [proto];
      messages.push({ role: 'assistant', content: res.content || '' });
      for (const call of batch) {
        const t0 = Date.now();
        const result = await this.tools.execute(call.name, call.args);
        const ms = Date.now() - t0;
        const entry = { tool: call.name, args: call.args, ms };
        if (result && result.ok === false) entry.error = result.error || result.reason || 'failed';
        entry.resultSummary = JSON.stringify(result).slice(0, 400);
        trace.push(entry);
        this.log.info?.(`[agent] tool ${call.name}(${JSON.stringify(call.args).slice(0, 120)}) → ${ms}ms ${entry.error ? 'ERR ' + entry.error : 'ok'}`);
        messages.push({
          role: 'user',
          content: `Tool result for ${call.name}:\n${JSON.stringify(result, null, 1).slice(0, TOOL_RESULT_MAX)}`,
        });
      }
      if (round === MAX_ROUNDS - 1) {
        reply = reply || 'I hit the tool-call limit (6) without a final answer. Try a narrower question.';
      }
    }

    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    return { reply, trace };
  }

  // ─── state / config ───────────────────────────────────────────────────────

  async _refreshPing() {
    if (Date.now() - this._lastPingAt < PING_TTL_MS) return;
    this._lastPingAt = Date.now();
    const p = await this.ollama.ping();
    this.ollamaUp = p.ok;
    if (p.ok && !p.modelLoaded) {
      this.log.warn?.(`[agent] ollama up but model ${this.ollama.model} not in /api/tags`);
    }
  }

  async getState() {
    await this._refreshPing().catch(() => { this.ollamaUp = false; });
    const supCfg = this.supervisor ? this.supervisor.cfg : {};
    return {
      ok: true,
      enabled: this.cfg.enabled === true,
      tradeEnabled: this.cfg.trade_enabled === true,
      model: this.cfg.model || this.ollama.model,
      ollamaUp: this.ollamaUp,
      messageCount: this.history.length,
      supervisor: this.supervisor ? {
        enabled: supCfg.supervisor_enabled === true,
        auto: supCfg.supervisor_auto === true,
        intervalMin: supCfg.supervisor_interval_min,
        running: this.supervisor.running,
      } : null,
      lastSupervisor: this.supervisor ? this.supervisor.last : null,
    };
  }

  async setConfig(patch = {}) {
    const next = { ...this.cfg };
    if ('enabled' in patch) next.enabled = Boolean(patch.enabled);
    if ('trade_enabled' in patch) next.trade_enabled = Boolean(patch.trade_enabled);
    if ('supervisor_enabled' in patch) next.supervisor_enabled = Boolean(patch.supervisor_enabled);
    if ('supervisor_auto' in patch) next.supervisor_auto = Boolean(patch.supervisor_auto);
    if ('supervisor_interval_min' in patch) {
      const n = Math.floor(Number(patch.supervisor_interval_min));
      if (Number.isFinite(n) && n >= 1) next.supervisor_interval_min = Math.min(120, n);
    }
    if ('model' in patch && String(patch.model || '').trim()) {
      next.model = String(patch.model).trim().slice(0, 80);
      this.ollama.model = next.model;
    }
    this.cfg = next;
    if (this.supervisor) {
      try { this.supervisor.configure(); } catch (err) {
        this.log.warn?.(`[agent] supervisor configure failed: ${err.message}`);
      }
    }
    if (this.persistConfig) {
      try { await this.persistConfig(next); } catch (err) {
        this.log.warn?.(`[agent] config persist failed: ${err.message}`);
      }
    }
    this.log.info?.(`[agent] config: enabled=${this.cfg.enabled} trade_enabled=${this.cfg.trade_enabled} model=${this.cfg.model}`);
    return this.getState();
  }
}

module.exports = AgentService;
