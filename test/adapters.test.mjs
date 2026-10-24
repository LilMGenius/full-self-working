import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacingGuard, resolveOmowrightScript } from '../src/browser/driver.mjs';
import { redactDigits, snippet } from '../src/platforms/kit.mjs';
import * as kmong from '../src/platforms/kmong/parse.mjs';

const NOW = new Date('2026-10-25T03:00:00Z');

function fakeClock() {
  let t = 1_000_000;
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, advance: (ms) => { t += ms; }, slept };
}

test('page loads wait out minGapMs from the previous load', async () => {
  const c = fakeClock();
  const g = createPacingGuard('kmong', { minGapMs: 6000, maxActionsPerHour: 100, maxMessagesPerHour: 10 }, c);
  await g.beforeLoad();
  c.advance(2000);
  await g.beforeLoad();
  c.advance(9000);
  await g.beforeLoad();
  assert.deepEqual(c.slept, [4000]);
});

test('actions stop at the hourly cap and free up once the hour rolls over', async () => {
  const c = fakeClock();
  const g = createPacingGuard('soomgo', { minGapMs: 1, maxActionsPerHour: 3, maxMessagesPerHour: 1 }, c);
  await g.beforeLoad();
  g.beforeAction();
  g.beforeAction();
  assert.throws(() => g.beforeAction(), { code: 'FSW_PACING_LIMIT' });
  await assert.rejects(g.beforeLoad(), { code: 'FSW_PACING_LIMIT' });
  c.advance(3_600_001);
  g.beforeAction();
  g.beforeMessage();
  assert.throws(() => g.beforeMessage(), { kind: 'message' });
});

test('the newest omo version directory wins, and FSW_OMOWRIGHT overrides it', () => {
  const root = mkdtempSync(join(tmpdir(), 'fsw-omo-'));
  for (const v of ['5.1.9', '5.1.45', '5.1.100-beta']) {
    const dir = join(root, v, 'skills', 'browser', 'scripts');
    if (v !== '5.1.100-beta') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'omowright.mjs'), '');
    } else mkdirSync(join(root, v), { recursive: true });
  }
  assert.match(resolveOmowrightScript({}, root), /5\.1\.45/);
  assert.equal(resolveOmowrightScript({ FSW_OMOWRIGHT: 'x.mjs' }, root), 'x.mjs');
  assert.throws(() => resolveOmowrightScript({}, join(root, 'none')), { code: 'FSW_NO_OMOWRIGHT' });
});

test('snippets drop phone numbers, safe numbers and long digit runs but keep prices and years', () => {
  assert.equal(redactDigits('0504 3799 0704 로 전화 주세요'), '[number] 로 전화 주세요');
  assert.equal(redactDigits('010-1234-5678 으로'), '[number] 으로');
  assert.equal(redactDigits('계좌 12345678901 입니다'), '계좌 [number] 입니다');
  assert.equal(redactDigits('220,000원, 2026년, 26.10.16'), '220,000원, 2026년, 26.10.16');
  assert.equal(snippet('가'.repeat(100)).length, 80);
});

test('kmong dates: MM.DD is the current Seoul year, YY.MM.DD names its year', () => {
  assert.equal(kmong.parseKmongDate('10.16', NOW), '2026-10-16T00:00:00+09:00');
  assert.equal(kmong.parseKmongDate('25.12.12', NOW), '2025-12-12T00:00:00+09:00');
  assert.equal(kmong.parseKmongDate('26.10.16 08:37', NOW), '2026-10-16T08:37:00+09:00');
  assert.equal(kmong.parseKmongDate('어제', NOW), null);
});

test('kmong inbox rows carry ids, unread from the 안읽음 tab and redacted previews', () => {
  const rows = [
    { href: '?inbox_group_id=111&partner_id=9', nickname: '의뢰인A', time: '10.20', preview: '랜딩 페이지 견적 문의드려요' },
    { href: '?inbox_group_id=222&partner_id=8', nickname: '의뢰인B', time: '25.01.02', preview: '010 9999 8888 로 연락 주세요' },
  ];
  const t = kmong.parseInbox(rows, ['?inbox_group_id=111&partner_id=9'], NOW);
  assert.deepEqual(t.map((x) => [x.id, x.partnerId, x.unread]), [['111', '9', true], ['222', '8', false]]);
  assert.equal(t[1].preview, '[number] 로 연락 주세요');
  assert.equal(t[0].at, '2026-10-20T00:00:00+09:00');
});

test('kmong thread splits the inquiry card from the first message and marks direction', () => {
  const t = kmong.parseThread({
    id: '111',
    nickname: '의뢰인A',
    gigHrefs: ['/gig/12345'],
    bubbles: [
      { text: '문의 서비스\n로고 디자인 해드립니다\n50,000원\n안녕하세요', stamp: '26.10.15 21:48', outbound: false },
      { text: '네 안녕하세요', stamp: '26.10.16 00:57', outbound: true },
      { text: '연락처 010-2222-3333 입니다', stamp: '26.10.16 08:37', outbound: false },
    ],
    composer: { found: true, disabled: false, sendButton: true },
  }, NOW);
  assert.equal(t.gigId, 12345);
  assert.deepEqual(t.messages[0].inquiry, { gigTitle: '로고 디자인 해드립니다', priceKRW: 50000 });
  assert.equal(t.messages[0].text, '안녕하세요');
  assert.deepEqual(t.messages.map((m) => m.direction), ['in', 'out', 'in']);
  assert.equal(t.messages[2].text, '연락처 [number] 입니다');
  assert.equal(t.canReply, true);
  assert.equal(kmong.parseThread({ id: '1', composer: { found: true, disabled: true } }).canReply, false);
});

test('kmong gig list reads counts and each gig row after 서비스 상태 안내', () => {
  const text = ['내 서비스', '전체', '2', '승인 전', '0', '판매중', '1', '비승인', '0', '판매 중지', '1', '서비스 상태 안내',
    '판매중', '#111', '디자인', '로고 디자인', '심볼 로고', '심플한 로고 만들어 드립니다', '30,000원~', '편집하기', '등록일', '2026.01.02', '수정일', '2026.02.03', '승인 안내', '2026.02.04',
    '판매 중지', '#222', 'IT·프로그래밍', '웹 제작', '랜딩페이지', '반응형 랜딩페이지', '150,000원', '편집하기', '등록일', '2025.05.06', '빠른 서비스 등록을 위해 꼭 읽어주세요'].join('\n');
  const r = kmong.parseGigList(text);
  assert.deepEqual(r.counts, { all: 2, waiting: 0, selling: 1, rejected: 0, suspended: 1 });
  assert.equal(r.gigs.length, 2);
  assert.deepEqual(r.gigs[0], { gigId: 111, status: '판매중', category: ['디자인', '로고 디자인', '심볼 로고'], title: '심플한 로고 만들어 드립니다', priceKRW: 30000, priceFrom: true, url: 'https://kmong.com/gig/111', registeredAt: '2026-01-02', modifiedAt: '2026-02-03', approvedAt: '2026-02-04' });
  assert.equal(r.gigs[1].priceFrom, false);
  assert.equal(r.gigs[1].modifiedAt, null);
});

test('kmong orders: counters by testid; rows present without a parser are a named gap', () => {
  const counters = { 'ongoing-count': '2건', 'complete-count': '1건' };
  const empty = kmong.parseOrders({ counters, emptyState: true });
  assert.equal(empty.counts.ongoing, 2);
  assert.equal(empty.counts.late, null);
  assert.equal(empty.total, 3);
  assert.deepEqual(empty.orders, []);
  assert.equal(kmong.parseOrders({ counters, emptyState: false }).orders, null);
});

test('kmong dashboard and profile read their labelled values', () => {
  const d = kmong.parseDashboard(['프로필 완성도', '70%', '비즈머니', '10% 추가 적립', '내 등급', 'NEW', '비즈머니', '1,000원', '월별 수익금 현황', '0원', '진행 중인 주문', '3건', '평균 객단가', '0원', '평균 응답 시간', '1시간 이내', '응답률', '90%'].join('\n'));
  assert.deepEqual(d, { grade: 'NEW', bizmoneyKRW: 1000, monthlyEarningsKRW: 0, ongoingOrders: 3, averageOrderKRW: 0, averageResponse: '1시간 이내', responseRate: '90%', profileCompletion: '70%' });
  const p = kmong.parseProfile(['예시전문가', '편집', '4.8', '(12)', '총 작업 수', '15개', '만족도', '98%', '세금계산서 발행 가능', '연락 가능 시간: 10시 ~ 18시', '평균 응답 시간: 1시간 이내', '총 3년', '전문분야∙상세분야', '필수', '편집', '∙', '디자인', '로고', '보유 기술', '소개', '필수', '편집', '깔끔한 디자인을 합니다', '포트폴리오', '서비스', '바로가기', '로고 디자인', '30,000원~', '예시전문가'].join('\n'), { nickname: '예시전문가' });
  assert.equal(p.rating, 4.8);
  assert.equal(p.reviews, 12);
  assert.equal(p.totalJobs, 15);
  assert.equal(p.contactHours, '10시 ~ 18시');
  assert.equal(p.headline, '깔끔한 디자인을 합니다');
  assert.deepEqual(p.specialties, ['디자인', '로고']);
  assert.deepEqual(p.services, [{ title: '로고 디자인', priceKRW: 30000 }]);
});

test('kmong listing form maps counters, packages, prices and limits', () => {
  const f = kmong.parseListingForm({
    url: 'https://kmong.com/my-gigs/edit/111?rootCategoryId=1&subCategoryId=101&thirdCategoryId=10101',
    title: '심플한 로고',
    headings: ['심플한 로고', '상세 정보', '메인 이미지\n\n(1/4)', '상세 이미지\n\n(2/9)', '동영상\n\n(0/6)', '가격 정보', '판매 핵심 정보\n\n작성하면', '검색 키워드\n\n(3/5)', '자주 묻는 질문\n\n(1/50)', '추가 정보'],
    counters: ['500/20000', '120/20000', '80/20000'],
    packages: { '0.0': '기본', '0.1': '표준', '0.2': '고급', '1.0': '시안 1개', '1.1': '시안 2개', '1.2': '시안 3개' },
    prices: ['30,000', '66,000', '120,000'],
    faqs: [{ question: '수정 횟수는?', answer: '3회입니다' }],
    limits: { packageTitle: 20, packageDescription: 60, faq: 255, keyword: 20 },
  });
  assert.equal(f.gigId, 111);
  assert.deepEqual(f.category, { root: 1, sub: 101, third: 10101 });
  assert.deepEqual(f.sections, ['상세 정보', '가격 정보', '판매 핵심 정보', '추가 정보']);
  assert.deepEqual(f.description, { length: 500, maxChars: 20000 });
  assert.deepEqual(f.images, { main: { count: 1, max: 4 }, detail: { count: 2, max: 9 }, video: { count: 0, max: 6 } });
  assert.deepEqual(f.packages[1], { tier: 'DELUXE', title: '표준', description: '시안 2개', priceKRW: 66000 });
  assert.deepEqual(f.keywords, { count: 3, max: 5 });
  assert.equal(f.limits.packageDescription, 60);
});
