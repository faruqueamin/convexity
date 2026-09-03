# Alpaca stack

Convexity talks to Alpaca three ways. There is no other market-data warehouse in the public tree.

## 1. Trading API (paper)

**Client:** `PaperAlpacaClient.js`  
**Base:** `VOL10S_ALPACA_BASE_URL=https://paper-api.alpaca.markets`

| Call | Use |
|---|---|
| `GET /v2/account` | Cash, equity, account number |
| `GET /v2/positions` | Street positions |
| `POST /v2/orders` | Option (and equity) orders |
| `GET /v2/assets?attributes=has_options` | Optionable universe |
| `GET /v2/options/contracts` | Chains |

`assertPaper()` refuses any non-paper URL and any live-looking `AK…` key.

## 2. Market Data API

**Client:** `OptionsClient.js`  
**Base:** `VOL10S_ALPACA_DATA_URL=https://data.alpaca.markets`

| Call | Use |
|---|---|
| Stock trades/bars/snapshot | Spot, day volume, **1m/5m/15m bars** (NTSM) |
| Option snapshots | Bid/ask, greeks, IV, volume |
| Stock WS (SIP → IEX, optional BOATS overnight) | Live tape |
| Options WS (OPRA MsgPack, else indicative) | Live option marks |

Optional dedicated data key (`VOL10S_DATA_ALPACA_KEY` or `ALPACA_OPTIONS_DATA_API_KEY_2`) so snapshot bursts do not 429 the trading key. Trading stays on `VOL10S_ALPACA_*`.

If SIP is not entitled, bars retry `feed=iex`. If OPRA probe fails, RiskGate uses the **indicative** spread cap (15%).

Missing greeks/IV: local Black-Scholes solver from mid + spot (`r = 0.043`).

## 3. Alpaca CLI

**Env:** `VOL10S_ALPACA_CLI=true`, optional `VOL10S_ALPACA_CLI_BIN`

| Where | Commands |
|---|---|
| Engine loop (~60s) | `account get`, `position list` |
| Agent tool `alpaca_cli` | Same plus `order list`, `clock`, `calendar` |

Hard read-only whitelist. `order create` / `cancel` never pass. Child processes get `VOL10S_ALPACA_KEY` / `SECRET` injected so a leftover AWS profile cannot leak in.

Hackathon rule is **MCP or CLI**. This project uses **CLI**.

## Paper account

Hackathon judging wants a **fresh** paper account at **$100,000**. The process starts **disarmed**. Arm from `/desk` when you want paper orders.
