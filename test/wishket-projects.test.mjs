// 위시켓 projects: the list and detail readers on synthetic markup and text written for these tests;
// real project pages never enter the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { DEFAULT_CHROME, openRenderer } from '../src/render/html2png.mjs';
import { listUrl } from '../src/platforms/wishket/market.mjs';
import {
  budgetOf, descriptionBudget, detailUrl, listQuery, openProjectReader, parseListCard, parseProjectDetail, requestedItems,
} from '../src/platforms/wishket/projects.mjs';
import { boardDrop, needsJudgement, projectFloorKRW, projectMemory, rankProjects, scoreProject } from '../src/projects/score.mjs';
import { buildCriticPrompt, buildProposalPrompt, draftProposal, proposalPolicy, usedToday } from '../src/projects/draft.mjs';

const NOW = new Date('2026-10-25T03:00:00Z'); // 12:00 Seoul
const CHROME = process.env.FSW_CHROME ?? DEFAULT_CHROME;

const DESCRIPTION = [
  '[프로젝트 개요]',
  '- 사내 회의실과 장비를 예약하는 웹을 만들려고 합니다.',
  '',
  '[제안 포함 필수 사항]',
  '지원 내용은 아래 기준으로 검토합니다.',
  '- 비슷한 예약 시스템 구축 사례',
  '- 단계별 일정과 견적',
  '',
  '[오픈 시점과 예산]',
  '- 12월 오픈 목표',
  '',
  '[견적 시 함께 부탁드립니다]',
  '1. 오픈 후 유지보수 조건',
].join('\r\n');

const card = (over = {}) => ({
  href: '/project/700001/', title: '사내 예약 관리 웹 구축', status: '모집 중', budget: '예상 금액 12,000,000원', term: '예상 기간40일', field: '중개ㆍ매칭 플랫폼 외 1개',
  type: '외주', posted: '· 등록일자 2026.10.21.', applicants: '12명', private: false, deadline: '마감 4일 3시간 전', location: '서울특별시 강남구', ...over,
});

const raw = (over = {}) => ({
  url: detailUrl(700001), title: '사내 예약 관리 웹 구축', text: '', heading: '사내 예약 관리 웹 구축', marks: ['모집 중', '외주'], private: false, privateNotice: false,
  posted: '등록 일자 2026.10.21.', categories: [['개발', '디자인'], ['웹'], ['중개ㆍ매칭 플랫폼,', '기타(내부 시스템)']],
  budget: '12,000,000원', term: '40일', applicants: '12명',
  rows: [{ label: '모집 마감일', data: '2026년 10월 29일', chips: [] }, { label: '예상 시작일', data: '계약 체결 이후, 즉시 시작', chips: [] }, { label: '관련 기술', data: '', chips: ['React', 'PostgreSQL'] }],
  location: '서울특별시 강남구', preQuestions: true, inquiries: '3',
  jobPosting: { description: DESCRIPTION, identifier: '700001', datePosted: '2026-10-21', validThrough: '2026-10-29T23:59', location: '서울특별시 강남구' }, ldErrors: [], ...over,
});

test('budgets: a stated amount, a negotiable one, a monthly one, and a description budget for a negotiable page', () => {
  assert.equal(budgetOf('예상 금액 22,000,000원').amountKRW, 22000000);
  assert.deepEqual(budgetOf('협의 후 결정'), { statedKRW: null, amountKRW: null, negotiable: true, monthly: false, budgetSource: null });
  assert.equal(budgetOf('월 금액 10,000,000원 /월').monthly, true);
  assert.equal(budgetOf('월 금액 10,000,000원 /월').amountKRW, null);
  assert.equal(descriptionBudget('[오픈 시점과 예산]\n- 예산: 1,200만 원 (부가세 별도)'), 12000000);
  assert.equal(descriptionBudget('예산은 협의하고 싶습니다\n총 예산 800만원에서 1,000만원 사이'), 8000000, 'a range counts at its lower end');
  assert.equal(descriptionBudget('예산 집행은 2026년 11월부터'), null);
  const negotiable = parseProjectDetail(raw({ budget: '협의 후 결정', jobPosting: { ...raw().jobPosting, description: DESCRIPTION + '\r\n\r\n[오픈 시점과 예산]\r\n- 예산: 900만원' } }), { now: NOW });
  assert.deepEqual([negotiable.statedKRW, negotiable.amountKRW, negotiable.budgetSource], [null, 9000000, 'description']);
});

test('requested items are the marked lines under the proposal and quote headings', () => {
  assert.deepEqual(requestedItems(DESCRIPTION), ['비슷한 예약 시스템 구축 사례', '단계별 일정과 견적', '오픈 후 유지보수 조건']);
  assert.deepEqual(requestedItems('[프로젝트 개요]\n- 예약 웹'), []);
});

test('a card and its detail page read alike, and the detail carries what scoring and drafting need', () => {
  const listed = parseListCard(card(), { now: NOW });
  assert.deepEqual([listed.id, listed.amountKRW, listed.durationDays, listed.applicants, listed.projectType, listed.private, listed.postedOn], [700001, 12000000, 40, 12, 'task_based', false, '2026-10-21']);
  const d = parseProjectDetail(raw(), { now: NOW });
  assert.equal(d.hash, listed.hash, 'one page version hashes alike from the list and the detail');
  assert.deepEqual([d.status, d.projectType, d.deadlineAt, d.deadlineDays, d.startDate, d.startText], ['open', 'task_based', '2026-10-29', 4, null, '계약 체결 이후, 즉시 시작']);
  assert.deepEqual(d.subcategories, ['중개ㆍ매칭 플랫폼', '기타(내부 시스템)']);
  assert.deepEqual([d.root.name, d.sub.name, d.skills, d.preQuestions, d.inquiries], ['개발, 디자인', '중개ㆍ매칭 플랫폼, 기타(내부 시스템)', ['React', 'PostgreSQL'], true, 3]);
  assert.equal(d.requested.length, 3);
  assert.ok(!d.description.includes('\r'));
  assert.notEqual(parseListCard(card({ budget: '예상 금액 15,000,000원' }), { now: NOW }).hash, listed.hash, 'a new budget is a new page version');
  assert.equal(parseListCard(card({ applicants: '30명' }), { now: NOW }).hash, listed.hash, 'more applicants is not a page change');
  assert.equal(parseListCard(card({ href: null }), { now: NOW }), null);
  const hidden = parseListCard(card({ private: true, applicants: '비공개' }), { now: NOW });
  assert.deepEqual([hidden.private, hidden.applicants, hidden.applicantsHidden], [true, null, true]);
  assert.equal(parseListCard(card({ type: '기간제', budget: '월 금액 5,000,000원 /월' }), { now: NOW }).projectType, 'term_based');
});

test('a closed, a private and an unreadable detail page', () => {
  assert.equal(parseProjectDetail(raw({ marks: ['모집 마감', '외주'] }), { now: NOW }).status, 'closed');
  const hidden = parseProjectDetail(raw({ private: true, marks: ['프라이빗 매칭', '모집 중', '외주'], jobPosting: null }), { now: NOW });
  assert.deepEqual([hidden.private, hidden.description, hidden.requested], [true, '', []]);
  assert.throws(() => parseProjectDetail(raw({ jobPosting: null, ldErrors: ['JSON-LD: Unexpected token'] }), { now: NOW }), (e) => e.code === 'FSW_WISHKET_PROJECT_DETAIL' && /Unexpected token/.test(e.message));
  assert.throws(() => parseProjectDetail(raw({ heading: null }), { now: NOW }), (e) => e.code === 'FSW_WISHKET_PROJECT_DETAIL');
});

// ---- scoring on the wishket board ----

const wishket = loadDescriptor('wishket');

function makeInstance() {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-wishket-score-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const instance = loadInstance({ dir });
  instance.profile.serviceFit = { web_app_dev: { strength: 'strong', evidence: ['x'] }, landing_page_web: { strength: 'strong', evidence: ['x'] }, ai_automation_chatbot: { strength: 'strong', evidence: ['x'] }, ppt_card_news: { strength: 'some', evidence: ['x'] }, thumbnail_banner: { strength: 'none', evidence: [] } };
  return instance;
}

const detail = (over = {}) => parseProjectDetail(raw(over), { now: NOW });
const ctxFor = (instance, extra = {}) => ({ profile: instance.profile, config: instance.config, descriptor: wishket, allocation: null, now: NOW, platform: 'wishket', ...extra });

test('the wishket board drops private, closed, term-based, late, offline, unservable and underfunded projects', () => {
  const ctx = ctxFor(makeInstance());
  const reason = (over) => scoreProject(detail(over), ctx).reason ?? 'kept';
  assert.equal(reason({}), 'kept');
  assert.match(reason({ private: true, marks: ['프라이빗 매칭', '모집 중', '외주'] }), /private matching/);
  assert.match(reason({ marks: ['모집 마감', '외주'] }), /shows it as closed/);
  assert.match(reason({ marks: ['모집 중', '기간제'] }), /not outsourcing work \(term_based\)/);
  assert.match(reason({ rows: [{ label: '모집 마감일', data: '2026년 10월 24일', chips: [] }] }), /deadline 2026-10-24 passed/);
  assert.match(reason({ jobPosting: { ...raw().jobPosting, description: DESCRIPTION + '\n- 매장 현장 설치와 상주 운영 포함' } }), /offline, hardware/);
  assert.match(reason({ categories: [['개발'], ['임베디드'], ['IoTㆍ블루투스']] }), /no catalog service for IoTㆍ블루투스/);
  assert.match(reason({ budget: '협의 후 결정' }), /budget unknown KRW is under the cost floor/);
  assert.match(reason({ budget: '300,000원' }), /under the cost floor/);
});

test('the wishket board maps fields to services, falls back to keywords on an unknown field and prices the floor with its own fees', () => {
  const instance = makeInstance();
  const ctx = ctxFor(instance);
  assert.equal(scoreProject(detail({ categories: [['디자인'], ['기타'], ['기획서ㆍ제안서 등']] }), ctx).service, 'ppt_card_news');
  const unknownField = detail({ categories: [['개발'], ['웹'], ['새로운 분야']], jobPosting: { ...raw().jobPosting, description: '챗봇과 GPT 기반 상담 자동화를 만들고 싶습니다.' } });
  assert.equal(scoreProject(unknownField, ctx).service, 'ai_automation_chatbot');
  const kmongFloor = projectFloorKRW('web_app_dev', { config: instance.config, descriptor: loadDescriptor('kmong') });
  const wishketFloor = projectFloorKRW('web_app_dev', { config: instance.config, descriptor: wishket, platform: 'wishket' });
  assert.ok(wishketFloor > kmongFloor, 'a 20 to 25 percent partner fee needs a larger budget than the 13.2 percent enterprise fee');
  const big = detail({ budget: '30,000,000원' });
  const small = { ...detail({ budget: '8,000,000원' }), id: 700002 };
  assert.deepEqual(rankProjects([small, big], ctx).kept.map((k) => k.project.id), [700001, 700002]);
});

test('a card alone drops private and term-based projects, and wishket judgements live apart from kmong ones', () => {
  assert.match(boardDrop(parseListCard(card({ private: true }), { now: NOW }), 'wishket'), /private matching/);
  assert.equal(boardDrop(parseListCard(card({ type: '기간제', budget: '월 금액 5,000,000원 /월' }), { now: NOW }), 'wishket'), 'not outsourcing work (monthly)');
  assert.equal(boardDrop(parseListCard(card(), { now: NOW }), 'wishket'), null);
  const ledger = openLedger(':memory:');
  const memory = projectMemory('wishket');
  const d = detail();
  assert.equal(memory.needsJudgement(ledger, d), true);
  memory.remember(ledger, d, scoreProject(d, ctxFor(makeInstance())), NOW, { url: d.url });
  assert.equal(memory.needsJudgement(ledger, parseListCard(card({ applicants: '40명' }), { now: NOW })), false, 'the list card of the judged version needs no new judgement');
  assert.equal(memory.thread(ledger, 700001).meta.url, d.url);
  assert.equal(needsJudgement(ledger, d), true, 'the kmong memory does not see a wishket judgement');
  memory.mark(ledger, 700001, 'drafted', { proposal: { totalKRW: 9000000 } });
  assert.deepEqual([memory.thread(ledger, 700001).status, memory.thread(ledger, 700001).meta.proposal.totalKRW], ['drafted', 9000000]);
  ledger.close();
});

// ---- the page-side readers on synthetic markup in the owned headless browser ----

// ---- proposals on the wishket board ----

const draftParts = (over = {}) => ({
  need: '사내 회의실과 장비 예약을 한곳에서 관리하는 웹이 필요합니다.',
  answers: [{ item: '비슷한 사례', answer: '예약 페이지를 만든 경험을 바탕으로 설명드립니다.' }, { item: '일정과 견적', answer: '2단계로 진행합니다.' }, { item: '유지보수', answer: '오픈 후 한 달 무상 수정입니다.' }],
  phases: [
    { title: '설계', deliverables: ['화면 설계서'], startDate: '2026-11-02', endDate: '2026-11-20', priceKRW: 4000000, pilot: false },
    { title: '개발', deliverables: ['예약 웹'], startDate: '2026-11-23', endDate: '2026-12-18', priceKRW: 6000000, pilot: false },
  ],
  terms: '부가세 별도이며 위시켓 계약 단계에 맞춰 나누어 받습니다.',
  aiNote: 'AI 도구로 작업하고 모든 결과물은 제가 검토합니다.',
  closing: '예약 대상 목록을 보내 주시면 바로 시작합니다.',
  claimsUsed: [],
  ...over,
});

test('a wishket proposal and its critic never see the operator names, companies, employers or project names, and kmong keeps its copy', () => {
  const instance = makeInstance();
  instance.profile.roles = [{ org: '예시회사', title: '소프트웨어 엔지니어' }, { org: 'Example Studio', org_ko: '예시스튜디오 (Example Studio)', title: 'Founder/CEO' }];
  instance.profile.summary_ko = '예시스튜디오를 세웠고 예시회사에서 예약 시스템을 만들었습니다.';
  const project = detail();
  const prompt = buildProposalPrompt({ project, instance, service: 'web_app_dev', floorKRW: 1000000, now: NOW, platform: 'wishket', anonymous: true });
  const critic = buildCriticPrompt({ project, proposal: { text: '제안서' }, instance, platform: 'wishket', anonymous: true });
  for (const text of [prompt, critic]) {
    for (const name of ['홍길동', 'Gildong', 'gildong', '예시상사', '예시스튜디오', 'Example Studio', '예시회사', '예시 프로젝트']) assert.ok(!text.includes(name), name);
    assert.match(text, /위시켓/);
    assert.doesNotMatch(text, /크몽/);
  }
  assert.match(prompt, /제 회사를 세웠고 이전 직장에서 예약 시스템을 만들었습니다/);
  assert.match(prompt, /escrow/);
  assert.match(prompt, /about 40 days/);
  assert.match(critic, /identifies a member/);
  const kmong = buildProposalPrompt({ project, instance, service: 'web_app_dev', floorKRW: 1000000, now: NOW });
  assert.match(kmong, /크몽 엔터프라이즈/);
  assert.match(kmong, /홍길동/);
});

test('a wishket draft that names the operator is blocked and redrafted, and policy and quota are per platform', async () => {
  const instance = makeInstance();
  const calls = [];
  const runCodex = async ({ prompt }) => (calls.push(prompt), { data: draftParts({ closing: '홍길동이 직접 진행합니다.' }) });
  const d = await draftProposal(detail(), { instance, descriptor: wishket, service: 'web_app_dev', floorKRW: 1000000, runCodex, lessonsRules: [], now: NOW });
  assert.equal(d.ok, false);
  assert.ok(d.violations.some((v) => v.rule === 'identity.name'));
  assert.equal(calls.length, 2);
  assert.match(calls[1], /identity\.name/);
  const clean = await draftProposal(detail(), { instance, descriptor: wishket, service: 'web_app_dev', floorKRW: 1000000, runCodex: async () => ({ data: draftParts() }), lessonsRules: [], now: NOW });
  assert.deepEqual([clean.ok, clean.proposal.totalKRW], [true, 10000000]);
  const config = { platforms: { kmong: { proposals: { maxPerDay: 5, minFit: 'strong', autoMaxKRW: 0 } }, wishket: { proposals: { maxPerDay: 2, minFit: 'some', autoMaxKRW: 0 } } } };
  assert.deepEqual([proposalPolicy(config).maxPerDay, proposalPolicy(config, 'wishket').maxPerDay, proposalPolicy(config, 'wishket').minFit], [5, 2, 'some']);
  assert.throws(() => proposalPolicy({ platforms: { wishket: {} } }, 'wishket'), /platforms\.wishket\.proposals/);
  const ledger = openLedger(':memory:');
  ledger.addEvent({ at: NOW.toISOString(), kind: 'project.queued', platform: 'kmong', ref: 1 });
  ledger.addEvent({ at: NOW.toISOString(), kind: 'project.drafted', platform: 'wishket', ref: 2 });
  ledger.addEvent({ at: NOW.toISOString(), kind: 'project.drafted', platform: 'wishket', ref: 3 });
  assert.deepEqual([usedToday(ledger, NOW), usedToday(ledger, NOW, 'wishket')], [1, 2]);
  ledger.close();
});

const LZ = '<script>window.LZString = { compressToBase64: (q) => "ENC:" + q };</script>';
const listCard = ({ id, title, budget, term = '30일', type = '외주', field = '랜딩ㆍ소개 페이지', applicants = '5명', isPrivate = false }) => '<div class="project-info-box"><section class="project-organic-info">'
  + '<div class="project-status-label recruiting-status">' + (isPrivate ? '<div class="status-mark private-mark">프라이빗 매칭<div class="status-mark-tooltip">일부 파트너에게만 공개</div></div>' : '') + '<div class="status-mark recruiting-mark">모집 중</div></div>'
  + '<a class="project-link" href="/project/' + id + '/"><p>' + title + '</p></a>'
  + '<div class="project-core-info"><p class="budget">' + budget + '</p><p class="term">예상 기간<span>' + term + '</span></p></div>'
  + '<p class="project-field-subcategory">' + field + '</p>'
  + '<div class="project-minor-info"><div class="project-status-label"><div class="status-mark project-type-mark with-img"><img alt="">' + type + '</div></div>'
  + '<p class="location-data">서울특별시 마포구</p><p class="start-recruitment-data">· 등록일자 2026.10.22.</p></div></section>'
  + '<section class="proposal-and-client-info"><div class="proposal-info"><p class="info-detail">마감 <span>3일 2시간 전</span></p><p class="info-detail">지원자 <span>' + applicants + '</span></p></div></section></div>';
const listPage = (total, cards) => '<!doctype html><html><head><meta charset="utf-8"><title>프로젝트 찾기</title>' + LZ + '</head><body><p>' + total + '개의 프로젝트</p>' + cards.map(listCard).join('') + '</body></html>';
const detailPage = (ld) => '<!doctype html><html><head><meta charset="utf-8"><title>사내 예약 관리 웹 구축</title><script type="application/ld+json">' + JSON.stringify(ld) + '</script></head><body>'
  + '<div class="project-content-title"><div class="status-guide"><div class="project-status-label"><div style="display:flex"><div class="status-mark recruiting-mark">모집 중</div><div class="status-mark project-type-mark with-img"><img alt="">외주</div></div><p class="project-recruit-guide">등록 일자 2026.10.21.</p></div></div>'
  + '<h1>사내 예약 관리 웹 구축</h1><div class="project-classification"><p class="project-category"><span class="category-wrapper">개발</span><span class="category-wrapper">디자인</span></p><p class="project-category"><span class="category-wrapper">웹</span></p>'
  + '<p class="project-category"><span class="category-wrapper">중개ㆍ매칭 플랫폼,</span> <span class="category-wrapper">기타(내부 시스템)</span></p></div></div>'
  + '<div class="project-important-condition task_based"><div class="project-condition-box project-budget"><p class="condition-box-name">예상 금액</p><p class="project-condition-data">12,000,000원</p></div>'
  + '<div class="project-condition-box project-term"><p class="project-condition-data">40일</p></div><div class="project-condition-box project-applicant"><p class="project-condition-data">12명</p></div></div>'
  + '<div class="project-detail-condition-row"><p class="condition-label">모집 마감일</p><p class="condition-data">2026년 10월 29일<img alt=""><span class="condition-accent">마감 4일 3시간 전</span></p></div>'
  + '<div class="project-detail-condition-row"><p class="condition-label">예상 시작일</p><p class="condition-data">계약 체결 이후, 즉시 시작</p></div>'
  + '<div class="project-detail-condition-row"><p class="condition-label">진행 분류</p><p class="condition-data"><img alt=""></p></div>'
  + '<div class="project-detail-condition-row"><p class="condition-label">관련 기술</p><div class="condition-data-split"><div class="project-skills-box"><div class="subcategory-box">React</div><div class="subcategory-box">PostgreSQL</div></div></div></div>'
  + '<p class="meeting-condition-data">서울특별시 강남구</p><a href="#pre_question">지원 전 질문</a><span class="comment-layer-count">3</span></body></html>';

test('the reader pages through open projects and reads a detail page from its markup', { skip: !existsSync(CHROME) && 'Chrome not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-wishket-'));
  const file = (name, html) => (writeFileSync(join(dir, name), html), pathToFileURL(join(dir, name)).href);
  const routes = new Map([
    ['https://www.wishket.com/project/', file('index.html', listPage(12, []))],
    [listUrl('ENC:' + listQuery(1)), file('page1.html', listPage(12, [
      { id: 700001, title: '사내 예약 관리 웹 구축', budget: '예상 금액 <span>12,000,000원</span>', field: '중개ㆍ매칭 플랫폼 외 1개', applicants: '12명' },
      { id: 700002, title: '브랜드 소개 페이지', budget: '예상 금액 <span>협의 후 결정</span>' },
      { id: 700003, title: '교육 플랫폼 구축', budget: '예상 금액 <span>40,000,000원</span>', applicants: '비공개', isPrivate: true },
    ]))],
    [listUrl('ENC:' + listQuery(2)), file('page2.html', listPage(12, [{ id: 700004, title: '사내 대시보드', budget: '예상 금액 <span>8,000,000원</span>' }]))],
    [detailUrl(700001), file('detail.html', detailPage({ '@context': 'https://schema.org', '@type': 'JobPosting', title: '사내 예약 관리 웹 구축 전문가', description: DESCRIPTION, identifier: { '@type': 'PropertyValue', value: '700001' }, datePosted: '2026-10-21', validThrough: '2026-10-29T23:59', jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', streetAddress: '서울특별시 강남구' } } }))],
  ]);
  const visited = [];
  const renderer = await openRenderer();
  try {
    const routed = {
      async page(opts) {
        const page = await renderer.page(opts);
        return {
          async navigate(url) {
            visited.push(url);
            if (!routes.has(url)) throw new Error('no synthetic page for ' + url);
            await page.navigate(routes.get(url), { settle: 0 });
          },
          evaluate: page.evaluate,
          close: page.close,
        };
      },
    };
    const reader = await openProjectReader({ renderer: routed, pacing: { minGapMs: 0, maxActionsPerHour: 100, maxMessagesPerHour: 100 } });
    const { projects, total } = await reader.listProjects({ pages: 3, now: NOW });
    assert.equal(total, 12);
    assert.deepEqual(visited, ['https://www.wishket.com/project/', listUrl('ENC:' + listQuery(1)), listUrl('ENC:' + listQuery(2))], 'a third page is not read when twelve projects fit in two');
    assert.deepEqual(projects.map((p) => [p.id, p.amountKRW, p.negotiable, p.private, p.applicants, p.durationDays, p.deadlineText]), [
      [700001, 12000000, false, false, 12, 30, '마감 3일 2시간 전'], [700002, null, true, false, 5, 30, '마감 3일 2시간 전'], [700003, 40000000, false, true, null, 30, '마감 3일 2시간 전'], [700004, 8000000, false, false, 5, 30, '마감 3일 2시간 전'],
    ]);
    const d = await reader.readProject(700001, { now: NOW });
    assert.deepEqual([d.title, d.amountKRW, d.durationDays, d.applicants, d.deadlineAt, d.status, d.projectType, d.private], ['사내 예약 관리 웹 구축', 12000000, 40, 12, '2026-10-29', 'open', 'task_based', false]);
    assert.deepEqual([d.subcategories, d.platforms, d.skills, d.startText, d.location, d.preQuestions, d.inquiries], [['중개ㆍ매칭 플랫폼', '기타(내부 시스템)'], ['웹'], ['React', 'PostgreSQL'], '계약 체결 이후, 즉시 시작', '서울특별시 강남구', true, 3]);
    assert.deepEqual(d.requested, ['비슷한 예약 시스템 구축 사례', '단계별 일정과 견적', '오픈 후 유지보수 조건']);
    assert.equal(reader.loads(), 4);
    await reader.close();
  } finally {
    await renderer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
