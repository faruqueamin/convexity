# Convexity — detailed system breakdown

Convexity is a **single Node process** that runs an autonomous **paper** options desk. It ranks live setups with **XGBoost** and **NTSM**, decides through **RiskGate**, executes on Alpaca’s **paper Trading API**, and reconciles with the **Alpaca CLI**. An optional LLM (any model) can narrate and shrink risk. No model sits in the fill path.

Live surfaces: story site `/` or `/landing/` · operator desk `/desk`.

Paper trading is a simulation. Results are hypothetical and do not represent actual trading. Options involve substantial risk.

---

## 1. What the system is (and is not)

| It is | It is not |
|---|---|
| A paper-only options agent on a $100k Alpaca paper account | Live brokerage |
| Rankers that **score** public features | A model that can bypass RiskGate |
| Alpaca Market Data + Trading API + CLI | A third-party tape warehouse |
| A brain that can only **reduce** risk | An LLM that can arm or raise limits |
| A built frontend (desk + landing) | Frontend source in this repo |

Process entry: `src/vol10s-paper-server.js` (pm2 name `vol10s-paper`, default `127.0.0.1:8977`).

---

## 2. Authority envelope

Orders only happen if **all** of these are true:

1. Paper keys pass `assertPaper()` (URL must be `paper-api.alpaca.markets`; live-looking `AK…` keys refused).
2. Options engine is **enabled** and **armed** (both default false).
3. Entry window is open (Regular hours, configurable ET bounds).
4. **RiskGate** accepts a **fresh** quote at order time.
5. Daily loss lock, concurrency, and “one working order per symbol” are clear.
6. If the LLM requested the trade: `agent.trade_enabled` is also true.

The LLM and the rankers **never** submit to Alpaca. They emit scores or tool calls. `OptionsPlayEngine` is the only submitter.

```
  XGBoost / NTSM / human / LLM
              │
              ▼
         candidate
              │
              ▼
          RiskGate     ← can only reject
              │
              ▼
     OptionsPlayEngine  ← only path that POSTs /v2/orders
              │
              ▼
     Alpaca paper Trading API
```

---

## 3. Process map (one box)

```
                         Alpaca Market Data API
                    (bars, snapshots, chains, SIP/OPRA WS)
                              │
                              ▼
 ┌──────────────────────── DeskEngine ─────────────────────────┐
 │  SetupScanner → SetupRanker (XGBoost + NTSM)           │
 │  watchlist / journal / paper account snapshot            │
 │        │                                                │
 │        │  onEntrySignal                                  │
 │        ▼                                                │
 │  OptionsPlayEngine ── RiskGate → PaperAlpacaClient      │
 │        │                    │                           │
 │        │                    └── Alpaca CLI (60s sync)  │
 │        ▼                                                │
 │  AgentBrain (15s, deterministic, can only shrink risk)  │
 │  AgentService + AgentSupervisor (pluggable LLM)         │
 │  LiveMarketHub (stock + option websockets)               │
 │  Vol10sPaperServer (HTTP + WebSocket)                   │
 └─────────────────────────────────────────────────────────┘
                              │
                              ▼
                    /desk  (built UI)
                    /landing  (built story site)
```

Boot order (`src/vol10s-paper-server.js`):

1. Load `envs/vol10s-paper.env`
2. Construct Alpaca paper client, options data client, fill ledger, pending book
3. `DeskEngine` + `OptionsPlayEngine` + screener
4. Pluggable `LlmClient` → agent tools / chat / supervisor / brain
5. `LiveMarketHub` + order websocket
6. HTTP+WS listen → ping LLM → start screener, streams, engines, brain

Shutdown on SIGINT/SIGTERM: stop streams, engines, brain, HTTP.

---

## 4. Data flow (one scan cycle)

Default poll is 15s (`VOL10S_POLL_MS`). Universe refresh is 5 minutes (`VOL10S_UNIVERSE_MS`).

```
1. listOptionableAssets()          Trading API  GET /v2/assets?attributes=has_options
2. getStockSnapshot(symbol)        Data API     last + day volume  (price band $5–$500)
3. getStockBars(symbol, 1Min)     Data API      last ~30 1m bars → NTSM
4. listContracts + snapshots        Trading + Data APIs → ATM-ish contract
5. SetupRanker.rank()
      NTSM  → side (call|put), continuation, callScore, putScore
      XGB   → contract quality 0–1
      blend = 0.55·xgb + 0.45·tape·continuation
6. If blend ≥ minScore (0.52) → watchlist row (xgbScore, ntsmScore, side, occ)
7. If desk is ARMED → OptionsPlayEngine.handleEntrySignal
8. RiskGate.evaluateEntry(fresh quote)
9. Limit buy at the ask  (paper Trading API)
10. Exits in code on live marks; CLI reconciles account/positions every 60s
```

Nothing in steps 5–6 can place an order. Step 9 is the only POST to `/v2/orders`.

---

## 5. Runtime objects

| Object | File | Role |
|---|---|---|
| `PaperAlpacaClient` | `src/services/vol10s/PaperAlpacaClient.js` | Paper trading REST; `assertPaper()` |
| `OptionsClient` | `src/services/vol10s/OptionsClient.js` | Assets, chains, snapshots, bars, Black-Scholes fallback |
| `DeskEngine` | `src/services/vol10s/DeskEngine.js` | Watchlist, scan loop, arm flag, snapshot for the UI |
| `SetupScanner` | `src/services/vol10s/SetupScanner.js` | Universe + per-name rank |
| `SetupRanker` | `src/services/ml/SetupRanker.js` | Blend XGBoost + NTSM |
| `XgbScorer` | `src/services/ml/XgbScorer.js` | GBDT inference |
| `NtsmScorer` | `src/services/ml/NtsmScorer.js` | Recurrent tape score |
| `OptionScreener` | `src/services/vol10s/OptionScreener.js` | Chain-volume table for the desk |
| `OptionsPlayEngine` | `src/services/vol10s/OptionsPlayEngine.js` | Entries, working orders, exits |
| `RiskGate` | `src/services/vol10s/options/RiskGate.js` | Mandatory pre-trade checkpoint |
| `BidMoveGate` | `src/services/vol10s/options/BidMoveGate.js` | Optional bid-move confirm |
| `PendingOrderBook` | `src/services/vol10s/PendingOrderBook.js` | One working order per symbol |
| `PaperFillLedger` | `src/services/vol10s/PaperFillLedger.js` | Fill / P&L ledger |
| `DeskEventLog` | `src/services/vol10s/DeskEventLog.js` | JSONL desk events |
| `LiveMarketHub` | `src/services/vol10s/LiveMarketHub.js` | SIP/IEX + OPRA sockets |
| `AlpacaOrderWs` | `src/services/vol10s/AlpacaOrderWs.js` | `trade_updates` |
| `LlmClient` | `src/services/llm/LlmClient.js` | Ollama or OpenAI-compatible |
| `AgentTools` | `src/services/agent/AgentTools.js` | 7 tools; CLI is read-only |
| `AgentService` | `src/services/agent/AgentService.js` | Chat + prompt-protocol tools |
| `AgentSupervisor` | `src/services/agent/AgentSupervisor.js` | Periodic JSON risk review |
| `AgentBrain` | `src/services/agent/AgentBrain.js` | Deterministic 15s guards |
| `Vol10sPaperServer` | `src/services/vol10s/Vol10sPaperServer.js` | HTTP + WebSocket |
| `AdminAuth` | `src/services/vol10s/AdminAuth.js` | Optional desk password |

---

## 6. Loops and cadences

| Loop | Cadence | Owner |
|---|---|---|
| Universe refresh | 5 min | `DeskEngine` |
| Rank / scan | 15 s | `DeskEngine.scanOnce` |
| Broker account sync | 15 s | `DeskEngine.syncBroker` |
| Options engine tick | 3 s | `OptionsPlayEngine` |
| Exit eval | ~3–5 s | `OptionsPlayEngine` |
| Alpaca CLI sync | 60 s | `OptionsPlayEngine` (`account get`, `position list`) |
| AgentBrain | 15 s | `AgentBrain.tick` |
| Supervisor | 5 min (if enabled) | `AgentSupervisor` |
| Order websocket | evented | `AlpacaOrderWs` |
| Market data sockets | evented | `LiveMarketHub` |
| HTTP + desk WS | request / push | `Vol10sPaperServer` |

---

## 7. Identify → Decide → Execute → Manage

Hackathon “plan” mapped onto code:

| Step | Public behavior | Code |
|---|---|---|
| **Identify** | Optionable Alpaca names, 1m bars, nearest-expiry ATM-ish contract | `SetupScanner` + `OptionsClient` |
| **Score** | XGBoost on the book, NTSM on the tape, blended rank | `SetupRanker` |
| **Decide** | Fresh-quote RiskGate; brain may pause/veto | `RiskGate`, `AgentBrain` |
| **Execute** | Limit at ask on paper Trading API | `OptionsPlayEngine` + `PaperAlpacaClient` |
| **Manage** | Mark to bid, trail/stop/flatten in code, CLI reconcile | `OptionsPlayEngine` + CLI |

The optional LLM sits **beside** this pipeline (chat + supervisor). It does not replace RiskGate.

---

## 8. Surfaces (HTTP)

| Path | Who | What |
|---|---|---|
| `/` | public | Landing on `convexity.*` hosts; desk locally |
| `/landing/*` | public | Built story site (consent modal + “Revisit consent”) |
| `/desk` | observer / admin | Built command desk |
| `GET /api/vol10s-paper/state` | observer | Sanitized snapshot |
| `POST /api/vol10s-paper/arm` | admin | Arm / disarm |
| `GET/POST /api/options/engine*` | mixed | Engine state, flatten, config |
| `GET /api/options/screener` | observer | Screener rows |
| `GET /api/options/chain` | observer | Live chain |
| `GET /api/brain/state` | observer | Brain journal + skills |
| `POST /api/agent/chat` | admin | LLM chat |
| `POST /api/kill` | loopback | Disarm + flatten |
| `WS` | both | Live snapshot / ticks (observers cannot send trade actions) |

Admin is an httpOnly cookie (`VOL10S_ADMIN_PASSWORD`). With no password, only loopback is treated as operator.

---

## 9. Persistence (local files, gitignored)

Under `data/vol10s-paper/` (never commit):

| File | Purpose |
|---|---|
| `config.json` | Desk + options knobs |
| `state.json` | Watchlist / engine state |
| `options-state.json` | Open option positions |
| `options-scan.json` | Screener cache |
| `fills.jsonl` / `fill-model.json` | Ledger |
| `desk-events.jsonl` | Event log |
| `brain-config.json` / `brain-state.json` | Brain |

Keys live in `envs/vol10s-paper.env` (gitignored). Template: `docs/env.example`.

---

## 10. Failure and safety

- Missing paper keys → scan-only, no orders.
- LLM down → desk still ranks, RiskGate still runs, brain still loops.
- Market data 403 on SIP → bars retry `feed=iex`.
- OPRA unavailable → indicative quotes; RiskGate uses the tighter indicative spread cap.
- Kill switch: `POST /api/kill` (loopback) or desk KILL — disarms and flattens.

---

## 11. What this public tree does not include

The published repo ships rankers, RiskGate, Alpaca wiring, the brain, and the **built** UI. It does not ship a proprietary tape detector or option-picker UI. You can replace `SetupScanner` / `SetupRanker` with your own signal source; the rest of the desk stays the same.

---

## 12. Read next

- Rankers: [xgboost.md](./xgboost.md) · [ntsm.md](./ntsm.md) · [setup-scanner.md](./setup-scanner.md)
- Gates and fills: [risk-gate.md](./risk-gate.md) · [execution.md](./execution.md)
- Intelligence: [agent-brain.md](./agent-brain.md) · [llm.md](./llm.md)
- Broker: [alpaca.md](./alpaca.md)
- UI and env: [desk.md](./desk.md) · [config.md](./config.md)
