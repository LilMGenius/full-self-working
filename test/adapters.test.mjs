import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserInstance, createPacingGuard, pickBrowser, resolveOmowrightScript } from '../src/browser/driver.mjs';
import { redactDigits, snippet } from '../src/platforms/kit.mjs';
import * as kmong from '../src/platforms/kmong/parse.mjs';
import * as soomgo from '../src/platforms/soomgo/parse.mjs';
import { openKmongConversation as openKmong } from '../src/platforms/kmong/conversation.mjs';
import { openSoomgo } from '../src/platforms/soomgo/adapter.mjs';
import { tempDir } from './tmp.mjs';

// A stand-in driver session: page extractors are answered by function name, and every action is logged
// so a test can prove a refusal happened before anything touched the page.
function fakeSession(answers) {
  const log = [];
  const s = {
    loads: 0,
    log,
    guard: { beforeMessage: () => log.push('message') },
    navigate: async (url) => { log.push('navigate ' + url); s.loads += 1; return url; },
    evaluate: async (fn, arg) => { log.push('evaluate ' + (fn.name || 'inline')); const a = answers[fn.name]; return typeof a === 'function' ? a(arg) : a; },
    click: async (t) => log.push('click ' + t),
    fill: async (t) => log.push('fill ' + t),
    typeKeys: async (t) => log.push('type ' + t),
    setFiles: async (t) => log.push('files ' + t),
    stop: async () => {},
  };
  return s;
}
const acted = (log) => log.filter((l) => /^(click|fill|type|files|message)/.test(l));

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
  const root = tempDir('fsw-omo-');
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

test('a session starts in the configured browser, the single online one, or fails naming them', () => {
  const chrome = { instance_id: 'aa11', label: '', browser_name: 'chrome', browser_version: '155.0.0.0' };
  const aside = { instance_id: 'bb22', label: 'aside', browser_name: 'chrome', browser_version: '154.0.0.0' };
  assert.equal(pickBrowser([aside, chrome], 'aa11'), 'aa11');
  assert.equal(pickBrowser([chrome, aside], 'aside'), 'bb22');
  // An id that changed after a restart, or no setting, still finds the only browser online.
  assert.equal(pickBrowser([chrome], 'old-id'), 'aa11');
  assert.equal(pickBrowser([chrome], null), 'aa11');
  assert.throws(() => pickBrowser([chrome, aside], 'old-id'), (err) => err.code === 'FSW_BROWSER_AMBIGUOUS' && /old-id is not online/.test(err.message) && /aa11 chrome 155/.test(err.message) && /bb22 \(aside\)/.test(err.message));
  assert.throws(() => pickBrowser([chrome, aside], null), /config.browser is unset and 2 browsers are/);
  assert.equal(pickBrowser([], 'aa11'), undefined);
});

test('the configured browser is config.browser.instance, and a bare string from an older config still counts', () => {
  assert.equal(browserInstance({ browser: 'aa11' }), 'aa11');
  assert.equal(browserInstance({ browser: { instance: 'bb22', chromeProfile: null } }), 'bb22');
  assert.equal(browserInstance({ browser: { instance: null, chromeProfile: null } }), null);
  assert.equal(browserInstance({}), null);
  assert.equal(browserInstance(null), null);
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

test('soomgo requests map card props, Seoul times, unread from isRead and redacted summaries', () => {
  const r = soomgo.parseRequests([
    { id: 'abc123', createdAt: '2026-10-25T01:13:34.6230', expiredAt: '2026-10-27T01:13:34.6230', quoteCount: 4, isQuotable: true, isRead: false, customer: '고객A', customerRequestCount: 2, service: '웹 개발', serviceId: 1, category: ['외주', '개발 외주'], address: '서울 강남구', summary: '랜딩 페이지, 연락은 010 1111 2222' },
    { id: 'def456', createdAt: null, isRead: true, isQuotable: false, customer: '', summary: '' },
  ]);
  assert.equal(r[0].unread, true);
  assert.equal(Date.parse(r[0].at), Date.parse('2026-10-24T16:13:34.623Z'));
  assert.equal(Date.parse(r[0].expiresAt), Date.parse('2026-10-26T16:13:34.623Z'));
  assert.equal(r[0].preview, '랜딩 페이지, 연락은 [number]');
  assert.equal(r[0].url, 'https://soomgo.com/requests/received/abc123?from=request_list');
  assert.deepEqual([r[1].unread, r[1].quotable, r[1].customer, r[1].at], [false, false, null, null]);
});

test('a soomgo budget answer becomes a KRW range, one-sided for 미만 and 이상, and null without an amount', () => {
  const b = (a, q = '예산은 어느 정도 생각하시나요?') => soomgo.budgetFromAnswers([{ q: '서비스', a: '웹 개발' }, { q, a }]);
  assert.deepEqual(b('100만원~200만원'), { minKRW: 1000000, maxKRW: 2000000 });
  assert.deepEqual(b('100~200만원'), { minKRW: 1000000, maxKRW: 2000000 });
  assert.deepEqual(b('50만원 미만'), { minKRW: null, maxKRW: 500000 });
  assert.deepEqual(b('1,000만원 이상'), { minKRW: 10000000, maxKRW: null });
  assert.equal(b('협의 후 결정'), null);
  assert.equal(b('100만원~200만원', '원하는 시작일'), null);
});

test('soomgo request detail pairs questions with answers and reads the cash cost from the send label', () => {
  const d = soomgo.parseRequestDetail({
    id: 'abc123',
    pairs: ['레슨 목적', '취업 준비', '연락처', '010-3333-4444'],
    customerText: '고객A\n가입일 2026.10.01\n숨고 3회 이용',
    form: { priceInput: true, priceTypes: ['총 비용', '시간 당'], selectedPriceType: '총 비용', textarea: true, textMaxChars: 1000, fileInput: true, sendLabel: '2,490캐시로 견적 보내기', sendDisabled: true },
  });
  assert.deepEqual(d.answers, [{ q: '레슨 목적', a: '취업 준비' }, { q: '연락처', a: '[number]' }]);
  assert.equal(d.customer.uses, 3);
  assert.equal(d.quoteCostKRW, 2490);
  assert.equal(d.quoteForm.sendButton, true);
  assert.equal(soomgo.parseRequestDetail({ id: 'x', form: {} }).quoteCostKRW, null);
});

test('soomgo chats: unread from new_message_count, quotes and system rows flagged', () => {
  const c = soomgo.parseChats([
    { id: 1, customer: '고객A', service: '웹 개발', region: '서울 강남구', updatedAt: '2026-10-24T10:00:00.123456', lastMessage: '견적 확인했어요', lastType: 'TEXT', newMessages: 2, status: 'negotiating', quotePrice: 99999, quoteUnit: 'H', quoteOpened: true, requestObjectId: 'r1' },
    { id: 2, customer: '고객B', lastMessage: '고객이 48시간 동안 견적을 읽지 않아서', lastType: 'SYSTEM', newMessages: 0, status: 'before_nego', quotePrice: null },
  ]);
  assert.deepEqual([c[0].unread, c[0].unreadCount, c[0].quote], [true, 2, { priceKRW: 99999, unit: 'hour', opened: true }]);
  assert.deepEqual([c[1].unread, c[1].system, c[1].quote], [false, true, null]);
});

test('soomgo chat thread dates its messages from the day separators and drops system rows', () => {
  const t = soomgo.parseChatThread({
    id: '9',
    customer: '고객A',
    items: [
      { date: '2026년 09월 23일 수요일' },
      { kind: 'quote', outbound: true, text: '서비스 견적', time: '오후 10:42' },
      { kind: 'system', text: '숨고 알리미', time: '오후 10:43' },
      { date: '2026년 09월 24일 목요일' },
      { kind: 'text', outbound: false, text: '전화 010-5555-6666 주세요', time: '오전 9:05' },
      { kind: 'text', outbound: true, text: '네 확인했습니다', time: '오후 12:30' },
    ],
    composer: { found: true, disabled: false, maxChars: 1000 },
  });
  assert.deepEqual(t.messages.map((m) => [m.direction, m.type, m.at]), [
    ['out', 'quote', '2026-09-23T22:42:00+09:00'],
    ['in', 'text', '2026-09-24T09:05:00+09:00'],
    ['out', 'text', '2026-09-24T12:30:00+09:00'],
  ]);
  assert.equal(t.messages[1].text, '전화 [number] 주세요');
  assert.equal(t.systemMessages, 1);
  assert.equal(t.canReply, true);
});

test('soomgo profile reads values after the last label and never returns registration lines', () => {
  const text = ['예시고수', '한 줄 소개 문장', '리뷰 평점', '4.9', '리뷰수', '12', '고용수', '30', '90% 완성', '대표 서비스', '사진 및 동영상', '질문답변', '본인인증',
    '활동 가능 범위', '전국 이동 가능', '대표 서비스', '웹 개발', '제공 서비스', '웹 개발 외 3개', '사진 및 동영상', '4', '질문답변', '2', '본인인증', '인증', '사업자등록증', '인증', '사업자등록번호', '000-00-00000', '세금 계산서 발행', '네, 가능합니다', '결제 수단', '숨고페이 외 3개'].join('\n');
  const p = soomgo.parseProfile(text);
  assert.deepEqual([p.nickname, p.headline, p.rating, p.reviews, p.hires, p.completion], ['예시고수', '한 줄 소개 문장', 4.9, 12, 30, '90%']);
  assert.deepEqual([p.mainService, p.media, p.qna, p.identityVerified, p.businessVerified], ['웹 개발', 4, 2, true, true]);
  assert.ok(!JSON.stringify(p).includes('000-00-00000'));
});

test('soomgo cash reads the balance and payback only when they are cash amounts', () => {
  assert.deepEqual(soomgo.parseCash('숨고 캐시\n스토어\n12,345캐시\n충전/사용 내역\n이번 달 페이백\n100캐시'), { balance: 12345, paybackThisMonth: 100 });
  assert.deepEqual(soomgo.parseCash('스토어\n바로가기'), { balance: null, paybackThisMonth: null });
});

test('kmong signIn fills the email login and reports the dashboard check, and refuses a page without the form', async () => {
  let signedIn = false;
  const s = fakeSession({ pageLoginForm: { found: true }, pageLogin: () => ({ url: 'u', avatar: signedIn, authSection: signedIn, loginButton: !signedIn, sellerMode: true, profileHref: null }) });
  const click = s.click;
  s.click = async (t) => {
    await click(t);
    if (t === '[data-fsw=login-submit]') signedIn = true;
  };
  const k = await openKmong({ session: s, sleep: async () => {} });
  assert.deepEqual(await k.signIn({ email: 'seller@example.invalid', password: 'not-a-real-password' }), { signedIn: true });
  assert.deepEqual(acted(s.log), ['fill [data-fsw=login-email]', 'fill [data-fsw=login-password]', 'click [data-fsw=login-submit]']);
  const none = fakeSession({ pageLoginForm: { found: false } });
  const r = await (await openKmong({ session: none, sleep: async () => {} })).signIn({ email: 'seller@example.invalid', password: 'not-a-real-password' });
  assert.deepEqual([r.signedIn, acted(none.log)], [false, []]);
});

test('kmong readThread refuses an unread thread unless the caller will reply, before opening it', async () => {
  const row = { href: '?inbox_group_id=111&partner_id=9', nickname: '의뢰인A', time: '10.20', preview: '문의' };
  const s = fakeSession({ pageInboxRows: [row], pageSelectTab: { ok: true, empty: false }, pageOpenRow: true, pageThread: { url: 'u', gigHrefs: [], bubbles: [], composer: { found: true } } });
  const k = await openKmong({ session: s });
  await assert.rejects(k.readThread('111'), { code: 'FSW_UNREAD_REFUSED' });
  assert.ok(!s.log.includes('evaluate pageOpenRow'));
});

test('kmong send refuses a missing or failed gate and an unreachable composer without typing', async () => {
  const s = fakeSession({ pageInboxRows: [{ href: '?inbox_group_id=111&partner_id=9' }], pageSelectTab: { ok: true, empty: true }, pageOpenRow: true, pageThread: { url: 'u', bubbles: [], composer: { found: true, disabled: true, placeholder: '대화할 수 없는 회원입니다', sendButton: true } } });
  const k = await openKmong({ session: s });
  assert.equal((await k.send('111', { text: '안녕하세요' })).sent, false);
  assert.equal((await k.send('111', { text: '안녕하세요', gate: { ok: false } })).sent, false);
  const r = await k.send('111', { text: '안녕하세요', gate: { ok: true } });
  assert.match(r.reason, /composer unavailable/);
  assert.deepEqual(acted(s.log), []);
});

test('soomgo readThread refuses a chat with new messages, and quote refuses without allowSpendCash', async () => {
  const chat = { id: 5, customer: '고객A', newMessages: 2 };
  const s = fakeSession({ pageChats: [chat], pageOpenChat: true, pageScrollChats: 1 });
  const g = await openSoomgo({ session: s });
  await assert.rejects(g.readThread('5'), { code: 'FSW_UNREAD_REFUSED' });
  assert.ok(!s.log.includes('evaluate pageOpenChat'));
  const q = await g.quote('req1', { amountKRW: 50000, text: '견적 드립니다', gate: { ok: true } });
  assert.equal(q.sent, false);
  assert.match(q.reason, /allowSpendCash/);
  assert.equal((await g.quote('req1', { amountKRW: 50000, text: '견적', gate: { ok: false }, allowSpendCash: true })).sent, false);
  assert.deepEqual(acted(s.log), []);
});

test('soomgo quote refuses when the cost cannot be read from the send button', async () => {
  const form = { priceInput: true, priceTypes: ['총 비용', '시간 당'], selectedPriceType: '총 비용', textarea: true, fileInput: true, sendLabel: '견적 보내기', sendDisabled: true, saveTemplateChecked: false, priceValue: '', textValue: '' };
  const s = fakeSession({ pageRequestDetail: { url: 'u', pairs: [], customerText: '', form } });
  const g = await openSoomgo({ session: s });
  const q = await g.quote('req1', { amountKRW: 50000, text: '견적 드립니다', gate: { ok: true }, allowSpendCash: true });
  assert.match(q.reason, /cost not readable/);
  assert.deepEqual(acted(s.log), []);
});

// A request page that keeps its send button after the click, and a 충전/사용 내역 page whose text is
// given by the test.
function sentQuoteSession(cashText) {
  const form = { priceInput: true, priceTypes: ['총 비용', '시간 당'], selectedPriceType: '총 비용', textarea: true, fileInput: true, sendLabel: '2,490 캐시로 견적 보내기', sendDisabled: false, saveTemplateChecked: false, priceValue: '', textValue: '' };
  let reads = 0;
  return fakeSession({
    pageRequestDetail: () => {
      reads += 1;
      const typed = reads >= 2 ? { priceValue: '50,000', textValue: '견적 드립니다' } : {};
      return { url: 'u', service: '웹 개발', pairs: [], customerText: '', form: { ...form, ...typed } };
    },
    pageText: cashText,
  });
}
const seoulStamp = (ms = Date.now()) => new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const quoteArgs = { amountKRW: 50000, text: '견적 드립니다', gate: { ok: true }, allowSpendCash: true, customer: '고객A' };

test('soomgo cash history reads each charge with its customer, Seoul time and signed amount', () => {
  const text = ['35,000캐시', '지급 예정 페이백', '2026년', '10월', '견적 발송 - 고객A', '2026-10-26 09:15:00', '-4,490캐시', '스마트견적 발송 - 고객B', '2026-10-23 18:30:00', '-1,990캐시', '견적 보상 - 고객C', '2026-10-24 07:30:00', '1,990캐시', '전체 내역'].join('\n');
  assert.deepEqual(soomgo.parseCashHistory(text), [
    { what: '견적 발송', customer: '고객A', at: '2026-10-26T09:15:00+09:00', amountKRW: -4490 },
    { what: '스마트견적 발송', customer: '고객B', at: '2026-10-23T18:30:00+09:00', amountKRW: -1990 },
    { what: '견적 보상', customer: '고객C', at: '2026-10-24T07:30:00+09:00', amountKRW: 1990 },
  ]);
});

test('soomgo quote is observed from its 견적 발송 charge in 충전/사용 내역, at the cost charged', async () => {
  const s = sentQuoteSession(['35,000캐시', '견적 발송 - 고객A', seoulStamp(), '-4,490캐시', '견적 보상 - 고객C', '2026-10-24 07:30:00', '1,990캐시'].join('\n'));
  const q = await (await openSoomgo({ session: s, sleep: async () => {} })).quote('req1', quoteArgs);
  assert.deepEqual([q.observed, q.cashSpentKRW], [true, 4490]);
});

test('soomgo quote is not observed from another customer\'s charge or one older than the press, and stays counted as pressed', async () => {
  const other = sentQuoteSession(['견적 발송 - 고객B', seoulStamp(), '-5,890캐시'].join('\n'));
  const q = await (await openSoomgo({ session: other, sleep: async () => {} })).quote('req1', quoteArgs);
  assert.deepEqual([q.observed, q.pressed, q.costKRW], [false, true, 2490]);
  assert.match(q.reason, /newest row 견적 발송 고객B/);
  const stale = sentQuoteSession(['견적 발송 - 고객A', seoulStamp(Date.now() - 3_600_000), '-5,890캐시'].join('\n'));
  assert.equal((await (await openSoomgo({ session: stale, sleep: async () => {} })).quote('req1', quoteArgs)).observed, false);
});
