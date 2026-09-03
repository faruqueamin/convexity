# Convexity — one-page hackathon write-up

**Autonomous Options Alpha Agent** on Alpaca paper. MIT.

## AI logic

Two rankers, neither in the fill path:

- **XGBoost** — gradient-boosted trees over public contract features (spread, IV, delta, DTE, OI, premium, rvol).
- **NTSM** — a compact neural time-series model over the last N **Alpaca 1-minute bars** (returns, range, volume).

The blend ranks the watchlist. You can swap either model file. The hosted desk's LLM is an **Ollama Cloud custom model**; operators plug in any Ollama or OpenAI-compatible endpoint.

A 15-second **AgentBrain** (deterministic, LLM-optional) can only reduce risk: pause entries, veto a symbol, flatten on hard drawdown. A hung model cannot strand a position.

## Risk gates

`RiskGate` runs on every entry path (ranker, agent, human) at order time:

- spread caps on every DTE path (tighter on indicative / 0DTE)
- size and premium at the **ask**
- one working order per symbol
- daily loss lock = realized + unrealized (mark-to-bid)
- `assertPaper()` refuses live URLs and live-looking keys

## Alpaca infrastructure

- **Trading API** — paper orders, positions, account
- **Market Data API** — stock bars/snapshots, option chains, SIP/OPRA websockets
- **Alpaca CLI** — `account get` / `position list` every 60s; read-only agent tool (`place_option_trade` still goes through RiskGate)

No other tape database. Starts disarmed on a $100,000 paper account.
