// The synthetic instance the site tests and the site workflow build (.github/workflows/site.yml). No value here
// comes from an operator instance; PRIVATE holds the values the build must never print.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PRIVATE = Object.freeze({ BIZ_REG_NO: '314-15-92653', PAYOUT_ACCOUNT: '271-828-182845', PHONE: '010-5555-0199' });
const { BIZ_REG_NO, PAYOUT_ACCOUNT, PHONE } = PRIVATE;

export function writeSiteFixture(dir) {
  mkdirSync(dir, { recursive: true });
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
