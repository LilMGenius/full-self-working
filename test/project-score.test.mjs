// 크몽 엔터프라이즈 projects: page parsing, scoring drops and ranking, and once-only judgement. Every project
// here is synthetic; real project text never enters the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { parseProjectDetail, parseProjectRow, parseProposals, parseQuota, requestedItems, REQUESTED_HEADING } from '../src/platforms/kmong/projects.mjs';
import { needsJudgement, projectFloorKRW, rankProjects, rememberJudgement, scoreProject } from '../src/projects/score.mjs';
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

test('parsers read the list row, the detail entry, the requested items and the quota', () => {
  const p = project();
  assert.equal(p.deadlineAt, '2026-10-30');
  assert.deepEqual(p.requested, ['비슷한 구축 사례', '단계별 견적']);
  assert.deepEqual(requestedItems('no heading here'), []);
  const d = parseProjectDetail({ id: 900001, title: row().title, description: 'x', amount: 20000000, deadline: 5, status: 'APPROVAL', projectType: 'OUTSOURCING', subCategoryId: 42, answers: [{ title: '프로젝트 설명', type: 'TEXT', description: row().content }, { title: '프로젝트 종료 예정일', type: 'TEXT', description: '2027-01-31' }, { title: '진행 방식', type: 'ITEMS', contents: ['외주'] }] }, { now: NOW });
  assert.equal(d.endDate, '2027-01-31');
  assert.equal(d.mode, '외주');
  assert.equal(d.hash, p.hash, 'the list and the detail of one page version hash alike');
  assert.equal(parseQuota('보낸 제안\n오늘 보낼 수 있는 제안 : \n5\n개'), 5);
  assert.equal(parseQuota('nothing here'), null);
  const list = parseProposals('보낸 제안\n사내 업무 관리 웹 시스템 구축\n2,000만원\n미팅 요청\n다른 프로젝트\n응답 대기중', ['사내 업무 관리 웹 시스템 구축', '다른 프로젝트', '없는 제목']);
  assert.deepEqual(list.found.map((f) => f.status), ['meeting', 'waiting']);
});

test('scoring drops closed, late, resident, offline, native, uncatalogued, unfit and underfunded projects', () => {
  const instance = makeInstance();
  const ctx = ctxFor(instance);
  const reason = (over) => scoreProject(project(over), ctx).reason ?? 'kept';
  assert.equal(reason({}), 'kept');
  assert.match(reason({ status: 'CLOSED' }), /CLOSED/);
  assert.match(reason({ deadline: -1 }), /deadline/);
  assert.match(reason({ project_type: 'RESIDENT' }), /not outsourcing/);
  assert.match(reason({ content: '공장 현장 설치 공사와 웹 화면' }), /offline, hardware/);
  assert.match(reason({ content: '안드로이드 앱과 관리자 웹' }), /native mobile/);
  assert.match(reason({ category: { cat1: 6, cat2: 105, cat2_name: '하드웨어' } }), /no catalog service/);
  assert.match(reason({ category: { cat1: 1, cat2: 106, cat2_name: 'AI 디자인' } }), /serviceFit is none/);
  const floor = projectFloorKRW('web_app_dev', { config: instance.config, descriptor });
  assert.match(reason({ amount: floor - 1000 }), /under the cost floor/);
  assert.equal(reason({ amount: floor }), 'kept');
  assert.match(scoreProject(project({ title: '브랜드 홈페이지 리뉴얼', content: '랜딩 홈페이지 반응형 개편' }), { ...ctx, minFit: 'strong' }).reason, /below strong/);
});

test('ranking orders by budget over the floor, fit strength and the allocation weight', () => {
  const instance = makeInstance();
  const big = project({ id: 1, amount: 30000000 });
  const small = project({ id: 2, amount: 6000000 });
  const some = project({ id: 3, amount: 30000000, title: '브랜드 홈페이지 리뉴얼', content: '랜딩 홈페이지 반응형 개편' });
  assert.deepEqual(rankProjects([small, some, big], ctxFor(instance)).kept.map((k) => k.project.id), [1, 3, 2]);
  const ai = project({ id: 4, amount: 30000000, title: '챗봇 구축', content: 'AI 챗봇 GPT RAG 자동화', category: { cat1: 6, cat2: 102, cat2_name: 'AI' } });
  const allocation = { weights: [{ platform: 'kmong', service: 'ai_automation_chatbot', weight: 0.4 }, { platform: 'kmong', service: 'web_app_dev', weight: 0.05 }] };
  assert.deepEqual(rankProjects([big, ai], ctxFor(instance, { allocation })).kept.map((k) => k.project.id), [4, 1]);
  const flipped = { weights: [{ platform: 'kmong', service: 'ai_automation_chatbot', weight: 0.05 }, { platform: 'kmong', service: 'web_app_dev', weight: 0.4 }] };
  assert.deepEqual(rankProjects([big, ai], ctxFor(instance, { allocation: flipped })).kept.map((k) => k.project.id), [1, 4]);
});

test('a project is judged once per page version and a sent one stays sent', () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const p = project();
  assert.equal(needsJudgement(ledger, p), true);
  rememberJudgement(ledger, p, scoreProject(p, ctxFor(instance)));
  assert.equal(needsJudgement(ledger, p), false);
  assert.equal(needsJudgement(ledger, project({ deadline: 4 })), false, 'a day passing is not a page change');
  const changed = project({ amount: 25000000 });
  assert.equal(needsJudgement(ledger, changed), true);
  ledger.upsertThread({ platform: 'kmong', externalId: 'project:900001', kind: 'project', status: 'proposed' });
  rememberJudgement(ledger, changed, scoreProject(changed, ctxFor(instance)));
  assert.equal(ledger.listThreads({ platform: 'kmong' })[0].status, 'proposed');
  ledger.close();
});
