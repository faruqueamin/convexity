# Setup scanner

**Files:** `src/services/vol10s/SetupScanner.js`, `src/services/ml/SetupRanker.js`  
**Owner:** `DeskEngine` (poll `VOL10S_POLL_MS`, default 15s)

Turns Alpaca market data into a **ranked watchlist**. Rankers score; they do not trade.

## Universe

1. `GET /v2/assets?status=active&asset_class=us_equity&attributes=has_options`
2. Stock snapshot: last price in **$5–$500**, ranked by **day volume**
3. Cap: `universeCap` (default 40)

Refreshed about every 5 minutes (`VOL10S_UNIVERSE_MS`).

## Per name

1. Fetch ~30 Alpaca **1Min** bars.
2. Run **NTSM** → `side` (call or put).
3. Load nearest non-0DTE expiry (about 1–21 DTE), pick nearest-to-spot strike on that side, snapshot bid/ask/IV/delta/OI/volume.
4. Run **XGBoost** on that contract + `rvol` / `ret5`.
5. Blend (default weight 0.55 XGB):

```
blend = xgbWeight * xgb.score + (1 - xgbWeight) * tapeScore * ntsm.continuation
```

`tapeScore` is `ntsm.callScore` or `ntsm.putScore` matching `side`.

6. Keep rows with `blend ≥ minScore` (default **0.52**).
7. Sort descending. Top 12 become the watchlist.

Each watchlist row carries `symbol`, `side`, `occ`, `score`, `xgbScore`, `ntsmScore`, `px`.

## Into the engine

If the desk is **armed**, `DeskEngine` calls `onEntrySignal({ symbol, side, reason: 'xgboost_ntsm', refPx, strength: score })`.

`OptionsPlayEngine` then runs RiskGate. A high score is not a fill.

## Swap the ranker

`SetupRanker` only needs `{ blend, side, xgb, ntsm }`. Replace `XgbScorer` / `NtsmScorer`, or replace `SetupScanner.scoreSymbol` with your own features — keep RiskGate as the fill gate.
