# Convexity documentation

Paper-trading **Options Alpha Agent** for the Alpaca AI Trading Agents Hackathon.

| Document | What it covers |
|---|---|
| [SYSTEM.md](./SYSTEM.md) | End-to-end architecture, data flow, authority, process map |
| [xgboost.md](./xgboost.md) | XGBoost contract-quality ranker |
| [ntsm.md](./ntsm.md) | NTSM neural time-series tape ranker |
| [setup-scanner.md](./setup-scanner.md) | Universe → rank → watchlist |
| [risk-gate.md](./risk-gate.md) | Mandatory pre-trade checkpoint |
| [execution.md](./execution.md) | Options engine, fills, exits, CLI sync |
| [agent-brain.md](./agent-brain.md) | 15s observe → analyze → act loop |
| [llm.md](./llm.md) | Pluggable LLM (Ollama Cloud / local / OpenAI-compatible) |
| [alpaca.md](./alpaca.md) | Trading API, Market Data API, CLI |
| [desk.md](./desk.md) | HTTP/WS server, built UI, paper consent |
| [config.md](./config.md) | Environment, arming, model swap |
| [hackathon-writeup.md](./hackathon-writeup.md) | One-page submission write-up |
| [CONVEXITY.md](./CONVEXITY.md) | Public README-style story |
| [env.example](./env.example) | Env template (no secrets) |

Start here: **[SYSTEM.md](./SYSTEM.md)**.
