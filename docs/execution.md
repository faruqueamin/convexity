# Execution engine

**File:** `src/services/vol10s/OptionsPlayEngine.js`  
**Clients:** `PaperAlpacaClient.js`, `OptionsClient.js`  
**Helpers:** `PendingOrderBook.js`, `PaperFillLedger.js`, `BidMoveGate.js`

This is the **only** module that submits option orders. Rankers and the LLM stop at “candidate.”

## Entry

`handleEntrySignal({ symbol, side, qty?, refPx, reason })`

1. Engine must be **running + enabled + armed**.
2. Inside the ET entry window (default ~09:35–15:30).
3. Not in daily loss lock; `entriesPaused` must be false.
4. One working order per underlying (`PendingOrderBook`).
5. Pick a contract (`OptionsClient.pickContract` — nearest listed expiry, premium/delta/spread band).
6. **RiskGate.evaluateEntry** on a fresh quote.
7. Optional bid-move confirm (`BidMoveGate`).
8. **Limit buy at the ask**. Unfilled buys cancel after `cancelAfterSec` (default 20s). Re-pegs re-check the book (chase guard).

`agentEntry` is the same path with `reason: agent: …` and requires `agent.trade_enabled`.

## Exits (code, not prompts)

Evaluated on live bid / IV (engine tick ~3s):

- Instant profit / profit-lock + giveback trail
- Bid stop
- Time gates and session flatten (default **15:50 ET**)
- Unfilled sells re-peg toward the bid

A hung LLM cannot strand a position: flatten and stops are deterministic.

## Reconciliation

| Channel | What |
|---|---|
| REST | Positions and orders on the tick |
| `AlpacaOrderWs` | `trade_updates` |
| Alpaca CLI | Every 60s: `account get`, `position list` (`VOL10S_ALPACA_CLI=true`) |

CLI child env is forced to `VOL10S_ALPACA_*` so a leftover shell profile cannot leak in (`alpacaCliEnv.js`).

## Paper-only

`assertPaper()` in both REST clients:

- Base URL must include `paper-api.alpaca.markets`
- Trading key must not look live (`AK…`)

## Kill

`POST /api/kill` (loopback) or desk KILL: disarm + flatten all option positions; journaled `kill_switch`.
