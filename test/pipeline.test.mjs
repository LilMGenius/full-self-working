import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { listApprovals, resolveApproval } from '../src/brain/approvals.mjs';
import { flushApprovals, processThread } from '../src/pipeline/thread.mjs';

function makeInstance() {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-pipe-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

// Fake adapter on the DESIGN interface; every write reports what it observed.
function fakeAdapter({ observed = true, messages = [{ direction: 'in', text: '랜딩 페이지 제작 가능한가요?', externalId: 'm1' }], request, quoteCostKRW } = {}) {
  const calls = { readThread: [], send: [], quote: [], readRequest: [] };
  return {
    calls,
    async readThread(id, opts) {
      calls.readThread.push({ id, opts });
      return { id, messages };
    },
    async readRequest(id) {
      calls.readRequest.push(id);
      return { id, title: '홈페이지 제작', text: '회사 소개 랜딩 페이지가 필요합니다.', quoteCostKRW, ...request };
    },
    async send(id, { text, gate }) {
      calls.send.push({ id, text, gate });
      if (!gate?.ok) throw new Error('adapter refuses an ungated send');
      return observed ? { observed: true, text, externalId: 'out-' + calls.send.length } : { observed: false, error: 'not visible after send' };
    },
    async quote(id, q) {
      calls.quote.push({ id, ...q });
      if (!q.gate?.ok) throw new Error('adapter refuses an ungated quote');
      return observed ? { observed: true, text: q.text, cashSpentKRW: quoteCostKRW } : { observed: false };
    },
  };
}

const reply = (over = {}) => ({
  action: 'reply',
  modelCalls: 1,
  decision: { intent: 'inquiry', service: 'landing_page_web', language: 'ko', reply: '안녕하세요. 원하시는 구성과 일정을 알려 주세요.', quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [] },
  item: { kind: 'message' },
  gate: { ok: true, violations: [], warnings: [] },
  priceRow: null,
  ...over,
});
const fakeDecide = (result) => {
  const fn = async (thread) => {
    fn.threads.push(thread);
    return typeof result === 'function' ? result(thread) : result;
  };
  fn.threads = [];
  return fn;
};

function setup(platform = 'kmong') {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  return { instance, ledger, descriptor: loadDescriptor(platform), platform };
}

test('observe mode never opens an unread thread or asks the brain', async () => {
  const s = setup();
  const adapter = fakeAdapter();
  const decide = fakeDecide(reply());
  const r = await processThread({ ...s, threadRef: { id: 't1', unread: true, preview: '문의드립니다' }, adapter, mode: 'observe', decide });
  assert.equal(r.action, 'observed');
  assert.equal(adapter.calls.readThread.length, 0);
  assert.equal(decide.threads.length, 0);
  assert.equal(s.ledger.listThreads({ platform: 'kmong' }).length, 1);
});

test('draft mode queues an approval and never calls send', async () => {
  const s = setup();
  const adapter = fakeAdapter();
  const r = await processThread({ ...s, threadRef: { id: 't1' }, adapter, mode: 'draft', decide: fakeDecide(reply()) });
  assert.equal(r.action, 'queued');
  assert.equal(adapter.calls.send.length, 0);
  assert.deepEqual(adapter.calls.readThread[0].opts, { willReply: true });
  const [a] = listApprovals(s.instance, { status: 'open' });
  assert.equal(a.draft, reply().decision.reply);
  assert.equal(s.ledger.threadMessages(s.ledger.listThreads()[0].id).filter((m) => m.direction === 'out').length, 0);
});

test('auto mode records the outbound message only when the adapter observed it', async () => {
  const s = setup();
  const seen = fakeAdapter({ observed: true });
  const r1 = await processThread({ ...s, threadRef: { id: 't1' }, adapter: seen, mode: 'auto', decide: fakeDecide(reply()) });
  assert.equal(r1.action, 'sent');
  const t1 = s.ledger.listThreads().find((t) => t.externalId === 't1');
  const out1 = s.ledger.threadMessages(t1.id).filter((m) => m.direction === 'out');
  assert.equal(out1.length, 1);
  assert.equal(out1[0].gate.ok, true);

  const blind = fakeAdapter({ observed: false });
  const r2 = await processThread({ ...s, threadRef: { id: 't2' }, adapter: blind, mode: 'auto', decide: fakeDecide(reply()) });
  assert.equal(blind.calls.send.length, 1);
  assert.equal(r2.action, 'queued');
  const t2 = s.ledger.listThreads().find((t) => t.externalId === 't2');
  assert.equal(s.ledger.threadMessages(t2.id).filter((m) => m.direction === 'out').length, 0);
});

const soomgoQuote = () => reply({
  decision: { ...reply().decision, intent: 'quote_request', quote: { amountKRW: 500000, scope: ['1페이지'], deliveryDays: 7, priceType: 'fixed', split: { parts: [{ amountKRW: 250000 }, { amountKRW: 250000 }] } } },
  item: { kind: 'quote' },
  priceRow: { platform: 'soomgo', service: 'landing_page_web', floorKRW: 100000, ceilingKRW: 2000000, viable: true },
});

test('a soomgo quote is refused and queued when the day cash budget is spent', async () => {
  const s = setup('soomgo');
  const budget = { maxQuotesPerDay: 5, maxCashPerDay: 10000 };
  s.ledger.addQuote({ platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 8000, status: 'sent' });
  const adapter = fakeAdapter({ quoteCostKRW: 3000 });
  const r = await processThread({ ...s, threadRef: { id: 'r1', kind: 'request' }, adapter, mode: 'auto', budget, decide: fakeDecide(soomgoQuote()) });
  assert.equal(adapter.calls.quote.length, 0);
  assert.equal(r.action, 'queued');
  assert.match(r.reason, /cash budget/);
  assert.equal(s.ledger.listQuotes({ platform: 'soomgo' }).length, 1);
});

test('a soomgo quote inside the budget is sent with spend allowed and recorded with its cost', async () => {
  const s = setup('soomgo');
  const adapter = fakeAdapter({ quoteCostKRW: 3000 });
  const r = await processThread({ ...s, threadRef: { id: 'r1', kind: 'request' }, adapter, mode: 'auto', budget: { maxQuotesPerDay: 5, maxCashPerDay: 10000 }, decide: fakeDecide(soomgoQuote()) });
  assert.equal(r.action, 'sent');
  assert.equal(adapter.calls.quote[0].allowSpendCash, true);
  const [q] = s.ledger.listQuotes({ platform: 'soomgo' });
  assert.equal(q.costKRW, 3000);
  assert.equal(q.depositKRW, 250000);
});

test('a soomgo quote with an unknown cost is refused even with budget left', async () => {
  const s = setup('soomgo');
  const adapter = fakeAdapter({});
  const r = await processThread({ ...s, threadRef: { id: 'r1', kind: 'request' }, adapter, mode: 'auto', budget: { maxQuotesPerDay: 5, maxCashPerDay: 10000 }, decide: fakeDecide(soomgoQuote()) });
  assert.equal(adapter.calls.quote.length, 0);
  assert.match(r.reason, /cost was not read/);
});

test('an unsupported service goes to the operator instead of the customer', async () => {
  const s = setup();
  const adapter = fakeAdapter();
  const res = reply({ decision: { ...reply().decision, intent: 'unsupported', service: null, needsOperator: true, operatorReason: '세무 상담 요청' } });
  const r = await processThread({ ...s, threadRef: { id: 't1' }, adapter, mode: 'auto', decide: fakeDecide(res) });
  assert.equal(r.action, 'queued');
  assert.match(r.reason, /unsupported/);
  assert.equal(adapter.calls.send.length, 0);
});

test('a thread with an open approval is not decided again', async () => {
  const s = setup();
  const decide = fakeDecide(reply());
  await processThread({ ...s, threadRef: { id: 't1' }, adapter: fakeAdapter(), mode: 'draft', decide });
  const r = await processThread({ ...s, threadRef: { id: 't1' }, adapter: fakeAdapter(), mode: 'draft', decide });
  assert.equal(r.action, 'pending_approval');
  assert.equal(decide.threads.length, 1);
});

test('an approved draft is re-gated and sent once', async () => {
  const s = setup();
  await processThread({ ...s, threadRef: { id: 't1' }, adapter: fakeAdapter(), mode: 'draft', decide: fakeDecide(reply()) });
  const [a] = listApprovals(s.instance, { status: 'open' });
  resolveApproval(s.instance, a.id, { approve: true, editedText: '연락처는 010-1234-5678 입니다.' });
  const adapter = fakeAdapter();
  const r = await flushApprovals({ ...s, adapter });
  assert.deepEqual(r.map((x) => x.action), ['blocked']);
  assert.equal(adapter.calls.send.length, 0);
});
