# RiskGate

**File:** `src/services/vol10s/options/RiskGate.js`  
**Used by:** every option entry (ranker signal, agent `place_option_trade`, manual buy, DCA)

RiskGate is the **only** pre-trade checkpoint. It re-reads a **fresh quote at order time**. A ranker score or an LLM suggestion cannot skip it.

## Rules (defaults)

| Gate | Default | Notes |
|---|---|---|
| Spread cap | 20% OPRA · 15% indicative · 12% 0DTE | Wider during 09:30–09:45 ET (`openSpreadMult`) |
| 0DTE | off | `allow0dte` must be true; size haircut 0.5× |
| Premium band | ask in [$0.50, $25] | Priced at **ask**, never mid |
| IV | 0.10–2.0 (wider at the open) | When greeks exist |
| Delta | \|delta\| ≥ 0.30 | |
| DTE | 1–45 | Weekly floor 1 |
| Notional | qty × ask × 100 ≤ $2,000 | Worst-case pay |
| Open premium | open + working ≤ $5,000 | |
| Daily loss lock | $2,000 | **Realized + unrealized, mark-to-bid** |
| Concurrent | 8 | Open + working |
| One working order | per symbol | Including DCA; blocked while a sell is working |
| Entries / symbol / day | 3 | |
| Cooldown | 120s | After cancel / close / reject storm |
| Chase abort | spread > 30% or pay > mid × 1.35 | Do not chase a widening book |
| Brain veto | per-symbol | `AgentBrain` can veto a name |

Failed checks are journaled (`ok: false`, reason). The trade is not resized through a failed gate — it is refused.

## Open window

`OpenWindow.js` widens spread/IV bands from **09:30–09:45 ET** so the open auction does not false-veto every name. Caps still exist.

## Feed

`setFeed('opra' | 'indicative')` follows `OptionsClient.probeFeed()`. Indicative books get the tighter 15% cap.

## Not in the fill path

XGBoost, NTSM, and the LLM **do not** call Alpaca. They produce candidates or chat. RiskGate + `OptionsPlayEngine` are the only path to `POST /v2/orders`.
