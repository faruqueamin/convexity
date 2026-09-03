# XGBoost ranker

**File:** `src/services/ml/XgbScorer.js`  
**Model:** `src/services/ml/xgbModel.json`  
**Swap:** `VOL10S_XGB_MODEL`

XGBoost here is a **gradient-boosted decision tree (GBDT)** that scores a **single option contract**. It does not detect setups and does not send orders.

## Features (public book + tape stats)

| Index | Name | Meaning |
|---|---|---|
| 0 | `spreadPct` | `(ask − bid) / mid × 100` |
| 1 | `iv` | implied vol (Alpaca greeks or local Black-Scholes) |
| 2 | `absDelta` | `\|delta\|` |
| 3 | `dte` | calendar days to expiry |
| 4 | `logOi` | `log(1 + open interest)` |
| 5 | `logVol` | `log(1 + option volume)` |
| 6 | `premium` | ask (fallback mid) |
| 7 | `rvol` | last 1m volume / recent average |
| 8 | `absRet5` | absolute 5-bar return on the underlying |

## Inference

1. Build the 9-vector from the contract row.
2. Sum `baseScore` + leaf values of each tree (threshold splits).
3. `sigmoid(raw)` → score in `(0, 1)`.

The bundled booster prefers **tight spreads**, **moderate delta**, **weekly (not 0DTE) DTE**, **listed IV**, and **some size**. Replace `xgbModel.json` with a booster you trained (same JSON shape: `featureNames`, `baseScore`, `trees[].nodes`).

## Output

```json
{ "model": "xgboost", "score": 0.61, "raw": 0.44, "features": { "spreadPct": 8.2, "iv": 0.41 } }
```

`SetupRanker` uses `score` as the contract half of the blend. RiskGate still evaluates the live quote before any order.
