import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { getApproval, listApprovals, queueApproval } from '../src/brain/approvals.mjs';
import { runPlatform } from '../src/supervisor/run.mjs';
import { tempDir } from './tmp.mjs';

// 숨고 spent the day's cash at 08:05 Seoul on 2026-10-26; every later request was still read, sent
// through the model and refused at send time into an operator approval, which only a manual approval
// with no budget check could send.
const DAY = 86_400_000;
const today = () => new Date();
const yesterday = () => new Date(Date.now() - DAY);
const tomorrow = () => new Date(Date.now() + DAY);
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

function makeInstance() {
  const dir = tempDir('fsw-budget-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.activeHours = { outbound: ['00:00', '00:00'] };
  config.platforms.soomgo = { ...config.platforms.soomgo, enabled: true, mode: 'auto', maxQuotesPerDay: 5, maxCashPerDay: 10000 };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

// A 숨고 request list: a request read once is no longer unread, and a quoted one leaves the list.
function fakeSoomgo(requests) {
  const calls = { readRequest: [], quote: [] };
  const read = new Set();
  const cost = (id) => requests.find((r) => r.id === id).cost;
  return {
    calls,
    login: async () => ({ loggedIn: true }),
    requests: async () => requests.filter((r) => !calls.quote.includes(r.id)).map((r) => ({ id: r.id, at: r.at, unread: !read.has(r.id) })),
    readRequest: async (id) => {
      read.add(id);
      calls.readRequest.push(id);
      return { id, title: '랜딩 페이지', text: '회사 소개 랜딩 페이지가 필요합니다.', quoteCostKRW: cost(id) };
    },
    quote: async (id, q) => {
      calls.quote.push(id);
      return { observed: true, text: q.text, cashSpentKRW: cost(id) };
    },
    stop: async () => {},
  };
}

const QUOTE = { amountKRW: 300000, deliveryDays: 7, scope: ['랜딩 페이지 1개'] };
const REPLY = '견적 드립니다. 구성과 일정을 알려 주세요.';

function quoteDecider() {
  const fn = async () => {
    fn.calls += 1;
    return {
      action: 'reply', modelCalls: 1,
      decision: { intent: 'quote_request', service: 'landing_page_web', language: 'ko', reply: REPLY, quote: QUOTE, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [] },
      item: { kind: 'quote' }, gate: { ok: true, violations: [], warnings: [] }, priceRow: { viable: true },
    };
  };
  fn.calls = 0;
  return fn;
}

// The day before today already spent spentYesterday KRW in one quote.
function setup(requests, spentYesterday) {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const seed = ledger.upsertThread({ platform: 'soomgo', externalId: 'seed', kind: 'request' });
  ledger.addQuote({ threadId: seed.id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: spentYesterday, at: yesterday().toISOString() });
  const adapter = fakeSoomgo(requests);
  const decide = quoteDecider();
  const tick = (now) => runPlatform('soomgo', { instance, ledger, now, priceTable: [], loadAdapter: async () => async () => adapter, decide });
  return { instance, ledger, adapter, decide, tick };
}

test('a request is neither read nor sent to the model while the day budget is spent, and is read on the next day', async () => {
  const s = setup([{ id: 'r1', at: minutesAgo(30), cost: 1990 }], 10000);
  const r1 = await s.tick(yesterday());
  assert.equal(r1.threads.budget, 1);
  const r1Row = () => s.ledger.listThreads({ platform: 'soomgo' }).find((t) => t.externalId === 'r1');
  assert.deepEqual([s.adapter.calls.readRequest.length, s.decide.calls, s.ledger.threadMessages(r1Row().id).length, r1Row().meta ?? null], [0, 0, 0, null]);
  assert.deepEqual(s.ledger.db.prepare("SELECT kind FROM events WHERE ref = 'r1'").all(), []);
  const r2 = await s.tick(today());
  assert.deepEqual([r2.threads.sent, s.adapter.calls.readRequest, s.adapter.calls.quote, s.decide.calls], [1, ['r1'], ['r1'], 1]);
});

test('a quote refused for the budget goes out the next day with no operator step, and only once', async () => {
  const s = setup([{ id: 'r2', at: minutesAgo(30), cost: 1990 }], 9000);
  const r1 = await s.tick(yesterday());
  assert.equal(r1.threads.deferred, 1);
  const [a] = listApprovals(s.instance, { status: 'open' });
  assert.deepEqual([a.deferredForBudget, s.adapter.calls.quote.length], [{ costKRW: 1990 }, 0]);
  const requests = join(s.instance.paths.operator, 'requests.md');
  assert.equal(existsSync(requests) && readFileSync(requests, 'utf8').includes(a.id), false);
  await s.tick(yesterday());
  assert.deepEqual([s.adapter.calls.quote.length, getApproval(s.instance, a.id).status], [0, 'open']);
  const r2 = await s.tick(today());
  assert.deepEqual([r2.approvalsSent, s.adapter.calls.quote, getApproval(s.instance, a.id).status], [1, ['r2'], 'sent']);
  assert.equal(s.ledger.listQuotes({ platform: 'soomgo' }).filter((q) => q.costKRW === 1990).length, 1);
  await s.tick(today());
  await s.tick(tomorrow());
  assert.deepEqual([s.adapter.calls.quote, s.decide.calls], [['r2'], 1]);
});

test('deferred quotes go out oldest first within the cap, and one the cap cannot pay stays deferred', async () => {
  const s = setup([{ id: 'r3', at: minutesAgo(40), cost: 5890 }, { id: 'r4', at: minutesAgo(30), cost: 5890 }], 9000);
  await s.tick(yesterday());
  assert.deepEqual([s.decide.calls, s.adapter.calls.quote.length], [2, 0]);
  const [first, second] = listApprovals(s.instance, { status: 'open' });
  const r2 = await s.tick(today());
  assert.deepEqual([r2.approvalsSent, s.adapter.calls.quote], [1, [first.threadRef]]);
  assert.deepEqual([getApproval(s.instance, first.id).status, getApproval(s.instance, second.id).status], ['sent', 'open']);
  await s.tick(today());
  assert.deepEqual([s.adapter.calls.quote, s.decide.calls, getApproval(s.instance, second.id).status], [[first.threadRef], 2, 'open']);
});

// 숨고 held a deferred lesson quote on 2026-10-26 when the operator took lessons back to answer himself.
test('a deferred quote for a service the instance stopped answering is left for the operator', async () => {
  const s = setup([{ id: 'r6', at: minutesAgo(30), cost: 1990 }], 0);
  const r6 = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'r6', kind: 'request' });
  const lesson = await queueApproval(s.instance, { platform: 'soomgo', threadRef: 'r6', threadId: r6.id, threadKind: 'request', kind: 'quote', reason: 'cash quote refused: daily cash budget spent (12000 + 1990 over 10000)', draft: REPLY, quote: QUOTE, service: 'lesson_tutoring', costKRW: 1990, deferredForBudget: { costKRW: 1990 }, item: { kind: 'quote' }, priceRow: { viable: true } });
  s.instance.config.platforms.soomgo.services = ['landing_page_web'];
  const r = await s.tick(today());
  assert.deepEqual([r.approvalsSent, s.adapter.calls.quote, getApproval(s.instance, lesson.id).status], [0, [], 'open']);
});

test('an approval refused for the budget before the marker existed is sent the next day the same way', async () => {
  const s = setup([{ id: 'r5', at: minutesAgo(30), cost: 4490 }], 0);
  const r5 = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'r5', kind: 'request' });
  const legacy = await queueApproval(s.instance, { platform: 'soomgo', threadRef: 'r5', threadId: r5.id, threadKind: 'request', kind: 'quote', reason: 'cash quote refused: daily cash budget spent (12000 + 4490 over 10000)', draft: REPLY, quote: QUOTE, service: 'landing_page_web', costKRW: 4490, item: { kind: 'quote' }, priceRow: { viable: true } });
  const r = await s.tick(today());
  assert.deepEqual([r.approvalsSent, s.adapter.calls.quote, s.decide.calls, getApproval(s.instance, legacy.id).status], [1, ['r5'], 0, 'sent']);
});

