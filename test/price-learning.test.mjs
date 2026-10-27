// Price learning from quote outcomes (070 U7.P): what became of every quote fsw sent, replayed from the
// ledger, and the bounded price move each row learns from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../src/core/ledger.mjs';
import { plan, setStatus } from '../src/outbox/index.mjs';
import { QUOTE_RESULTS, dayStart, priceIndex, quoteResults } from '../src/economics/quote-results.mjs';

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
