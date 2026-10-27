// The quote funnel from the soomgo chat list (070 U7.Q): every chat row that carries our quote leaves a
// change-only record of whether the customer opened it and whether they hired us or another pro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../src/core/ledger.mjs';
import { FUNNEL_EVENTS } from '../src/economics/quote-results.mjs';
import { OTHER_HIRED, recordFunnel } from '../src/loop/funnel.mjs';

const NOW = new Date('2026-10-27T03:00:00.000Z');
const later = (min) => new Date(NOW.getTime() + min * 60_000);
const chat = (ref, over = {}) => ({ platform: 'soomgo', ref, kind: 'message', status: 'pending', hired: null, otherProHired: null, requestId: 'r1', quote: { priceKRW: 300000, unit: 'total', opened: false }, ...over });

function setup() {
  const ledger = openLedger(':memory:');
  const req = ledger.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  const quote = ledger.addQuote({ threadId: req.id, platform: 'soomgo', service: 'detail_page_design', amountKRW: 300000, costKRW: 4000, status: 'sent', at: '2026-10-26T00:00:00.000Z' });
  const poll = (inbound, now = NOW) => {
    const rows = new Map(inbound.map((ib) => [String(ib.ref), ledger.upsertThread({ platform: ib.platform, externalId: String(ib.ref), kind: ib.kind })]));
    return recordFunnel(ledger, { platform: inbound[0]?.platform ?? 'soomgo', inbound, rows, now });
  };
  const events = () => ledger.db.prepare("SELECT kind, ref, at, payload FROM events WHERE kind LIKE 'quote.%' ORDER BY id").all().map((e) => ({ kind: e.kind, ref: e.ref, at: e.at, ...JSON.parse(e.payload) }));
  return { ledger, req, quote, poll, events };
}

test('first sight of an opened quote writes one event tied to our quote, and a repeat poll writes nothing', () => {
  const s = setup();
  assert.equal(s.poll([chat('c1', { quote: { priceKRW: 300000, unit: 'total', opened: true } })]).written, 1);
  const [e] = s.events();
  assert.deepEqual([e.kind, e.ref, e.at, e.quoteId, e.requestThreadId, e.firstSeen, e.unlinked], ['quote.opened', 'c1', NOW.toISOString(), s.quote.id, s.req.id, true, null]);
  const meta = s.ledger.listThreads({ platform: 'soomgo' }).find((t) => t.externalId === 'c1').meta;
  assert.deepEqual(meta.funnel, { opened: true, hiredUs: false, hiredOther: false, otherStatus: null, quoteId: s.quote.id, seenAt: NOW.toISOString() });
  const before = s.ledger.db.prepare("SELECT meta FROM threads WHERE external_id = 'c1'").get().meta;
  assert.equal(s.poll([chat('c1', { quote: { priceKRW: 300000, unit: 'total', opened: true } })], later(5)).written, 0);
  assert.equal(s.events().length, 1);
  assert.equal(s.ledger.db.prepare("SELECT meta FROM threads WHERE external_id = 'c1'").get().meta, before, 'no thread write on a repeat poll');
});

test('an open seen later is written at that poll and is no first sight', () => {
  const s = setup();
  s.poll([chat('c1')]);
  assert.equal(s.events().length, 0);
  s.poll([chat('c1', { quote: { priceKRW: 300000, unit: 'total', opened: true } })], later(5));
  assert.deepEqual(s.events().map((e) => [e.kind, e.firstSeen, e.at]), [['quote.opened', false, later(5).toISOString()]]);
});

test('a hire of another pro is recorded with its raw status, and its end is recorded too', () => {
  const s = setup();
  s.poll([chat('c1', { otherProHired: OTHER_HIRED[0] })]);
  s.poll([chat('c1', { otherProHired: 'customer_cancelled' })], later(5));
  assert.deepEqual(s.events().map((e) => [e.kind, e.otherStatus, e.quoteId]), [['quote.hired_other', OTHER_HIRED[0], s.quote.id], ['quote.hired_other_cancelled', 'customer_cancelled', s.quote.id]]);
});

test('an other-pro status the code does not name is recorded as unknown once per value, asks the operator once, and counts as no hire', () => {
  const s = setup();
  const first = s.poll([chat('c1', { otherProHired: 'pending_contract' })]);
  s.poll([chat('c1', { otherProHired: 'pending_contract' })], later(5));
  const other = s.poll([chat('c2', { otherProHired: 'pending_contract' })], later(10));
  assert.deepEqual(s.events().map((e) => [e.kind, e.ref, e.otherStatus, e.unknown]), [['quote.other_status', 'c1', 'pending_contract', true], ['quote.other_status', 'c2', 'pending_contract', true]]);
  assert.equal(s.events().filter((e) => e.kind === 'quote.hired_other').length, 0);
  assert.deepEqual(first.effects.map((e) => e.note.dedupeKey), ['soomgo-other-pro-status:pending_contract']);
  assert.match(first.effects[0].note.body, /pending_contract/);
  assert.deepEqual(other.effects, [], 'told once per value');
});

test('our own hire is recorded once', () => {
  const s = setup();
  s.poll([chat('c1', { status: 'hired', hired: 'hired', quote: { priceKRW: 300000, unit: 'total', opened: true } })]);
  s.poll([chat('c1', { status: 'hired', hired: 'hired', quote: { priceKRW: 300000, unit: 'total', opened: true } })], later(5));
  assert.deepEqual(s.events().map((e) => e.kind), ['quote.opened', 'quote.hired_us']);
});

test('a row that cannot be tied to an fsw quote is still recorded, with the reason', () => {
  const s = setup();
  const empty = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'r-empty', kind: 'request' });
  assert.ok(empty.id);
  const opened = { priceKRW: 300000, unit: 'total', opened: true };
  s.poll([chat('a', { requestId: null, quote: opened }), chat('b', { requestId: 'r-gone', quote: opened }), chat('c', { requestId: 'r-empty', quote: opened })]);
  assert.deepEqual(s.events().map((e) => [e.ref, e.quoteId, e.unlinked]), [['a', null, 'the row names no request'], ['b', null, 'request r-gone is not in the ledger'], ['c', null, 'no fsw quote on request r-empty']]);
});

test('rows without an opened field, a kmong chat or a soomgo request, are left alone', () => {
  const s = setup();
  assert.equal(s.poll([{ platform: 'kmong', ref: 'k1', kind: 'message', quote: null }]).written, 0);
  assert.equal(s.poll([{ platform: 'soomgo', ref: 'r1', kind: 'request', quote: null }]).written, 0);
  assert.equal(s.events().length, 0);
  assert.ok(FUNNEL_EVENTS.includes('quote.other_status'));
});

// A chat's funnel state belongs to the quote it is linked to: a newer fsw quote on the same request starts the
// chat's record over, so its open and a hire of another pro are tied to it rather than to the quote it replaced.
test('a second quote on the same request starts the chat funnel over, tying the open and the other-pro hire to it', () => {
  const s = setup();
  const opened = { priceKRW: 300000, unit: 'total', opened: true };
  s.poll([chat('c1', { quote: opened, otherProHired: OTHER_HIRED[0] })]);
  const second = s.ledger.addQuote({ threadId: s.req.id, platform: 'soomgo', service: 'detail_page_design', amountKRW: 260000, costKRW: 4000, status: 'sent', at: '2026-10-27T02:00:00.000Z' });
  assert.equal(s.poll([chat('c1', { quote: opened, otherProHired: OTHER_HIRED[0] })], later(5)).written, 2);
  assert.deepEqual(s.events().map((e) => [e.kind, e.quoteId, e.firstSeen]), [['quote.opened', s.quote.id, true], ['quote.hired_other', s.quote.id, true], ['quote.opened', second.id, true], ['quote.hired_other', second.id, true]]);
  const meta = s.ledger.listThreads({ platform: 'soomgo' }).find((t) => t.externalId === 'c1').meta;
  assert.deepEqual([meta.funnel.quoteId, meta.funnel.seenAt], [second.id, later(5).toISOString()]);
  assert.equal(s.poll([chat('c1', { quote: opened, otherProHired: OTHER_HIRED[0] })], later(10)).written, 0);
});

// soomgo refunds a quote its customer has not opened 48 hours after it went out (bidCost.unreadRefundHours). A poll that
// shows our quote still unopened once that long has passed is the platform's own word that it went unread: one
// quote.unread event, the evidence src/economics/quote-results.mjs expires the quote on. Before the window, without a
// window, or once opened, there is none.
test('a chat row still showing our quote unopened past the refund window writes quote.unread once', () => {
  const s = setup();
  const poll = (minutesAfterQuote, over = {}, refundHours = 48) => {
    const now = new Date(Date.parse(s.quote.at) + minutesAfterQuote * 60_000);
    const rows = new Map([['c1', s.ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' })]]);
    return recordFunnel(s.ledger, { platform: 'soomgo', inbound: [chat('c1', over)], rows, now, refundHours });
  };
  const unread = () => s.events().filter((e) => e.kind === 'quote.unread');
  poll(47 * 60);
  poll(49 * 60, {}, null);
  assert.equal(unread().length, 0, 'inside the window, or with no window, nothing says it went unread');
  poll(48 * 60);
  poll(50 * 60);
  assert.deepEqual(unread().map((e) => [e.ref, e.quoteId, e.requestThreadId]), [['c1', s.quote.id, s.req.id]]);
  assert.equal('quoteAt' in unread()[0], false);
  const seen = setup();
  const rows = new Map([['c2', seen.ledger.upsertThread({ platform: 'soomgo', externalId: 'c2', kind: 'message' })]]);
  recordFunnel(seen.ledger, { platform: 'soomgo', inbound: [chat('c2', { quote: { priceKRW: 300000, unit: 'total', opened: true } })], rows, now: new Date(Date.parse(seen.quote.at) + 49 * 3_600_000), refundHours: 48 });
  assert.deepEqual(seen.events().map((e) => e.kind), ['quote.opened']);
});
