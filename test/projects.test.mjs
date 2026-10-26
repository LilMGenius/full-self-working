// 크몽 엔터프라이즈 proposals: the daily quota, the send policy, the plan check, the gate, the hourly job that
// plans outbox rows, and the kmong drain that sends them through Surface.propose.
// Every project here is synthetic; real project text never enters the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { assertSendable, CONFIRM_LABELS, pageConfirm, parseProjectDetail, parseProjectRow, planForm, proposalDays, readbackProblems, REQUESTED_HEADING } from '../src/platforms/kmong/projects.mjs';
import { checkPlan, composeText, draftProposal, minimumKRW, proposalPolicy, proposalsLeft, sendDecision } from '../src/projects/draft.mjs';
import { rememberJudgement } from '../src/projects/score.mjs';
import { expireProposals, nextStep, planProposal, projectsJob, readJobState, reviseApproval, syncProposals } from '../src/projects/job.mjs';
import { setStatus } from '../src/outbox/index.mjs';
import { step } from '../src/loop/index.mjs';
import { AdapterRefusal } from '../src/platforms/kit.mjs';
import { readCases } from '../src/learning/outcomes.mjs';
import { scriptedSurface } from './helpers/surface.mjs';
import { tempDir } from './tmp.mjs';

const descriptor = loadDescriptor('kmong');
const NOW = new Date('2026-10-25T03:00:00Z'); // 12:00 Seoul, inside the outbound hours

function makeInstance(proposals = { maxPerDay: 5, minFit: 'strong', autoMaxKRW: 0 }) {
  const dir = tempDir('fsw-projects-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms.kmong.proposals = proposals;
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const instance = loadInstance({ dir });
  instance.profile.serviceFit = { web_app_dev: { strength: 'strong', evidence: ['x'] }, landing_page_web: { strength: 'some', evidence: ['x'] }, ai_automation_chatbot: { strength: 'strong', evidence: ['x'] }, thumbnail_banner: { strength: 'none', evidence: [] } };
  return instance;
}

const row = (over = {}) => ({
  id: 900001, title: '사내 업무 관리 웹 시스템 구축', content: '관리자 화면과 회원 로그인이 있는 웹 시스템을 만들고자 합니다.\n\n' + REQUESTED_HEADING + '\n비슷한 구축 사례\n단계별 견적', amount: 20000000,
  deadline: 5, status: 'APPROVAL', project_type: 'OUTSOURCING', business_type: 'COMPANY', is_tax: true, is_government: false, days: 90, proposal_count: 3,
  category: { cat1: 6, cat1_name: 'IT', cat2: 42, cat2_name: '웹사이트 개발' }, ...over,
});
const project = (over = {}, now = NOW) => parseProjectRow(row(over), { now });
const ctxFor = (instance, extra = {}) => ({ profile: instance.profile, config: instance.config, descriptor, allocation: null, now: NOW, ...extra });

test('the quota never goes past the page counter or maxPerDay', () => {
  const policy = proposalPolicy({ platforms: { kmong: { proposals: { maxPerDay: 5, minFit: 'strong', autoMaxKRW: 0 } } } });
  assert.equal(proposalsLeft({ policy, pageQuota: 5, usedToday: 0 }), 5);
  assert.equal(proposalsLeft({ policy, pageQuota: 2, usedToday: 0 }), 2);
  assert.equal(proposalsLeft({ policy, pageQuota: 5, usedToday: 4 }), 1);
  assert.equal(proposalsLeft({ policy, pageQuota: 5, usedToday: 7 }), 0);
  assert.equal(proposalsLeft({ policy, pageQuota: null, usedToday: 0 }), 0);
  assert.throws(() => proposalPolicy({ platforms: { kmong: {} } }), /proposals/);
  assert.throws(() => proposalPolicy({ platforms: { kmong: { proposals: { maxPerDay: 5, minFit: 'any', autoMaxKRW: 0 } } } }), /minFit/);
});

test('only a strong, small, critic-approved draft in auto mode inside the hours is sent', () => {
  const policy = { autoMaxKRW: 10000000, minCriticScore: 0.75 };
  const base = { policy, mode: 'auto', sendingHours: true, fit: 'strong', totalKRW: 9000000, critic: { pass: true, score: 0.9 } };
  assert.equal(sendDecision(base).action, 'send');
  assert.match(sendDecision({ ...base, totalKRW: 12000000 }).reason, /above autoMaxKRW/);
  assert.match(sendDecision({ ...base, critic: { pass: false, score: 0.5, problems: ['vague'] } }).reason, /critic score 0.5/);
  assert.match(sendDecision({ ...base, critic: { pass: false, error: 'FSW_CODEX_EXIT: down' } }).reason, /critic failed/);
  assert.match(sendDecision({ ...base, fit: 'some' }).reason, /fit is some/);
  assert.match(sendDecision({ ...base, mode: 'draft' }).reason, /mode is draft/);
  assert.match(sendDecision({ ...base, sendingHours: false }).reason, /outbound hours/);
  assert.equal(sendDecision({ ...base, policy: { ...policy, autoMaxKRW: 0 } }).action, 'approval');
});

const parts = (over = {}) => ({
  need: '사내 업무를 한곳에서 관리할 웹 시스템이 필요하신 것으로 이해했습니다.',
  answers: [{ item: '비슷한 구축 사례', answer: '관리자 화면이 있는 웹 서비스를 만든 경험을 바탕으로 설명드립니다.' }, { item: '단계별 견적', answer: '아래 진행 계획에 단계별 금액을 적었습니다.' }],
  phases: [
    { title: '설계와 화면 시안', deliverables: ['설계 문서'], startDate: '2026-11-02', endDate: '2026-11-20', priceKRW: 4000000, pilot: false },
    { title: '개발과 납품', deliverables: ['웹 시스템', '운영 안내'], startDate: '2026-11-23', endDate: '2027-01-15', priceKRW: 10000000, pilot: false },
  ],
  terms: '합계는 부가세 포함 금액이며 전자세금계산서를 발행합니다. 범위 밖 추가 작업은 사전에 견적을 드립니다.',
  aiNote: '제작에는 AI 도구를 쓰고, 모든 결과물은 제가 직접 검토한 뒤 납품합니다.',
  closing: '사용자 수와 기존 데이터 형식을 알려 주시면 일정을 확정하겠습니다.',
  claimsUsed: [],
  ...over,
});

test('the plan check holds the budget, the floor, the dates, every item and a requested pilot', () => {
  const p = parseProjectDetail({ id: 1, title: 't', description: row().content, amount: 20000000, deadline: 5, status: 'APPROVAL', projectType: 'OUTSOURCING', answers: [{ title: '프로젝트 종료 예정일', type: 'TEXT', description: '2027-01-31' }] }, { now: NOW });
  assert.deepEqual(checkPlan(parts(), p, { floorKRW: 1000000, now: NOW }).violations, []);
  const rules = (x, opts = {}) => checkPlan(x, { ...p, ...opts }, { floorKRW: 1000000, now: NOW }).violations.map((v) => v.rule);
  assert.deepEqual(rules(parts({ answers: parts().answers.slice(0, 1) })), ['plan.answers']);
  assert.deepEqual(rules(parts(), { amountKRW: 10000000 }), ['plan.budget']);
  assert.deepEqual(checkPlan(parts(), p, { floorKRW: 20000000, now: NOW }).violations.map((v) => v.rule), ['plan.floor']);
  assert.ok(rules(parts({ phases: [{ ...parts().phases[0], startDate: '2026-10-01' }, parts().phases[1]] })).includes('plan.dates'));
  assert.ok(rules(parts({ phases: [parts().phases[0], { ...parts().phases[1], endDate: '2027-03-01' }] })).includes('plan.dates'));
  assert.deepEqual(rules(parts(), { description: '주력 데이터로 시범 구축 후 확장합니다' }), ['plan.pilot']);
  assert.deepEqual(rules(parts({ aiNote: '사람이 검토합니다' })), ['plan.ai_note']);
  const text = composeText(parts());
  assert.match(text, /합계 14,000,000원/);
  assert.match(text, /1\. 비슷한 구축 사례/);
});

test('a gate-blocked draft is retried once and never reaches the form, and no contact detail does', async () => {
  const instance = makeInstance();
  const p = parseProjectDetail({ id: 1, title: 't', description: row().content, amount: 20000000, deadline: 5, status: 'APPROVAL', projectType: 'OUTSOURCING', answers: [] }, { now: NOW });
  const leaky = parts({ closing: '자세한 내용은 010-1234-5678 로 연락 주세요.' });
  const calls = [];
  const runCodex = async ({ prompt }) => (calls.push(prompt), { data: leaky });
  const d = await draftProposal(p, { instance, descriptor, service: 'web_app_dev', floorKRW: 1000000, runCodex, lessonsRules: [], now: NOW });
  assert.equal(d.ok, false);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /contact\.phone/);
  assert.throws(() => assertSendable(d.proposal, d.gate), /gate passed/);
  assert.throws(() => assertSendable(d.proposal, { ok: true }), /contact\.phone/);
  assert.throws(() => assertSendable({ text: '메일 a@b.co 로', totalKRW: 1 }, { ok: true }), /contact\.email/);
  assert.doesNotThrow(() => assertSendable({ text: composeText(parts()), totalKRW: 14000000 }, { ok: true }));
  const form = { fields: [{ ref: 'field-0', tag: 'TEXTAREA', maxLength: 50, required: true, label: '제안 내용' }, { ref: 'field-1', tag: 'INPUT', type: 'file', required: true, label: '제안서', accept: '.pdf' }] };
  assert.deepEqual(planForm(form, { text: 'x'.repeat(60), totalKRW: 1 }).problems, ['the proposal has 60 characters and the field takes 50', 'required attachment 제안서 (.pdf)']);
});

// A job pass against fakes: the reader and the seller's quota for the job, and a scripted kmong surface whose
// propose the outbox drain calls, so a test sees what reached the form and how often.
function fakeSurfaces(projects, { quota = 5, propose } = {}) {
  const proposed = [];
  const reader = {
    listProjects: async () => ({ projects }),
    readProject: async (id) => projects.find((p) => p.id === id),
    close: async () => {},
  };
  const seller = {
    quota: async () => quota - proposed.length,
    proposals: async () => ({ quota, found: [] }),
    stop: async () => {},
  };
  const surface = scriptedSurface({
    methods: ['propose'],
    receipts: {
      propose: propose ?? ((ref, args) => {
        assert.ok(args.text && args.amountKRW > 0, 'the drain passes the row text and amount');
        proposed.push(Number(String(ref).replace('project:', '')));
        return { observed: true, snippet: '응답 대기중' };
      }),
    },
  });
  const notes = [];
  // One kmong tick: the loop step with nothing listed, so only the outbox drain acts.
  const drain = (instance, ledger, now) => step('kmong', { instance, ledger, now, priceTable: [], openSurface: async () => surface, notify: async (_i, n) => (notes.push(n), { written: true }) });
  return { reader, seller, surface, proposed, notes, drain, openReader: async () => reader, openSeller: async () => seller };
}

const goodCodex = (critic = { score: 0.9, needRestated: true, everyItemAnswered: true, claimsBacked: true, pricePlausible: true, problems: [] }) =>
  async ({ schema }) => ({ data: schema.required.includes('score') ? critic : parts() });
const proposalRows = (ledger) => ledger.listOutbox({ kinds: ['proposal'] });
const kinds = (ledger, kind) => ledger.db.prepare('SELECT ref, payload, at FROM events WHERE kind = ? ORDER BY id').all(kind);

test('the job plans within the quota, the drain sends, and each project is proposed once', async () => {
  const instance = makeInstance({ maxPerDay: 2, minFit: 'strong', autoMaxKRW: 15000000 });
  const ledger = openLedger(':memory:');
  // Budgets where the 14,000,000 KRW plan stays above the 70% the form takes.
  const many = [1, 2, 3].map((id) => project({ id, title: '웹 시스템 ' + id, amount: 19000000 + id }));
  const f = fakeSurfaces(many);
  const job = (now) => projectsJob({ instance, ledger, now, openReader: f.openReader, openSeller: f.openSeller, runCodex: goodCodex() });
  const r1 = await job(NOW);
  assert.equal(r1.planned.length, 2, JSON.stringify(r1));
  assert.deepEqual(proposalRows(ledger).map((r) => [r.status, r.payload.decision.needsOperator]), [['planned', false], ['planned', false]]);
  assert.equal(f.proposed.length, 0, 'the job itself never sends');
  await f.drain(instance, ledger, NOW);
  assert.deepEqual([f.proposed.length, proposalRows(ledger).map((r) => r.status)], [2, ['observed', 'observed']]);
  const r2 = await job(NOW);
  assert.equal(r2.synced.length, 2);
  assert.equal(r2.planned.length, 0, 'maxPerDay is spent for the day');
  assert.deepEqual(kinds(ledger, 'project.proposed').map((e) => e.at), [NOW.toISOString(), NOW.toISOString()]);
  // The next Seoul day counts only its own proposed events, which the job dates by its clock (1a952d1).
  const nextDay = new Date(NOW.getTime() + 86_400_000);
  await job(nextDay);
  await f.drain(instance, ledger, nextDay);
  assert.deepEqual([...f.proposed].sort(), [1, 2, 3]);
  assert.equal(new Set(f.proposed).size, f.proposed.length, 'no project proposed twice');
  ledger.close();
});

test('nextStep plans where it used to send, and no code path in the job sends', () => {
  const policy = { autoMaxKRW: 10000000, minCriticScore: 0.75 };
  const best = { ok: true, proposal: { totalKRW: 9000000 }, critic: { pass: true, score: 0.9 }, rewrites: 0 };
  assert.deepEqual(nextStep({ policy, mode: 'auto', sendingHours: true, verdict: { fit: 'strong' }, best }), { action: 'plan', reason: null });
  assert.equal(nextStep({ policy, mode: 'draft', sendingHours: true, verdict: { fit: 'strong' }, best }).action, 'queue');
  const job = readFileSync(new URL('../src/projects/job.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(job, /\.propose\(/);
});
// Drafts and critic verdicts in order; every prompt is kept so a test can read what the model was told.
function seqCodex(critics) {
  const prompts = { draft: [], critic: [] };
  let n = 0;
  const run = async ({ schema, prompt }) => {
    if (schema.required.includes('score')) {
      prompts.critic.push(prompt);
      return { data: critics[Math.min(n++, critics.length - 1)] };
    }
    prompts.draft.push(prompt);
    return { data: parts() };
  };
  return { run, prompts };
}
const verdict = (score, problems = []) => ({ score, needRestated: true, everyItemAnswered: score >= 0.75, claimsBacked: true, pricePlausible: true, problems });

test('a draft above autoMaxKRW is held for the operator with the critic verdict, and the drain asks once without proposing', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 1000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project()]);
  const r = await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: goodCodex() });
  assert.deepEqual([r.planned.length, r.queued.length, r.dropped.length], [0, 1, 0]);
  const [row] = proposalRows(ledger);
  assert.deepEqual([row.status, row.payload.decision.needsOperator, row.payload.critic.score], ['planned', true, 0.9]);
  assert.match(row.payload.summary, /^크몽 엔터프라이즈 제안 검토.*autoMaxKRW/);
  assert.equal(kinds(ledger, 'project.queued').length, 1);
  assert.equal(ledger.listThreads({ platform: 'kmong' }).find((t) => t.kind === 'project').status, 'queued');
  await f.drain(instance, ledger, NOW);
  const after = ledger.getOutbox(row.id);
  assert.equal(after.status, 'awaiting_operator');
  assert.match(after.approvalId, /-kmong-/);
  assert.equal(f.notes.filter((n) => n.kind === 'approval').length, 1);
  assert.equal(f.surface.count('propose'), 0);
  ledger.close();
});

test('a draft the critic keeps failing is rewritten twice with its problems, then dropped instead of waiting on the operator', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 50000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project()]);
  const codex = seqCodex([verdict(0.4, ['item 2 skipped'])]);
  const r = await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: codex.run });
  assert.deepEqual([r.planned.length, r.queued.length, r.dropped.length, proposalRows(ledger).length], [0, 0, 1, 0]);
  assert.deepEqual([codex.prompts.draft.length, codex.prompts.critic.length], [3, 3]);
  assert.doesNotMatch(codex.prompts.draft[0], /A reviewer scored/);
  for (const p of codex.prompts.draft.slice(1)) assert.match(p, /A reviewer scored your previous draft 0\.4 of 1[\s\S]*- item 2 skipped/);
  assert.match(r.dropped[0].reason, /critic score 0\.4 after 2 rewrites: item 2 skipped/);
  assert.equal(ledger.listThreads({ platform: 'kmong' }).find((t) => t.kind === 'project').status, 'dropped');
  assert.deepEqual(readCases(instance).map((c) => c.kind), ['lead_lost']);
  ledger.close();
});

test('a rewrite the critic passes is planned for the drain', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 50000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project()]);
  const codex = seqCodex([verdict(0.4, ['vague schedule']), verdict(0.85)]);
  const r = await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: codex.run });
  assert.deepEqual([r.planned.map((p) => p.id), r.dropped.length, codex.prompts.draft.length], [[900001], 0, 2]);
  ledger.close();
});

// A proposal row waiting for the operator, as the drain leaves it.
function waitingRow(ctx, { critic, text = 'old draft text', approvalId }) {
  const p = project();
  rememberJudgement(ctx.ledger, p, { keep: true, score: 1, service: 'web_app_dev', fit: 'strong', title: p.title }, NOW);
  const planned = planProposal(ctx, { project: p, verdict: { service: 'web_app_dev' }, proposal: { text, totalKRW: 14000000, phases: parts().phases, floorKRW: 1000000 }, critic, auto: false, reason: 'held' });
  setStatus(ctx.ledger, planned.outboxId, { from: 'planned', to: 'awaiting_operator', approvalId });
  return planned.outboxId;
}

test('a waiting proposal held only by a weak critic verdict is reworked from that verdict and rejected when it stays weak', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 50000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project()]);
  const ctx = { instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller };
  const weak = waitingRow(ctx, { critic: { pass: false, score: 0.3, problems: ['no past cases given'] }, approvalId: '20261025-kmong-aaaa0001' });
  const codex = seqCodex([verdict(0.5, ['still thin'])]);
  const r = await reviseApproval({ ...ctx, runCodex: codex.run }, '20261025-kmong-aaaa0001');
  assert.equal(r.action, 'dropped');
  assert.match(codex.prompts.draft[0], /scored your previous draft 0\.3 of 1[\s\S]*old draft text[\s\S]*- no past cases given/);
  assert.deepEqual([ledger.getOutbox(weak).status, f.proposed.length], ['rejected', 0]);
  assert.match(ledger.getOutbox(weak).reason, /^dropped: critic score 0\.5/);
  ledger.close();
});

test('a revised draft whose text changed replaces the waiting row, and one that did not keeps it', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 1000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project()]);
  const ctx = { instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller };
  const old = waitingRow(ctx, { critic: null, text: 'old', approvalId: '20261025-kmong-bbbb0002' });
  const r = await reviseApproval({ ...ctx, runCodex: goodCodex() }, '20261025-kmong-bbbb0002');
  assert.deepEqual([r.action, r.planned, ledger.getOutbox(old).status, ledger.getOutbox(old).reason], ['revised', 'queued', 'rejected', 'revised']);
  const fresh = ledger.getOutbox(r.outboxId);
  assert.deepEqual([fresh.status, fresh.payload.text === composeText(parts()), fresh.payload.critic.score, fresh.payload.decision.needsOperator], ['planned', true, 0.9, true]);
  setStatus(ledger, fresh.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261025-kmong-cccc0003' });
  const kept = await reviseApproval({ ...ctx, runCodex: goodCodex() }, '20261025-kmong-cccc0003');
  assert.deepEqual([kept.action, ledger.getOutbox(fresh.id).status], ['kept', 'awaiting_operator']);
  await assert.rejects(reviseApproval(ctx, '20261025-kmong-cccc0003x'), { code: 'FSW_APPROVAL_STATE' });
  ledger.close();
});

test('what the drain sent is carried onto the project thread once, and an unobserved send waits for readStatuses', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 50000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project({ id: 1 }), project({ id: 2, title: '두번째' })]);
  await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: goodCodex() });
  const [a, b] = proposalRows(ledger);
  setStatus(ledger, a.id, { from: 'planned', to: 'sending' });
  setStatus(ledger, a.id, { from: 'sending', to: 'observed', receipt: { observed: true, snippet: '응답 대기중' } });
  setStatus(ledger, b.id, { from: 'planned', to: 'sending' });
  setStatus(ledger, b.id, { from: 'sending', to: 'unobserved', reason: 'not on /seller/proposals' });
  const ctx = { instance, ledger, now: NOW };
  const synced = await syncProposals(ctx);
  assert.deepEqual(synced.map((s) => s.status), ['observed', 'unobserved']);
  const status = (id) => ledger.listThreads({ platform: 'kmong' }).find((t) => t.externalId === 'project:' + id).status;
  assert.deepEqual([status(a.payload.project.id), status(b.payload.project.id)], ['proposed', 'unobserved']);
  assert.equal(kinds(ledger, 'project.proposed').length, 1);
  assert.deepEqual(await syncProposals(ctx), []);
  assert.equal(kinds(ledger, 'project.proposed').length, 1);
  ledger.close();
});

test('a waiting proposal whose project closed goes stale before the drain reaches it', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 1000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project()]);
  await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: goodCodex() });
  const [row] = proposalRows(ledger);
  setStatus(ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261025-kmong-dddd0004' });
  setStatus(ledger, row.id, { from: 'awaiting_operator', to: 'approved' });
  const closed = { readProject: async () => ({ ...project(), status: 'CLOSED' }) };
  const out = await expireProposals({ instance, ledger, now: NOW }, { reader: closed });
  assert.deepEqual(out.map((o) => o.action), ['stale']);
  assert.equal(ledger.getOutbox(row.id).status, 'stale');
  await f.drain(instance, ledger, NOW);
  assert.equal(f.surface.count('propose'), 0);
  ledger.close();
});

test('outside the outbound hours the kmong tick sends no planned proposal', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 50000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project()]);
  await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: goodCodex() });
  await f.drain(instance, ledger, new Date('2026-10-24T22:30:00Z')); // 07:30 Seoul
  assert.deepEqual([proposalRows(ledger)[0].status, f.surface.count('propose')], ['planned', 0]);
  ledger.close();
});

test('a missing enterprise profile returns the row, and the next job remembers it for the day and drafts nothing', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 50000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project({ id: 1 }), project({ id: 2, title: '두번째' })], { propose: () => new AdapterRefusal('FSW_KMONG_ENTERPRISE_PROFILE', 'the enterprise profile is not registered') });
  const codex = goodCodex();
  await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: codex });
  const r = await f.drain(instance, ledger, NOW);
  assert.deepEqual(r.outbox, { deferred: 1 });
  assert.deepEqual(proposalRows(ledger).map((x) => x.status), ['planned', 'planned']);
  assert.equal(kinds(ledger, 'send.deferred').length, 1);
  // The drain dates its events by the wall clock; this tick ran at NOW.
  ledger.db.prepare("UPDATE events SET at = ? WHERE kind = 'send.deferred'").run(NOW.toISOString());
  const next = await projectsJob({ instance, ledger, now: new Date(NOW.getTime() + 3_600_000), openReader: f.openReader, openSeller: f.openSeller, runCodex: async () => assert.fail('no draft while the profile is missing') });
  assert.equal(readJobState(instance).enterpriseProfile.missing, true);
  assert.match(next.detail, /enterprise profile not registered/);
  assert.equal(readFileSync(join(instance.paths.operator, 'requests.md'), 'utf8').match(/엔터프라이즈 프로필 등록이 필요합니다/g).length, 1);
  ledger.close();
});

test('an interrupted proposal goes to the operator unread, and the job marks its project unobserved', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 50000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project()]);
  await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: goodCodex() });
  const [row] = proposalRows(ledger);
  setStatus(ledger, row.id, { from: 'planned', to: 'sending' });
  await f.drain(instance, ledger, NOW);
  assert.deepEqual([ledger.getOutbox(row.id).status, f.surface.count('read'), f.surface.count('propose')], ['unobserved', 0, 0]);
  assert.equal(f.notes.filter((n) => /was not observed/.test(n.title)).length, 1);
  await syncProposals({ instance, ledger, now: NOW });
  assert.equal(ledger.listThreads({ platform: 'kmong' }).find((t) => t.kind === 'project').status, 'unobserved');
  ledger.close();
});

test('the plan keeps to the least the platform form takes for the budget', () => {
  assert.equal(minimumKRW({ amountKRW: 22000000 }, descriptor), 15400000);
  assert.equal(minimumKRW({ amountKRW: null }, descriptor), 0);
  const p = parseProjectDetail({ id: 1, title: 't', description: row().content, amount: 20000000, deadline: 5, status: 'APPROVAL', projectType: 'OUTSOURCING', answers: [] }, { now: NOW });
  assert.deepEqual(checkPlan(parts(), p, { floorKRW: 1000000, minKRW: 14000000, now: NOW }).violations, []);
  assert.deepEqual(checkPlan(parts(), p, { floorKRW: 1000000, minKRW: 15000000, now: NOW }).violations.map((v) => v.rule), ['plan.minimum']);
  const text = composeText(parts());
  assert.match(text, /- 설계 문서\n2단계/);
  assert.match(text, /\[계약 조건\]\n합계는 부가세 포함/);
});

test('a signed-in session is opened per step, and one that fails to close leaves the work recorded', async () => {
  const instance = makeInstance({ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 50000000 });
  const ledger = openLedger(':memory:');
  const f = fakeSurfaces([project({ id: 7 })]);
  let opened = 0;
  const openSeller = async () => {
    opened += 1;
    return { ...f.seller, stop: async () => { throw Object.assign(new Error('session is not registered'), { code: 'not_found' }); } };
  };
  const r = await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller, runCodex: goodCodex() });
  assert.deepEqual(r.planned.map((p) => p.id), [7]);
  assert.equal(r.status, 'partial');
  assert.ok(r.errors.every((e) => e.ref === 'seller.stop'));
  assert.equal(opened, 1, 'the quota read opens its own session; the send is the drain\'s');
  ledger.close();
});

// The 제안하기 dialog as it read on 2026-10-25 (an enterprise project), with synthetic values.
const ACKS = descriptor.enterprise.proposalAcknowledgements;
const dialog = (over = {}) => ({
  dialogs: ['제안할 예산\n만원\n프로젝트 예산 2000만원\n\n입력 가능한 예산 : 최소 1400만원 ~\n\n제안할 진행 기간\n일\n세금계산서 발행 여부\n가능\n불가능\n제안 내용\n\n0/3000\n\n[필수] ' + ACKS[0] + '.\n[필수] ' + ACKS[1] + '.\n제안하기'],
  fields: [
    { ref: 'field-0', tag: 'INPUT', type: 'text', name: 'amount', maxLength: 5, required: false, label: '입력 가능한 예산 : 최소 1400만원 ~', value: '' },
    { ref: 'field-1', tag: 'INPUT', type: 'text', name: 'days', maxLength: 4, required: false, label: '제안할 진행 기간', value: '' },
    { ref: 'field-2', tag: 'TEXTAREA', type: 'textarea', name: 'content', maxLength: null, required: false, label: '제안 내용', value: '' },
    { ref: 'field-3', tag: 'INPUT', type: 'file', required: false, label: '파일첨부', accept: '*' },
    { ref: 'field-4', tag: 'INPUT', type: 'checkbox', required: false, label: '[필수] ' + ACKS[0] + '.', checked: false },
    { ref: 'field-5', tag: 'INPUT', type: 'checkbox', required: false, label: '[필수] ' + ACKS[1] + '.', checked: false },
  ],
  buttons: [{ text: '가능', className: 'b', pressed: 'false' }, { text: '불가능', className: 'b', pressed: 'false' }, { text: '제안하기', className: 'c', pressed: null }],
  counters: ['0/3000'],
  ...over,
});
const offer = (over = {}) => ({ text: composeText(parts()), totalKRW: 14000000, phases: parts().phases, ...over });

test('the proposal form takes the total in 만원 above its floor, the length in days, the tax answer and only known acknowledgements', () => {
  const opts = { taxInvoice: true, acknowledgements: ACKS };
  const plan = planForm(dialog(), offer(), opts);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.fills.map((f) => [f.as, f.value ?? f.choice ?? f.ref]), [['text', offer().text], ['amount', '1400'], ['days', '75'], ['choice', '가능'], ['check', 'field-4'], ['check', 'field-5']]);
  assert.deepEqual(planForm(dialog(), offer({ text: 'x'.repeat(3001) }), opts).problems, ['the proposal has 3001 characters and the field takes 3000']);
  assert.match(planForm(dialog(), offer({ totalKRW: 13990000 }), opts).problems.join(), /under the form floor of 1400만원/);
  assert.match(planForm(dialog(), offer(), { acknowledgements: ACKS }).problems.join(), /tax invoice/);
  const changed = dialog();
  changed.fields[5] = { ...changed.fields[5], label: '[필수] 엔터프라이즈 중개 수수료는 총 계약 대금의 15%이며, 계약 체결 시점에 부과됩니다.' };
  assert.match(planForm(changed, offer(), opts).problems.join(), /unknown required acknowledgement/);
  assert.equal(proposalDays([{ startDate: '2026-11-02', endDate: '2026-11-02' }]), 1);
});

test('the read back sees an unticked acknowledgement, the wrong choice and a cut text', () => {
  const opts = { taxInvoice: false, acknowledgements: ACKS };
  const { fills } = planForm(dialog(), offer(), opts);
  const filled = (over) => {
    const f = dialog(over);
    f.fields = f.fields.map((x) => ({ ...x, value: { amount: '1400', days: '75', content: offer().text }[x.name] ?? x.value, checked: x.type === 'checkbox' ? true : x.checked }));
    return f;
  };
  const pressed = (yes, no) => [{ text: '가능', className: 'b', pressed: yes }, { text: '불가능', className: 'b', pressed: no }];
  assert.deepEqual(readbackProblems(filled({ buttons: pressed('false', 'true') }), fills), []);
  assert.deepEqual(readbackProblems(filled({ buttons: pressed('true', 'false') }), fills), ['choice 불가능 does not show as selected']);
  const cut = filled({ buttons: pressed('false', 'true') });
  cut.fields[2].value = offer().text.slice(0, 20);
  cut.fields[4].checked = false;
  assert.deepEqual(readbackProblems(cut, fills), ['text field holds something else than what was written', 'acknowledgement [필수] ' + ACKS[0] + '. is not ticked']);
});

// A page model of kmong's proposal step as measured on 2026-10-25: the form dialog holds a visible
// textarea and its own disabled 제안하기, and the final confirm is a SweetAlert2 dialog whose hidden
// textarea belongs to the popup library. Page functions run against a minimal document.
function node({ tag = 'div', text = '', visible = true, disabled = false, role = null, children = [] } = {}) {
  const n = { tagName: tag.toUpperCase(), innerText: text, disabled, role, clicks: 0, children, getBoundingClientRect: () => (visible ? { width: 40, height: 20 } : { width: 0, height: 0 }), click: () => { n.clicks += 1; } };
  const all = () => n.children.flatMap((c) => [c, ...c.all()]);
  const matches = (c, selector) => selector.split(',').map((s) => s.trim()).some((s) => (s === '[role=dialog]' && c.role === 'dialog') || (s === '[role=alertdialog]' && c.role === 'alertdialog') || (s === 'textarea' && c.tagName === 'TEXTAREA') || (s === 'button' && c.tagName === 'BUTTON'));
  n.all = all;
  n.querySelectorAll = (selector) => all().filter((c) => matches(c, selector));
  n.querySelector = (selector) => n.querySelectorAll(selector)[0] ?? null;
  return n;
}

test('the final confirm is pressed in a dialog whose only text field is hidden', () => {
  const form = node({ role: 'dialog', text: '제안 내용', children: [node({ tag: 'textarea' }), node({ tag: 'button', text: '제안하기', disabled: true })] });
  const confirm = node({ tag: 'button', text: '제안하기' });
  const popup = node({ role: 'dialog', text: '제안 후 내용을 수정할 수 없어요.\n이 내용으로 최종 제안할까요?', children: [node({ tag: 'textarea', visible: false }), node({ tag: 'button', text: '아니요', visible: false }), node({ tag: 'button', text: '취소' }), confirm] });
  const page = node({ children: [form, popup] });
  globalThis.document = page;
  try {
    assert.equal(pageConfirm(CONFIRM_LABELS).pressed, '제안하기');
    assert.equal(confirm.clicks, 1);
    assert.equal(form.children[1].clicks, 0);
  } finally {
    delete globalThis.document;
  }
});
