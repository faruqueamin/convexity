'use strict';

/**
 * Env bundle for child `alpaca` CLI processes.
 * VOL10S_ALPACA_* keys always win over a leftover AWS/shell profile.
 * Paper only — ALPACA_LIVE_TRADE is never forwarded.
 */
function alpacaCliEnv() {
  const env = { ...process.env };
  delete env.ALPACA_LIVE_TRADE;
  const key = process.env.VOL10S_ALPACA_KEY || '';
  const secret = process.env.VOL10S_ALPACA_SECRET || '';
  if (key && secret) {
    env.ALPACA_API_KEY = key;
    env.ALPACA_SECRET_KEY = secret;
  }
  return env;
}

function accountLabel() {
  return String(process.env.VOL10S_ALPACA_ACCOUNT_EMAIL || '').trim() || null;
}

module.exports = { alpacaCliEnv, accountLabel };
