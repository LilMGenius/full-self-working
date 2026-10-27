// The quote value gate (src/economics/quote-gate.mjs): the win chance a paid quote is judged at, its margin
// and expected value, the verdict, and the pace that spreads a day's quote cash over the Seoul day. Every
// figure is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIT_RANK, armCounts, fitMeets, judgeQuote, paceSpent } from '../src/economics/quote-gate.mjs';

// A platform that keeps 10% of the amount and takes at most 10 quotes a request.
const PLATFORM = { id: 'testboard', fees: { seller: 0.1, paymentNetworkRate: 0, vatOnFees: 0 }, bidCost: { unit: 'cash', maxPerRequest: 10 } };
const ROW = { platform: 'testboard', service: 'svc_a', baseKRW: 200000, costFloorKRW: 50000 };
const SETTINGS = { minFit: 'some', minCases: 4 };
const NO_ARM = { won: 0, lost: 0, expired: 0 };
const judge = (over = {}) => judgeQuote({ fit: 'strong', quoteCount: 3, quoteCostKRW: 5000, amountKRW: 200000, row: ROW, descriptor: PLATFORM, arm: NO_ARM, settings: SETTINGS, ...over });

test('the win chance starts at the equal share among the quotes on the request', () => {
  assert.equal(judge().p0, 0.25);
  assert.equal(judge().p, 0.25);
  // An unread quote count falls back to the most quotes the platform takes.
  assert.equal(judge({ quoteCount: null }).p0, 0.1);
});

test('resolved outcomes at the current price basis blend with the share, weighted by minCases', () => {
  // (won + w x p0) / (resolved + w) = (3 + 2 x 0.25) / (4 + 2)
  const r = judge({ arm: { won: 3, lost: 1, expired: 0 }, settings: { ...SETTINGS, minCases: 2 } });
  assert.equal(r.p, 3.5 / 6);
  // An instance that learns nothing (no minCases) judges at the share alone.
  assert.equal(judge({ arm: { won: 3, lost: 1, expired: 0 }, settings: { minFit: 'some' } }).p, 0.25);
});

test('the arm counts only resolved quotes of its platform and service that carry a price index', () => {
  const row = (over) => ({ source: 'quote', platform: 'testboard', service: 'svc_a', result: 'won', index: 1, ...over });
  const results = [
    row({}), row({ result: 'lost' }), row({ result: 'expired' }), row({ result: 'expired' }),
    row({ index: null }), row({ result: 'lost', index: null }),
    row({ result: 'open' }), row({ result: 'superseded' }), row({ source: 'outbox', result: 'refused', index: null }),
    row({ service: 'svc_b' }), row({ platform: 'otherboard' }),
  ];
  assert.deepEqual(armCounts(results, 'testboard', 'svc_a'), { won: 1, lost: 1, expired: 2 });
});

test('the margin is the seller net less the row cost floor, and the value subtracts the quote cost once', () => {
  // net 180,000 after the 10% fee, less the 50,000 floor; 0.25 x 130,000 - 5,000.
  const r = judge();
  assert.equal(r.marginKRW, 130000);
  assert.equal(r.evKRW, 27500);
  assert.deepEqual([r.verdict, r.reason], ['send', 'gate: value.positive']);
});

test('a fit below the floor, an unknown fit, a full request and a value at or under zero drop the quote', () => {
  assert.deepEqual([judge({ fit: 'none' }).verdict, judge({ fit: 'none' }).reason], ['drop', 'gate: fit.low']);
  assert.deepEqual([judge({ fit: null }).verdict, judge({ fit: null }).reason], ['drop', 'gate: fit.unknown']);
  assert.equal(judge({ fit: 'some', settings: { ...SETTINGS, minFit: 'strong' } }).reason, 'gate: fit.low');
  assert.equal(judge({ fit: 'none', settings: { ...SETTINGS, minFit: 'none' } }).verdict, 'send');
  const full = judge({ quoteCount: 10 });
  assert.equal(full.verdict, 'drop');
  assert.match(full.reason, /^expired: /);
  // A quote priced at the floor plus its cost: net 54,000, margin 4,000, 0.1 x 4,000 - 5,000.
  const floor = judge({ amountKRW: 60000, quoteCount: 9 });
  assert.deepEqual([floor.verdict, floor.reason, floor.marginKRW, floor.evKRW], ['drop', 'gate: value.negative', 4000, -4600]);
});

test('a quote whose value cannot be computed drops as value.unknown and never carries NaN', () => {
  for (const over of [{ row: null }, { row: { ...ROW, costFloorKRW: undefined } }, { amountKRW: null }, { quoteCostKRW: null }, { pricing: { source: 'model', reason: 'no price row' } }]) {
    const r = judge(over);
    assert.deepEqual([r.verdict, r.reason], ['drop', 'gate: value.unknown'], JSON.stringify(over));
    assert.ok(!Number.isNaN(r.evKRW) && !Number.isNaN(r.marginKRW), JSON.stringify(r));
  }
});

test('a win chance, margin or value that is not a finite number drops as value.unknown', () => {
  // An arm count read as NaN makes p and the value NaN, and NaN <= 0 is false, so it must not read as a send.
  const cases = [
    { arm: { won: Number.NaN, lost: 0, expired: 0 } },
    { arm: { won: 0, lost: Number.NaN, expired: 0 }, settings: { ...SETTINGS, minCases: 2 } },
    { amountKRW: Number.MAX_VALUE, row: { ...ROW, costFloorKRW: -Number.MAX_VALUE } },
  ];
  for (const over of cases) {
    const r = judge(over);
    assert.deepEqual([r.verdict, r.reason], ['drop', 'gate: value.unknown'], JSON.stringify(over));
    for (const k of ['p', 'marginKRW', 'evKRW']) assert.ok(r[k] === null || Number.isFinite(r[k]), k + ' ' + r[k]);
  }
});

test('fit ranks and the floor check carried from src/projects', () => {
  assert.deepEqual(FIT_RANK, { none: 0, some: 1, strong: 2 });
  assert.deepEqual([fitMeets('strong', 'some'), fitMeets('some', 'some'), fitMeets('none', 'some'), fitMeets(undefined, 'none')], [true, true, false, false]);
});

test('the pace allows the elapsed share of the Seoul day of maxCashPerDay, one quote of overshoot included', () => {
  const cfg = { maxQuotesPerDay: 5, maxCashPerDay: 24000 };
  const at = (hm) => new Date('2026-03-02T' + hm + ':00+09:00');
  assert.equal(paceSpent(cfg, { quotes: 0, cashKRW: 0 }, at('00:10')), false);
  assert.equal(paceSpent(cfg, { quotes: 1, cashKRW: 2000 }, at('00:10')), true);
  assert.equal(paceSpent(cfg, { quotes: 3, cashKRW: 12000 }, at('12:00')), false);
  assert.equal(paceSpent(cfg, { quotes: 3, cashKRW: 12001 }, at('12:00')), true);
  assert.equal(paceSpent({ ...cfg, quoteGate: { pace: 'off' } }, { quotes: 1, cashKRW: 2000 }, at('00:10')), false);
  // A missing cap paces nothing, as budgetSpent leaves it to the send-time check.
  assert.equal(paceSpent({ maxQuotesPerDay: 5, maxCashPerDay: null }, { quotes: 1, cashKRW: 2000 }, at('00:10')), false);
  assert.equal(paceSpent({ maxCashPerDay: 24000 }, { quotes: 1, cashKRW: 2000 }, at('00:10')), false);
});
