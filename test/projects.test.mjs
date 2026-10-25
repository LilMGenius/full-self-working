// 크몽 엔터프라이즈 proposals: the daily quota, the send policy, the plan check, the gate and the hourly job.
// Every project here is synthetic; real project text never enters the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { assertSendable, parseProjectDetail, parseProjectRow, planForm, proposalDays, readbackProblems, REQUESTED_HEADING } from '../src/platforms/kmong/projects.mjs';
import { checkPlan, composeText, draftProposal, proposalPolicy, proposalsLeft, sendDecision } from '../src/projects/draft.mjs';
import { projectsJob } from '../src/projects/job.mjs';
import { listApprovals } from '../src/brain/approvals.mjs';

const descriptor = loadDescriptor('kmong');
const NOW = new Date('2026-10-25T03:00:00Z'); // 12:00 Seoul, inside the outbound hours

function makeInstance(proposals = { maxPerDay: 5, minFit: 'strong', autoMaxKRW: 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-projects-'));
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

// A job pass against fakes: an approval for anything the policy does not auto-send, nothing sent past
// the quota, and nothing proposed twice.
function fakeSurfaces(projects, { quota = 5 } = {}) {
  const proposed = [];
  const reader = {
    listProjects: async () => ({ projects }),
    readProject: async (id) => projects.find((p) => p.id === id),
    close: async () => {},
  };
  const seller = {
    quota: async () => quota - proposed.length,
    proposals: async () => ({ quota, found: [] }),
    propose: async (p, proposal, { gate }) => {
      assertSendable(proposal, gate);
      proposed.push(p.id);
      return { observed: true, submitted: true, status: 'waiting', label: '응답 대기중', steps: [] };
    },
    stop: async () => {},
  };
  return { reader, seller, proposed, openReader: async () => reader, openSeller: async () => seller };
}

const goodCodex = (critic = { score: 0.9, needRestated: true, everyItemAnswered: true, claimsBacked: true, pricePlausible: true, problems: [] }) =>
  async ({ schema }) => ({ data: schema.required.includes('score') ? critic : parts() });

test('the job sends within the quota, queues what the policy holds, and proposes each project once', async () => {
  const instance = makeInstance({ maxPerDay: 2, minFit: 'strong', autoMaxKRW: 15000000 });
  const ledger = openLedger(':memory:');
  const many = [1, 2, 3].map((id) => project({ id, title: '웹 시스템 ' + id, amount: 20000000 + id }));
  const f = fakeSurfaces(many);
  const r1 = await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: goodCodex() });
  assert.equal(r1.sent.length, 2, JSON.stringify(r1));
  assert.deepEqual(f.proposed.length, 2);
  const r2 = await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: goodCodex() });
  assert.equal(r2.sent.length, 0, 'maxPerDay is spent for the day');
  assert.equal(new Set(f.proposed).size, f.proposed.length, 'no project proposed twice');
  const nextDay = new Date(NOW.getTime() + 86_400_000);
  await projectsJob({ instance, ledger, now: nextDay, openReader: f.openReader, openSeller: f.openSeller, runCodex: goodCodex() });
  assert.deepEqual([...f.proposed].sort(), [1, 2, 3]);
  ledger.close();
});

test('a draft above autoMaxKRW or under the critic threshold becomes an approval', async () => {
  for (const [policy, codex, why] of [
    [{ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 1000000 }, goodCodex(), /autoMaxKRW/],
    [{ maxPerDay: 5, minFit: 'strong', autoMaxKRW: 50000000 }, goodCodex({ score: 0.4, needRestated: true, everyItemAnswered: false, claimsBacked: true, pricePlausible: true, problems: ['item 2 skipped'] }), /critic score 0.4/],
  ]) {
    const instance = makeInstance(policy);
    const ledger = openLedger(':memory:');
    const f = fakeSurfaces([project()]);
    const r = await projectsJob({ instance, ledger, now: NOW, openReader: f.openReader, openSeller: f.openSeller, runCodex: codex });
    assert.equal(f.proposed.length, 0);
    assert.equal(r.queued.length, 1);
    const [a] = listApprovals(instance, { status: 'open' });
    assert.equal(a.kind, 'project_proposal');
    assert.equal(a.orderItem, true);
    assert.match(a.reason, why);
    assert.match(a.reason, /^크몽 엔터프라이즈 제안 검토/);
    ledger.close();
  }
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
  assert.deepEqual(r.sent, [7]);
  assert.equal(r.status, 'partial');
  assert.ok(r.errors.every((e) => e.ref === 'seller.stop'));
  assert.ok(opened >= 2, 'the quota read and the send each open their own session');
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

