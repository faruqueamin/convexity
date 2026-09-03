# Pluggable LLM

**File:** `src/services/llm/LlmClient.js`  
**Used by:** `AgentService`, `AgentSupervisor`, `AgentBrain` (narration)

The hosted Convexity desk uses an **Ollama Cloud custom model**. This repo does not hard-code that name. **Any** model that speaks Ollama `/api/chat` or OpenAI `/v1/chat/completions` can be plugged in.

## Env

| Variable | Role |
|---|---|
| `VOL10S_LLM_PROVIDER` | `ollama` (default) or `openai` |
| `VOL10S_LLM_BASE_URL` | Host, no trailing slash |
| `VOL10S_LLM_MODEL` | Model id (any string) |
| `VOL10S_LLM_API_KEY` | Bearer token (Ollama Cloud, OpenAI, Groq, Featherless, …) |

Legacy aliases: `VOL10S_OLLAMA_URL`, `VOL10S_OLLAMA_MODEL`.

### Examples

**Local Ollama**

```
VOL10S_LLM_PROVIDER=ollama
VOL10S_LLM_BASE_URL=http://127.0.0.1:11434
VOL10S_LLM_MODEL=llama3.1
```

**Ollama Cloud (custom)**

```
VOL10S_LLM_PROVIDER=ollama
VOL10S_LLM_BASE_URL=https://ollama.com
VOL10S_LLM_API_KEY=…
VOL10S_LLM_MODEL=your-custom-model
```

**OpenAI-compatible** (OpenAI, Groq, Featherless, OpenRouter, vLLM, …)

```
VOL10S_LLM_PROVIDER=openai
VOL10S_LLM_BASE_URL=https://api.openai.com
VOL10S_LLM_API_KEY=…
VOL10S_LLM_MODEL=gpt-4o-mini
```

`LlmClient.chat(messages)` always returns `{ content, toolCalls }`.

If the LLM is down, the desk still ranks, RiskGate still runs, and AgentBrain still loops.

## Agent chat (`AgentService`)

Prompt-protocol tools: the model emits one fenced `json` block `{ "tool", "args" }`. Up to 6 rounds. History is in-memory only.

## Tools (`AgentTools`) — 15s timeout, ≤ 50 rows

| Tool | Data | Can trade? |
|---|---|---|
| `query_stock_metrics` | Alpaca snapshots | no |
| `query_bars` | Alpaca 1m/5m/15m bars | no |
| `get_options_screener` | Screener table | no |
| `get_option_chain` | Live chain | no |
| `get_engine_state` | Armed flags, P&L | no |
| `alpaca_cli` | CLI whitelist only | **no** (no order create/cancel) |
| `place_option_trade` | `agentEntry` | only if `trade_enabled` **and** engine armed **and** RiskGate |

CLI whitelist: `account get`, `position list`, `order list`, `clock`, `calendar`.

## Supervisor (`AgentSupervisor`)

Every N minutes (default 5) the model must return strict JSON:

```json
{ "assessment": "…", "advisories": ["…"], "pause_new_entries": false, "tighten": false }
```

If `supervisor_auto` is true it may **only**:

- set `entriesPaused`
- lower `maxConcurrent` by 1 (floor 1)

It cannot arm, trade, or raise a limit. Parse failures are journaled and skipped.
