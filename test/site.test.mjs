// Synthetic fixtures only: no value here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSite } from '../site/build.mjs';
import { rankPortfolio } from '../src/portfolio/rank.mjs';
import { DEFAULT_CHROME } from '../src/render/html2png.mjs';
import { tempDir } from './tmp.mjs';

const BIZ_REG_NO = '314-15-92653';
const PAYOUT_ACCOUNT = '271-828-182845';
const PHONE = '010-5555-0199';

function fixture() {
  const dir = tempDir('fsw-site-test-');
  const write = (file, data) => {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };
  write('profile.json', {
    person: { nameKo: '김예시', nameEn: 'Yesi Kim', handle: 'yesi', phone: PHONE, links: ['https://example.org/yesi'] },
    headline_ko: '작은 가게의 예약 페이지와 자동화를 만드는 개발자',
    headline_en: 'Developer who builds booking pages and automations for small shops',
    summary_ko: '예약 페이지와 반복 업무 자동화를 기획부터 배포까지 맡습니다.',
    summary_en: 'I plan, build and deploy booking pages and office automations.',
    roles: [{ org: 'Example Studio', title: 'Developer', period: '2023.01 to present' }],
    projects: [
      { name: 'Booking Page', name_ko: '예약 페이지', role: 'Author', url: 'https://example.org/booking', what: 'A booking page for a bakery.', stack: ['HTML', 'CSS'] },
      { name: 'Sheet Bot', role: 'Author', url: 'https://example.org/sheet-bot', what: 'A bot that fills a spreadsheet from orders.', stack: ['Node.js'] },
    ],
    serviceFit: {
      landing_page_web: { evidence: ['Booking Page'], strength: 'strong' },
      excel_macro: { evidence: ['Sheet Bot'], strength: 'some' },
      logo_brand: { evidence: [], strength: 'none' },
    },
    claimsNotToMake: [],
  });
  write('business.json', {
    company: 'Example Studio', bizRegNo: BIZ_REG_NO, email: 'hello@example.org', taxInvoice: true,
    payout: { bank: 'Example Bank', account: PAYOUT_ACCOUNT, holder: 'Yesi Kim' },
  });
  write('config.json', {
    timezone: 'Asia/Seoul',
    platforms: { kmong: { enabled: true, mode: 'observe' }, soomgo: { enabled: true, mode: 'observe' } },
    payment: { depositRatio: 0.5, milestoneThresholdKRW: 1000000, milestones: [0.3, 0.4, 0.3] },
    site: { domain: 'portfolio.example.org' },
  });
  write('pricing/price-table-20260101.json', { observedAt: '2026-01-01', rows: [
    { platform: 'soomgo', service: 'landing_page_web', baseKRW: 500000, viable: true },
    { platform: 'kmong', service: 'landing_page_web', baseKRW: 320000, viable: true },
    { platform: 'kmong', service: 'excel_macro', baseKRW: 10000, viable: false },
    { platform: 'kmong', service: 'logo_brand', baseKRW: 90000, viable: true },
  ] });
  write('platforms/kmong-state.json', { services: [{ url: 'https://kmong.com/gig/1' }, { url: 'https://elsewhere.example/gig' }] });
  // Paid jobs with every ranking signal, written straight to items.json; syncPortfolio keeps them.
  const job = (id, extra) => ({ id, source: 'job', title_ko: '작업 ' + id, title_en: 'Job ' + id, paidAt: '2026-01-0' + (id.length % 9 + 1) + 'T00:00:00Z', permission: 'granted', summary_ko: '요약 ' + id, summary_en: 'Summary ' + id, url: null, media: [], ...extra });
  write('portfolio/items.json', [
    job('q-low', { quality: 0.2 }),
    job('liked', { satisfaction: { rating: 5, liked: true }, client: { fame: 0.3 } }),
    job('famous', { satisfaction: { rating: 4.8 }, client: { fame: 0.9 } }),
    job('hidden', { satisfaction: { rating: 3 } }),
    job('pending', { permission: 'pending' }),
    job('q-high', { quality: 0.9, volume: { priceKRW: 300000 } }),
  ]);
  return dir;
}

const files = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)).map((f) => n + '/' + f) : [n]));

test('site build from a fixture instance', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed' }, async (t) => {
  const dir = fixture();
  const out = join(dir, 'dist');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = await buildSite({ instance: dir, out });
  const ko = readFileSync(join(out, 'index.html'), 'utf8');
  const en = readFileSync(join(out, 'en', 'index.html'), 'utf8');

  await t.test('writes both languages with share image, icons, robots, sitemap and a content hash', () => {
    assert.match(ko, /<html lang="ko">/);
    assert.match(en, /<html lang="en">/);
    assert.match(ko, /작은 가게의 예약 페이지/);
    assert.match(en, /booking pages and automations/);
    for (const f of ['og.jpg', 'og-en.jpg', 'favicon.svg', 'apple-touch-icon.png', 'robots.txt', 'sitemap.xml', '404.html']) assert.ok(existsSync(join(out, f)), f);
    assert.match(readFileSync(join(out, 'sitemap.xml'), 'utf8'), /https:\/\/portfolio\.example\.org\/en\//);
    assert.equal(readFileSync(join(out, '.content-hash'), 'utf8').trim(), result.hash);
  });

  await t.test('orders gallery cards exactly as rankPortfolio returns them', () => {
    const items = JSON.parse(readFileSync(join(dir, 'portfolio', 'items.json'), 'utf8'));
    const expected = rankPortfolio(items).map((i) => i.id);
    for (const html of [ko, en]) {
      const shown = [...html.matchAll(/<li class="work-item" id="work-([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(shown, expected);
    }
    assert.ok(!expected.includes('hidden') && !expected.includes('pending'));
  });

  await t.test('never carries an em dash or a private value from the fixture', () => {
    for (const f of files(out).filter((f) => /\.(html|txt|xml|svg|json|css)$/.test(f))) {
      const text = readFileSync(join(out, f), 'utf8');
      assert.doesNotMatch(text, /[\u2014\u2015]/, f + ' holds an em dash');
      for (const value of [BIZ_REG_NO, PAYOUT_ACCOUNT, PHONE]) {
        const digits = value.replace(/\D/g, '');
        assert.doesNotMatch(text, new RegExp(digits.split('').join('[\\s.\\-]*')), f + ' holds a private value');
      }
    }
  });

  await t.test('prices come from the newest table, only for viable rows of evidenced services', () => {
    assert.match(ko, /320,000원/);
    assert.match(ko, /크몽 기준/);
    assert.match(en, /KRW 320,000/);
    assert.doesNotMatch(ko, /엑셀 매크로/);
    assert.doesNotMatch(ko, /로고/);
    assert.match(ko, /전자세금계산서 발행 가능/);
    assert.match(ko, /https:\/\/kmong\.com\/gig\/1/);
    assert.doesNotMatch(ko, /elsewhere\.example/);
  });
});
