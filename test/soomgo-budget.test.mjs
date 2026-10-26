// What soomgo's poll and hourly reads spend of the account's action cap (descriptor pacing: 60 an hour, page
// loads and clicks count, evaluate does not). A fake driver session answers each page extractor and runs
// every load and action through a real createPacingGuard on a clock the test moves, so the counts are the
// guard's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPacingGuard } from '../src/browser/driver.mjs';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { step } from '../src/loop/index.mjs';
import { openSoomgoSurface } from '../src/surface/soomgo.mjs';
import { recordReviews } from '../src/loop/reviews.mjs';
import { supplyLines, supplyReport } from '../src/supervisor/supply.mjs';
import { tempDir } from './tmp.mjs';

const pacing = loadDescriptor('soomgo').pacing;
const START = Date.parse('2026-10-27T10:00:00+09:00');

function makeInstance(mode = 'auto') {
  const dir = tempDir('fsw-budget-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  for (const id of Object.keys(config.platforms)) config.platforms[id] = { ...config.platforms[id], enabled: false };
  config.platforms.soomgo = { ...config.platforms.soomgo, enabled: true, mode, maxQuotesPerDay: 5, maxCashPerDay: 5000 };
  config.notify = { toast: false, webhookUrl: null };
  config.activeHours = { outbound: ['00:00', '00:00'] };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

const chatRow = (id, over = {}) => ({ id, customer: '고객' + id, service: '웹 개발', region: null, updatedAt: '2026-10-27T09:00:00.000000', lastMessage: '문의드립니다', lastType: 'TEXT', newMessages: 0, status: 'pending', hireStatus: null, otherProHireStatus: null, safePaymentId: null, safePaymentStatus: null, quotePrice: null, quoteUnit: null, quoteOpened: null, requestObjectId: null, ...over });
const requestRow = (id, over = {}) => ({ id, createdAt: '2026-10-27T09:30:00.000', expiredAt: '2026-10-29T09:30:00.000', quoteCount: 1, isQuotable: true, isRead: false, customer: '고객' + id, customerRequestCount: 1, service: '웹 개발', serviceId: 7, category: ['개발', '웹 개발'], address: '서울', summary: '홈페이지가 필요해요', ...over });

// One account: the guard is shared by every session, as pacingFor shares it per platform in the supervisor.
export function account({ chats = [], requests = [] } = {}) {
  let clock = START;
  const guard = createPacingGuard('soomgo', pacing, { now: () => clock, sleep: async (ms) => { clock += ms; } });
  const page = { chats, requests };
  const open = () => {
    const log = [];
    let path = null;
    const answers = {
      pageLogin: () => ({ url: 'https://soomgo.com/mypage', loginButton: false, proChat: true, profileLink: true, proGreeting: true }),
      '': () => (path === '/profile' ? ['고수 프로필', '웹 개발 고수', '리뷰 평점', '4.9', '리뷰수', '7'].join('\n') : '고수님 숨고캐시 12,345캐시'),
      pageChats: () => (path === '/pro/chats' ? page.chats : []),
      pageRequests: () => (path === '/requests/received' ? page.requests : []),
      pageOpenChat: (id) => page.chats.some((c) => String(c.id) === id),
      pageChatThread: () => ({ url: 'u', items: [{ date: '2026년 10월 27일 화요일' }, { kind: 'text', outbound: false, text: '문의드립니다', time: '오전 9:00' }], composer: { found: true } }),
      pageRequestDetail: () => ({ url: 'u', service: '웹 개발', pairs: ['예산', '100만원~200만원'], customerText: '', quoteCount: 1, form: { sendLabel: '1,990 캐시로 견적 보내기' } }),
      pageServiceRows: () => [{ name: '웹 개발', itemsSet: true, ref: 'a' }],
      pageText: () => ['견적 발송 - 고객A', '2026-10-27 09:00:00', '-1,990캐시', '견적 발송 - 고객B', '2026-10-26 09:00:00', '-1,990캐시'].join('\n'),
      pageCampaignLinks: () => [],
    };
    const s = {
      guard,
      log,
      loads: 0,
      async navigate(url) {
        await guard.beforeLoad();
        s.loads += 1;
        path = new URL(url).pathname;
        log.push('navigate ' + path);
        return url;
      },
      async evaluate(fn, arg) {
        const a = answers[fn.name];
        if (!a) throw new Error('no answer for ' + fn.name);
        return a(arg);
      },
      click: async (t) => (guard.beforeAction(), log.push('click ' + t)),
      fill: async (t) => (guard.beforeAction(), log.push('fill ' + t)),
      typeKeys: async (t) => (guard.beforeAction(), log.push('type ' + t)),
      press: async () => guard.beforeAction(),
      stop: async () => {},
    };
    return s;
  };
  const sessions = [];
  const surface = async () => {
    const s = open();
    sessions.push(s);
    return openSoomgoSurface({ session: s, sleep: async () => {} });
  };
  return { guard, page, sessions, surface, now: () => new Date(clock), at: (ms) => { clock = Math.max(clock, ms); } };
}

const quietDecide = async () => ({ modelCalls: 1, item: null, decision: { intent: 'spam', service: null, language: 'ko', reply: null, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [] } });
const poll = (instance, ledger, acct) => step('soomgo', { instance, ledger, now: acct.now(), openSurface: acct.surface, decide: quietDecide, notify: async () => ({ written: false }), loadRecipe: () => null });
const used = (acct) => acct.guard.counts().actions;

test('an idle soomgo poll costs at most 3 actions once every listed thread was read', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const acct = account({ chats: [chatRow(701), chatRow(702)] });
  const first = await poll(instance, ledger, acct);
  assert.equal(first.status, 'ok', JSON.stringify(first.errors ?? first.error));
  const before = used(acct);
  acct.at(START + 5 * 60_000);
  const second = await poll(instance, ledger, acct);
  assert.equal(second.status, 'ok', JSON.stringify(second.errors ?? second.error));
  assert.deepEqual([...acct.sessions.at(-1).log].sort(), ['navigate /mypage', 'navigate /pro/chats', 'navigate /requests/received']);
  assert.equal(used(acct) - before, 3);
});

test('an hour of idle soomgo polls and the hourly supply report leave the cap a margin', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const acct = account({ chats: [chatRow(701)] });
  for (let i = 0; i < 12; i++) {
    acct.at(START + i * 5 * 60_000);
    const r = await poll(instance, ledger, acct);
    assert.equal(r.status, 'ok', 'poll ' + i + ' ' + JSON.stringify(r.errors ?? r.error));
  }
  acct.at(START + 59 * 60_000);
  const supply = await supplyReport('soomgo', { instance, ledger, now: acct.now(), openSurface: acct.surface });
  assert.equal(supply.status, 'ok', supply.notes.join('; '));
  assert.ok(supply.spend, 'the spend read ran');
  const reviews = await recordReviews({ instance, ledger, now: acct.now(), openSurface: acct.surface, notify: async () => ({ written: false }) });
  assert.deepEqual(reviews, [{ platform: 'soomgo', status: 'ok', changed: false, signals: 0 }]);
  // 12 polls of 3 loads, the first also opening the one chat, the supply report's login, services and
  // spend, and the review pass's one /profile load.
  assert.equal(used(acct), 12 * 3 + 1 + 4 + 1);
  assert.deepEqual(acct.sessions.at(-1).log, ['navigate /profile']);
});


test('a poll that reads several listed chats loads the chat list once for all of them', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const acct = account({ chats: [chatRow(701), chatRow(702), chatRow(703)] });
  const r = await poll(instance, ledger, acct);
  assert.equal(r.status, 'ok', JSON.stringify(r.errors ?? r.error));
  assert.equal(r.threads.observed ?? 0, 0);
  assert.equal(ledger.db.prepare("SELECT count(*) n FROM events WHERE kind = 'brain.decision'").get().n, 3);
  // The poll's 3 list loads, then one /pro/chats load: sense ends on the request list.
  assert.equal(used(acct), 4);
  assert.deepEqual(acct.sessions[0].log, ['navigate /mypage', 'navigate /pro/chats', 'navigate /requests/received', 'navigate /pro/chats']);
});


// 2026-10-26 15:21Z to 16:00Z: the supervisor restarted with an empty guard, the polls read every new item
// they listed, and by the 01:00 hourly the 60 were spent, so the spend read and the next poll failed.
test('an hour of polls that each list new requests leaves the hourly reads and the sends room in the cap', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const acct = account({ chats: [] });
  for (let i = 0; i < 12; i++) {
    acct.at(START + i * 5 * 60_000);
    acct.page.requests = Array.from({ length: 5 }, (_, k) => requestRow('r' + i + '-' + k));
    const r = await poll(instance, ledger, acct);
    assert.equal(r.status, 'ok', 'poll ' + i + ' ' + JSON.stringify(r.errors ?? r.error));
  }
  acct.at(START + 59 * 60_000);
  const supply = await supplyReport('soomgo', { instance, ledger, now: acct.now(), openSurface: acct.surface });
  assert.equal(supply.status, 'ok', supply.notes.join('; '));
  assert.ok(supply.spend, 'the spend read ran');
  // The hourly review pass runs after the supply report; with the read share spent it waits a later hour.
  const reviews = await recordReviews({ instance, ledger, now: acct.now(), openSurface: acct.surface, notify: async () => ({ written: false }) });
  assert.deepEqual(reviews.map((r) => r.status), ['deferred']);
  // What is left for the hour's sends: a quote press costs up to 8 (its request page, the price, the text,
  // the send and up to four cash history loads).
  assert.ok(pacing.maxActionsPerHour - used(acct) >= 10, 'room left ' + (pacing.maxActionsPerHour - used(acct)));
});


test('requests beyond the read share wait and are reported, while a customer chat is read at once', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const acct = account({ chats: [] });
  // Spend the hour's read share on request reads.
  acct.page.requests = Array.from({ length: pacing.readActionsPerHour }, (_, k) => requestRow('a' + k));
  await poll(instance, ledger, acct);
  assert.equal(acct.guard.readRoom(), 0);
  acct.at(START + 5 * 60_000);
  acct.page.requests = [requestRow('late')];
  acct.page.chats = [chatRow(801, { newMessages: 1 })];
  const r = await poll(instance, ledger, acct);
  assert.equal(r.status, 'ok', JSON.stringify(r.errors ?? r.error));
  assert.deepEqual([r.threads.paced, r.deferred], [1, 1]);
  const decided = ledger.db.prepare("SELECT ref FROM events WHERE kind = 'brain.decision' ORDER BY id").all().map((e) => e.ref);
  assert.ok(decided.includes('801'), 'the customer chat was read and decided');
  assert.ok(!decided.includes('late'));
  const report = await supplyReport('soomgo', { instance, ledger, now: acct.now(), openSurface: acct.surface });
  assert.deepEqual(report.paced, { waited: 1, parkedUnread: 0 });
  assert.match(supplyLines({ reports: [report] })[0], /1 requests waited for the hourly read share/);
});


test('a request that waited for the read share and then expired is parked as unread and counted', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const acct = account({ chats: [] });
  acct.page.requests = Array.from({ length: pacing.readActionsPerHour }, (_, k) => requestRow('a' + k));
  await poll(instance, ledger, acct);
  acct.at(START + 5 * 60_000);
  acct.page.requests = [requestRow('late')];
  await poll(instance, ledger, acct);
  acct.at(START + 10 * 60_000);
  acct.page.requests = [requestRow('late', { isQuotable: false })];
  const r = await poll(instance, ledger, acct);
  assert.equal(r.threads.parked, 1);
  const park = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'thread.skipped' AND ref = 'late'").get();
  assert.equal(JSON.parse(park.payload).paced, true);
  assert.deepEqual((await supplyReport('soomgo', { instance, ledger, now: acct.now(), openSurface: acct.surface })).paced, { waited: 1, parkedUnread: 1 });
});
