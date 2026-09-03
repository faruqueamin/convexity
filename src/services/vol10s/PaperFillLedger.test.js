'use strict';

const assert = require('assert');
const PaperFillLedger = require('./PaperFillLedger');

const log = { info() {}, warn() {} };
const ledger = new PaperFillLedger({ log });

function fill({ id, side, symbol, occ, qty, px, kind, ts }) {
  const epoch = Date.parse(ts);
  ledger.noteSubmit({
    kind: kind || (occ ? 'option' : 'equity'),
    side,
    symbol,
    occ,
    qty,
    orderId: id,
    limitPx: px,
  });
  const ev = ledger.noteFill({ orderId: id, fillPx: px, filledQty: qty });
  assert.ok(ev);
  ev.ts = ts;
  ev.epoch = epoch;
}

fill({
  id: 'eq1', side: 'buy', symbol: 'WHLR', qty: 100, px: 5, kind: 'equity',
  ts: '2026-08-28T13:18:00.000Z',
});
fill({
  id: 'b1', side: 'buy', symbol: 'GAP', occ: 'GAP260828P00024500', qty: 10, px: 0.60,
  ts: '2026-08-28T13:40:00.000Z',
});
fill({
  id: 's1', side: 'sell', symbol: 'GAP', occ: 'GAP260828P00024500', qty: 10, px: 0.44,
  ts: '2026-08-28T13:43:00.000Z',
});
fill({
  id: 'pin', side: 'buy', symbol: 'RBRK', occ: 'RBRK260828P00102000', qty: 50, px: 2.75,
  ts: '2026-08-28T13:38:00.000Z',
});

const rows = ledger._positionSummaries();
assert.strictEqual(rows[0].occ, 'GAP260828P00024500', 'latest activity first');
assert.strictEqual(rows[0].status, 'closed');
assert.strictEqual(rows[0].realizedPnl, -160);
assert.strictEqual(rows[1].occ, 'RBRK260828P00102000');
// Past-expiry leftover lots are dropped (replaced/duplicate buys, not broker inventory).
assert.strictEqual(rows[1].status, 'closed');
assert.strictEqual(rows[1].openQty, 0);
assert.strictEqual(rows[1].expiredQty, 50);
assert.strictEqual(rows[1].realizedPnl, 0);
assert.strictEqual(rows[2].symbol, 'WHLR');
assert.strictEqual(rows[2].kind, 'equity');

const sum = ledger.getSummary();
assert.ok(Array.isArray(sum.positions));
assert.strictEqual(sum.stats.realizedPnl, -160);
assert.strictEqual(sum.stats.positionCount, 3);
assert.strictEqual(sum.stats.openCount, 1);

const orphan = new PaperFillLedger({ log });
const orphanFill = orphan.noteFill({
  orderId: 'orphan-buy',
  fillPx: 0.63,
  filledQty: 2,
  symbol: 'TSLL260904C00009500',
  side: 'buy',
  kind: 'option',
});
assert.ok(orphanFill);
assert.strictEqual(orphanFill.occ, 'TSLL260904C00009500');
assert.strictEqual(orphanFill.symbol, 'TSLL');
assert.strictEqual(orphanFill.kind, 'option');

const tsll = new PaperFillLedger({ log });
tsll.noteSubmit({ kind: 'option', side: 'buy', qty: 2, orderId: 'buy-unknown', limitPx: 0.63 });
const buyEv = tsll.noteFill({ orderId: 'buy-unknown', fillPx: 0.63, filledQty: 2 });
assert.ok(buyEv);
assert.ok(!buyEv.occ);
tsll.noteSubmit({
  kind: 'option', side: 'sell', symbol: 'TSLL', occ: 'TSLL260904C00009500',
  qty: 2, orderId: 'sell-tsll', limitPx: 0.58,
});
tsll.noteFill({
  orderId: 'sell-tsll', fillPx: 0.58, filledQty: 2,
  symbol: 'TSLL', occ: 'TSLL260904C00009500', side: 'sell', kind: 'option',
});
const before = tsll._positionSummaries();
assert.ok(before.some((r) => r.key === 'unknown'));
const ingest = tsll.ingestBrokerOrders([{
  id: 'buy-unknown',
  symbol: 'TSLL260904C00009500',
  asset_class: 'us_option',
  side: 'buy',
  filled_qty: 2,
  filled_avg_price: 0.63,
  status: 'filled',
}]);
assert.strictEqual(ingest.patched, 1);
const after = tsll._positionSummaries();
const tsllRow = after.find((r) => r.occ === 'TSLL260904C00009500');
assert.ok(tsllRow);
assert.strictEqual(tsllRow.realizedPnl, -10);
assert.ok(!after.some((r) => r.key === 'unknown'));

const unmatched = new PaperFillLedger({ log });
unmatched.noteFill({
  orderId: 'sell-only', fillPx: 5.49, filledQty: 12,
  symbol: 'SNAP', side: 'sell', kind: 'equity',
});
const um = unmatched._positionSummaries()[0];
assert.strictEqual(um.status, 'unmatched');
assert.strictEqual(um.realizedPnl, null);
assert.strictEqual(um.unmatched, true);
assert.strictEqual(unmatched.getSummary().stats.realizedPnl, 0);

// Equity fills mis-tagged kind:"option" without OCC must not get 100× multiplier.
const mis = new PaperFillLedger({ log });
mis.noteSubmit({ kind: 'option', side: 'buy', symbol: 'OLOX', qty: 618, orderId: 'olox-b', limitPx: 1.24 });
mis.noteFill({ orderId: 'olox-b', fillPx: 1.24, filledQty: 618, side: 'buy', symbol: 'OLOX', kind: 'option' });
mis.noteSubmit({ kind: 'option', side: 'sell', symbol: 'OLOX', qty: 618, orderId: 'olox-s', limitPx: 1.26 });
mis.noteFill({ orderId: 'olox-s', fillPx: 1.27, filledQty: 441, side: 'sell', symbol: 'OLOX', kind: 'option' });
const olox = mis._positionSummaries().find((r) => r.symbol === 'OLOX');
assert.strictEqual(olox.kind, 'equity');
assert.strictEqual(olox.realizedPnl, Math.round((1.27 - 1.24) * 441 * 100) / 100);

const chrono = new PaperFillLedger({ log });
chrono.noteFill({
  orderId: 'sell-first', fillPx: 5, filledQty: 100, symbol: 'WBUY', side: 'sell', kind: 'equity',
  ts: '2026-08-31T15:18:00.000Z',
});
chrono.noteFill({
  orderId: 'buy-earlier', fillPx: 5.01, filledQty: 100, symbol: 'WBUY', side: 'buy', kind: 'equity',
  ts: '2026-08-31T15:17:00.000Z',
});
const chronoRow = chrono._positionSummaries()[0];
assert.strictEqual(chronoRow.status, 'closed');
assert.strictEqual(chronoRow.unmatched, false);
assert.strictEqual(chronoRow.realizedPnl, -1);

console.log('PaperFillLedger.test ok');
