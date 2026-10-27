// The quote funnel from the soomgo chat list (070 U7.Q): every chat row that carries our quote leaves a
// change-only record of whether the customer opened it and whether they hired us or another pro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../src/core/ledger.mjs';
import { FUNNEL_EVENTS, OTHER_HIRED, recordFunnel } from '../src/loop/funnel.mjs';

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
