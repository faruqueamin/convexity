'use strict';

/**
 * Pre-entry bid-movement confirmation.
 * Blocks entries when only the ask/mid flickers but the bid is stuck (illiquid book).
 */

function evaluateBidMove({
  samples = [],
  side = 'call',
  spotStart,
  spotEnd,
  minMove = 0.01,
  minDistinctBids = 2,
  requireLive = true,
} = {}) {
  const checks = [];
  const withQuote = samples.filter((s) => s.bid > 0 || s.ask > 0);
  if (!withQuote.length) {
    return {
      ok: false,
      reason: 'bid_confirm_no_samples',
      detail: 'no option quotes during confirm window',
      checks,
    };
  }

  const withBid = withQuote.filter((s) => s.bid > 0);
  if (!withBid.length) {
    return {
      ok: false,
      reason: 'bid_confirm_no_bid',
      detail: 'quotes arrived but no bid side',
      checks,
    };
  }

  if (requireLive && !withQuote.some((s) => s.live === true)) {
    return {
      ok: false,
      reason: 'bid_confirm_not_live',
      detail: 'no live OPRA ticks during confirm window',
      checks,
    };
  }

  const first = withBid[0];
  const last = withBid[withBid.length - 1];
  const distinctBids = [...new Set(withBid.map((s) => Math.round(s.bid * 100) / 100))];
  const bidDelta = Math.round((last.bid - first.bid) * 100) / 100;
  const askDelta = first.ask > 0 && last.ask > 0
    ? Math.round((last.ask - first.ask) * 100) / 100
    : 0;
  const bidMoved = distinctBids.length >= minDistinctBids || Math.abs(bidDelta) >= minMove;
  const askMoved = first.ask > 0 && last.ask > 0 && Math.abs(askDelta) >= minMove;

  checks.push({
    id: 'bid_move',
    samples: withQuote.length,
    distinctBids: distinctBids.length,
    bidDelta,
    askDelta,
    firstBid: first.bid,
    lastBid: last.bid,
    firstAsk: first.ask,
    lastAsk: last.ask,
  });

  if (askMoved && !bidMoved) {
    return {
      ok: false,
      reason: 'bid_frozen_ask_only',
      detail: `ask ${first.ask}→${last.ask} but bid stuck ${first.bid}`,
      checks,
      bidDelta,
      askDelta,
    };
  }

  if (!bidMoved) {
    return {
      ok: false,
      reason: 'bid_frozen',
      detail: `bid flat at ${first.bid} (${withBid.length} samples)`,
      checks,
      bidDelta,
      askDelta,
    };
  }

  const ss = Number(spotStart);
  const se = Number(spotEnd);
  if (ss > 0 && se > 0) {
    const stockUp = se >= ss * 1.001;
    const stockDn = se <= ss * 0.999;
    if (side === 'call' && stockUp && bidDelta < -minMove) {
      return {
        ok: false,
        reason: 'bid_vs_stock',
        detail: `stock ${ss}→${se} up but bid fell ${first.bid}→${last.bid}`,
        checks,
        bidDelta,
        askDelta,
      };
    }
    if (side === 'put' && stockDn && bidDelta < -minMove) {
      return {
        ok: false,
        reason: 'bid_vs_stock',
        detail: `stock ${ss}→${se} down but bid fell ${first.bid}→${last.bid}`,
        checks,
        bidDelta,
        askDelta,
      };
    }
    checks.push({ id: 'bid_vs_stock', spotStart: ss, spotEnd: se, ok: true });
  }

  return {
    ok: true,
    reason: 'ok',
    detail: `bid ${first.bid}→${last.bid} (${distinctBids.length} levels)`,
    checks,
    bidDelta,
    askDelta,
    lastQuote: last,
  };
}

module.exports = { evaluateBidMove };
