// Synthetic pages and rates only: no fixture here is a copied page or a real exchange rate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobsUrl, parseJobs, parseProjects, projectsUrl, sample as sampleFreelancer } from '../src/platforms/freelancer/market.mjs';
import { filterQuery, listUrl, parseCard as parseWishketCard, sample as sampleWishket } from '../src/platforms/wishket/market.mjs';
import { parseSearch, sample as sampleFiverr, searchUrl } from '../src/platforms/fiverr/market.mjs';
import { challengeOf } from '../src/platforms/kit.mjs';
import { latestSummary } from '../src/economics/market.mjs';
import { marketEngine, run, targetsFor } from '../src/cli/market.mjs';
import { archiveSession, archiveUrl, captureOf } from '../src/browser/archive.mjs';
import { validateDescriptor } from '../src/platforms/registry.mjs';

const fx = { date: '2026-10-23', source: 'https://api.frankfurter.dev/v1/latest?base=USD', rates: { INR: 80, KRW: 1200, USD: 1 } };
const project = (id, over = {}) => ({ id, type: 'fixed', seo_url: 'logo-design/Logo-' + id, title: 'Logo ' + id, currency: { code: 'USD' }, budget: { minimum: 30, maximum: 250 }, bid_stats: { bid_count: 12, bid_avg: 90 }, time_submitted: 1792800000, ...over });
const success = (result) => ({ json: { status: 'success', result } });

test('a freelancer project is a sample at its converted budget midpoint, and hourly or unpriced ones are counted by name', () => {
  const { total, projects, skipped } = parseProjects({ total_count: 177, projects: [
    project(1),
    project(2, { currency: { code: 'INR' }, budget: { minimum: 1500, maximum: 12500 }, bid_stats: { bid_count: 3, bid_avg: 0 } }),
    project(3, { type: 'hourly' }),
    project(4, { budget: { minimum: 250, maximum: null } }),
    project(5, { currency: { code: 'XTS' } }),
  ] }, fx);
  assert.equal(total, 177);
  assert.deepEqual(skipped, { notFixed: 1, noBudget: 1, currency: 1 });
  assert.deepEqual(projects[0], { url: 'https://www.freelancer.com/projects/logo-design/Logo-1', title: 'Logo 1', priceKRW: 168000, budget: { min: 30, max: 250, currency: 'USD' }, bids: 12, bidAvgKRW: 108000, postedAt: '2026-10-24T00:00:00.000Z', fx: { currency: 'USD', krwPerUnit: 1200, date: '2026-10-23', source: fx.source } });
  assert.equal(projects[1].priceKRW, 105000);
  assert.equal(projects[1].bidAvgKRW, null);
  assert.deepEqual(parseJobs([{ id: 32, name: 'Logo Design' }, { name: 'no id' }]), new Map([['Logo Design', 32]]));
});

test('the freelancer sampler resolves jobs by name and fails a missing job or an unreadable answer by name', async () => {
  const targets = [{ category: 'Logo Design' }, { category: 'Banner Design' }, { category: 'No Such Job' }];
  const pages = new Map([
    [jobsUrl(targets.map((t) => t.category)), success([{ id: 32, name: 'Logo Design' }, { id: 26, name: 'Banner Design' }])],
    [projectsUrl(32, 30), success({ total_count: 2, projects: [project(1), project(2)] })],
    [projectsUrl(26, 30), { title: '502 Bad Gateway', text: 'Bad gateway' }],
  ]);
  let url;
  const session = { navigate: async (u) => { url = u; }, evaluate: async () => pages.get(url) };
  const { rows, errors } = await sampleFreelancer(session, targets, { fx, now: () => new Date('2026-10-25T03:00:00Z') });
  assert.deepEqual(rows.map((r) => [r.platform, r.category, r.rank, r.priceKRW, r.listingTotal]), [['freelancer', 'Logo Design', 1, 168000, 2], ['freelancer', 'Logo Design', 2, 168000, 2]]);
  assert.deepEqual(errors.map((e) => e.category), ['Banner Design', 'No Such Job']);
  assert.match(errors[0].message, /502 Bad Gateway/);
  assert.match(errors[1].message, /no Freelancer job named No Such Job/);
});

// A default run over a config that lists kmong (enabled) and freelancer (disabled): kmong pages give one
// card each, freelancer pages answer from the synthetic API above.
function overseasRun({ loadFx }) {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-overseas-'));
  const instance = { config: { platforms: { kmong: { enabled: true, mode: 'auto' }, freelancer: { enabled: false, mode: 'observe' } } }, paths: { market: join(dir, 'market') } };
  const opened = [];
  const page = (url) => {
    if (url.startsWith('https://kmong.com/')) return { total: '10', cards: [{ href: '/gig/1', text: '제목\n50,000원~\n판매자' }] };
    if (url.includes('/jobs/?')) return success(targetsFor('freelancer').map((t, i) => ({ id: i + 1, name: t.category })));
    return success({ total_count: 1, projects: [project(7)] });
  };
  const withPage = async (platform, fn) => {
    opened.push(platform);
    let url;
    return fn({ navigate: async (u) => { url = u; }, evaluate: async () => page(url) });
  };
  const ctx = { instance, log: () => {}, now: () => new Date('2026-10-25T03:00:00Z'), withPage, loadFx };
  return { instance, opened, go: () => run([], ctx) };
}

test('the default market run samples a configured platform that is not enabled, at the day\'s exchange rate', async () => {
  const { instance, opened, go } = overseasRun({ loadFx: async () => fx });
  const result = await go();
  assert.equal(result.exitCode, 0);
  assert.deepEqual([...new Set(opened)], ['kmong', 'freelancer']);
  const freelancer = latestSummary(instance).entries.filter((e) => e.platform === 'freelancer');
  assert.equal(freelancer.length, targetsFor('freelancer').length);
  assert.ok(freelancer.every((e) => e.median === 168000 && e.n === 1));
});

test('without exchange rates the overseas categories fail by name, load no page, and the rest is still written', async () => {
  const failure = Object.assign(new Error('no exchange rates'), { code: 'FSW_FX_UNAVAILABLE' });
  const { instance, opened, go } = overseasRun({ loadFx: async () => { throw failure; } });
  const result = await go();
  assert.equal(result.exitCode, 1);
  assert.ok(!opened.includes('freelancer'));
  const fxErrors = result.errors.filter((e) => e.platform === 'freelancer');
  assert.equal(fxErrors.length, targetsFor('freelancer').length);
  assert.ok(fxErrors.every((e) => e.message === 'fx unavailable: no exchange rates'));
  assert.ok(latestSummary(instance).entries.every((e) => e.platform === 'kmong'));
});

const wishketCard = (id, over = {}) => ({ href: '/project/' + id + '/', title: '랜딩페이지 ' + id, status: '모집 중', budget: '예상 금액 2,500,000원', term: '예상 기간21일', field: '랜딩ㆍ소개 페이지 외 1개', type: '외주', posted: '· 등록일자 2026.10.21.', applicants: '12명', ...over });

test('a wishket card is a sample at its stated budget, and negotiable, monthly or term-based ones are skipped by name', () => {
  assert.deepEqual(parseWishketCard(wishketCard(1)), { project: { url: 'https://www.wishket.com/project/1/', title: '랜딩페이지 1', priceKRW: 2500000, status: '모집 중', days: 21, applicants: 12, postedOn: '2026-10-21', field: '랜딩ㆍ소개 페이지 외 1개' } });
  assert.equal(parseWishketCard(wishketCard(2, { applicants: '비공개' })).project.applicants, null);
  assert.deepEqual(parseWishketCard(wishketCard(3, { budget: '예상 금액 협의 후 결정' })), { skip: 'budget negotiable' });
  assert.deepEqual(parseWishketCard(wishketCard(4, { budget: '월 금액 5,000,000원 /월' })), { skip: 'monthly amount' });
  assert.deepEqual(parseWishketCard(wishketCard(5, { type: '기간제' })), { skip: 'term based' });
  assert.deepEqual(parseWishketCard(wishketCard(6, { href: null })), { skip: 'no project link' });
});

test('the wishket sampler encodes each field filter in the page, reads a second page only when there is one, and fails a field by name', async () => {
  const lists = new Map([
    [listUrl('ENC:' + filterQuery(45, 1)), { total: '12', cards: [wishketCard(1), wishketCard(2, { budget: '예상 금액 협의 후 결정' })] }],
    [listUrl('ENC:' + filterQuery(45, 2)), { total: '12', cards: [wishketCard(1), wishketCard(3, { budget: '예상 금액 8,000,000원' })] }],
    [listUrl('ENC:' + filterQuery(29, 1)), { total: '3', cards: [wishketCard(4, { budget: '예상 금액 협의 후 결정' })] }],
  ]);
  const loaded = [];
  let url;
  const session = {
    navigate: async (u) => { loaded.push(u); url = u; },
    evaluate: async (fn, arg) => {
      if (typeof arg === 'string') return 'ENC:' + arg;
      if (url === 'https://www.wishket.com/project/') return { title: '프로젝트 찾기', text: '', fields: [['랜딩ㆍ소개 페이지', '45'], ['ChatGPTㆍ챗봇', '29']] };
      return lists.get(url);
    },
  };
  const targets = [{ category: '랜딩ㆍ소개 페이지' }, { category: 'ChatGPTㆍ챗봇' }, { category: '없는 분야' }];
  const { rows, errors, skipped } = await sampleWishket(session, targets, { now: () => new Date('2026-10-25T03:00:00Z') });
  assert.deepEqual(rows.map((r) => [r.platform, r.category, r.rank, r.priceKRW, r.listingTotal]), [['wishket', '랜딩ㆍ소개 페이지', 1, 2500000, 12], ['wishket', '랜딩ㆍ소개 페이지', 2, 8000000, 12]]);
  assert.deepEqual(loaded, ['https://www.wishket.com/project/', listUrl('ENC:' + filterQuery(45, 1)), listUrl('ENC:' + filterQuery(45, 2)), listUrl('ENC:' + filterQuery(29, 1))]);
  assert.deepEqual(skipped, [{ category: '랜딩ㆍ소개 페이지', reason: 'budget negotiable', count: 1 }, { category: 'ChatGPTㆍ챗봇', reason: 'budget negotiable', count: 1 }]);
  assert.deepEqual(errors.map((e) => e.category), ['ChatGPTㆍ챗봇', '없는 분야']);
  assert.match(errors[1].message, /no project field named 없는 분야/);
});

const perseus = (over = {}) => JSON.stringify({ currency: { name: 'USD', rate: 1 }, appData: { pagination: { total: 230152 } }, listings: [{ gigs: [
  { gig_url: '/studio/logo', title: 'minimal logo', price_i: 15, buying_review_rating_count: 202, buying_review_rating: 4.8, seller_level: 'level_two_seller', is_pro: false },
  { gig_url: '/new/logo', title: 'new logo', price_i: 5 },
  { gig_url: '/free/logo', title: 'no price', price_i: 0 },
] }], ...over });

test('a fiverr search yields each gig\'s starting price in KRW, and a display currency other than USD fails by name', () => {
  const { total, gigs } = parseSearch(perseus(), fx);
  assert.equal(total, 230152);
  assert.deepEqual(gigs[0], { url: 'https://www.fiverr.com/studio/logo', title: 'minimal logo', priceKRW: 18000, priceUSD: 15, fromPrice: true, reviews: 202, rating: 4.8, sellerLevel: 'level_two_seller', pro: false, fx: { currency: 'USD', krwPerUnit: 1200, date: '2026-10-23', source: fx.source } });
  assert.deepEqual(gigs.map((g) => [g.priceUSD, g.reviews, g.rating]), [[15, 202, 4.8], [5, 0, null]]);
  assert.throws(() => parseSearch(perseus({ currency: { name: 'KRW', rate: 1400 } }), fx), /display currency KRW at rate 1400/);
});

test('bot walls are named by vendor, and the first one ends a sampler\'s reads for every later target', async () => {
  assert.equal(challengeOf({ title: 'It needs a human touch', text: 'ERRCODE PXCR10002539' }), 'perimeterx');
  assert.equal(challengeOf({ title: 'Attention Required! | Cloudflare', text: 'Sorry, you have been blocked' }), 'cloudflare');
  assert.equal(challengeOf({ title: 'Logo Design Jobs', text: 'Find jobs' }), null);
  const loaded = [];
  const session = { navigate: async (u) => { loaded.push(u); }, evaluate: async () => ({ title: 'It needs a human touch', text: 'Press & Hold', props: null }) };
  const targets = [{ category: 'logo design' }, { category: 'video editing' }, { category: 'copywriting' }];
  const { rows, errors } = await sampleFiverr(session, targets, { fx });
  assert.equal(rows.length, 0);
  assert.deepEqual(loaded, [searchUrl('logo design')]);
  assert.deepEqual(errors.map((e) => [e.category, e.challenge]), [['logo design', 'perimeterx'], ['video editing', 'perimeterx'], ['copywriting', 'perimeterx']]);
});

test('the market run reports a bot challenge by name and does not retry it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-overseas-'));
  const instance = { config: { platforms: { kmong: { enabled: true, mode: 'auto' }, fiverr: { enabled: false, mode: 'observe' } } }, paths: { market: join(dir, 'market') } };
  const opened = [];
  const withPage = async (platform, fn, { engine }) => {
    opened.push(platform + ':' + engine);
    let url;
    const page = () => (url.startsWith('https://kmong.com/') ? { total: '10', cards: [{ href: '/gig/1', text: '제목\n50,000원~\n판매자' }] } : { title: 'It needs a human touch', text: 'PXCR10002539', props: null });
    return fn({ navigate: async (u) => { url = u; }, evaluate: async () => page() });
  };
  const result = await run([], { instance, log: () => {}, now: () => new Date('2026-10-25T03:00:00Z'), withPage, loadFx: async () => fx });
  assert.deepEqual(opened.filter((p) => p.startsWith('fiverr')), ['fiverr:attached']);
  const walls = result.errors.filter((e) => e.platform === 'fiverr');
  assert.equal(walls.length, targetsFor('fiverr').length);
  assert.ok(walls.every((e) => e.challenge === 'perimeterx' && e.engine === 'attached' && /perimeterx bot challenge on https:\/\/www\.fiverr\.com\/search\/gigs/.test(e.message)));
  assert.equal(result.exitCode, 1);
});

test('a platform\'s market engine is the operator\'s setting, else its descriptor\'s, else owned, and an unknown one fails by name', () => {
  assert.equal(marketEngine('fiverr', {}), 'attached');
  assert.equal(marketEngine('fiverr', { market: { engines: { fiverr: null } } }), 'attached');
  assert.equal(marketEngine('fiverr', { market: { engines: { fiverr: 'archive' } } }), 'archive');
  assert.equal(marketEngine('kmong', { market: { engines: { fiverr: 'archive' } } }), 'owned');
  assert.equal(marketEngine('kmong', { market: { engines: { kmong: 'attached' } } }), 'attached');
  assert.throws(() => marketEngine('fiverr', { market: { engines: { fiverr: 'proxy' } } }), (err) => err.code === 'FSW_MARKET_ENGINE_UNKNOWN' && /"proxy" for fiverr/.test(err.message));
  const fiverrDescriptor = JSON.parse(readFileSync(new URL('../src/platforms/descriptors/fiverr.json', import.meta.url), 'utf8'));
  assert.throws(() => validateDescriptor({ ...fiverrDescriptor, market: { engine: 'stealth' } }), /market\.engine/);
});

test('the market run opens each platform through its configured engine, and refuses an engine its sampler cannot date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-overseas-'));
  const instance = { config: { platforms: { kmong: { enabled: true, mode: 'auto' }, fiverr: { enabled: false, mode: 'observe' } }, market: { engines: { kmong: 'archive', fiverr: 'owned' } } }, paths: { market: join(dir, 'market') } };
  const opened = [];
  const withPage = async (platform, fn, { engine }) => {
    opened.push(platform + ':' + engine);
    return fn({ navigate: async () => {}, evaluate: async () => ({ title: 'Fiverr', text: '', props: perseus() }) });
  };
  const result = await run([], { instance, log: () => {}, now: () => new Date('2026-10-25T03:00:00Z'), withPage, loadFx: async () => fx });
  assert.deepEqual([...new Set(opened)], ['fiverr:owned']);
  const kmong = result.errors.filter((e) => e.platform === 'kmong');
  assert.equal(kmong.length, targetsFor('kmong').length);
  assert.ok(kmong.every((e) => /kmong sampler cannot read through the archive engine/.test(e.message)));
  const samples = readFileSync(result.samplesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(samples.length > 0 && samples.every((r) => r.platform === 'fiverr' && r.engine === 'owned'));
});

test('an archive snapshot is dated by its capture, keeps its address, and a missing or stale one fails by name', async () => {
  assert.equal(captureOf('https://web.archive.org/web/20260128032306id_/https://www.fiverr.com/search/gigs?query=x'), '2026-01-28T03:23:06.000Z');
  assert.equal(captureOf('https://web.archive.org/web/29991231id_/x'), null);
  const target = searchUrl('logo design');
  const captured = 'https://web.archive.org/web/20261020120000id_/' + target;
  const loaded = [];
  const page = (href) => ({
    navigate: async (u) => { loaded.push(u); },
    evaluate: async (fn) => (String(fn).includes('location.href') ? href : { title: 'Fiverr', text: '', props: perseus() }),
  });
  const now = () => new Date('2026-10-25T03:00:00Z');
  const { rows, errors } = await sampleFiverr(archiveSession(page(captured), { now, maxAgeDays: 7 }), [{ category: 'logo design' }], { fx, now });
  assert.deepEqual(errors, []);
  assert.deepEqual(loaded, [archiveUrl(target)]);
  assert.ok(rows.length === 2 && rows.every((r) => r.observedAt === '2026-10-20T12:00:00.000Z' && r.snapshot === captured));
  const missing = await sampleFiverr(archiveSession(page('https://web.archive.org/web/29991231id_/' + target), { now, maxAgeDays: 7 }), [{ category: 'logo design' }], { fx, now });
  assert.match(missing.errors[0].message, /no archive snapshot of https:\/\/www\.fiverr\.com/);
  const stale = await sampleFiverr(archiveSession(page('https://web.archive.org/web/20170301095312id_/' + target), { now, maxAgeDays: 7 }), [{ category: 'logo design' }], { fx, now });
  assert.match(stale.errors[0].message, /is from 2017-03-01T09:53:12\.000Z, older than 7 days/);
});
