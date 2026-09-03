<p align="center">
  <img src="brand/logo-lockup.svg" alt="Convexity" height="56" />
</p>

<h1 align="center">Convexity</h1>

<p align="center">
  <strong>Autonomous Options Alpha Agent</strong> · Alpaca AI Trading Agents Hackathon<br />
  <a href="https://lablab.ai/ai-hackathons/alpaca-ai-trading-agents-hackathon/convexity">Team page</a>
  ·
  <a href="https://lablab.ai/ai-hackathons/alpaca-ai-trading-agents-hackathon">Challenge</a>
</p>

Convexity is a paper-trading options desk. It ranks live option setups with **XGBoost** (contract quality) and **NTSM** (neural time-series over Alpaca 1-minute bars), decides through a mandatory **RiskGate** on a fresh quote, executes on Alpaca's **Trading API**, and reconciles the street with the **Alpaca CLI**. A 15-second brain can only ever reduce risk. No model sits in the fill path.

Live command desk: `/desk` · Story site: `/landing/`

## Bring your own model

The hosted desk uses an **Ollama Cloud custom model**. You can plug in **any** model:

| Provider | Env |
|---|---|
| Ollama local | `VOL10S_LLM_PROVIDER=ollama` · `VOL10S_LLM_BASE_URL=http://127.0.0.1:11434` · `VOL10S_LLM_MODEL=llama3.1` |
| Ollama Cloud | `VOL10S_LLM_PROVIDER=ollama` · `VOL10S_LLM_BASE_URL=https://ollama.com` · `VOL10S_LLM_API_KEY` · `VOL10S_LLM_MODEL=<your-custom>` |
| OpenAI-compatible | `VOL10S_LLM_PROVIDER=openai` · `VOL10S_LLM_BASE_URL` · `VOL10S_LLM_API_KEY` · `VOL10S_LLM_MODEL` |

OpenAI-compatible covers OpenAI, Groq, Featherless, OpenRouter, and anything that speaks `/v1/chat/completions`. The LLM may narrate and pause risk. It cannot arm, raise a limit, or place an order unless `trade_enabled` is on **and** RiskGate still passes.

## Rankers (swap them)

| Model | Role | Swap |
|---|---|---|
| **XGBoost** | Scores spread, IV, delta, DTE, OI, premium | `VOL10S_XGB_MODEL` → your booster JSON |
| **NTSM** | Recurrent net over the last N Alpaca 1m bars | `VOL10S_NTSM_MODEL` |

Both emit a 0–1 score. The blend ranks the watchlist. **RiskGate** is the only thing that can send an order.

## Alpaca stack

- **Trading API** (paper) — orders, positions, account
- **Market Data API** — stock bars/snapshots, option chains, SIP/OPRA sockets
- **Alpaca CLI** — `account get` / `position list` every 60s and as a read-only agent tool

There is no third-party tape database. Point keys at paper and run.

## Risk gates

- Hard spread caps: 20% OPRA · 15% indicative · 12% 0DTE
- Premium and size priced at the **ask**, never mid
- One working order per symbol
- Daily loss lock = realized + unrealized, marked to bid
- `assertPaper()` refuses live URLs and live-looking keys

## Run

```bash
cp docs/env.example envs/vol10s-paper.env   # paper keys + any LLM
npm install
# optional: alpaca profile / CLI binary on PATH
pm2 start ecosystem.config.js               # http://127.0.0.1:8977/desk
```

Everything ships **disarmed**. Arm from the desk when you want paper orders.

The frontend in this repo is the **built** desk + landing bundle only.

## Docs

Full architecture and one page per subsystem: **[docs/README.md](docs/README.md)** · detailed breakdown **[docs/SYSTEM.md](docs/SYSTEM.md)**.

Paper trading is a simulation. Results are hypothetical and do not represent actual trading. Options involve substantial risk.
