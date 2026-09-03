'use strict';

const assert = require('assert');
const Vol10sConfig = require('./Vol10sConfig');
const OptionsPlayEngine = require('./OptionsPlayEngine');

function mockEngine(cfgPatch = {}) {
  const opt = Object.create(OptionsPlayEngine.prototype);
  opt.cfg = Vol10sConfig.sanitizeOptions(cfgPatch);
  opt.dailyPnl = 0;
  opt.logger = { warn() {}, info() {}, error() {} };
  opt.sold = [];
  opt._journal = () => {};
  opt._lossCutAllowed = () => true;
  opt._noteOpt10sBid = () => null;
  opt._evalOptProfitLock10s = () => null;
  opt._askPnlPct = OptionsPlayEngine.prototype._askPnlPct;
  opt._bidPnlPct = OptionsPlayEngine.prototype._bidPnlPct;
  opt._startSell = async (p, reason) => { opt.sold.push(reason); };
  return opt;
}

function pos(extra = {}) {
  return {
    occ: 'AAPL260902C00200000',
    underlying: 'AAPL',
    qty: 10,
    fillPrice: 1.00,
    lastBid: 1.20,
    lastAsk: 1.25,
    lastMid: 1.22,
    lastIv: 0.80,
    entryIv: 0.80,
    peakBid: 1.80,
    lockArmed: false,
    entryTs: Date.now() - 60_000,
    sellOrderId: null,
    _selling: false,
    ...extra,
  };
}

const rth = { mins: 10 * 60, h: 10, m: 0, s: 0, date: '2026-09-01' };

async function main() {
  const d = Vol10sConfig.sanitizeOptions({});
  const desk = Vol10sConfig.toRiskDesk(d, { flipExitOnReverse: true });
  assert.strictEqual(desk.exits.fastExitsEnabled, true);
  assert.strictEqual(desk.exits.lockArmUsd, 200);
  assert.strictEqual(desk.exits.lockArmPct, 15);
  assert.strictEqual(desk.exits.givebackPct, 30);
  assert.strictEqual(desk.exits.exitProfitLock10s, false);
  assert.strictEqual(desk.exits.askProfitExitEnabled, false);
  assert.strictEqual(desk.exits.bidStopEnabled, false);
  assert.strictEqual(desk.exits.catastropheEnabled, false);
  assert.strictEqual(desk.exits.ivCrushEnabled, false);
  assert.strictEqual(desk.exits.volDeathExitEnabled, false);
  assert.strictEqual(desk.exits.sessionFlattenEnabled, false);
  assert.strictEqual(desk.exits.instantProfitEnabled, false);
  assert.strictEqual(desk.exits.flipExitOnReverse, true);
  const { optionsPatch, equityPatch } = Vol10sConfig.fromRiskDesk({
    exits: {
      flipExitOnReverse: true,
      fastExitsEnabled: true,
      lockArmUsd: 200,
      lockArmPct: 15,
      givebackPct: 30,
      exitProfitLock10s: false,
      askProfitExitEnabled: false,
      instantProfitEnabled: false,
      instantProfitPct: 20,
      bidStopEnabled: false,
      catastropheEnabled: false,
      ivCrushEnabled: false,
      volDeathExitEnabled: false,
      sessionFlattenEnabled: false,
    },
  });
  assert.strictEqual(equityPatch.flipExitOnReverse, true);
  assert.strictEqual(optionsPatch.fastExitsEnabled, true);
  assert.strictEqual(optionsPatch.lockArmUsd, 200);
  assert.strictEqual(optionsPatch.lockArmPct, 0.15);
  assert.strictEqual(optionsPatch.givebackPct, 0.30);
  assert.strictEqual(optionsPatch.instantProfitEnabled, false);
  assert.strictEqual(optionsPatch.exitProfitLock10s, false);
  assert.strictEqual(optionsPatch.askProfitExitEnabled, false);

  {
    const opt = mockEngine();
    const p = pos({ lastBid: 1.20, peakBid: 1.80, lockArmed: true });
    await opt._checkExits(p, rth, { force: true });
    assert.deepStrictEqual(opt.sold, ['giveback_trail'], 'default policy sells only giveback');
  }

  {
    const opt = mockEngine();
    const p = pos({ lastBid: 0.50, lastMid: 0.50, peakBid: 0.50, lockArmed: false });
    await opt._checkExits(p, rth, { force: true, structure: true });
    assert.deepStrictEqual(opt.sold, [], 'catastrophe / vol_death / bid_stop stay off');
  }

  {
    const opt = mockEngine({
      fastExitsEnabled: true,
      exitProfitLock10s: true,
      askProfitExitEnabled: true,
    });
    opt._evalOptProfitLock10s = () => ({ bid: 1.3, minPct: 20 });
    const p = pos({ lastBid: 1.30, lastAsk: 1.40, peakBid: 1.30 });
    await opt._checkExits(p, rth, { force: true });
    assert.deepStrictEqual(opt.sold, ['profit_lock_10s'], 'profit lock still fires when flagged on');
  }

  {
    const opt = mockEngine();
    const sold = [];
    opt.positions = new Map([['p', pos()]]);
    opt._startSell = async (_p, reason) => { sold.push(reason); };
    const journal = [];
    opt._journal = (type, extra) => journal.push({ type, ...extra });
    opt.handleExitSignal({ symbol: 'AAPL', reason: 'vol_death' });
    opt.handleExitSignal({ symbol: 'AAPL', reason: 'flip_reverse' });
    assert.ok(journal.some((j) => j.type === 'opt_exit_ignore' && j.reason === 'vol_death'));
    assert.deepStrictEqual(sold, ['flip_reverse']);
  }

  console.log('options-exits ok · giveback only + flip_reverse stop · desk keys round-trip');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
