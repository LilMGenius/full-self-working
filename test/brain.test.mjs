import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { answeredServices } from '../src/economics/catalog.mjs';
import { quoteFromRow } from '../src/economics/quote.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { gateOutbound } from '../src/policy/gate.mjs';
import { DECISION_SCHEMA, decide, matchSystemNotice, parseDecision } from '../src/brain/respond.mjs';
import { CodexError, runCodex } from '../src/brain/codex.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-brain-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}
const LESSONS_ON_SOOMGO = (c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, services: [...answeredServices(c, 'soomgo'), 'lesson_tutoring'] } } });

const decision = (over = {}) => ({
  intent: 'inquiry', service: 'landing_page_web', language: 'ko', reply: '안녕하세요. 원하시는 페이지 구성과 일정을 알려 주시면 견적을 드리겠습니다.',
  quote: null, needsOperator: false, operatorReason: null, confidence: 0.8, claimsUsed: [], statedBudgetKRW: null, ...over,
});

// A fake runCodex that answers from a queue and records every prompt and schema it saw.
function fakeCodex(answers) {
  const calls = [];
  const fn = async ({ prompt, schema }) => {
    calls.push({ prompt, schema });
    if (!answers.length) throw new Error('fake codex: no answer left');
    return { data: answers.shift(), durationMs: 1 };
  };
  fn.calls = calls;
  return fn;
}
const noCodex = async () => {
  throw new Error('the model must not be called');
};

const thread = (messages, over = {}) => ({ platform: 'kmong', externalId: 't1', kind: 'message', stage: 'pre_order', messages, ...over });
const ctx = (instance, platform, runCodex, over = {}) => ({ instance, descriptor: loadDescriptor(platform), priceTable: [], runCodex, playbook: '', lessons: [], lessonsRules: [], ...over });

test('a soomgo unread-quote notice is classified system without a model call', async () => {
  const instance = makeInstance();
  const t = thread([{ direction: 'out', text: '견적 보냈습니다' }, { direction: 'in', text: '고객이 48시간 동안 견적을 읽지 않아 숨고캐시를 돌려드렸어요.' }], { platform: 'soomgo' });
  const r = await decide(t, ctx(instance, 'soomgo', noCodex));
  assert.deepEqual([r.decision.intent, r.item, r.priceRow, r.modelCalls], ['system', null, null, 0]);
  assert.equal(matchSystemNotice(thread([{ direction: 'in', text: '견적을 읽었어요' }])), true);
});

test('a customer question after a notice still goes to the model and returns the 003 shape', async () => {
  const t = thread([{ direction: 'in', text: '견적을 읽었어요' }, { direction: 'in', text: '수정은 몇 번까지 되나요?' }]);
  assert.equal(matchSystemNotice(t), false);
  const codex = fakeCodex([decision({ reply: '수정은 2회까지 포함입니다.' })]);
  const r = await decide(t, ctx(makeInstance(), 'kmong', codex));
  assert.equal(codex.calls.length, 1);
  assert.deepEqual(Object.keys(r).sort(), ['decision', 'item', 'modelCalls', 'priceRow']);
  assert.equal(r.item.kind, 'message');
  assert.equal(r.item.text, '수정은 2회까지 포함입니다.');
  assert.deepEqual([r.item.costKRW, r.item.thread.kind, r.item.decision.intent], [0, 'message', 'inquiry']);
});

test('a draft blocked twice returns the second draft after two model calls, for authorize to gate again', async () => {
  const blocked = decision({ reply: '편하게 010-1234-5678 로 전화 주세요.' });
  const codex = fakeCodex([blocked, { ...blocked, reply: '연락처 010-1234-5678 로 문자 주세요.' }]);
  const r = await decide(thread([{ direction: 'in', text: '랜딩 페이지 제작 가능한가요?' }]), ctx(makeInstance(), 'kmong', codex));
  assert.equal(codex.calls.length, 2);
  assert.match(codex.calls[1].prompt, /contact\.phone/);
  assert.equal(r.modelCalls, 2);
  assert.equal(r.item.text, '연락처 010-1234-5678 로 문자 주세요.');
});

test('a retry that fixes the violation is planned as the reply', async () => {
  const codex = fakeCodex([decision({ reply: '편하게 010-1234-5678 로 전화 주세요.' }), decision({ reply: '크몽 메시지로 편하게 말씀 주세요.' })]);
  const r = await decide(thread([{ direction: 'in', text: '랜딩 페이지 제작 가능한가요?' }]), ctx(makeInstance(), 'kmong', codex));
  assert.equal(r.decision.reply, '크몽 메시지로 편하게 말씀 주세요.');
  assert.equal(r.modelCalls, 2);
});

test('a kmong fixed quote is priced from the price row base times complexity and clamped', async () => {
  const row = { platform: 'kmong', service: 'landing_page_web', baseKRW: 300000, floorKRW: 200000, ceilingKRW: 900000, viable: true };
  const quote = { amountKRW: 999000, scope: ['3개 섹션'], deliveryDays: 7, priceType: 'fixed', complexity: 1.2 };
  const codex = fakeCodex([decision({ intent: 'quote_request', quote, reply: '요청하신 3개 섹션으로 진행 가능합니다.' })]);
  const r = await decide(thread([{ direction: 'in', text: '견적 부탁드립니다' }]), ctx(makeInstance(), 'kmong', codex, { priceTable: [row] }));
  assert.equal(r.decision.quote.amountKRW, 360000);
  assert.equal(r.decision.quote.pricing.source, 'price-row');
  assert.equal(r.decision.quote.split.mechanism, 'reorder');
  assert.equal(r.priceRow, row);
  assert.equal(quoteFromRow({ row, complexity: 0.6 }).amountKRW, 200000);
  assert.equal(quoteFromRow({ row: { ...row, ceilingKRW: 320000 }, complexity: 1.6 }).amountKRW, 320000);
  assert.throws(() => quoteFromRow({ row: {}, complexity: 1 }), { code: 'FSW_PRICE_ROW_MISSING' });
  assert.throws(() => quoteFromRow({ row, complexity: 2 }), RangeError);
  const hourly = fakeCodex([decision({ intent: 'quote_request', quote: { ...quote, priceType: 'hourly', amountKRW: 250000 }, reply: '시간 단위로 진행합니다.' })]);
  const h = await decide(thread([{ direction: 'in', text: '견적 부탁드립니다' }]), ctx(makeInstance(), 'kmong', hourly, { priceTable: [row] }));
  assert.deepEqual([h.decision.quote.amountKRW, h.decision.quote.pricing], [250000, { source: 'model', reason: 'hourly quote' }]);
});

test('a request quote on a price-guide platform is priced from the guide and the model complexity', async () => {
  const row = { platform: 'soomgo', service: 'landing_page_web', baseKRW: 500000, floorKRW: 100000, ceilingKRW: 2500000, costFloorKRW: 48000, viable: true, basis: { source: 'price-guide', p25: 100000, median: 500000, high: 2500000 } };
  const asked = { amountKRW: 9999999, scope: ['5개 섹션', '문의 폼'], deliveryDays: 10, priceType: 'fixed', complexity: 1.2 };
  const codex = fakeCodex([decision({ intent: 'quote_request', quote: asked, reply: '요청하신 5개 섹션과 문의 폼을 포함해 진행합니다. 결제는 착수금과 잔금으로 나누어 받습니다.' })]);
  const t = thread([{ direction: 'in', text: '웹 디자인\n랜딩 페이지 5개 섹션과 문의 폼이 필요합니다.' }], { platform: 'soomgo', kind: 'request', quoteCostKRW: 1990, serviceLabel: '웹 디자인' });
  const r = await decide(t, ctx(makeInstance(), 'soomgo', codex, { priceTable: [row] }));
  assert.equal(r.decision.quote.amountKRW, 600000);
  assert.deepEqual([r.decision.quote.pricing.guideAvg, r.decision.quote.pricing.complexity], [500000, 1.2]);
  assert.match(codex.calls[0].prompt, /This is a buyer request/);
  assert.equal(r.decision.quote.split.parts.length, 2);
  assert.deepEqual([r.item.kind, r.item.costKRW, r.item.serviceLabel, r.item.thread.kind], ['quote', 1990, '웹 디자인', 'request']);
});

test('a request quote moves toward the budget the buyer stated without leaving the guide', async () => {
  const instance = makeInstance();
  const row = { platform: 'soomgo', service: 'landing_page_web', baseKRW: 500000, floorKRW: 100000, ceilingKRW: 2500000, costFloorKRW: 48000, viable: true, basis: { source: 'price-guide', p25: 100000, median: 500000, high: 2500000 } };
  const quote = { amountKRW: 1, scope: ['5페이지 회사 소개 사이트', '문의 폼'], deliveryDays: 14, priceType: 'fixed', complexity: 1 };
  const priced = async (budget) => {
    const codex = fakeCodex([decision({ intent: 'quote_request', quote, reply: '요청하신 구성으로 진행합니다. 결제는 착수금과 잔금으로 나누어 받습니다.' })]);
    const t = thread([{ direction: 'in', text: '웹 개발\n예산: 예시' }], { platform: 'soomgo', kind: 'request', quoteCostKRW: 1990, budget });
    return (await decide(t, ctx(instance, 'soomgo', codex, { priceTable: [row] }))).decision.quote.amountKRW;
  };
  assert.equal(await priced({ minKRW: 1000000, maxKRW: 2000000 }), 1000000);
  assert.equal(await priced({ minKRW: 5000000, maxKRW: null }), 2500000);
  assert.equal(await priced({ minKRW: null, maxKRW: 300000 }), 300000);
  assert.equal(await priced({ minKRW: null, maxKRW: 20000 }), 100000);
  assert.equal(await priced(null), 500000);
});

test('a quote with no amount is blocked by the gate before any send', () => {
  const g = gateOutbound({ platform: 'soomgo', kind: 'quote', text: '요청하신 범위로 진행합니다.' }, { descriptor: loadDescriptor('soomgo'), instance: makeInstance() });
  assert.equal(g.ok, false);
  assert.ok(g.violations.some((v) => v.rule === 'price.missing'));
});

test('a model answer naming a service outside the catalog is rejected', () => {
  assert.throws(() => parseDecision(decision({ service: 'rocket_science' }), ['landing_page_web']), { code: 'FSW_BRAIN_BAD_DECISION' });
});

test('a decision carries statedBudgetKRW, and one without it parses as null', () => {
  const ids = ['landing_page_web'];
  assert.equal(parseDecision(decision({ statedBudgetKRW: 30000 }), ids).statedBudgetKRW, 30000);
  const { statedBudgetKRW, ...older } = decision();
  assert.equal(parseDecision(older, ids).statedBudgetKRW, null);
  assert.throws(() => parseDecision(decision({ statedBudgetKRW: 0 }), ids), { code: 'FSW_BRAIN_BAD_DECISION' });
  assert.throws(() => parseDecision(decision({ statedBudgetKRW: '3만' }), ids), { code: 'FSW_BRAIN_BAD_DECISION' });
  assert.ok(DECISION_SCHEMA(ids).required.includes('statedBudgetKRW'));
});

test('the model sees only the services and price rows the instance answers on the platform', async () => {
  const row = (service) => ({ platform: 'soomgo', service, packages: { standard: 40000, deluxe: 88000, premium: 160000 }, floorKRW: 35000, ceilingKRW: 160000, viable: true });
  const priceTable = [row('landing_page_web'), row('lesson_tutoring')];
  const t = { platform: 'soomgo', externalId: 'c1', kind: 'message', stage: 'pre_order', messages: [{ direction: 'in', text: '문의드립니다' }] };
  const lesson = () => fakeCodex([decision({ service: 'lesson_tutoring', reply: '원하시는 요일과 시간을 알려 주세요.' })]);
  const off = lesson();
  await decide(t, ctx(makeInstance(), 'soomgo', off, { priceTable })).catch(() => {});
  assert.doesNotMatch(off.calls[0].prompt, /lesson_tutoring/);
  assert.ok(!off.calls[0].schema.properties.service.enum.includes('lesson_tutoring'));
  const on = lesson();
  await decide(t, ctx(makeInstance(LESSONS_ON_SOOMGO), 'soomgo', on, { priceTable }));
  assert.match(on.calls[0].prompt, /- lesson_tutoring \(과외 및 레슨\): standard 40000/);
  assert.ok(on.calls[0].schema.properties.service.enum.includes('lesson_tutoring'));
});

test('the decision prompt lists the operator-delivered services it answers and asks deliveryDays of at least 1', async () => {
  const codex = fakeCodex([decision({ service: null, reply: null })]);
  const t = thread([{ direction: 'in', text: '파이썬 기초를 배우고 싶습니다.' }], { platform: 'soomgo', kind: 'request' });
  await decide(t, ctx(makeInstance(LESSONS_ON_SOOMGO), 'soomgo', codex));
  const prompt = codex.calls[0].prompt;
  assert.match(prompt, /# Services I deliver myself/);
  assert.match(prompt, /- lesson_tutoring \(과외 및 레슨\): 60-minute sessions; ask the subject/);
  assert.match(prompt, /at least 1/);
  assert.match(prompt, /Set statedBudgetKRW to the budget the customer states/);
});

test('runCodex throws with the exit code when the process fails', async () => {
  await assert.rejects(
    runCodex({ prompt: 'x', schema: { type: 'object' }, bin: process.execPath, timeoutMs: 20000 }),
    (err) => err instanceof CodexError && err.code === 'FSW_CODEX_EXIT' && err.exitCode !== 0 && err.stderrTail.length > 0,
  );
});
