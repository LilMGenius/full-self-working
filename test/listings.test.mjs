import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { buildListing, checkListing, KMONG_LIMITS, ListingError, packageTerms, processText } from '../src/listings/kmong.mjs';
import { checkImages, detailHtmls, imageSize, LABELS, mainHtml, renderListingImages } from '../src/listings/images.mjs';
import { formProblems } from '../src/platforms/kmong/adapter.mjs';
import { lintText } from '../src/policy/slop.mjs';

function makeInstance() {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-listings-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  writeFileSync(join(dir, 'config.json'), readFileSync(join(exampleDir, 'config.json')));
  return loadInstance({ dir });
}

const ROW = { platform: 'kmong', service: 'landing_page_web', packages: { standard: 200000, deluxe: 440000, premium: 800000 }, floorKRW: 100000, ceilingKRW: 1000000, viable: true };
const CATALOG = {
  landing_page_web: { ko: '랜딩페이지 제작', en: 'Landing page', agentHours: { standard: 6, deluxe: 14, premium: 28 }, deliverables: ['page'], kmongGig: { root: 'IT·프로그래밍', sub: '랜딩페이지' }, kmongForm: { meta: { '팀 규모': '1인' }, packageSelects: {}, packageChecks: {}, scope: ['a', 'b', 'c'] } },
};

// A model answer that meets every rule; tests break one field at a time.
const draft = (over = {}) => ({
  title: '반응형 랜딩페이지 제작 기획부터 배포까지',
  description: '서비스 소개\n방문자가 내용을 읽고 다음 행동을 찾도록 랜딩페이지를 만듭니다. 문구 순서를 먼저 정리하고 반응형으로 구현합니다.\n\nAI 활용과 검수\n코드와 문구 초안에 AI 도구를 씁니다. 모든 결과물은 사람이 직접 검수한 뒤 전달합니다.',
  preparation: '페이지의 목적과 대상, 사용할 문구와 이미지, 참고 화면과 희망 일정을 크몽 메시지로 보내 주세요.',
  revision: '수정은 합의한 구성 안에서 패키지 횟수만큼 반영합니다. 페이지 추가나 새 기능은 새 작업으로 보고 범위를 다시 정합니다.',
  packages: [
    { tier: 'STANDARD', title: '한 페이지 기본', description: '한 페이지, 다섯 개 섹션 이내로 만듭니다.' },
    { tier: 'DELUXE', title: '섹션 확장과 문의 폼', description: '여덟 개 섹션과 문의 폼 연결까지 포함합니다.' },
    { tier: 'PREMIUM', title: '여러 페이지 구성', description: '여러 페이지와 공통 디자인 기준을 함께 만듭니다.' },
  ],
  keywords: ['랜딩페이지', '반응형 웹', '홈페이지 제작', '회사 소개 페이지', '웹페이지 제작'],
  faqs: [{ question: '수정은 몇 번 되나요?', answer: '패키지마다 정해진 횟수만큼 반영합니다.' }, { question: '소스도 받나요?', answer: '네, 소스 파일을 함께 드립니다.' }, { question: 'AI를 쓰나요?', answer: 'AI 도구를 쓰고 사람이 검수합니다.' }],
  card: { headline: ['랜딩페이지', '반응형 제작'], subline: '구성 정리부터 소스 전달까지', tags: ['모바일', '소스 제공', '배포 안내'] },
  intro: { headline: ['전할 내용을 정리하고', '화면으로 구현합니다'], body: '서비스 소개에 필요한 랜딩페이지를 만들고 소스 파일을 함께 전달합니다.' },
  audience: ['새 서비스를 소개하려는 팀', '회사 소개 페이지가 필요한 분', '모바일 홍보 페이지가 필요한 분'],
  included: ['반응형 HTML 페이지', '소스 파일', '배포 안내'],
  steps: [{ title: '자료 확인', detail: '목적과 자료를 메시지로 확인합니다.' }, { title: '범위 확정', detail: '구성과 일정을 글로 정리합니다.' }, { title: '제작', detail: '화면을 만들고 중간에 공유합니다.' }, { title: '전달', detail: '점검한 뒤 소스와 안내를 전달합니다.' }],
  aiNote: '코드와 문구 초안에 AI 도구를 씁니다. 모든 결과물은 사람이 직접 검수한 뒤 전달합니다.',
  proofCaptions: [],
  claimsUsed: [],
  ...over,
});

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

const ctx = (runCodex, over = {}) => ({ instance: makeInstance(), priceTable: [ROW], runCodex, catalog: CATALOG, background: '', playbook: '', lessonsRules: [], ...over });

test('package prices come from the price table and days from agent hours', () => {
  const terms = packageTerms('landing_page_web', ROW, CATALOG);
  assert.deepEqual(terms.map((t) => t.priceKRW), [200000, 440000, 800000]);
  assert.deepEqual(terms.map((t) => t.days), [2, 4, 6]);
  assert.throws(() => packageTerms('landing_page_web', { ...ROW, viable: false }, CATALOG), (e) => e.code === 'FSW_LISTING_NOT_VIABLE');
  assert.throws(() => packageTerms('landing_page_web', null, CATALOG), (e) => e.code === 'FSW_LISTING_NO_PRICE');
});

test('a clean draft passes on the first model call', async () => {
  const codex = fakeCodex([draft()]);
  const r = await buildListing('landing_page_web', ctx(codex));
  assert.equal(r.modelCalls, 1);
  assert.equal(r.listing.packages[1].priceKRW, 440000);
  assert.equal(r.listing.process, processText(draft().steps));
  assert.deepEqual(r.listing.form.meta, { '팀 규모': '1인' });
  assert.match(codex.calls[0].prompt, /scope: a/);
});

test('a blocked draft goes back once with its violations, then passes', async () => {
  const bad = draft({ title: '국내 최고 랜딩페이지 제작 전문가', description: draft().description + '\n문의는 example.com 으로 주세요.' });
  const codex = fakeCodex([bad, draft()]);
  const r = await buildListing('landing_page_web', ctx(codex));
  assert.equal(r.modelCalls, 2);
  const rules = r.retried.map((v) => v.rule);
  assert.ok(rules.includes('listing.superlative'));
  assert.ok(rules.includes('contact.url'));
  assert.match(codex.calls[1].prompt, /previous draft was blocked/);
  assert.match(codex.calls[1].prompt, /listing\.superlative/);
});

test('two blocked drafts throw with the violations and nothing is returned', async () => {
  const bad = draft({ keywords: ['랜딩페이지'] });
  const codex = fakeCodex([bad, bad]);
  await assert.rejects(buildListing('landing_page_web', ctx(codex)), (e) => e instanceof ListingError && e.code === 'FSW_LISTING_BLOCKED' && e.violations.some((v) => v.rule === 'limit.keywords'));
  assert.equal(codex.calls.length, 2);
});

const listingOf = (over = {}) => {
  const d = draft(over);
  return {
    title: d.title, description: d.description, process: processText(d.steps), preparation: d.preparation, revision: d.revision,
    packages: d.packages.map((p, i) => ({ ...p, priceKRW: [200000, 440000, 800000][i], days: [2, 4, 6][i], revisions: i + 1 })),
    keywords: d.keywords, faqs: d.faqs,
    imageCopy: { card: d.card, intro: d.intro, audience: d.audience, included: d.included, steps: d.steps, aiNote: d.aiNote, proofCaptions: [] },
  };
};
const rulesOf = (l, opts = {}) => checkListing(l, { instance: makeInstance(), priceRow: ROW, ...opts }).map((v) => v.field + ':' + v.rule);

test('field limits from the kmong form are enforced', () => {
  assert.deepEqual(rulesOf(listingOf()), []);
  assert.ok(rulesOf(listingOf({ title: '짧은 제목' })).includes('title:limit.length'));
  assert.ok(rulesOf(listingOf({ title: '랜딩페이지 제작 & 배포 서비스' })).includes('title:limit.title_chars'));
  const l = listingOf();
  l.description = 'AI 도구를 쓰고 사람이 검수합니다. 짧아요';
  assert.ok(rulesOf(l).includes('description:limit.length'));
  const lt = listingOf();
  lt.description += ' a < b';
  assert.ok(rulesOf(lt).includes('description:limit.banned_chars'));
  const pk = listingOf();
  pk.packages[0].title = '가'.repeat(KMONG_LIMITS.packageTitle.max + 1);
  pk.packages[2].description = '가'.repeat(KMONG_LIMITS.packageDescription.max + 1);
  const r = rulesOf(pk);
  assert.ok(r.includes('packages.0.title:limit.length'));
  assert.ok(r.includes('packages.2.description:limit.length'));
  const kw = listingOf({ keywords: ['랜딩페이지', '랜딩 페이지', '홈페이지', '웹', '가'.repeat(21)] });
  const k = rulesOf(kw);
  assert.ok(k.includes('keywords:limit.keywords_unique'));
  assert.ok(k.includes('keywords.4:limit.length'));
  const faq = listingOf({ faqs: [{ question: '질문', answer: '가'.repeat(256) }] });
  assert.ok(rulesOf(faq).includes('faqs.0.answer:limit.length'));
  const proc = listingOf();
  proc.preparation = '자료를 보내 주세요.';
  assert.ok(rulesOf(proc).includes('preparation:limit.length'));
  const rev = listingOf();
  rev.revision = '수정 가능합니다.';
  assert.ok(rulesOf(rev).includes('revision:limit.length'));
});

test('prices must match the table and rise across tiers', () => {
  const l = listingOf();
  l.packages[1].priceKRW = 450000;
  assert.ok(rulesOf(l).includes('packages.1.priceKRW:price.table'));
  l.packages[2].priceKRW = 2000000;
  assert.ok(rulesOf(l).includes('packages.2.priceKRW:price.range'));
});

test('copy rules: AI disclosure, slop, contacts and claims anywhere, image copy included', () => {
  const noAi = listingOf({ description: draft().description.replace(/AI[^\n]*\n[^\n]*$/, '사람이 직접 만듭니다.') + ' 서비스 설명을 충분히 길게 씁니다. 문구 순서와 화면 구성을 정리합니다.' });
  assert.ok(rulesOf(noAi).includes('description:listing.ai_disclosure'));
  const dash = listingOf();
  dash.imageCopy.card.subline = '기획 \u2014 배포';
  assert.ok(rulesOf(dash).includes('imageCopy.card:slop.em_dash'));
  const dot = listingOf();
  dot.imageCopy.included[0] = '기획\u00B7디자인';
  assert.ok(rulesOf(dot).includes('imageCopy.included:slop.middle_dot'));
  const hype = listingOf();
  hype.faqs[0].answer = '최고의 품질로 만듭니다.';
  assert.ok(rulesOf(hype).includes('faqs.0.answer:slop.hype_ko'));
  const contact = listingOf();
  contact.imageCopy.proofCaptions = ['studio.example.com 첫 화면'];
  assert.ok(rulesOf(contact).includes('imageCopy.proof:contact.url'));
  const claim = listingOf();
  claim.description += ' 경력 10년 개발자가 만듭니다.';
  assert.ok(rulesOf(claim).includes('description:claims.unapproved'));
  const banned = listingOf();
  banned.description += ' 전문 디자이너가 만듭니다.';
  assert.ok(rulesOf(banned).includes('description:claims.forbidden'));
  const sup = listingOf();
  sup.imageCopy.card.tags[0] = '업계 1위';
  assert.ok(rulesOf(sup).includes('imageCopy.card:listing.superlative'));
  const career = listingOf();
  career.description += ' 회사 대표로 기업용 챗봇을 구축해 온 경험을 바탕으로 작업합니다.';
  career.imageCopy.intro.body = '대기업 출신 개발자가 만듭니다. 전할 내용을 정리합니다.';
  const c = rulesOf(career);
  assert.ok(c.includes('description:listing.career_claim'));
  assert.ok(c.includes('imageCopy.intro:listing.career_claim'));
});

test('the fixed image labels pass the slop gate', () => {
  for (const label of Object.values(LABELS)) assert.deepEqual(lintText(label).filter((f) => f.tier === 'floor'), [], label);
});

test('image HTML carries only escaped copy, no URL, and the fonts inline', () => {
  const l = listingOf();
  l.imageCopy.card.subline = '<script>x</script>';
  const html = mainHtml({ listing: l, studio: '스튜디오' });
  assert.ok(!html.includes('<script>x'));
  assert.ok(html.includes('data:font/woff2;base64,'));
  assert.ok(!/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')));
  const pages = detailHtmls({ listing: listingOf(), studio: '스튜디오' });
  assert.equal(pages.length, 4);
  assert.ok(pages.every((p) => !/https?:\/\//.test(p.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ''))));
});

test('image slot rules are read from the written files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-img-'));
  const r = await renderListingImages({ listing: listingOf(), studio: '스튜디오', outDir: dir });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(imageSize(readFileSync(r.main)), { width: 652, height: 488 });
  assert.deepEqual(imageSize(readFileSync(r.preview)).width, 190);
  for (const f of r.detail) {
    const d = imageSize(readFileSync(f));
    assert.ok(d.width >= 652 && d.width <= 2000 && d.height <= 3000, f + ' ' + JSON.stringify(d));
  }
  const bad = checkImages({ main: r.detail[0], detail: r.detail.slice(0, 2) });
  assert.deepEqual(bad.map((v) => v.rule).sort(), ['image.count', 'image.size']);
});

test('the form read-back names every field that did not land', () => {
  const l = { ...listingOf(), images: { main: 'm.png', detail: ['d1.jpg'] } };
  const good = {
    counters: ['500/20000', '120/20000', '80/20000'], packageMode: true,
    packages: l.packages.map((p) => ({ title: p.title, description: p.description })),
    prices: ['200,000', '440,000', '800,000'], mainImages: [1, 1], detailImages: [1, 9],
    keywords: [5, 5], faqs: [10, 10, 10],
    revision: l.revision,
  };
  assert.deepEqual(formProblems(good, l), []);
  const bad = { ...good, counters: ['0/20000', '120/20000', '80/20000'], prices: ['200,000', '44,000', '800,000'], mainImages: [0, 1], keywords: [4, 5], faqs: [10, 0, 10], revision: '' };
  const p = formProblems(bad, l);
  assert.ok(p.includes('description is empty'));
  assert.ok(p.some((x) => x.startsWith('package 1 price')));
  assert.ok(p.includes('no main image'));
  assert.ok(p.some((x) => x.startsWith('keywords read 4')));
  assert.ok(p.some((x) => x.startsWith('faqs read')));
  assert.ok(p.includes('revision text differs'));
});


test('the weekly listings job reads /my-gigs for every published gig and records each status', async () => {
  const { listingsJob } = await import('../src/cli/listings.mjs');
  const instance = makeInstance();
  const events = [];
  const ledger = { addEvent: (e) => events.push(e) };
  assert.equal((await listingsJob({ instance, ledger, openKmong: async () => assert.fail('nothing published, no browser') })).status, 'skipped');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(instance.dir, 'listings', 'landing_page_web'), { recursive: true });
  writeFileSync(join(instance.dir, 'listings', 'landing_page_web', 'publish-20261025.json'), JSON.stringify({ service: 'landing_page_web', gigId: 7, observed: true }));
  let stopped = false;
  const fake = async () => ({ listings: async () => ({ gigs: [{ gigId: 7, status: '승인 전' }] }), stop: async () => (stopped = true) });
  const r = await listingsJob({ instance, ledger, openKmong: fake });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rows, [{ service: 'landing_page_web', gigId: 7, status: '승인 전' }]);
  assert.equal(events[0].kind, 'listing.status');
  assert.ok(stopped);
});

