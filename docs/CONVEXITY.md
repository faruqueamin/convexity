<p align="center">
  <img src="brand/logo-lockup.svg" alt="Convexity" height="56" />
</p>

<h1 align="center">Convexity</h1>

<p align="center">
  <strong>Autonomous Options Alpha Agent</strong> · Alpaca AI Trading Agents Hackathon
</p>

Paper-trading options desk. **XGBoost** scores the contract book. **NTSM** scores the Alpaca 1-minute tape. **RiskGate** decides. Alpaca **Trading API** + **CLI** execute and reconcile. Plug in any LLM (Ollama Cloud custom, local Ollama, or OpenAI-compatible). No model in the fill path.

## Identify → Decide → Execute → Manage

| Step | What happens |
|---|---|
| **Identify** | Alpaca Market Data API (bars, snapshots, option chains). XGBoost + NTSM rank setups. |
| **Decide** | RiskGate on a fresh quote: spread caps, ask-priced notional, one working order, daily loss lock. |
| **Execute** | Paper Trading API. Limit at the ask. $100,000 paper. Starts disarmed. |
| **Manage** | Mark to bid. Trail / stop / flatten in code. CLI `account get` / `position list` every 60s. |

Bring your own model via `VOL10S_LLM_*`. Swap rankers via `VOL10S_XGB_MODEL` / `VOL10S_NTSM_MODEL`.
