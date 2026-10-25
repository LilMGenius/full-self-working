import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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


// ---- review watch (src/listings/review.mjs, listingsWatch) ----

const publishedInstance = (services = { landing_page_web: 7 }) => {
  const instance = makeInstance();
  for (const [service, gigId] of Object.entries(services)) {
    mkdirSync(join(instance.dir, 'listings', service), { recursive: true });
    writeFileSync(join(instance.dir, 'listings', service, 'publish-20261025.json'), JSON.stringify({ service, gigId, observed: true, submitted: true }));
    writeFileSync(join(instance.dir, 'listings', service, 'spec.json'), JSON.stringify(listingOf()));
  }
  return instance;
};
const NOTICE_ROW = ['비승인', '#7', 'IT·프로그래밍', '랜딩페이지', '반응형 랜딩페이지 제작', '180,000원~', '편집하기', '등록일', '2026.10.25', '수정일', '2026.10.25', '승인 안내', '2026.10.27'].join('\n');
const NOTICE_OPEN = NOTICE_ROW + '\n\n안녕하세요, 전문가님. 크몽입니다.\n\n서비스가 비승인되었습니다.\n사유: 상세 이미지에 서비스와 무관한 이미지가 포함되어 있습니다.\n(참고: https://support.kmong.com/hc/ko/articles/1)\n\n감사합니다.';

function fakeKmong(gigs, { notice = { toggle: true, before: NOTICE_ROW, after: NOTICE_OPEN } } = {}) {
  const calls = { notice: 0, stop: 0 };
  const a = { listings: async () => ({ gigs }), gigNotice: async () => { calls.notice += 1; return notice; }, stop: async () => { calls.stop += 1; } };
  return { open: async () => a, calls };
}

function watchCtx(instance, gigs, over = {}) {
  const k = fakeKmong(gigs, over);
  const built = [];
  const published = [];
  const notes = [];
  const events = [];
  return {
    k, built, published, notes, events,
    ctx: {
      instance,
      ledger: { addEvent: (e) => events.push(e) },
      openKmong: k.open,
      notify: async (_i, msg) => notes.push(msg),
      build: async (service, opts) => built.push({ service, violations: opts.violations, previous: opts.previous }),
      publish: async (service, opts) => {
        published.push({ service, replaceImages: opts.replaceImages });
        return { observed: true, submitted: true, gigId: 7, status: '승인 전' };
      },
      ...over.ctx,
    },
  };
}

test('gig status chips, review notices and the toggled text are read without kmong boilerplate', async () => {
  const { addedText, gigStatus, parseReviewNotice } = await import('../src/listings/review.mjs');
  assert.deepEqual(['승인 전', '판매중', '비승인', '판매 중지', '임시 저장', '보류'].map(gigStatus), ['waiting', 'selling', 'rejected', 'suspended', 'draft', 'unknown']);
  const added = addedText(NOTICE_ROW, NOTICE_OPEN);
  assert.ok(added.startsWith('\n\n안녕하세요'));
  assert.equal(parseReviewNotice(added), '서비스가 비승인되었습니다.\n사유: 상세 이미지에 서비스와 무관한 이미지가 포함되어 있습니다.');
  assert.equal(parseReviewNotice('안녕하세요, 전문가님. 크몽입니다.\n감사합니다.'), null);
  assert.equal(addedText('abc', 'abXYc'), 'XY');
});

test('the review decision: on sale once, a rejection resubmitted at most twice, then the operator', async () => {
  const { MAX_RESUBMITS, nextReviewAction } = await import('../src/listings/review.mjs');
  assert.equal(MAX_RESUBMITS, 2);
  assert.equal(nextReviewAction({}, { status: 'selling' }).action, 'notify_selling');
  assert.equal(nextReviewAction({ sellingNotifiedAt: 'x' }, { status: 'selling' }).action, 'none');
  assert.equal(nextReviewAction({}, { status: 'waiting' }).action, 'none');
  const k = 'rejected:2026-10-27:2026-10-25';
  assert.equal(nextReviewAction({}, { status: 'rejected', key: k }).action, 'read_notice');
  assert.deepEqual(nextReviewAction({}, { status: 'rejected', key: k, notice: '사유: 무관한 이미지' }), { action: 'resubmit', detail: '사유: 무관한 이미지' });
  assert.equal(nextReviewAction({ resubmits: [{}] }, { status: 'rejected', key: k, notice: 'x' }).action, 'resubmit');
  assert.equal(nextReviewAction({ resubmits: [{}, {}] }, { status: 'rejected', key: k, notice: 'x' }).action, 'escalate');
  assert.equal(nextReviewAction({}, { status: 'rejected', key: k, notice: null }).action, 'escalate');
  assert.equal(nextReviewAction({}, { status: 'rejected', key: k, notice: 'AI 디자인 카테고리로 등록해 주세요' }).action, 'escalate');
  // the same rejection seen again is left alone; one that follows a resubmit is handled again
  assert.equal(nextReviewAction({ handledRejection: k, lastStatus: 'rejected' }, { status: 'rejected', key: k }).action, 'none');
  assert.equal(nextReviewAction({ handledRejection: k, lastStatus: 'waiting' }, { status: 'rejected', key: k }).action, 'read_notice');
});

test('a rejection is a learning case and its notice reaches the brain as a violation', async () => {
  const { listingsWatch } = await import('../src/cli/listings.mjs');
  const { readCases } = await import('../src/learning/outcomes.mjs');
  const instance = publishedInstance();
  const gig = { gigId: 7, status: '비승인', approvedAt: '2026-10-27', modifiedAt: '2026-10-25', title: 't' };
  const w = watchCtx(instance, [gig]);
  const r = await listingsWatch(w.ctx);
  assert.equal(r.rows[0].action, 'resubmitted');
  const cases = readCases(instance);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].kind, 'approval_rejected');
  assert.equal(cases[0].threadRef, 'gig:7');
  assert.match(cases[0].note, /무관한 이미지/);
  assert.match(cases[0].text, /title: /);
  assert.equal(w.built.length, 1);
  assert.equal(w.built[0].violations[0].rule, 'kmong.rejected');
  assert.match(w.built[0].violations[0].detail, /무관한 이미지/);
  assert.equal(w.built[0].previous.title, listingOf().title);
  assert.deepEqual(w.published[0].replaceImages, ['main', 'detail']);
  // the next hour sees the gig waiting again and does nothing more
  const w2 = watchCtx(instance, [{ ...gig, status: '승인 전' }]);
  assert.equal((await listingsWatch(w2.ctx)).rows[0].action, 'none');
  assert.equal(w2.built.length, 0);
  assert.equal(readCases(instance).length, 1);
});

test('the third rejection of a gig goes to the operator and is not resubmitted', async () => {
  const { listingsWatch } = await import('../src/cli/listings.mjs');
  const { readReview } = await import('../src/listings/review.mjs');
  const instance = publishedInstance();
  const dir = join(instance.dir, 'listings');
  for (const [day, mod] of [['2026-10-27', '2026-10-25'], ['2026-10-29', '2026-10-27'], ['2026-10-31', '2026-10-29']]) {
    const w = watchCtx(instance, [{ gigId: 7, status: '비승인', approvedAt: day, modifiedAt: mod }]);
    await listingsWatch(w.ctx);
    const waiting = watchCtx(instance, [{ gigId: 7, status: '승인 전', approvedAt: null, modifiedAt: day }]);
    await listingsWatch(waiting.ctx);
  }
  const state = readReview(dir, 'landing_page_web');
  assert.equal(state.resubmits.length, 2);
  assert.ok(state.escalatedAt);
  const again = watchCtx(instance, [{ gigId: 7, status: '비승인', approvedAt: '2026-10-31', modifiedAt: '2026-10-29' }]);
  await listingsWatch(again.ctx);
  assert.equal(again.built.length, 0);
});

test('a gig on sale is announced to the operator once', async () => {
  const { listingsWatch } = await import('../src/cli/listings.mjs');
  const instance = publishedInstance();
  const w = watchCtx(instance, [{ gigId: 7, status: '판매중', title: 't', url: 'u' }]);
  assert.equal((await listingsWatch(w.ctx)).rows[0].action, 'notify_selling');
  assert.equal(w.notes.length, 1);
  assert.ok(w.events.some((e) => e.kind === 'listing.selling'));
  const w2 = watchCtx(instance, [{ gigId: 7, status: '판매중' }]);
  await listingsWatch(w2.ctx);
  assert.equal(w2.notes.length, 0);
  assert.equal(w2.k.calls.notice, 0);
});

test('a forced observe pass records the rejection but never resubmits', async () => {
  const { listingsWatch } = await import('../src/cli/listings.mjs');
  const { readCases } = await import('../src/learning/outcomes.mjs');
  const instance = publishedInstance();
  const w = watchCtx(instance, [{ gigId: 7, status: '비승인', approvedAt: '2026-10-27', modifiedAt: '2026-10-25' }], { ctx: { forceMode: 'observe' } });
  const r = await listingsWatch(w.ctx);
  assert.equal(r.rows[0].action, 'observed');
  assert.equal(w.built.length, 0);
  assert.equal(readCases(instance).length, 1);
  assert.equal(w.notes.length, 1);
});

test('a review notice given to buildListing is in the first prompt as a violation', async () => {
  const { reviewViolation } = await import('../src/listings/review.mjs');
  const codex = fakeCodex([draft()]);
  await buildListing('landing_page_web', ctx(codex, { violations: [reviewViolation('사유: 연락처가 이미지에 있습니다')], previous: draft() }));
  assert.equal(codex.calls.length, 1);
  assert.match(codex.calls[0].prompt, /previous draft was blocked/);
  assert.match(codex.calls[0].prompt, /kmong\.rejected/);
  assert.match(codex.calls[0].prompt, /연락처가 이미지에 있습니다/);
});

// ---- portfolio-driven proofs (src/listings/proofs.mjs, listingsRefresh) ----

const BG = (id, title, service) => ({ id, source: 'background', title_en: title, service, permission: 'granted', paidAt: null, satisfaction: null, quality: null, volume: null, media: [] });
const PROOFS = [{ id: 'site-a', project: 'Site A' }, { id: 'site-b', project: 'Site B' }];
const PROFILE = { serviceFit: { landing_page_web: { evidence: ['Site A', 'Site B'] } } };
const JOB = (over = {}) => ({ id: 'job-1', source: 'job', title_ko: '빵집 랜딩', service: 'landing_page_web', paidAt: '2026-11-01T00:00:00Z', permission: 'granted', satisfaction: { rating: 5, liked: true }, quality: 0.9, volume: { priceKRW: 300000, hours: 6 }, media: [{ src: 'media/job-1.jpg', kind: 'image', width: 1440, height: 900 }], ...over });

test('proof images follow rankPortfolio: a paid, permitted job that ranks first replaces a background project', async () => {
  const { proofPlan, basisChanged } = await import('../src/listings/proofs.mjs');
  const items = [BG('bg-a', 'Site A', 'landing_page_web'), BG('bg-b', 'Site B', 'landing_page_web')];
  const before = proofPlan({ service: 'landing_page_web', items, profile: PROFILE, proofs: PROOFS, maxItems: 2 });
  assert.deepEqual(before.basis, ['bg-a', 'bg-b']);
  assert.deepEqual(before.gallery.map((s) => s.id), ['site-a', 'site-b']);
  const after = proofPlan({ service: 'landing_page_web', items: [...items, JOB()], profile: PROFILE, proofs: PROOFS, maxItems: 2 });
  assert.deepEqual(after.basis, ['job-1', 'bg-a']);
  assert.equal(after.gallery[0].kind, 'media');
  assert.ok(basisChanged(before.basis, after.basis));
  // without the client's permission, or before payment, the job shows nothing
  for (const job of [JOB({ permission: 'pending' }), JOB({ paidAt: null })]) assert.deepEqual(proofPlan({ service: 'landing_page_web', items: [...items, job], profile: PROFILE, proofs: PROOFS, maxItems: 2 }).basis, ['bg-a', 'bg-b']);
  // a service with no own item shows its samples, labelled as samples
  const s = proofPlan({ service: 'photo_editing', items, profile: PROFILE, proofs: PROOFS, samples: [{ id: 'cutout', file: 'x.jpg', note: '누끼 예시' }] });
  assert.deepEqual(s.basis, []);
  assert.equal(s.gallery[0].kind, 'sample');
});

test('a gig is rebuilt only when its top items changed, it is on sale and it was not refreshed lately', async () => {
  const { refreshDecision } = await import('../src/cli/listings.mjs');
  const today = new Date('2026-11-20T00:00:00Z');
  assert.equal(refreshDecision({ status: '판매중', before: ['bg-a'], now: ['bg-a'], today }).refresh, false);
  assert.equal(refreshDecision({ status: '판매중', before: ['bg-a', 'bg-b'], now: ['job-1', 'bg-a'], today }).refresh, true);
  assert.equal(refreshDecision({ status: '승인 전', before: ['bg-a'], now: ['job-1'], today }).refresh, false);
  assert.equal(refreshDecision({ status: '판매중', before: ['bg-a'], now: ['job-1'], last: '2026-11-10T00:00:00Z', today }).refresh, false);
  assert.equal(refreshDecision({ status: '판매중', before: ['bg-a'], now: ['job-1'], last: '2026-11-01T00:00:00Z', today }).refresh, true);
});

test('the daily refresh opens kmong only when a gig shows changed top items', async () => {
  const { listingsRefresh } = await import('../src/cli/listings.mjs');
  const instance = publishedInstance();
  const spec = { ...listingOf(), portfolioBasis: [] };
  writeFileSync(join(instance.dir, 'listings', 'landing_page_web', 'spec.json'), JSON.stringify(spec));
  const r = await listingsRefresh({ instance, openKmong: async () => assert.fail('no change, no browser') });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rows, []);
});

// ---- no link or contact detail in listing or portfolio text ----

test('listing text refuses SNS handles beside the gate contact rules', async () => {
  const handle = listingOf();
  handle.imageCopy.proofCaptions = ['인스타그램 @studio_kr 계정 화면'];
  assert.ok(rulesOf(handle).includes('imageCopy.proof:contact.handle'));
  assert.ok(!rulesOf(listingOf({ faqs: [{ question: '메일은?', answer: '크몽 메시지로 문의해 주세요.' }, ...draft().faqs.slice(1)] })).some((r) => r.endsWith('contact.handle')));

});

// ---- kmong page shapes the write paths rely on ----

test('a /my-gigs row never reads the approval notice of the row below, and edit URLs give their ids', async () => {
  const { parseGigList } = await import('../src/platforms/kmong/parse.mjs');
  const { editIds } = await import('../src/platforms/kmong/adapter.mjs');
  const text = ['서비스 상태 안내', '승인 전', '#1', 'IT·프로그래밍', '랜딩페이지', '랜딩페이지 제작', '35,000원~', '제출 취소', '등록일', '2026.10.25',
    '판매중', '#2', '데이터 분석 레슨', '프로그래밍 레슨', '웹 레슨', '레슨', '150,000원~', '편집하기', '등록일', '2022.03.14', '승인 안내', '2026.07.30'].join('\n');
  const { gigs } = parseGigList(text);
  assert.equal(gigs[0].approvedAt, null);
  assert.equal(gigs[1].approvedAt, '2026-07-30');
  assert.deepEqual(editIds('https://kmong.com/my-gigs/edit/700001?rootCategoryId=7&subCategoryId=769&thirdCategoryId=76901'), { gigId: 700001, categoryIds: { root: 7, sub: 769, third: 76901 } });
  assert.deepEqual(editIds('https://kmong.com/my-gigs/edit/5'), { gigId: 5, categoryIds: { root: null, sub: null, third: null } });
  assert.equal(editIds('https://kmong.com/my-gigs'), null);
});
