# Desk and frontend

## HTTP + WebSocket

**File:** `src/services/vol10s/Vol10sPaperServer.js`  
**Default:** `VOL10S_BIND` + `VOL10S_PAPER_PORT` (8977)

One process serves:

| Path | Content |
|---|---|
| `/landing/*` | Built story site (Vite bundle) |
| `/` | Landing on `convexity.*` hosts; desk on localhost |
| `/desk` | Built command desk (`public/desk.min.html`) |

This repo ships **built** UI only (`desk.min.html`, `public/landing/`). Unminified desk source is gitignored.

## Command desk (`/desk`)

Observer (no login): positions, P&L, journal, RiskGate lights, brain, screener, chains.

Admin (password cookie or loopback): arm, flatten, config, agent chat, kill.

WebSocket observers cannot send trade actions (`WS_OBSERVER_ACTIONS`).

## Landing and paper consent

Built React bundle. First visit: full-screen **paper trading disclosure**. Button **I understand — this is paper** stores `localStorage` key `convexity.paper-consent.v1`. Footer **Revisit consent** re-opens the modal.

Copy states: simulated $100k, Alpaca paper, hypothetical results, not investment advice, options risk. Link to [Alpaca disclosures](https://alpaca.markets/disclosures).

## Kill switch

`POST /api/kill` is **loopback only**. Desk KILL (double confirm) disarms and flattens.

## Brand

`brand/` — lockup, mark, social. Landing OG image and thesis PDF are under `public/landing/`.
