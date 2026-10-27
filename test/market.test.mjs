import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listingUrl, parseCard, parseListing } from '../src/platforms/kmong/market.mjs';
import { koreanAmount, parseGuide } from '../src/platforms/soomgo/market.mjs';
import { latestSummary, summarizeDay } from '../src/economics/market.mjs';
import { targetsFor } from '../src/economics/catalog.mjs';
import { sampleMarket } from '../src/economics/sampling.mjs';
import { SAMPLERS } from '../src/surface/index.mjs';

const run = (platforms, ctx) => sampleMarket(ctx.instance, { ...ctx, platforms, samplers: SAMPLERS });
import { tempDir } from './tmp.mjs';

test('a kmong card yields title, rating, reviews, starting price, seller and badges', () => {
  const card = parseCard({ href: '/gig/1', text: '브랜드 로고 제작\n\n4.9\n\n(2,391)\n60,000원~\n스튜디오 A\n\n빠른 응답\n\n세금계산서' });
  assert.deepEqual(card, { href: '/gig/1', title: '브랜드 로고 제작', seller: '스튜디오 A', priceKRW: 60000, fromPrice: true, rating: 4.9, reviews: 2391, badges: ['빠른 응답', '세금계산서'], img: null });
  assert.equal(parseCard({ href: '/gig/1', text: '로고\n60,000원~\n판매자', img: 'https://cdn.example/cover.jpg' }).img, 'https://cdn.example/cover.jpg');
});

test('a card without reviews has no rating, and a card without a price is skipped', () => {
  assert.deepEqual(parseCard({ href: '/gig/2', text: '새 상세페이지\n35,000원\n신규 판매자' }), { href: '/gig/2', title: '새 상세페이지', seller: '신규 판매자', priceKRW: 35000, fromPrice: false, rating: null, reviews: 0, badges: [], img: null });
  assert.equal(parseCard({ href: '/gig/3', text: '가격 없는 카드\n판매자' }), null);
});

test('a listing dedupes cards by href and keeps the first priced ones up to the limit', () => {
  const card = (n) => ({ href: `/gig/${n}`, text: `제목 ${n}\n${n},000원~\n판매자 ${n}` });
  const listing = parseListing({ total: '2,955', cards: [card(1), card(1), { href: '/gig/x', text: 'no price' }, card(2), card(3)] }, { limit: 2 });
  assert.equal(listing.total, 2955);
  assert.deepEqual(listing.cards.map((c) => c.href), ['/gig/1', '/gig/2']);
});

test('a service samples its kmong category page, or a keyword search on its label', () => {
  assert.equal(listingUrl({ kmongCategory: '로고 디자인', kmongCategoryId: 101 }), 'https://kmong.com/category/101');
  assert.equal(listingUrl({ kmongCategory: '데이터 크롤링' }), 'https://kmong.com/search?type=gig&keyword=%EB%8D%B0%EC%9D%B4%ED%84%B0%20%ED%81%AC%EB%A1%A4%EB%A7%81');
});

test('Korean amounts read 억, 만 and 천 units and plain digits', () => {
  assert.equal(koreanAmount('7만 5천원'), 75000);
  assert.equal(koreanAmount('1만 3천원'), 13000);
  assert.equal(koreanAmount('160만원'), 1600000);
  assert.equal(koreanAmount('1억 2000만원'), 120000000);
  assert.equal(koreanAmount('1,600,000원'), 1600000);
  assert.equal(koreanAmount('없음'), null);
});

const guideText = (sentence) => `영어 번역\n평균\n7만\n최저\n1만 3천원\n~\n최고\n80만원\n누적 견적요청\n53,929건\n활동고수\n51,912명\n${sentence}`;

test('the guide sentence in digits wins over the rounded label lines and keeps its unit', () => {
  assert.deepEqual(parseGuide(guideText('평균 비용은 건당 79,000원이에요. 최저 비용은 13,000원이고 최고 비용은 800,000원으로 책정되었답니다.')), { avgKRW: 79000, minKRW: 13000, maxKRW: 800000, unit: '건', quoteRequests: 53929, activePros: 51912 });
  assert.equal(parseGuide(guideText('평균 비용은 장당 20,000원이에요. 최저 비용은 10,000원이고 최고 비용은 75,000원으로 책정되었답니다.')).unit, '장');
  const variant = parseGuide(guideText('평균 비용은 58,000원이예요. 최저 비용은 19,000원이고 최대 비용은 160,000원이예요.'));
  assert.deepEqual([variant.avgKRW, variant.minKRW, variant.maxKRW, variant.unit], [58000, 19000, 160000, null]);
});

test('label lines stand in when the sentence is missing, and a page with neither fails', () => {
  const fromLines = parseGuide(guideText(''));
  assert.deepEqual([fromLines.avgKRW, fromLines.minKRW, fromLines.maxKRW], [70000, 13000, 800000]);
  assert.throws(() => parseGuide('견적요청\n고수찾기'), /price guide figures not found/);
});

test('a day summary turns listing samples into quantiles and passes price-guide figures through', () => {
  const at = '2026-10-24T15:05:00.000Z';
  const rows = [10000, 20000, 30000, 40000, 50000].map((priceKRW, i) => ({ platform: 'kmong', category: '로고 디자인', priceKRW, reviews: i, observedAt: at }));
  rows.push({ platform: 'soomgo', category: '로고 디자인', url: 'https://soomgo.com/prices/x', guide: { avgKRW: 100000, minKRW: 50000, maxKRW: 300000, unit: '건', quoteRequests: 117808, activePros: 57509 }, observedAt: at });
  const [listing, guide] = summarizeDay(rows);
  assert.deepEqual([listing.platform, listing.n, listing.p25, listing.median, listing.p75], ['kmong', 5, 20000, 30000, 40000]);
  assert.deepEqual(guide, { platform: 'soomgo', category: '로고 디자인', n: 117808, minKRW: 50000, p25: null, median: null, p75: null, maxKRW: 300000, avgKRW: 100000, unit: '건', activePros: 57509, url: 'https://soomgo.com/prices/x', observedAt: at });
});

test('fsw market retries a failed category once, reports what still fails and writes the files fsw price reads', async () => {
  const dir = tempDir('fsw-market-');
  const instance = { config: { platforms: { kmong: { enabled: true, mode: 'auto' }, soomgo: { enabled: true, mode: 'auto' }, upwork: { enabled: false } } }, paths: { market: join(dir, 'market') } };
  const card = (n, price) => ({ href: `/gig/${n}`, text: `제목 ${n}\n${price}원~\n판매자 ${n}` });
  let keywordLoads = 0;
  const page = (url) => {
    if (url.startsWith('https://kmong.com/')) {
      if (url.includes('keyword=') && keywordLoads++ === 0) return { total: null, cards: [] };
      return { total: '1,000', cards: [card(1, '10,000'), card(2, '20,000'), card(3, '30,000')] };
    }
    if (url === 'https://soomgo.com/prices') return targetsFor('soomgo').filter((t) => t.category !== '웹 개발').map((t) => [t.category, '/prices/' + encodeURIComponent(t.category)]);
    return guideText('평균 비용은 건당 100,000원이에요. 최저 비용은 50,000원이고 최고 비용은 300,000원이 책정되었답니다.');
  };
  const fakeSession = () => {
    let url = null;
    return { navigate: async (u) => { url = u; }, evaluate: async () => page(url) };
  };
  const ctx = { instance, log: () => {}, now: () => new Date('2026-10-24T15:00:00Z'), withPage: async (platform, fn) => fn(fakeSession()) };

  const first = await run([], ctx);
  assert.equal(first.exitCode, 1);
  assert.deepEqual(first.errors.map(({ platform, category }) => [platform, category]), [['soomgo', '웹 개발']]);
  const { day, entries } = latestSummary(instance);
  assert.equal(day, '20261025');
  assert.deepEqual(entries.filter((e) => e.platform === 'kmong').map((e) => e.category).sort(), targetsFor('kmong').map((t) => t.category).sort());
  assert.equal(entries.filter((e) => e.platform === 'soomgo').length, targetsFor('soomgo').length - 1);
  assert.ok(entries.every((e) => e.platform !== 'soomgo' || e.avgKRW === 100000));
  assert.equal(readFileSync(first.samplesFile, 'utf8').trim().split('\n').length, targetsFor('kmong').length * 3 + targetsFor('soomgo').length - 1);

  const again = await run([], ctx);
  assert.equal(again.written, false);
});

test('a named market run replaces only the pairs it read and keeps the rest of the day', async () => {
  const dir = tempDir('fsw-market-');
  const instance = { config: { platforms: { kmong: { enabled: true, mode: 'auto' }, soomgo: { enabled: true, mode: 'auto' } } }, paths: { market: join(dir, 'market') } };
  const [broken] = targetsFor('kmong');
  let price = '10,000';
  let failing = null;
  const page = (url) => {
    if (url.startsWith('https://kmong.com/')) return url === failing ? { total: null, cards: [] } : { total: '1,000', cards: [{ href: '/gig/1', text: `제목\n${price}원~\n판매자` }] };
    if (url === 'https://soomgo.com/prices') return targetsFor('soomgo').map((t) => [t.category, '/prices/' + encodeURIComponent(t.category)]);
    return guideText('평균 비용은 건당 100,000원이에요. 최저 비용은 50,000원이고 최고 비용은 300,000원이 책정되었답니다.');
  };
  const fakeSession = () => {
    let url = null;
    return { navigate: async (u) => { url = u; }, evaluate: async () => page(url) };
  };
  const ctx = { instance, log: () => {}, now: () => new Date('2026-10-25T03:00:00Z'), withPage: async (platform, fn) => fn(fakeSession()) };
  await run([], ctx);

  price = '20,000';
  failing = listingUrl(broken.def);
  const named = await run(['kmong'], ctx);
  assert.deepEqual(named.errors.map(({ platform, category }) => [platform, category]), [['kmong', broken.category]]);
  const { entries } = latestSummary(instance);
  assert.equal(entries.filter((e) => e.platform === 'soomgo').length, targetsFor('soomgo').length);
  const kmong = entries.filter((e) => e.platform === 'kmong');
  assert.equal(kmong.length, targetsFor('kmong').length);
  assert.equal(kmong.find((e) => e.category === broken.category).median, 10000);
  assert.ok(kmong.filter((e) => e.category !== broken.category).every((e) => e.median === 20000));
  const samples = readFileSync(named.samplesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(samples.filter((r) => r.platform === 'soomgo').length, targetsFor('soomgo').length);
  assert.equal(samples.filter((r) => r.platform === 'kmong').length, targetsFor('kmong').length);
});

test('a new day that cannot read a platform keeps its recent samples with their old dates, and drops them after a week', async () => {
  const dir = tempDir('fsw-market-');
  const instance = { config: { platforms: { kmong: { enabled: true, mode: 'auto' }, soomgo: { enabled: true, mode: 'auto' } } }, paths: { market: join(dir, 'market') } };
  let soomgoDown = false;
  const page = (url) => {
    if (url.startsWith('https://kmong.com/')) return { total: '1,000', cards: [{ href: '/gig/1', text: '제목\n10,000원~\n판매자' }] };
    if (url === 'https://soomgo.com/prices') return soomgoDown ? [] : targetsFor('soomgo').map((t) => [t.category, '/prices/' + encodeURIComponent(t.category)]);
    return guideText('평균 비용은 건당 100,000원이에요. 최저 비용은 50,000원이고 최고 비용은 300,000원이 책정되었답니다.');
  };
  const fakeSession = () => {
    let url = null;
    return { navigate: async (u) => { url = u; }, evaluate: async () => page(url) };
  };
  const on = (iso) => ({ instance, log: () => {}, now: () => new Date(iso), withPage: async (platform, fn) => fn(fakeSession()) });
  await run([], on('2026-10-24T15:00:00Z'));
  soomgoDown = true;
  await run([], on('2026-10-25T15:00:00Z'));
  let summary = latestSummary(instance);
  assert.equal(summary.day, '20261026');
  const soomgo = summary.entries.filter((e) => e.platform === 'soomgo');
  assert.equal(soomgo.length, targetsFor('soomgo').length);
  assert.ok(soomgo.every((e) => e.observedAt === '2026-10-24T15:00:00.000Z'));
  await run([], on('2026-11-02T15:00:00Z'));
  summary = latestSummary(instance);
  assert.equal(summary.day, '20261103');
  assert.equal(summary.entries.filter((e) => e.platform === 'soomgo').length, 0);
});
