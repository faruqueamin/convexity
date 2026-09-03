# AgentBrain

**File:** `src/services/agent/AgentBrain.js`  
**Cadence:** 15 seconds (`intervalSec`)  
**LLM:** optional narration only

Always-on **deterministic** observe → analyze → act loop over the options book. It works with or without Ollama. It can **only reduce risk**.

## Guard skills

| Skill | Default action |
|---|---|
| **drawdown** | Pause entries at 80% of daily loss cap; flatten at 1.25×; optional disarm at 1.5× (`disarmOnCatastrophe`, default off) |
| **liquidity** | Veto symbols whose quotes keep failing RiskGate |
| **churn** | Pause entries on cancel/chase storms (window + cancel limit) |
| **exposure** | Bound aggregate open premium |
| **consistency** | Broker 403 / qty-desync patterns |

Each tick journals `{ skill, level, decision, metrics, actionTaken }` (persisted `brain-state.json`). Repeated identical no-op decisions are collapsed.

## Authority

Allowed actions:

- `pause_entries` / `resume_entries` (`options.entriesPaused`)
- `veto_symbol` (RiskGate per-symbol veto, minutes)
- `flatten_all` — only on hard drawdown breach
- `disarm` — only on catastrophe if that flag is on

The brain **cannot** arm, raise `maxConcurrent`, or place an order.

## HTTP

- `GET /api/brain/state` — journal, skill lights, pause state
- `POST /api/brain/config` — admin: interval, auto flags, thresholds

Optional Ollama narration (`narrate: true`) turns a decision into a short English line when the LLM is up. Guards still fire if the model is down.
