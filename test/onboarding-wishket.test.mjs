// 위시켓 onboarding: the planning and page parsers on a synthetic instance and synthetic markup; no real
// profile or page enters the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import {
  STEPS, careerEntries, desiredSkills, gateTexts, introCopy, isSignedOut, parseStackResult, pendingIdentity, periodOf, pickPortfolio, planList, portfolioCandidates, prizeEntries, sameCompany, skillCandidates, writePace,
} from '../src/platforms/wishket/onboarding.mjs';

const instance = {
  business: { company: '예시상호 (Example Co)', bizRegNo: '000-00-00000' },
  config: {},
  profile: {
    person: { nameKo: '홍길동', nameEn: 'Gildong Hong', handle: 'gildong' },
    summary_ko: '웹과 AI 도구를 만들어 온 개발자입니다. 예시상호를 세워 기업용 챗봇을 맡아 왔습니다. 배포와 모바일 점검까지 직접 진행합니다.',
    roles: [
      { org: 'Example Co', org_ko: '예시상호 (Example Co)', title: 'Founder/CEO', title_ko: '대표', period: '2024.12 to present' },
      { org: 'Sample Corp', org_ko: '샘플기업', title: 'Lead Engineer', title_ko: '리드 엔지니어', period: '2021.03 to 2023.02', detail_ko: '사내 AI 시스템을 설계했습니다.' },
      { org: 'Sample Academy', org_ko: '샘플아카데미', title: 'Instructor', title_ko: '강사', period: '2026.04 to present' },
      { org: 'Side Studio', title: 'Founder', title_ko: '대표', period: 'present' },
    ],
    awards: [
      { name: 'Sample Hackathon, Winner', name_ko: '샘플 해커톤 우승', date: '2026.03', organization: 'Sample Org' },
      { name: 'Sample Meetup, Speaker', name_ko: '샘플 밋업 연사', year: 2026 },
    ],
    education: [{ school_ko: '샘플대학교', field_ko: '컴퓨터공학', degree_ko: '중퇴', period: '2019.03 to 2019.08' }],
    skills: { web: ['Vercel deployment', 'Responsive layout'], app: ['Node.js', 'JavaScript and TypeScript'], ai: ['RAG', 'Prompt engineering'] },
    skills_ko: { web: ['Vercel 배포'], ai: ['RAG'] },
    claimsNotToMake: [],
  },
};

test('steps carry ids and the path each is detected on', () => {
  assert.deepEqual(STEPS.map((s) => s.id), ['identity', 'introduction', 'employment', 'prize', 'skills', 'education', 'portfolio', 'availability']);
  assert.ok(STEPS.find((s) => s.id === 'identity').detect.path.test('/accounts/settings/modify_identity/'));
  assert.ok(STEPS.find((s) => s.id === 'prize').detect.path.test('/partners/p/someone/prize/update/'));
});

test('the portfolio item is the AI project with an image, a period and a rate, written without company names or addresses', () => {
  const ctx = { instance: { ...instance, paths: { portfolio: 'pf' }, profile: { ...instance.profile, projects: [
    { name: 'Landing pair', url: 'https://engine.example', role: 'Main committer', role_ko: '주 커미터', stack: ['HTML'] },
    { name: 'Engine', url: 'https://engine.example', role: 'Founder of the company building it', role_ko: '개발사 창업자', stack: ['Node.js', 'LLM agents'] },
    { name: 'Tool', url: '', role: 'Author', role_ko: '저자', stack: ['JavaScript'] },
  ] } }, descriptor: loadDescriptor('wishket') };
  const image = [{ src: 'media/x.jpg', kind: 'image' }];
  const items = [
    { id: 'site', source: 'background', title_ko: '예시상호 회사 사이트', title_en: 'Site', summary_ko: '회사 사이트입니다.', media: image, period: { start: '2025-01', end: '2025-03' }, participation: { rate: 100 } },
    { id: 'tool', source: 'background', title_ko: '도구', title_en: 'Tool', summary_ko: '웹 화면을 만드는 도구입니다.', media: image, period: { start: '2026-01', end: '2026-02' } },
    { id: 'engine', source: 'background', title_ko: '엔진', title_en: 'Engine', summary_ko: 'AI 에이전트로 게임을 만드는 엔진입니다.', url: 'https://engine.example', media: image, period: { start: '2026-08', end: null }, participation: { rate: 96 } },
    { id: 'bare', source: 'background', title_ko: 'AI 챗봇', title_en: 'Bare', summary_ko: 'AI 챗봇입니다.', media: [], period: { start: '2026-01', end: null }, participation: { rate: 100 } },
  ];
  const all = portfolioCandidates(ctx.instance, items, { month: '2026-10' });
  assert.equal(all.find((c) => c.id === 'site').why, 'names the operator or a company');
  assert.equal(all.find((c) => c.id === 'bare').why, 'no image');
  assert.equal(all.find((c) => c.id === 'tool').form.participation_rate, '100');
  const pick = pickPortfolio(all, ctx);
  assert.equal(pick.id, 'engine');
  // The project is found by name before its address, which another project shares.
  assert.equal(pick.form.role, '개발사 창업자');
  assert.equal(pick.form.skills, 'Node.js*!*LLM agents');
  assert.deepEqual([pick.form.date_started, pick.form.date_ended, pick.form.participation_rate], ['2026.08.', '2026.10.', '96']);
  assert.deepEqual(pick.form.field_subcategory, ['gen_ai', 'game_reward', 'saas_solution']);
  assert.deepEqual([pick.form.category, pick.form.subcategory], [['develop'], ['web']]);
  assert.ok(!/https?:|engine\.example/.test(pick.form.description));
  assert.equal(pick.image, join('pf', 'media/x.jpg'));
});

test('periodOf reads dotted months, present and a single month', () => {
  assert.deepEqual(periodOf('2024.12 to present'), { start: '2024-12', end: null });
  assert.deepEqual(periodOf('2021.03 to 2023.02'), { start: '2021-03', end: '2023-02' });
  assert.deepEqual(periodOf('2021.8'), { start: '2021-08', end: null });
  assert.equal(periodOf('present'), null);
});

test('a company matches on either name part, so an older trade name does not', () => {
  assert.equal(sameCompany('예전상호(Oldname)', '예시상호 (Example Co)'), false);
  assert.equal(sameCompany('예시상호', '예시상호 (Example Co)'), true);
  assert.equal(sameCompany('새이름(Example Co)', '예시상호 (Example Co)'), true);
  assert.equal(sameCompany(null, '예시상호'), false);
});

test('the introduction drops identifying sentences, masks owned companies and passes the gate', () => {
  const copy = introCopy(instance);
  assert.doesNotMatch(copy.description, /예시상호|Example Co|홍길동|Gildong/);
  assert.match(copy.description, /^웹과 AI 도구를 만들어 온 개발자입니다\. 배포와 모바일 점검까지 직접 진행합니다\./);
  assert.match(copy.description, /- 2024\.12 ~ 현재: 창업 회사 대표/);
  assert.match(copy.description, /- 2021\.03 ~ 2023\.02: 샘플기업 리드 엔지니어\. 사내 AI 시스템을 설계했습니다/);
  assert.ok(copy.description.trimEnd().split('\n').some((l) => l === '- 현재: 창업 회사 대표'));
  assert.match(copy.strength, /- 웹: Vercel 배포/);
  assert.deepEqual(gateTexts([copy.description, copy.strength], { descriptor: loadDescriptor('wishket'), instance }), []);
});

test('the gate refuses an introduction that names the operator', () => {
  const v = gateTexts(['안녕하세요, 홍길동입니다.'], { descriptor: loadDescriptor('wishket'), instance });
  assert.ok(v.some((x) => x.startsWith('identity.name')));
});

test('stack search markup yields known names and never the typed echo', () => {
  const html = '<div class="result-content"><div class="stack-result-list"><div class="stack-selector" data-tag-name="Git"><span>Git</span></div><div class="stack-selector" data-tag-name="C&amp;C++"></div></div><div class="write-direct-list"><div class="selector" data-tag-name="Gi"></div></div></div>';
  assert.deepEqual(parseStackResult(html), ['Git', 'C&C++']);
  assert.deepEqual(parseStackResult('<div class="write-direct-list"><div class="selector" data-tag-name="Korean"></div></div>'), []);
});

test('skills come from the vocabulary plus typed names the profile backs', () => {
  assert.ok(skillCandidates(instance.profile).includes('JavaScript'));
  assert.ok(skillCandidates(instance.profile).includes('Vercel'));
  assert.deepEqual(desiredSkills(instance.profile, ['Node.js', 'JavaScript', 'Java'], ['RAG', 'Solidity', 'prompt engineering']), ['Node.js', 'JavaScript', 'RAG', 'prompt engineering']);
});

test('career items skip teaching and undated roles and hide an owned company as freelance', () => {
  const entries = careerEntries(instance, ['Node.js']);
  assert.equal(entries.length, 2);
  const [owned, employer] = entries;
  assert.deepEqual([owned.fields.is_freelance, owned.fields.company_name, owned.fields.role, owned.fields.level, owned.fields.date_hired, owned.fields.is_present], ['true', '프리랜서', 'ceo', 'director', '2024-12-01', 'on']);
  assert.deepEqual([employer.fields.is_freelance, employer.fields.company_name, employer.fields.level, employer.fields.date_retired], ['false', '샘플기업', 'techlead', '2023-02-01']);
  assert.equal(owned.key, '프리랜서|2024-12');
});

test('awards need an awarding body', () => {
  assert.deepEqual(prizeEntries(instance), [{ key: '샘플 해커톤 우승', fields: { title: '샘플 해커톤 우승', organization: 'Sample Org', date_prized: '2026-03-01', description: '' } }]);
});

test('planList adds what is missing, deletes what the profile lacks and keeps matches ignoring case and spaces', () => {
  const plan0 = planList([], []);
  assert.deepEqual(plan0, { add: [], remove: [], keep: [] });
});

test('a login page or a header offering only 로그인 reads as signed out', () => {
  assert.equal(isSignedOut({ url: 'https://auth.wishket.com/login/?next=/', text: '' }), true);
  assert.equal(isSignedOut({ url: 'https://www.wishket.com/', text: '위시켓 | 프로젝트 찾기 | 로그인 | 회원가입' }), true);
  assert.equal(isSignedOut({ url: 'https://www.wishket.com/partners/p/x/', text: '위시켓 | 내 프로필 | 내 프로젝트 관리 | 로그아웃' }), false);
  assert.equal(isSignedOut({ url: 'https://www.wishket.com/partners/p/x/', text: '위시켓 | 내 프로필 | 파트너 소개' }), false);
});

test('writes default to 30 s apart and 10 per run, and settings override them', () => {
  assert.deepEqual(writePace({ config: {} }), { gapMs: 30_000, perRun: 10 });
  assert.deepEqual(writePace({ config: { onboarding: { wishket: { writeGapMs: 60_000, writesPerRun: 5 } } } }), { gapMs: 60_000, perRun: 5 });
  assert.deepEqual(writePace({ config: { onboarding: { wishket: { writeGapMs: -1, writesPerRun: 0 } } } }), { gapMs: 30_000, perRun: 1 });
});

test('planList on a populated page', () => {
  const plan = planList([{ key: 'Node.js', pk: '1' }, { key: 'Solidity', pk: '2' }], [{ key: 'node.js' }, { key: 'RAG' }]);
  assert.deepEqual(plan.add.map((x) => x.key), ['RAG']);
  assert.deepEqual(plan.remove.map((x) => x.pk), ['2']);
  assert.deepEqual(plan.keep.map((x) => x.pk), ['1']);
});

// The pending 위시켓 identity request is the last one written (docs/DESIGN.md, Ledger), even when a clock step gave it
// an earlier time than the one before it.
test('the pending identity request is the newest written, and a request older than two days is none', () => {
  const ledger = openLedger(':memory:');
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const ago = (h) => new Date(now - h * 3_600_000).toISOString();
  assert.equal(pendingIdentity(ledger, now), null);
  ledger.addEvent({ kind: 'platform.identity_request', platform: 'wishket', ref: 'identity', at: ago(1), payload: { file: 'a.png' } });
  ledger.addEvent({ kind: 'platform.identity_request', platform: 'wishket', ref: 'identity', at: ago(5), payload: { file: 'b.png' } });
  assert.equal(pendingIdentity(ledger, now).at, ago(5));
  ledger.addEvent({ kind: 'platform.identity_request', platform: 'wishket', ref: 'identity', at: ago(50), payload: { file: 'c.png' } });
  assert.equal(pendingIdentity(ledger, now), null);
});

test('a ledger that cannot be read is an error, never "no pending request"', () => {
  const broken = { db: { prepare: () => { throw new Error('database disk image is malformed'); } } };
  assert.throws(() => pendingIdentity(broken, Date.now()), /malformed/);
});
