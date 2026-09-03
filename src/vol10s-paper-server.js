#!/usr/bin/env node
'use strict';

/**
 * Convexity paper desk — Alpaca Trading API + market data + CLI.
 * Paper only. Pluggable LLM. XGBoost + NTSM ranker. No ClickHouse.
 *
 *   VOL10S_ENV_FILE=envs/vol10s-paper.env node src/vol10s-paper-server.js
 */

const fs = require('fs');
const path = require('path');
const PaperAlpacaClient = require('./services/vol10s/PaperAlpacaClient');
const { DeskEngine } = require('./services/vol10s/DeskEngine');
const Vol10sPaperServer = require('./services/vol10s/Vol10sPaperServer');
const OptionsClient = require('./services/vol10s/OptionsClient');
const OptionScreener = require('./services/vol10s/OptionScreener');
const OptionsPlayEngine = require('./services/vol10s/OptionsPlayEngine');
const Vol10sConfig = require('./services/vol10s/Vol10sConfig');
const LlmClient = require('./services/llm/LlmClient');
const AgentTools = require('./services/agent/AgentTools');
const AgentService = require('./services/agent/AgentService');
const AgentSupervisor = require('./services/agent/AgentSupervisor');
const AgentBrain = require('./services/agent/AgentBrain');
const { accountLabel } = require('./services/vol10s/alpacaCliEnv');
const PaperFillLedger = require('./services/vol10s/PaperFillLedger');
const DeskEventLog = require('./services/vol10s/DeskEventLog');
const LiveMarketHub = require('./services/vol10s/LiveMarketHub');
const AlpacaOrderWs = require('./services/vol10s/AlpacaOrderWs');
const PendingOrderBook = require('./services/vol10s/PendingOrderBook');

const ENV_FILE = process.env.VOL10S_ENV_FILE
  || path.resolve(__dirname, '../envs/vol10s-paper.env');

const _pi = process.argv.indexOf('--port');
if (_pi > -1 && process.argv[_pi + 1]) process.env.VOL10S_PAPER_PORT = String(parseInt(process.argv[_pi + 1], 10) || 8977);
const _hi = process.argv.indexOf('--host');
if (_hi > -1 && process.argv[_hi + 1]) process.env.VOL10S_BIND = process.argv[_hi + 1];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[convexity] env file missing: ${filePath}`);
    return 0;
  }
  let n = 0;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
    n += 1;
  }
  return n;
}

const loaded = loadEnvFile(ENV_FILE);
const logger = {
  info: (...a) => console.log(`[${new Date().toISOString()}] [convexity]`, ...a),
  warn: (...a) => console.warn(`[${new Date().toISOString()}] [convexity] ⚠️`, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] [convexity] ❌`, ...a),
};

logger.info(`env ${ENV_FILE} (${loaded} keys) — Alpaca paper + market data`);
logger.info(`paper target ${accountLabel() || 'unset'} @ ${process.env.VOL10S_ALPACA_BASE_URL || 'no-url'}`);

const alpaca = new PaperAlpacaClient();
const fillLedger = new PaperFillLedger({
  dataDir: path.resolve(__dirname, '../data/vol10s-paper'),
  log: logger,
});
const eventLog = new DeskEventLog({
  dataDir: path.resolve(__dirname, '../data/vol10s-paper'),
  log: logger,
});
const pendingBook = new PendingOrderBook({ alpaca, logger });
const engine = new DeskEngine({
  alpaca,
  logger,
  fillLedger,
  eventLog,
  pendingBook,
  statePath: path.resolve(__dirname, '../data/vol10s-paper/state.json'),
  configPath: path.resolve(__dirname, '../data/vol10s-paper/config.json'),
});
const optionsClient = new OptionsClient({
  apiBase: process.env.VOL10S_ALPACA_BASE_URL,
  dataUrl: process.env.VOL10S_ALPACA_DATA_URL || 'https://data.alpaca.markets',
  key: process.env.VOL10S_ALPACA_KEY,
  secret: process.env.VOL10S_ALPACA_SECRET,
  dataKey: process.env.ALPACA_OPTIONS_DATA_API_KEY_2
    || process.env.VOL10S_DATA_ALPACA_KEY
    || process.env.VOL10S_ALPACA_KEY,
  dataSecret: process.env.ALPACA_OPTIONS_DATA_SECRET_KEY_2
    || process.env.VOL10S_DATA_ALPACA_SECRET
    || process.env.VOL10S_ALPACA_SECRET,
  log: logger,
});
engine.optionsClient = optionsClient;
engine.scanner.optionsClient = optionsClient;

const optionScreener = new OptionScreener({
  optionsClient,
  log: logger,
  dataDir: path.resolve(__dirname, '../data/vol10s-paper'),
  config: {
    universeCap: parseInt(process.env.VOL10S_OPT_UNIVERSE_CAP, 10) || 80,
    scanConcurrency: parseInt(process.env.VOL10S_OPT_SCAN_CONCURRENCY, 10) || 4,
    maxDte: parseInt(process.env.VOL10S_OPT_MAX_DTE, 10) || 28,
  },
});
const optionsEngine = new OptionsPlayEngine({
  optionsClient,
  paperClient: alpaca,
  log: logger,
  fillLedger,
  eventLog,
  pendingBook,
  getAccount: () => engine.paperAccount,
  config: engine.getConfig().options,
  dataDir: path.resolve(__dirname, '../data/vol10s-paper'),
  configPath: path.resolve(__dirname, '../data/vol10s-paper/config.json'),
});
pendingBook.setHoldChecks({
  equity: (sym) => {
    const st = engine.book.get(sym);
    if (!st) return false;
    if (st.status === 'pending_sell' || st.status === 'pending_buy' || st.status === 'long') return true;
    return false;
  },
  options: (sym) => [...optionsEngine.working.values()].some((w) => w.underlying === sym),
});
const orderWs = new AlpacaOrderWs({
  baseUrl: process.env.VOL10S_ALPACA_BASE_URL,
  key: process.env.VOL10S_ALPACA_KEY,
  secret: process.env.VOL10S_ALPACA_SECRET,
  log: logger,
  onEvent: (ev) => {
    try { optionsEngine.onBrokerOrder(ev); } catch (err) {
      logger.warn?.(`[order-ws] options: ${err.message}`);
    }
  },
});

const agentCfg = Vol10sConfig.sanitizeAgent(engine.getConfig().agent);
if (process.env.VOL10S_LLM_MODEL) agentCfg.model = process.env.VOL10S_LLM_MODEL;
else if (process.env.VOL10S_OLLAMA_MODEL) agentCfg.model = process.env.VOL10S_OLLAMA_MODEL;
if (process.env.VOL10S_AGENT_ENABLED != null && process.env.VOL10S_AGENT_ENABLED !== '') {
  agentCfg.enabled = String(process.env.VOL10S_AGENT_ENABLED).toLowerCase() === 'true' || process.env.VOL10S_AGENT_ENABLED === '1';
}
if (process.env.VOL10S_AGENT_TRADE_ENABLED != null && process.env.VOL10S_AGENT_TRADE_ENABLED !== '') {
  agentCfg.trade_enabled = String(process.env.VOL10S_AGENT_TRADE_ENABLED).toLowerCase() === 'true' || process.env.VOL10S_AGENT_TRADE_ENABLED === '1';
}
const envBool = (v) => String(v).toLowerCase() === 'true' || v === '1';
if (process.env.VOL10S_AGENT_SUPERVISOR_ENABLED != null && process.env.VOL10S_AGENT_SUPERVISOR_ENABLED !== '') {
  agentCfg.supervisor_enabled = envBool(process.env.VOL10S_AGENT_SUPERVISOR_ENABLED);
}
if (process.env.VOL10S_AGENT_SUPERVISOR_AUTO != null && process.env.VOL10S_AGENT_SUPERVISOR_AUTO !== '') {
  agentCfg.supervisor_auto = envBool(process.env.VOL10S_AGENT_SUPERVISOR_AUTO);
}

const llm = new LlmClient({
  log: logger,
  model: agentCfg.model,
});
let agentService;
const agentTools = new AgentTools({
  optionsClient,
  equityEngine: engine,
  optionScreener,
  optionsEngine,
  getConfig: () => (agentService ? agentService.cfg : agentCfg),
  log: logger,
});
const agentSupervisor = new AgentSupervisor({
  ollama: llm,
  tools: agentTools,
  equityEngine: engine,
  optionScreener,
  optionsEngine,
  paperClient: alpaca,
  getConfig: () => (agentService ? agentService.cfg : agentCfg),
  log: logger,
});
agentService = new AgentService({
  ollama: llm,
  tools: agentTools,
  log: logger,
  config: agentCfg,
  persistConfig: async (cfg) => engine.setConfig({ agent: cfg }),
  supervisor: agentSupervisor,
});

const agentBrain = new AgentBrain({
  optionsEngine,
  optionsClient,
  equityEngine: engine,
  fillLedger,
  eventLog,
  ollama: llm,
  log: logger,
  dataDir: path.resolve(__dirname, '../data/vol10s-paper'),
});

const dataKey = process.env.ALPACA_OPTIONS_DATA_API_KEY_2
  || process.env.VOL10S_DATA_ALPACA_KEY
  || process.env.VOL10S_ALPACA_KEY;
const dataSecret = process.env.ALPACA_OPTIONS_DATA_SECRET_KEY_2
  || process.env.VOL10S_DATA_ALPACA_SECRET
  || process.env.VOL10S_ALPACA_SECRET;
const liveHub = new LiveMarketHub({
  equityEngine: engine,
  optionsEngine,
  optionsClient,
  fillLedger,
  key: dataKey,
  secret: dataSecret,
  optKey: dataKey,
  optSecret: dataSecret,
  boatsKey: process.env.ALPACA_BOATS_API_KEY || dataKey,
  boatsSecret: process.env.ALPACA_BOATS_SECRET_KEY || dataSecret,
  boatsEnabled: process.env.ALPACA_BOATS_ENABLED !== 'false',
  log: logger,
});
engine.liveHub = liveHub;

const server = new Vol10sPaperServer({
  engine,
  logger,
  optionScreener,
  optionsClient,
  optionsEngine,
  agentService,
  fillLedger,
  brain: agentBrain,
  eventLog,
  liveHub,
  port: process.env.VOL10S_PAPER_PORT || 8977,
  bind: process.env.VOL10S_BIND || '0.0.0.0',
});
liveHub.onTick = (payload) => server.broadcastTick(payload);
engine.onBroadcast = (snap) => {
  const opt = optionsEngine.getState();
  snap.optionPnl = opt.dailyPnl;
  snap.unrealizedPnl = opt.unrealizedPnl;
  snap.optionOpenPnl = opt.unrealizedPnl;
  snap.optionsArmed = opt.armed;
  snap.optionsEnabled = opt.enabled;
  snap.dataFeed = liveHub.optStream?.feed || optionsClient.feed;
  snap.fills = fillLedger.getSummary();
  snap.openPremium = opt.openPremium;
  if (liveHub) snap.streams = liveHub.tickPayload().streams;
  server.broadcast(snap);
};
optionScreener.onBroadcast = (state) => server.broadcastOptions(state);
engine.onEntrySignal = (sig) => optionsEngine.handleEntrySignal({ ...sig, side: sig.side === 'put' ? 'put' : 'call' });
engine.onExitSignal = (sig) => optionsEngine.handleExitSignal(sig);
optionsEngine.onUnderlyingFill = (sig) => engine.markVectorFilled(sig);
optionsEngine.onUnderlyingCancel = (sig) => engine.markVectorCancel(sig);
optionsEngine.onVectorFlat = (sig) => engine.markVectorFlat(sig);
optionsEngine.onBroadcast = (s) => server.broadcastOptionsEngine(s);

async function main() {
  if (alpaca.enabled) {
    try {
      const acct = await alpaca.getAccount();
      logger.info(`paper account ${accountLabel() || ''} acct=${acct?.account_number || acct?.id} status=${acct?.status} equity=${acct?.equity}`);
    } catch (err) {
      logger.error(`paper Alpaca auth failed: ${err.message}`);
    }
  } else {
    logger.warn('paper keys missing — scan-only');
  }
  if (optionsClient.enabled) {
    try {
      const feed = await optionsClient.probeFeed();
      logger.info(`options data feed=${feed}`);
    } catch (err) {
      logger.warn(`options feed probe failed: ${err.message}`);
    }
  }
  await server.start();
  try {
    const ping = await llm.ping();
    agentService.ollamaUp = ping.ok;
    agentBrain.ollamaUp = ping.ok;
    if (ping.ok) logger.info(`llm up provider=${llm.provider} model=${llm.model}`);
    else logger.warn(`llm DOWN (${llm.provider} ${llm.baseUrl}): ${ping.error}`);
  } catch (err) {
    logger.warn(`llm ping failed (boot continues): ${err.message}`);
  }
  try { optionScreener.start(); } catch (err) {
    logger.error(`screener start failed: ${err.message}`);
  }
  try { liveHub.start(); } catch (err) {
    logger.error(`live streams start failed: ${err.message}`);
  }
  if (alpaca.enabled) {
    try { orderWs.start(); } catch (err) {
      logger.warn(`order stream start failed: ${err.message}`);
    }
  }
  await engine.start();
  try {
    await optionsEngine.start();
    logger.info(`options engine started (enabled=${optionsEngine.enabled} armed=${optionsEngine.armed})`);
  } catch (err) {
    logger.error(`options engine start failed: ${err.message}`);
  }
  try { agentSupervisor.start(); } catch (err) {
    logger.error(`supervisor start failed: ${err.message}`);
  }
  try {
    agentBrain.start();
    logger.info('agent brain started');
  } catch (err) {
    logger.error(`brain start failed: ${err.message}`);
  }
}

main().catch((err) => {
  logger.error(`fatal ${err.message}`);
  process.exit(1);
});

function shutdown() {
  logger.info('shutting down');
  orderWs.stop();
  liveHub.stop();
  engine.stop();
  optionScreener.stop();
  optionsEngine.stop();
  agentSupervisor.stop();
  agentBrain.stop();
  server.stop();
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
