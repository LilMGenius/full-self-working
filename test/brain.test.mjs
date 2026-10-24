import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { decide, matchSystemNotice, parseDecision } from '../src/brain/respond.mjs';
import { CodexError, runCodex } from '../src/brain/codex.mjs';
import { listApprovals, queueApproval, resolveApproval } from '../src/brain/approvals.mjs';
import { caseFromApproval, recordOutcome } from '../src/learning/outcomes.mjs';
import { writeLessons } from '../src/learning/lessons.mjs';
import { refreshPlaybook, validatePattern } from '../src/learning/playbook.mjs';

function makeInstance() {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-brain-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

const decision = (over = {}) => ({
  intent: 'inquiry', service: 'landing_page_web', language: 'ko', reply: '안녕하세요. 원하시는 페이지 구성과 일정을 알려 주시면 견적을 드리겠습니다.',
  quote: null, needsOperator: false, operatorReason: null, confidence: 0.8, claimsUsed: [], ...over,
});

// A fake runCodex that answers from a queue and records every prompt it saw.
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
  assert.equal(r.decision.intent, 'system');
  assert.equal(r.action, 'none');
  assert.equal(r.modelCalls, 0);
  assert.equal(matchSystemNotice(thread([{ direction: 'in', text: '견적을 읽었어요' }])), true);
});

test('a customer question after a notice still goes to the model', async () => {
  const t = thread([{ direction: 'in', text: '견적을 읽었어요' }, { direction: 'in', text: '수정은 몇 번까지 되나요?' }]);
  assert.equal(matchSystemNotice(t), false);
  const instance = makeInstance();
  const codex = fakeCodex([decision({ reply: '수정은 2회까지 포함입니다.' })]);
  const r = await decide(t, ctx(instance, 'kmong', codex));
  assert.equal(codex.calls.length, 1);
  assert.equal(r.action, 'reply');
});

test('a gate-blocked draft is retried once with its violations, then becomes an approval', async () => {
  const instance = makeInstance();
  const blocked = decision({ reply: '편하게 010-1234-5678 로 전화 주세요.' });
  const codex = fakeCodex([blocked, { ...blocked }]);
  const t = thread([{ direction: 'in', text: '랜딩 페이지 제작 가능한가요?' }]);
  const r = await decide(t, ctx(instance, 'kmong', codex));
  assert.equal(codex.calls.length, 2);
  assert.match(codex.calls[1].prompt, /contact\.phone/);
  assert.equal(r.action, 'approval');
  assert.ok(r.violations.some((v) => v.rule === 'contact.phone'));
});

test('a retry that fixes the violation is sent as a reply', async () => {
  const instance = makeInstance();
  const codex = fakeCodex([decision({ reply: '편하게 010-1234-5678 로 전화 주세요.' }), decision({ reply: '크몽 메시지로 편하게 말씀 주세요.' })]);
  const r = await decide(thread([{ direction: 'in', text: '랜딩 페이지 제작 가능한가요?' }]), ctx(instance, 'kmong', codex));
  assert.equal(r.action, 'reply');
  assert.equal(r.decision.reply, '크몽 메시지로 편하게 말씀 주세요.');
});

test('a quote gets the platform split from economics and is gated against the price row', async () => {
  const instance = makeInstance();
  const row = { platform: 'kmong', service: 'landing_page_web', baseKRW: 300000, packages: { standard: 300000, deluxe: 660000, premium: 1200000 }, floorKRW: 200000, ceilingKRW: 1500000, viable: true };
  const quote = { amountKRW: 2000000, scope: ['3개 섹션'], deliveryDays: 7, priceType: 'fixed', complexity: 1 };
  const codex = fakeCodex([decision({ intent: 'quote_request', quote, reply: '총 200만 원으로 진행 가능합니다.' }), decision({ intent: 'quote_request', quote: { ...quote, amountKRW: 600000 }, reply: '총 60만 원으로 진행 가능합니다.' })]);
  const r = await decide(thread([{ direction: 'in', text: '견적 부탁드립니다' }]), ctx(instance, 'kmong', codex, { priceTable: [row] }));
  assert.match(codex.calls[1].prompt, /price\.range/);
  assert.equal(r.action, 'reply');
  assert.equal(r.decision.quote.split.mechanism, 'reorder');
});

test('a request quote on a price-guide platform is priced from the guide and the model complexity', async () => {
  const instance = makeInstance();
  const row = { platform: 'soomgo', service: 'landing_page_web', baseKRW: 500000, floorKRW: 100000, ceilingKRW: 2500000, costFloorKRW: 48000, viable: true, basis: { source: 'price-guide', p25: 100000, median: 500000, high: 2500000 } };
  const asked = { amountKRW: 9999999, scope: ['5개 섹션', '문의 폼'], deliveryDays: 10, priceType: 'fixed', complexity: 1.2 };
  const codex = fakeCodex([decision({ intent: 'quote_request', quote: asked, reply: '요청하신 5개 섹션과 문의 폼을 포함해 진행합니다. 결제는 착수금과 잔금으로 나누어 받습니다.' })]);
  const t = thread([{ direction: 'in', text: '웹 디자인\n랜딩 페이지 5개 섹션과 문의 폼이 필요합니다.' }], { platform: 'soomgo', kind: 'request', quoteCostKRW: 1990 });
  const r = await decide(t, ctx(instance, 'soomgo', codex, { priceTable: [row] }));
  assert.equal(r.action, 'reply');
  assert.equal(r.decision.quote.amountKRW, 600000);
  assert.deepEqual([r.decision.quote.pricing.guideAvg, r.decision.quote.pricing.complexity], [500000, 1.2]);
  assert.match(codex.calls[0].prompt, /This is a buyer request/);
  assert.equal(r.decision.quote.split.parts.length, 2);
});

test('a quote with no amount is blocked before any send', async () => {
  const { gateOutbound } = await import('../src/policy/gate.mjs');
  const g = gateOutbound({ platform: 'soomgo', kind: 'quote', text: '요청하신 범위로 진행합니다.' }, { descriptor: loadDescriptor('soomgo'), instance: makeInstance() });
  assert.equal(g.ok, false);
  assert.ok(g.violations.some((v) => v.rule === 'price.missing'));
});

test('a model answer naming a service outside the catalog is rejected', () => {
  assert.throws(() => parseDecision(decision({ service: 'rocket_science' }), ['landing_page_web']), { code: 'FSW_BRAIN_BAD_DECISION' });
});

test('runCodex throws with the exit code when the process fails', async () => {
  await assert.rejects(
    runCodex({ prompt: 'x', schema: { type: 'object' }, bin: process.execPath, timeoutMs: 20000 }),
    (err) => err instanceof CodexError && err.code === 'FSW_CODEX_EXIT' && err.exitCode !== 0 && err.stderrTail.length > 0,
  );
});

test('approvals are queued as files and resolved once', async () => {
  const instance = makeInstance();
  const a = await queueApproval(instance, { platform: 'kmong', threadRef: 't1', kind: 'message', reason: 'draft mode', draft: '안녕하세요' });
  assert.equal(listApprovals(instance, { status: 'open' }).length, 1);
  const done = resolveApproval(instance, a.id, { approve: true, editedText: '안녕하세요. 반갑습니다.' });
  assert.equal(done.finalText, '안녕하세요. 반갑습니다.');
  assert.equal(done.edited, true);
  assert.throws(() => resolveApproval(instance, a.id, { approve: false }), /already approved/);
});

test('a generated regex that does not match its own case is not written to gate-rules.json', async () => {
  const instance = makeInstance();
  const c1 = recordOutcome(instance, null, { kind: 'approval_rejected', platform: 'kmong', text: '오픈채팅으로 오시면 더 빨리 답드려요' });
  const c2 = recordOutcome(instance, null, { kind: 'operator_correction', platform: 'kmong', text: '최저가 보장해 드립니다', before: '최저가 보장해 드립니다', after: '범위 안에서 맞춰 드리겠습니다' });
  const codex = fakeCodex([
    { lessons: [
      { class: 'chat_link_lure', rule: 'Never invite the customer to an outside chat.', evidence: [c1.id], gate: 'regex', pattern: '텔레그램\\s*방', appliesTo: ['all'] },
      { class: 'price_guarantee', rule: 'Never promise the lowest price.', evidence: [c2.id], gate: 'regex', pattern: '최저가\\s*보장', appliesTo: ['all'] },
    ] },
    { playbook: '## 대화\n\n- 외부 채팅으로 안내하지 않습니다.\n' },
  ]);
  const w = await writeLessons(instance, { runCodex: codex });
  assert.equal(w.lessons.length, 2);
  const r = await refreshPlaybook(instance, { runCodex: codex });
  assert.deepEqual(r.rules.map((x) => x.id), ['price_guarantee']);
  assert.deepEqual(r.rejected.map((x) => [x.class, x.reason]), [['chat_link_lure', 'does not match the case text it came from']]);
  const onDisk = JSON.parse(readFileSync(join(instance.paths.lessons, 'gate-rules.json'), 'utf8'));
  assert.deepEqual(onDisk.map((x) => x.id), ['price_guarantee']);
  assert.match(codex.calls[1].prompt, /Never invite the customer to an outside chat/);
  assert.equal(readFileSync(join(instance.paths.lessons, 'playbook.md'), 'utf8'), '## 대화\n\n- 외부 채팅으로 안내하지 않습니다.\n');
});

test('catastrophic or over-broad patterns are refused before they reach the gate', () => {
  const ev = [{ kind: 'approval_rejected', text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!' }];
  assert.equal(validatePattern({ pattern: '(a+)+!' }, ev).reason, 'nested quantifier');
  assert.equal(validatePattern({ pattern: 'a{1,}'.repeat(60) }, ev).ok, false);
  assert.equal(validatePattern({ pattern: '(' }, ev).ok, false);
  assert.equal(validatePattern({ pattern: '.' }, ev).reason, 'matches an ordinary polite reply');
  assert.equal(validatePattern({ pattern: 'a{20}!' }, ev).ok, true);
});

test('writeLessons learns each case once', async () => {
  const instance = makeInstance();
  recordOutcome(instance, null, { kind: 'lead_lost', platform: 'soomgo', text: '다른 분과 진행하기로 했어요', note: 'no reply for 3 hours' });
  const codex = fakeCodex([{ lessons: [{ class: 'slow_first_reply', rule: 'Answer a new request within the hour.', evidence: [], gate: 'judgment', pattern: null, appliesTo: ['soomgo'] }] }]);
  assert.equal((await writeLessons(instance, { runCodex: codex })).newCases, 1);
  const again = await writeLessons(instance, { runCodex: noCodex });
  assert.equal(again.changed, false);
  assert.equal(codex.calls.length, 1);
});

test('a rejected approval and an edited approval become cases', async () => {
  const instance = makeInstance();
  const a = await queueApproval(instance, { platform: 'kmong', threadRef: 't9', kind: 'message', reason: 'draft mode', draft: '바로 시작할게요' });
  const rejected = resolveApproval(instance, a.id, { approve: false, reason: 'scope not agreed' });
  assert.equal(caseFromApproval(rejected).kind, 'approval_rejected');
  const b = await queueApproval(instance, { platform: 'kmong', threadRef: 't10', kind: 'message', reason: 'draft mode', draft: '바로 시작할게요' });
  assert.equal(caseFromApproval(resolveApproval(instance, b.id, { approve: true, editedText: '범위를 먼저 정하고 시작하겠습니다.' })).kind, 'operator_correction');
});
