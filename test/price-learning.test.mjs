// Price learning from quote outcomes (070 U7.P): what became of every quote fsw sent, replayed from the
// ledger, and the bounded price move each row learns from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../src/core/ledger.mjs';
import { plan, setStatus } from '../src/outbox/index.mjs';
import { QUOTE_RESULTS, dayStart, priceIndex, quoteFunnel, quoteResults } from '../src/economics/quote-results.mjs';
import { learnPriceRows, learnedFactor } from '../src/economics/price-learning.mjs';
import { armStats } from '../src/economics/yield.mjs';
import { quoteForRequest } from '../src/economics/pricing.mjs';
import { quoteFromRow } from '../src/economics/quote.mjs';
import { sellerNet } from '../src/economics/fees.mjs';
import { priceLearningSettings } from '../src/core/settings.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';

const DAY = 86_400_000;
const T0 = '2026-10-01T03:00:00.000Z';
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

// A quote fsw sent: its observed outbox row (read back at rowAt) and the quote row the deal recorded at quoteAt.
function sent(ledger, { ref, amountKRW = 300000, service = 'detail_page_design', status = 'sent', quoteAt = T0, rowAt = T0, pricing = { source: 'price-row', base: 300000, reference: 300000, complexity: 1 }, pipeline = null, costKRW = 990 }) {
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: ref, kind: 'request' });
  const row = plan(ledger, { platform: 'soomgo', threadId: thread.id, kind: 'quote', payload: { text: 'q ' + ref, amountKRW, service, costKRW, ...(pricing ? { decision: { quote: { amountKRW, pricing } } } : {}) } });
  setStatus(ledger, row.id, { from: 'planned', to: 'sending' });
  setStatus(ledger, row.id, { from: 'sending', to: 'observed', receipt: { observed: true, ...(pipeline ? { pipeline } : {}) } });
  ledger.db.prepare('UPDATE outbox SET updated_at = ? WHERE id = ?').run(rowAt, row.id);
  const q = ledger.addQuote({ threadId: thread.id, platform: 'soomgo', service, amountKRW, costKRW, status, at: quoteAt });
  // The deal names the quote beside its row (src/deal/advance.mjs); a 2c77326 send was never applied by the deal.
  if (!pipeline) ledger.addEvent({ kind: 'deal.quote_observed', platform: 'soomgo', ref, payload: { outboxId: row.id, quoteId: q.id } });
  return { thread, row, quote: q };
}
const byId = (results) => Object.fromEntries(results.map((r) => [r.source + ':' + r.id, r]));
// A soomgo quote its customer never opened expires 48 hours after it went out (bidCost.unreadRefundHours), so a
// case about the age rule or the chat's hire marks its quote opened the day after it was sent.
const seenNextDay = (ledger, x) => ledger.addEvent({ kind: 'quote.opened', platform: 'soomgo', ref: 'c-' + x.thread.externalId, at: plus(x.quote.at, DAY), payload: { quoteId: x.quote.id } });

test('dayStart is 00:00 Seoul of a day key and refuses anything else', () => {
  assert.equal(dayStart('20261111').toISOString(), '2026-11-10T15:00:00.000Z');
  assert.throws(() => dayStart('2026-11-11'), RangeError);
});

test('priceIndex divides the amount by complexity and the unlearned reference, and is null without a basis', () => {
  assert.equal(priceIndex(270000, { reference: 300000, complexity: 1 }), 0.9);
  assert.equal(priceIndex(256000, { source: 'price-row', base: 128000, reference: 128000, guideAvg: 300000, complexity: 2 }), 1);
  assert.equal(priceIndex(450000, { base: 300000, complexity: 1.5 }), 1);
  assert.equal(priceIndex(300000, null), null);
  assert.equal(priceIndex(300000, { complexity: 1 }), null);
});

test('a request quote priced from the guide average says nothing about the tiered row base', () => {
  // Every soomgo request quote before 2026-10-27 recorded the guide average as its reference.
  const old = { guideAvg: 300000, guideMin: 35000, guideMax: 1500000, complexity: 1, raw: 300000, clamped: 300000, costFloorKRW: 45000 };
  assert.equal(priceIndex(300000, old), null);
  assert.equal(priceIndex(300000, { ...old, reference: 300000 }), null);
  const ledger = openLedger(':memory:');
  const lost = Array.from({ length: 5 }, (_, i) => sent(ledger, { ref: 'g' + i, status: 'declined', pricing: old }));
  const results = quoteResults(ledger, { asOf: new Date(plus(T0, 30 * DAY)), expireAfterDays: 14 });
  assert.deepEqual(lost.map((x) => results.find((r) => r.id === x.quote.id)).map((r) => [r.result, r.index]), Array(5).fill(['lost', null]));
  const [held] = learnPriceRows([row({ baseKRW: 128000 })], results, { settings: SETTINGS, descriptors, asOf: new Date(plus(T0, 30 * DAY)) });
  assert.deepEqual([held.baseKRW, held.learned.cases, held.learned.priced, held.learned.factor], [128000, 5, 0, 1]);
});

test('every quote ends in one result read from the ledger', () => {
  const ledger = openLedger(':memory:');
  const won = sent(ledger, { ref: 'w', status: 'accepted' });
  const lost = sent(ledger, { ref: 'l', status: 'declined' });
  const exp = sent(ledger, { ref: 'e', status: 'expired' });
  const aged = sent(ledger, { ref: 'a' });
  const young = sent(ledger, { ref: 'y', quoteAt: plus(T0, DAY), rowAt: plus(T0, DAY) });
  seenNextDay(ledger, young);
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
  seenNextDay(ledger, v0);
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

test('quoteResults needs a day and a positive expiry, and Infinity turns the age rule off', () => {
  const ledger = openLedger(':memory:');
  const a = sent(ledger, { ref: 'a' });
  seenNextDay(ledger, a);
  assert.throws(() => quoteResults(ledger, { asOf: null, expireAfterDays: 14 }), TypeError);
  assert.throws(() => quoteResults(ledger, { asOf: new Date(), expireAfterDays: 0 }), RangeError);
  assert.equal(quoteResults(ledger, { asOf: new Date(plus(T0, 400 * DAY)), expireAfterDays: Infinity }).find((x) => x.id === a.quote.id).result, 'open');
});

// soomgo refunds a quote the customer has not opened 48 hours after it went out (descriptor
// bidCost.unreadRefundHours), so such a quote can no longer win: once a poll saw its chat still unopened past the
// window (quote.unread, src/loop/funnel.mjs) it resolves as expired with cause unread within two days instead of
// fourteen. An expired quote is a loss to price learning (learnedFactor) and to the allocation (yield.mjs), and the
// funnel no longer counts it as no answer yet.
test('a soomgo quote seen unread past the refund window is expired with cause unread, and an opened one stays open', () => {
  const ledger = openLedger(':memory:');
  const unread = sent(ledger, { ref: 'u' });
  const opened = sent(ledger, { ref: 'o' });
  ledger.addEvent({ kind: 'quote.opened', platform: 'soomgo', ref: 'c-o', at: plus(T0, DAY), payload: { quoteId: opened.quote.id } });
  ledger.addEvent({ kind: 'quote.unread', platform: 'soomgo', ref: 'c-u', at: plus(T0, 2 * DAY), payload: { quoteId: unread.quote.id } });
  const at = (hours, expireAfterDays = 14) => byId(quoteResults(ledger, { asOf: new Date(plus(T0, hours * 3_600_000)), expireAfterDays }));
  const pick = (r, x) => [r['quote:' + x.quote.id].result, r['quote:' + x.quote.id].cause, r['quote:' + x.quote.id].aged];
  assert.deepEqual(pick(at(47), unread), ['open', null, false]);
  assert.deepEqual(pick(at(48), unread), ['expired', 'unread', true]);
  assert.deepEqual(pick(at(48), opened), ['open', null, false]);
  // The age rule off (Infinity, the funnel's read) still expires an unread quote.
  assert.deepEqual(pick(at(48, Infinity), unread), ['expired', 'unread', true]);
  const f = quoteFunnel(ledger, { platform: 'soomgo', now: new Date(plus(T0, 2 * DAY)), days: 7 });
  assert.deepEqual([f.sent, f.opened, f.noAnswer], [2, 1, 1]);
});

// A missing opened signal is no evidence that a quote went unread: the funnel reads only the chat list's first page,
// so a quote whose chat it never saw has no opened event either. Such a quote stays open past the refund window, and
// the price learning and the allocation read it exactly as they did inside the window, until the age rule ends it.
test('a soomgo quote no poll observed stays open past the refund window, and learning and allocation do not move', () => {
  const ledger = openLedger(':memory:');
  const quiet = sent(ledger, { ref: 'q' });
  const results = (hours, expireAfterDays = 14) => quoteResults(ledger, { asOf: new Date(plus(T0, hours * 3_600_000)), expireAfterDays });
  const inputs = (rs) => {
    const r = rs.find((x) => x.id === quiet.quote.id);
    const arm = armStats(ledger, { descriptors, services: { detail_page_design: { agentHours: { standard: 1 }, humanMinutes: { standard: 0 } } }, config: { yield: { humanHourWeight: 4 } }, results: rs }).find((a) => a.platform === 'soomgo' && a.service === 'detail_page_design');
    return [r.result, r.cause, r.aged, learnedFactor(rs, { step: 0.2, maxMove: 0.3 }), arm.losses];
  };
  const inside = inputs(results(1));
  assert.deepEqual(inside, ['open', null, false, 1, 0]);
  for (const hours of [48, 72, 13 * 24]) assert.deepEqual(inputs(results(hours)), inside, hours + ' hours');
  assert.deepEqual(inputs(results(72, Infinity)), inside, 'the funnel read, with the age rule off');
  assert.equal(quoteFunnel(ledger, { platform: 'soomgo', now: new Date(plus(T0, 3 * DAY)), days: 7 }).noAnswer, 1);
  // The age rule still ends it at 14 days, with no unread cause.
  assert.deepEqual(inputs(results(14 * 24)).slice(0, 3), ['expired', null, true]);
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
  const q = quoteForRequest({ guide, complexity: 1.2, row: { baseKRW: 270000, costFloorKRW: 50000, learned: { factor: 0.9, fromKRW: 300000 } }, descriptor: descriptors.soomgo, config: {}, quoteCostKRW: 990 });
  assert.equal(q.amountKRW, 324000);
  assert.deepEqual([q.basis.reference, q.basis.learnedFactor], [300000, 0.9]);
  assert.equal(priceIndex(q.amountKRW, q.basis), 0.9);
  const plain = quoteForRequest({ guide, complexity: 1.2, row: { baseKRW: 300000, costFloorKRW: 50000 }, descriptor: descriptors.soomgo, config: {}, quoteCostKRW: 990 });
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
    const row = plan(ledger, { platform: 'soomgo', threadId: t.id, kind: 'quote', payload: { text: 'q ' + ref + amountKRW, amountKRW, service: 'detail_page_design', decision: { quote: { amountKRW, pricing: { source: 'price-row', base: 300000, reference: 300000, complexity: 1 } } } } });
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
  ledger.addEvent({ kind: 'quote.opened', platform: 'soomgo', ref: 'c-h', at: plus(T0, DAY), payload: { quoteId: quote.id } });
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
  // Inside the 48 hours an unopened soomgo quote stays open (bidCost.unreadRefundHours).
  const now = new Date(plus(T0, 1.5 * DAY));
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

// The bound is on the amount a row prints, not the factor: rounding to 1,000 KRW can carry a small base past it.
test('the learned base stays within maxMove of the market base after rounding, rounding toward the base', () => {
  const small = row({ baseKRW: 5000, costFloorKRW: 1000, marketCeilingKRW: 100000 });
  const [up] = learnPriceRows([small], cases('won', 3, 5), { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([up.learned.factor, up.baseKRW, up.learned.capped], [1.3, 6000, true]);
  const [down] = learnPriceRows([small], cases('lost', 0.1, 5), { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([down.learned.factor, down.baseKRW, down.learned.capped], [0.7, 4000, true]);
  const [narrow] = learnPriceRows([row({ baseKRW: 1500, costFloorKRW: 1000, marketCeilingKRW: 100000 })], cases('won', 3, 5), { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.equal(narrow.baseKRW, 1500, 'no 1,000 KRW step fits inside the bound, so the base stays');
  const [cost] = learnPriceRows([row({ baseKRW: 100000, costFloorKRW: 95500 })], cases('lost', 1, 5), { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.equal(cost.baseKRW, 96000, 'a cost floor between steps rounds up to the next step, never under it');
});

// Each quote reads the pricing basis of its own outbox row: a later quote's basis on the same thread is not applied
// to the quotes before it.
test('a quote takes the pricing basis of its own row, never of a later quote on the same thread', () => {
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'r-many', kind: 'request' });
  for (let i = 1; i <= 5; i++) {
    const at = plus(T0, i * 60_000);
    const pricing = i === 5 ? { reference: 600000, complexity: 1 } : null;
    const row = plan(ledger, { platform: 'soomgo', threadId: thread.id, kind: 'quote', payload: { text: 'q ' + i, amountKRW: 300000, service: 'detail_page_design', costKRW: 990, ...(pricing ? { decision: { quote: { amountKRW: 300000, pricing } } } : {}) } });
    setStatus(ledger, row.id, { from: 'planned', to: 'sending' });
    setStatus(ledger, row.id, { from: 'sending', to: 'observed', receipt: { observed: true } });
    ledger.db.prepare('UPDATE outbox SET updated_at = ? WHERE id = ?').run(at, row.id);
    // The event shape before the quote id: the deal wrote it in the transaction that added the quote.
    ledger.addEvent({ kind: 'deal.quote_observed', platform: 'soomgo', ref: 'r-many', payload: { outboxId: row.id } });
    ledger.addQuote({ threadId: thread.id, platform: 'soomgo', service: 'detail_page_design', amountKRW: 300000, costKRW: 990, status: 'expired', at });
  }
  const results = quoteResults(ledger, { asOf: ASOF, expireAfterDays: 14 });
  assert.deepEqual(results.map((r) => r.index), [null, null, null, null, 0.5]);
  const [r] = learnPriceRows([row()], results, { settings: SETTINGS, descriptors, asOf: ASOF });
  assert.deepEqual([r.learned.priced, r.baseKRW], [1, 300000]);
  // A quote recorded without a row of its own (an outside quote at a hire) leaves its group ambiguous: no basis.
  ledger.addQuote({ threadId: thread.id, platform: 'soomgo', service: 'detail_page_design', amountKRW: 300000, costKRW: 0, status: 'accepted', at: plus(T0, 10 * 60_000) });
  assert.deepEqual(quoteResults(ledger, { asOf: ASOF, expireAfterDays: 14 }).map((q) => q.index), [null, null, null, null, null, null]);
});

// A quote is linked to its outbox row by the quote id the deal writes on deal.quote_observed. Rows imported from the
// 2c77326 approval files carry no such event; they pair with their quotes in send order (the row's close time and the
// quote's own time), never in the order the import wrote them. A row the deal has not applied yet links to nothing.
function observedRow(ledger, thread, { text, reference, at, pipeline = null }) {
  const row = plan(ledger, { platform: 'soomgo', threadId: thread.id, kind: 'quote', payload: { text, amountKRW: 300000, service: 'detail_page_design', costKRW: 990, decision: { quote: { amountKRW: 300000, pricing: { reference, complexity: 1 } } } } });
  setStatus(ledger, row.id, { from: 'planned', to: 'sending' });
  setStatus(ledger, row.id, { from: 'sending', to: 'observed', receipt: { observed: true, ...(pipeline ? { pipeline } : {}) } });
  ledger.db.prepare('UPDATE outbox SET updated_at = ? WHERE id = ?').run(at, row.id);
  return row;
}
const quoteAt = (ledger, thread, at, status = 'expired') => ledger.addQuote({ threadId: thread.id, platform: 'soomgo', service: 'detail_page_design', amountKRW: 300000, costKRW: 990, status, at });
const indexes = (ledger) => quoteResults(ledger, { asOf: ASOF, expireAfterDays: 14 }).map((r) => r.index);

test('imported rows pair with their quotes in send order, whatever order the import wrote them', () => {
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'imp', kind: 'request' });
  observedRow(ledger, thread, { text: 'second sent', reference: 600000, at: plus(T0, 2 * 3_600_000), pipeline: 'd605c5d' });
  observedRow(ledger, thread, { text: 'first sent', reference: 300000, at: plus(T0, 3_600_000), pipeline: 'd605c5d' });
  quoteAt(ledger, thread, plus(T0, 3_600_000));
  quoteAt(ledger, thread, plus(T0, 2 * 3_600_000));
  assert.deepEqual(indexes(ledger), [1, 0.5]);
});

test('a quote links to its row by the quote id on deal.quote_observed, and a hire quote beside an unapplied row has no basis', () => {
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'v0', kind: 'request' });
  const a = observedRow(ledger, thread, { text: 'a', reference: 300000, at: plus(T0, 60_000) });
  const b = observedRow(ledger, thread, { text: 'b', reference: 600000, at: plus(T0, 120_000) });
  const q1 = quoteAt(ledger, thread, plus(T0, 60_000));
  const q2 = quoteAt(ledger, thread, plus(T0, 120_000));
  // The events say q1 came from b and q2 from a, written in the order a then b.
  ledger.addEvent({ kind: 'deal.quote_observed', platform: 'soomgo', ref: 'v0', payload: { outboxId: a.id, quoteId: q2.id } });
  ledger.addEvent({ kind: 'deal.quote_observed', platform: 'soomgo', ref: 'v0', payload: { outboxId: b.id, quoteId: q1.id } });
  const byQuote = Object.fromEntries(quoteResults(ledger, { asOf: ASOF, expireAfterDays: 14 }).map((r) => [r.id, r.index]));
  assert.deepEqual([byQuote[q1.id], byQuote[q2.id]], [0.5, 1]);
  const hire = ledger.upsertThread({ platform: 'soomgo', externalId: 'hire', kind: 'message' });
  observedRow(ledger, hire, { text: 'not applied yet', reference: 600000, at: plus(T0, 60_000) });
  const outside = quoteAt(ledger, hire, plus(T0, 90_000), 'accepted');
  assert.equal(quoteResults(ledger, { asOf: ASOF, expireAfterDays: 14 }).find((r) => r.id === outside.id).index, null);
});

// The bounds are whole KRW: 100,000 x 1.15 is 114,999.99... in floating point, which lost the 115,000 step.
test('the step that lands exactly on a maxMove bound is reachable and never crossed', () => {
  const at = (maxMove, result, index) => learnPriceRows([row({ baseKRW: 100000, costFloorKRW: 1000, marketCeilingKRW: 1000000 })], cases(result, index, 5), { settings: { ...SETTINGS, maxMove }, descriptors, asOf: ASOF })[0].baseKRW;
  assert.equal(at(0.15, 'won', 3), 115000);
  assert.equal(at(0.15, 'lost', 0.1), 85000);
  assert.equal(at(0.4, 'won', 3), 140000);
  assert.equal(at(0.4, 'lost', 0.1), 60000);
});
