// Price learning from quote outcomes (070 U7.P): what became of every quote fsw sent, replayed from the
// ledger, and the bounded price move each row learns from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../src/core/ledger.mjs';
import { plan, setStatus } from '../src/outbox/index.mjs';
import { QUOTE_RESULTS, dayStart, priceIndex, quoteFunnel, quoteResults } from '../src/economics/quote-results.mjs';
import { learnPriceRows, learnedFactor } from '../src/economics/price-learning.mjs';
import { quoteForRequest } from '../src/economics/pricing.mjs';
import { quoteFromRow } from '../src/economics/quote.mjs';
import { sellerNet } from '../src/economics/fees.mjs';
import { priceLearningSettings } from '../src/core/settings.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';

const DAY = 86_400_000;
const T0 = '2026-10-01T03:00:00.000Z';
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

// A quote fsw sent: its observed outbox row (read back at rowAt) and the quote row the deal recorded at quoteAt.
function sent(ledger, { ref, amountKRW = 300000, service = 'detail_page_design', status = 'sent', quoteAt = T0, rowAt = T0, pricing = { source: 'guide', guideAvg: 300000, complexity: 1 }, pipeline = null, costKRW = 990 }) {
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: ref, kind: 'request' });
  const row = plan(ledger, { platform: 'soomgo', threadId: thread.id, kind: 'quote', payload: { text: 'q ' + ref, amountKRW, service, costKRW, ...(pricing ? { decision: { quote: { amountKRW, pricing } } } : {}) } });
  setStatus(ledger, row.id, { from: 'planned', to: 'sending' });
  setStatus(ledger, row.id, { from: 'sending', to: 'observed', receipt: { observed: true, ...(pipeline ? { pipeline } : {}) } });
  ledger.db.prepare('UPDATE outbox SET updated_at = ? WHERE id = ?').run(rowAt, row.id);
  const q = ledger.addQuote({ threadId: thread.id, platform: 'soomgo', service, amountKRW, costKRW, status, at: quoteAt });
  return { thread, row, quote: q };
}
const byId = (results) => Object.fromEntries(results.map((r) => [r.source + ':' + r.id, r]));

test('dayStart is 00:00 Seoul of a day key and refuses anything else', () => {
  assert.equal(dayStart('20261111').toISOString(), '2026-11-10T15:00:00.000Z');
  assert.throws(() => dayStart('2026-11-11'), RangeError);
});

test('priceIndex divides the amount by complexity and the unlearned reference, and is null without a basis', () => {
  assert.equal(priceIndex(270000, { reference: 300000, complexity: 1 }), 0.9);
  assert.equal(priceIndex(600000, { guideAvg: 300000, complexity: 2 }), 1);
  assert.equal(priceIndex(450000, { base: 300000, complexity: 1.5 }), 1);
  assert.equal(priceIndex(300000, null), null);
  assert.equal(priceIndex(300000, { complexity: 1 }), null);
});

test('every quote ends in one result read from the ledger', () => {
  const ledger = openLedger(':memory:');
  const won = sent(ledger, { ref: 'w', status: 'accepted' });
  const lost = sent(ledger, { ref: 'l', status: 'declined' });
  const exp = sent(ledger, { ref: 'e', status: 'expired' });
  const aged = sent(ledger, { ref: 'a' });
  const young = sent(ledger, { ref: 'y', quoteAt: plus(T0, DAY), rowAt: plus(T0, DAY) });
  const late = sent(ledger, { ref: 'z', quoteAt: plus(T0, 30 * DAY), rowAt: plus(T0, 30 * DAY) });
  const full = plan(ledger, { platform: 'soomgo', threadId: ledger.upsertThread({ platform: 'soomgo', externalId: 'f', kind: 'request' }).id, kind: 'quote', payload: { text: 'q f', amountKRW: 300000, service: 'detail_page_design' } });
  // The drain's path for a refused send: sending, back to planned, then stale with the refusal code.
  setStatus(ledger, full.id, { from: 'planned', to: 'sending' });
  setStatus(ledger, full.id, { from: 'sending', to: 'planned' });
  setStatus(ledger, full.id, { from: 'planned', to: 'stale', receipt: { refused: 'FSW_SOOMGO_REQUEST_FULL', at: T0 } });
  ledger.db.prepare('UPDATE outbox SET created_at = ? WHERE id = ?').run(T0, full.id);
  const r = byId(quoteResults(ledger, { asOf: new Date(plus(T0, 14 * DAY)), expireAfterDays: 14 }));
  assert.deepEqual([won, lost, exp, aged, young].map((x) => r['quote:' + x.quote.id].result), ['won', 'lost', 'expired', 'expired', 'open']);
  assert.deepEqual([r['quote:' + aged.quote.id].aged, r['quote:' + exp.quote.id].aged], [true, false]);
  assert.equal(r['quote:' + late.quote.id], undefined, 'a quote sent after asOf is not a case yet');
  assert.deepEqual([r['outbox:' + full.id].result, r['outbox:' + full.id].code, r['outbox:' + full.id].index], ['refused', 'FSW_SOOMGO_REQUEST_FULL', null]);
  assert.equal(r['quote:' + won.quote.id].index, 1);
  assert.equal(r['quote:' + won.quote.id].costKRW, 990);
  for (const x of Object.values(r)) assert.ok(QUOTE_RESULTS.includes(x.result));
});

test('a quote ages from its row read-back, a d605c5d send from its own time, and a stale row without a refusal is no case', () => {
  const ledger = openLedger(':memory:');
  const v0 = sent(ledger, { ref: 'v', quoteAt: T0, rowAt: plus(T0, 2 * DAY) });
  const old = sent(ledger, { ref: 'o', quoteAt: T0, rowAt: plus(T0, 2 * DAY), pipeline: 'd605c5d', pricing: null });
  const asOf = new Date(plus(T0, 15 * DAY));
  const r = byId(quoteResults(ledger, { asOf, expireAfterDays: 14 }));
  assert.deepEqual([r['quote:' + v0.quote.id].at, r['quote:' + v0.quote.id].result], [plus(T0, 2 * DAY), 'open']);
  assert.deepEqual([r['quote:' + old.quote.id].at, r['quote:' + old.quote.id].result, r['quote:' + old.quote.id].index], [T0, 'expired', null]);
  const t = ledger.upsertThread({ platform: 'kmong', externalId: 'p', kind: 'message' });
  const msg = plan(ledger, { platform: 'kmong', threadId: t.id, kind: 'quote', payload: { text: 'gone', amountKRW: 1 } });
  setStatus(ledger, msg.id, { from: 'planned', to: 'stale', reason: 'request expired' });
  assert.equal(quoteResults(ledger, { asOf, expireAfterDays: 14 }).filter((x) => x.source === 'outbox').length, 0);
});

test('quoteResults needs a day and a positive expiry, and Infinity reads statuses only', () => {
  const ledger = openLedger(':memory:');
  const a = sent(ledger, { ref: 'a' });
  assert.throws(() => quoteResults(ledger, { asOf: null, expireAfterDays: 14 }), TypeError);
  assert.throws(() => quoteResults(ledger, { asOf: new Date(), expireAfterDays: 0 }), RangeError);
  assert.equal(quoteResults(ledger, { asOf: new Date(plus(T0, 400 * DAY)), expireAfterDays: Infinity }).find((x) => x.id === a.quote.id).result, 'open');
});

const SETTINGS = { enabled: true, minCases: 5, step: 0.2, maxMove: 0.3, expireAfterDays: 14, lookbackDays: 180 };
const ASOF = new Date('2026-11-11T00:00:00+09:00');
const cases = (result, index, n, at = '2026-10-20T00:00:00Z') => Array.from({ length: n }, (_, i) => ({ source: 'quote', id: i + 1, platform: 'soomgo', service: 'detail_page_design', at, result, index }));
const row = (over = {}) => ({ platform: 'soomgo', service: 'detail_page_design', viable: true, baseKRW: 300000, baseNetKRW: 0, costFloorKRW: 50000, marketCeilingKRW: 1000000, floorKRW: 100000, ceilingKRW: 1200000, packages: { standard: 300000, deluxe: 660000, premium: 1200000 }, ...over });
const descriptors = { soomgo: loadDescriptor('soomgo') };

test('learnedFactor moves a step per decided case toward where it won or under where it lost, never up on a loss', () => {
  assert.equal(Math.round(learnedFactor(cases('expired', 1, 5), SETTINGS) * 10_000) / 10_000, 0.8655);
  assert.equal(Math.round(learnedFactor(cases('won', 1.3, 5), SETTINGS) * 10_000) / 10_000, 1.2017);
  assert.equal(learnedFactor(cases('lost', 2, 5), SETTINGS), 1, 'a loss above the current price says nothing about it');
  assert.equal(learnedFactor([...cases('open', 0.5, 3), ...cases('refused', null, 2), ...cases('lost', null, 4)], SETTINGS), 1);
  assert.equal(Math.round(learnedFactor(cases('won', 3, 20), SETTINGS) * 10_000) / 10_000, 1.3, 'held at 1 + maxMove');
});

test('learnPriceRows holds a row under minCases, moves it by the learned factor, and clamps to the cost floor and the market ceiling', () => {
  const [held] = learnPriceRows([row()], cases('expired', 1, 4), { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([held.baseKRW, held.learned.factor, held.learned.reason, held.learned.winRate], [300000, 1, '4 of 5 priced decided quotes', 1 / 6]);
  const [moved] = learnPriceRows([row()], cases('expired', 1, 5), { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([moved.baseKRW, moved.learned.factor, moved.learned.fromKRW, moved.learned.capped, moved.learned.priced], [260000, 0.8655, 300000, false, 5]);
  assert.equal(moved.baseNetKRW, sellerNet(260000, descriptors.soomgo).net);
  assert.deepEqual([moved.packages, moved.floorKRW, moved.ceilingKRW], [row().packages, 100000, 1200000], 'packages and the market range stay on the market');
  const [floor] = learnPriceRows([row({ baseKRW: 100000, costFloorKRW: 95000 })], cases('lost', 1, 5), { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([floor.baseKRW, floor.learned.capped], [95000, true]);
  const [ceiling] = learnPriceRows([row({ marketCeilingKRW: 330000 })], cases('won', 2, 5), { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([ceiling.baseKRW, ceiling.learned.factor, ceiling.learned.capped], [330000, 1.3, true]);
});

test('learnPriceRows counts cases without a pricing basis toward the win rate and moves nothing with them', () => {
  const [r] = learnPriceRows([row()], [...cases('expired', null, 6), ...cases('won', null, 1)], { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([r.baseKRW, r.learned.factor, r.learned.cases, r.learned.priced, r.learned.winRate, r.learned.reason], [300000, 1, 7, 0, 2 / 9, '0 of 5 priced decided quotes']);
  const [old] = learnPriceRows([row()], cases('expired', 1, 5, '2026-01-01T00:00:00Z'), { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.equal(old.learned.cases, 0, 'cases older than lookbackDays are dropped');
  const [off] = learnPriceRows([row({ viable: false })], cases('expired', 1, 5), { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([off.baseKRW, off.learned.reason], [300000, 'row not viable']);
});

test('a request quote applies the row factor inside the guide and records the reference it was priced from', () => {
  const guide = { avgKRW: 300000, minKRW: 100000, maxKRW: 1000000 };
  const q = quoteForRequest({ guide, complexity: 1.2, row: { costFloorKRW: 50000, learned: { factor: 0.9 } }, descriptor: descriptors.soomgo, config: {}, quoteCostKRW: 990 });
  assert.equal(q.amountKRW, 324000);
  assert.deepEqual([q.basis.reference, q.basis.learnedFactor], [300000, 0.9]);
  assert.equal(priceIndex(q.amountKRW, q.basis), 0.9);
  const plain = quoteForRequest({ guide, complexity: 1.2, row: { costFloorKRW: 50000 }, descriptor: descriptors.soomgo, config: {}, quoteCostKRW: 990 });
  assert.deepEqual([plain.amountKRW, plain.basis.learnedFactor], [360000, 1]);
});

test('a row quote records the base before learning, so its index reads against the market', () => {
  const q = quoteFromRow({ row: { baseKRW: 260000, floorKRW: 100000, ceilingKRW: 1200000, learned: { factor: 0.8655, fromKRW: 300000 } }, complexity: 1 });
  assert.deepEqual([q.amountKRW, q.basis.reference, q.basis.learnedFactor], [260000, 300000, 0.8655]);
  assert.equal(Math.round(priceIndex(q.amountKRW, q.basis) * 1000) / 1000, 0.867);
});

test('priceLearningSettings reads the group, learns nothing without it, and refuses a value out of range', () => {
  assert.deepEqual(priceLearningSettings({ priceLearning: SETTINGS }), SETTINGS);
  assert.deepEqual(priceLearningSettings({}), { enabled: false, expireAfterDays: Infinity, reason: 'config.priceLearning is not set' });
  assert.throws(() => priceLearningSettings({ priceLearning: { ...SETTINGS, maxMove: 1 } }), { code: 'FSW_CONFIG_MISSING' });
  assert.throws(() => priceLearningSettings({ priceLearning: { ...SETTINGS, minCases: 0 } }), { code: 'FSW_CONFIG_MISSING' });
});

// Two quotes on one thread, sent a day apart: the client hired on the newer one.
function requote(ledger, ref, { jobStatus = 'ordered', newerStatus = 'accepted', chat = false } = {}) {
  const t = ledger.upsertThread({ platform: 'soomgo', externalId: ref, kind: 'request' });
  const quote = (amountKRW, at, status) => {
    const row = plan(ledger, { platform: 'soomgo', threadId: t.id, kind: 'quote', payload: { text: 'q ' + ref + amountKRW, amountKRW, service: 'detail_page_design', decision: { quote: { amountKRW, pricing: { source: 'guide', guideAvg: 300000, complexity: 1 } } } } });
    setStatus(ledger, row.id, { from: 'planned', to: 'sending' });
    setStatus(ledger, row.id, { from: 'sending', to: 'observed', receipt: { observed: true } });
    ledger.db.prepare('UPDATE outbox SET updated_at = ? WHERE id = ?').run(at, row.id);
    return ledger.addQuote({ threadId: t.id, platform: 'soomgo', service: 'detail_page_design', amountKRW, costKRW: 990, status, at });
  };
  const older = quote(240000, T0, 'sent');
  const newer = quote(300000, plus(T0, DAY), newerStatus);
  const jobThread = chat ? ledger.upsertThread({ platform: 'soomgo', externalId: ref + '-chat', kind: 'message' }) : t;
  ledger.upsertJob({ id: 'soomgo-' + ref, threadId: jobThread.id, platform: 'soomgo', service: 'detail_page_design', status: jobStatus, meta: chat ? { requestThreadId: t.id } : {} });
  return { older, newer };
}

test('a quote the client passed over for a newer one on the same deal is superseded, never a loss', () => {
  const ledger = openLedger(':memory:');
  const hired = requote(ledger, 'h');
  const cancelled = requote(ledger, 'c', { jobStatus: 'lost', newerStatus: 'declined', chat: true });
  const waiting = requote(ledger, 'w', { jobStatus: 'quoted', newerStatus: 'sent' });
  const r = byId(quoteResults(ledger, { asOf: new Date(plus(T0, 30 * DAY)), expireAfterDays: 14 }));
  const at = (q) => [q.amountKRW, r['quote:' + q.id].result];
  assert.deepEqual([at(hired.older), at(hired.newer)], [[240000, 'superseded'], [300000, 'won']]);
  assert.deepEqual([at(cancelled.older), at(cancelled.newer)], [[240000, 'superseded'], [300000, 'lost']], 'a soomgo chat job names the request thread its quotes sit on');
  assert.deepEqual([at(waiting.older), at(waiting.newer)], [[240000, 'expired'], [300000, 'expired']], 'a deal still at quoted has decided nothing');
  const [row] = learnPriceRows([{ platform: 'soomgo', service: 'detail_page_design', viable: true, baseKRW: 300000, costFloorKRW: 50000, marketCeilingKRW: 1000000 }], Object.values(r).filter((x) => x.threadId === hired.older.threadId), { settings: { minCases: 1, step: 0.2, maxMove: 0.3, lookbackDays: 180 }, descriptors: { soomgo: loadDescriptor('soomgo') }, asOf: new Date(plus(T0, 30 * DAY)) });
  assert.deepEqual([row.learned.won, row.learned.superseded, row.learned.cases, row.learned.factor], [1, 1, 1, 1], 'only the won quote is learned');
});

test('decided quotes without a pricing basis fill the win rate, never minCases: one priced loss among five moves nothing', () => {
  const unpriced = cases('expired', null, 4);
  const priced = cases('expired', 1, 1).map((c) => ({ ...c, id: 99 }));
  const [r] = learnPriceRows([row()], [...unpriced, ...priced], { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([r.baseKRW, r.learned.factor, r.learned.cases, r.learned.priced, r.learned.winRate, r.learned.reason], [300000, 1, 5, 1, 1 / 7, '1 of 5 priced decided quotes']);
  const [five] = learnPriceRows([row()], [...unpriced, ...cases('expired', 1, 5)], { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([five.learned.factor, five.learned.cases, five.learned.priced], [0.8655, 9, 5], 'five priced cases move it, and the unpriced ones still count in the win rate');
});

// The chat list's acts, as recordFunnel writes them (src/loop/funnel.mjs).
const act = (ledger, kind, ref, quoteId, at, extra = {}) => ledger.addEvent({ kind, platform: 'soomgo', ref, at, payload: { quoteId, requestThreadId: null, unlinked: quoteId == null ? 'the row names no request' : null, firstSeen: false, otherStatus: null, ...extra } });

test('a customer who hired another pro makes the quote lost from the time it is seen, and the end of that hire reopens it', () => {
  const ledger = openLedger(':memory:');
  const { quote } = sent(ledger, { ref: 'h' });
  act(ledger, 'quote.hired_other', 'c-h', quote.id, plus(T0, 2 * DAY), { otherStatus: 'hired' });
  const at = (d) => quoteResults(ledger, { asOf: new Date(plus(T0, d * DAY)), expireAfterDays: 14 }).find((r) => r.id === quote.id);
  assert.deepEqual([at(1).result, at(1).cause], ['open', null]);
  assert.deepEqual([at(3).result, at(3).cause, at(3).aged], ['lost', 'hired_other', false]);
  act(ledger, 'quote.hired_other_cancelled', 'c-h', quote.id, plus(T0, 4 * DAY));
  assert.deepEqual([at(5).result, at(5).cause], ['open', null]);
});

test('an accepted quote stays won once whatever the chat showed before, and opened follows the open event', () => {
  const ledger = openLedger(':memory:');
  const won = sent(ledger, { ref: 'w', status: 'accepted' });
  const seen = sent(ledger, { ref: 's' });
  act(ledger, 'quote.hired_other', 'c-w', won.quote.id, plus(T0, DAY));
  act(ledger, 'quote.opened', 'c-s', seen.quote.id, plus(T0, DAY));
  const r = byId(quoteResults(ledger, { asOf: new Date(plus(T0, 2 * DAY)), expireAfterDays: 14 }));
  assert.deepEqual([r['quote:' + won.quote.id].result, r['quote:' + won.quote.id].cause], ['won', null]);
  assert.deepEqual([r['quote:' + seen.quote.id].opened, r['quote:' + won.quote.id].opened], [true, false]);
});

test('quoteFunnel counts what customers did with the quotes of the window', () => {
  const ledger = openLedger(':memory:');
  const now = new Date(plus(T0, 3 * DAY));
  const opened = sent(ledger, { ref: 'o' });
  const other = sent(ledger, { ref: 'x' });
  sent(ledger, { ref: 'p' });
  sent(ledger, { ref: 'old', quoteAt: plus(T0, -10 * DAY), rowAt: plus(T0, -10 * DAY) });
  act(ledger, 'quote.opened', 'c-o', opened.quote.id, plus(T0, DAY));
  act(ledger, 'quote.hired_other', 'c-x', other.quote.id, plus(T0, DAY), { otherStatus: 'hired' });
  act(ledger, 'quote.opened', 'c-u', null, plus(T0, DAY));
  const f = quoteFunnel(ledger, { platform: 'soomgo', now, days: 7 });
  assert.deepEqual(f, { days: 7, sent: 3, opened: 1, hiredUs: 0, hiredOther: 1, noAnswer: 2, unlinked: 1, opensKnown: false });
  ledger.upsertThread({ platform: 'soomgo', externalId: 'c-o', kind: 'message', meta: { funnel: { opened: true } } });
  assert.equal(quoteFunnel(ledger, { platform: 'soomgo', now, days: 7 }).opensKnown, true);
});

// The unlinked count reads the funnel's own events: the quote.* events other writers keep (quote.sent,
// quote.budget_refused, quote.cost_observed) are never a chat the funnel could not link.
test('quoteFunnel counts unlinked chats from the funnel events only', () => {
  const ledger = openLedger(':memory:');
  const now = new Date('2026-10-27T03:00:00.000Z');
  const at = '2026-10-27T01:00:00.000Z';
  ledger.addEvent({ kind: 'quote.opened', platform: 'soomgo', ref: 'c1', at, payload: { quoteId: null, unlinked: 'no fsw quote on request r1' } });
  ledger.addEvent({ kind: 'quote.sent', platform: 'soomgo', ref: 'c2', at, payload: { quoteId: null, unlinked: 'written by another path' } });
  ledger.addEvent({ kind: 'quote.budget_refused', platform: 'soomgo', ref: 'c3', at, payload: { unlinked: true } });
  assert.equal(quoteFunnel(ledger, { platform: 'soomgo', now, days: 7 }).unlinked, 1);
});
