# NTSM — Neural Time-Series Model

**File:** `src/services/ml/NtsmScorer.js`  
**Weights:** `src/services/ml/ntsmModel.json` (optional; bundled weights if missing)  
**Swap:** `VOL10S_NTSM_MODEL`

NTSM is a compact **recurrent net** over the last N **Alpaca 1-minute bars**. It scores **tape continuation** (call vs put). It is not a proprietary detector and does not send orders.

## Input

Last ~20 closed 1m bars from `OptionsClient.getStockBars(symbol, { timeframe: '1Min' })`.

Each step (bar `i` vs previous close):

| Feature | Formula |
|---|---|
| `ret` | `(close − prevClose) / prevClose` |
| `rangePct` | `(high − low) / low` |
| `volZ` | `(volume − meanVol) / sdVol` |
| `closeLoc` | `(close − low) / (high − low)` |

## Network

- Input dim 4, hidden 8
- Recurrence: `h = tanh(Wx x + Wh h + b)`
- Three logits → sigmoid:
  - `callScore`
  - `putScore`
  - `continuation`

`side` is `call` if `callScore ≥ putScore`, else `put`.

Weights can be a JSON file (`Wx`, `Wh`, `b`, `Wo`, `bo`) or the bundled seed network.

## Output

```json
{
  "model": "ntsm",
  "callScore": 0.58,
  "putScore": 0.41,
  "continuation": 0.57,
  "side": "call",
  "bars": 19
}
```

`SetupRanker` uses `side` to pick the contract and `continuation × (call|put)Score` as the tape half of the blend.

## Swap

Any class that exposes `score(bars) → { callScore, putScore, continuation, side }` can replace `NtsmScorer`. Point `VOL10S_NTSM_MODEL` at your weights, or fork the class.
