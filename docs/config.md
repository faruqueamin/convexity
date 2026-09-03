# Configuration

## Files

| Path | Commit? | Role |
|---|---|---|
| `docs/env.example` | yes | Template |
| `envs/.env.example` | yes | Copy of template |
| `envs/vol10s-paper.env` | **no** | Real keys |
| `ecosystem.config.js` | yes | pm2 |
| `data/vol10s-paper/*.json` | **no** | Runtime state |

```bash
cp docs/env.example envs/vol10s-paper.env
# fill paper key/secret + any LLM
npm install
pm2 start ecosystem.config.js
```

`VOL10S_ENV_FILE` overrides the env path. `pm2` sets `VOL10S_ARMED=false`.

## Required to trade (paper)

```
VOL10S_ALPACA_BASE_URL=https://paper-api.alpaca.markets
VOL10S_ALPACA_KEY=          # paper PK… key
VOL10S_ALPACA_SECRET=
```

Then **arm in the UI**. Env armed defaults false.

## LLM (any model)

See [llm.md](./llm.md). Hosted desk: Ollama Cloud custom. Locals: Ollama or OpenAI-compatible.

## Rankers

```
VOL10S_XGB_MODEL=./src/services/ml/xgbModel.json
VOL10S_NTSM_MODEL=./src/services/ml/ntsmModel.json
```

## Optional

| Variable | Default | Role |
|---|---|---|
| `VOL10S_PAPER_PORT` | 8977 | HTTP |
| `VOL10S_BIND` | `127.0.0.1` in example | Bind |
| `VOL10S_POLL_MS` | 15000 | Rank loop |
| `VOL10S_SYNC_MS` | 15000 | Account REST |
| `VOL10S_UNIVERSE_MS` | 300000 | Universe refresh |
| `VOL10S_ALPACA_CLI` | true | CLI reconcile |
| `VOL10S_ADMIN_PASSWORD` | empty | Desk login (empty = loopback operator) |
| `VOL10S_DATA_ALPACA_KEY` | trading key | Extra market-data key |

## Runtime knobs

Persisted in `data/vol10s-paper/config.json` via the desk (admin):

- Options: `enabled`, `armed`, `entriesPaused`, contracts, premium caps, daily loss, DTE/delta, exit stack, flatten ET
- Agent: `enabled`, `trade_enabled`, `model`, `supervisor_*`
- Brain: `POST /api/brain/config`

Never commit env files or `data/`.
