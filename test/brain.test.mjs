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
  const quote = { amountKRW: 2000000, scope: ['3개 섹션'], deliveryDays: 7, priceType: 'fixed' };
  const codex = fakeCodex([decision({ intent: 'quote_request', quote, reply: '총 200만 원으로 진행 가능합니다.' }), decision({ intent: 'quote_request', quote: { ...quote, amountKRW: 600000 }, reply: '총 60만 원으로 진행 가능합니다.' })]);
  const r = await decide(thread([{ direction: 'in', text: '견적 부탁드립니다' }]), ctx(instance, 'kmong', codex, { priceTable: [row] }));
  assert.match(codex.calls[1].prompt, /price\.range/);
  assert.equal(r.action, 'reply');
  assert.equal(r.decision.quote.split.mechanism, 'reorder');
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
