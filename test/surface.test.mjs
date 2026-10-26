// Synthetic page answers only: fixtures under test/fixtures/surfaces are hand-written, never recorded pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openKmongConversation } from '../src/platforms/kmong/conversation.mjs';
import { openSoomgo } from '../src/platforms/soomgo/adapter.mjs';
import { openSurface } from '../src/surface/index.mjs';
import { readRecording, recordSession, replaySession } from '../src/surface/recorder.mjs';

// A driver stand-in: extractors answer by function name and every action is logged.
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
    typeKeys: async (t, v) => log.push('type ' + t + ' ' + v),
    press: async (k) => log.push('press ' + k),
    setFiles: async (t) => log.push('files ' + t),
    stop: async () => {},
  };
  return s;
}
const acted = (log) => log.filter((l) => /^(click|fill|type|press|files|message)/.test(l));
const fixture = (platform) => join('test', 'fixtures', 'surfaces', platform, 'sense.jsonl');

test('a kmong send is observed only when the newest outbound bubble holds the text', async () => {
  let bubbles = [{ text: '이전 답장', stamp: '25.10.24 10:00', outbound: true }];
  let typed = '';
  const s = fakeSession({
    pageInboxRows: [{ href: '?inbox_group_id=111&partner_id=9' }],
    pageSelectTab: { ok: true, empty: true },
    pageOpenRow: true,
    pageThread: () => ({ url: 'u', gigHrefs: [], bubbles, composer: { found: true, disabled: false, value: typed, sendButton: true, sendDisabled: false } }),
  });
  s.fill = async (t, v) => { s.log.push('fill ' + t); typed = v; };
  s.click = async (t) => { s.log.push('click ' + t); typed = ''; };
  const k = await openKmongConversation({ session: s });
  const missed = await k.send('111', { text: '안녕하세요, 견적 드립니다', gate: { ok: true } });
  assert.deepEqual([missed.observed, missed.reason], [false, 'the sent text was not observed in the thread']);
  bubbles = [...bubbles, { text: '안녕하세요, 견적 드립니다', stamp: '25.10.25 10:00', outbound: true }];
  const seen = await k.send('111', { text: '안녕하세요, 견적 드립니다', gate: { ok: true } });
  assert.equal(seen.observed, true);
});

test('soomgo login needs the profile link and the greeting with no login control', async () => {
  const page = { url: 'https://soomgo.com/mypage', loginButton: false, proChat: true, profileLink: true, proGreeting: true };
  const login = async (over) => (await openSoomgo({ session: fakeSession({ pageLogin: { ...page, ...over }, '': '숨고캐시 1,000캐시' }) })).login();
  assert.equal((await login({})).loggedIn, true);
  assert.equal((await login({ loginButton: true })).loggedIn, false);
  assert.equal((await login({ proGreeting: false })).loggedIn, false);
  assert.equal((await login({ url: 'https://soomgo.com/login' })).loggedIn, false);
});

test('soomgo payRequest refuses without approval, refuses an unread chat, and a dry run closes without confirming', async () => {
  const read = { id: 8, customer: 'x', newMessages: 0 };
  let dialog = { open: false };
  const s = fakeSession({
    pageChats: () => [read],
    pageScrollChats: 1,
    pageOpenChat: true,
    pageChatThread: { url: 'u', items: [], composer: { found: true } },
    pageOpenPayDialog: () => { dialog = { open: true, title: '숨고페이 안전결제', amountInput: true, amountValue: '', hiddenAmount: '0', confirmFound: true, confirmDisabled: true, closeFound: true }; return true; },
    pagePayDialog: () => dialog,
  });
  s.typeKeys = async (t, v) => { s.log.push('type ' + t + ' ' + v); dialog = { ...dialog, amountValue: Number(v).toLocaleString('en'), hiddenAmount: v, confirmDisabled: false }; };
  s.click = async (t) => { s.log.push('click ' + t); if (t.includes('pay-close')) dialog = { open: false }; };
  const g = await openSoomgo({ session: s });
  const refused = await g.payRequest('8', { amountKRW: 50000 });
  assert.match(refused.reason, /approved operator item/);
  assert.equal((await g.payRequest('8', { amountKRW: 1000, dryRun: true })).sent, false);
  assert.deepEqual(acted(s.log), []);
  const dry = await g.payRequest('8', { amountKRW: 50000, dryRun: true });
  assert.deepEqual([dry.dryRun, dry.amountTyped, dry.confirmEnabledFilled, dry.closed, dry.sent], [true, true, true, true, false]);
  assert.ok(!s.log.some((l) => l.includes('pay-confirm')));
  assert.ok(!s.log.includes('message'));
  read.newMessages = 3;
  await assert.rejects(g.payRequest('8', { amountKRW: 50000, dryRun: true }), { code: 'FSW_UNREAD_REFUSED' });
});

test('surface writes refuse without an authorize verdict of send and never touch the page', async () => {
  for (const platform of ['kmong', 'soomgo']) {
    const s = fakeSession({});
    const surface = await openSurface(platform, { session: s });
    for (const authorized of [undefined, { verdict: 'operator' }, { verdict: 'refuse' }, { ok: true }]) {
      assert.deepEqual(await surface.send('1', { text: '안녕하세요', authorized }), { observed: false, reason: 'not authorized: a write needs the authorize() verdict send' });
    }
    const q = await surface.quote('1', { amountKRW: 50000, text: '견적', authorized: { verdict: 'refuse' }, allowSpendCash: true });
    assert.equal(q.observed, false);
    assert.deepEqual(s.log, []);
  }
});

test('a soomgo send with the verdict send returns the receipt the page showed', async () => {
  let typed = '';
  let items = [];
  const s = fakeSession({ pageChats: [{ id: 5, newMessages: 0 }], pageOpenChat: true, pageChatThread: () => ({ url: 'u', items, composer: { found: true, value: typed, sendButton: true } }) });
  s.fill = async (t, v) => { typed = v; };
  s.click = async () => { items = [{ kind: 'text', outbound: true, text: typed, time: '오전 10:00' }]; typed = ''; };
  const surface = await openSurface('soomgo', { session: s });
  assert.deepEqual(await surface.send('5', { text: '안녕하세요', authorized: { verdict: 'send' } }), { observed: true, text: '안녕하세요', snippet: '안녕하세요' });
});

test('sense maps soomgo chats and requests and kmong inbox rows to Inbound, opening nothing', async () => {
  const soomgo = await openSurface('soomgo', { replay: fixture('soomgo') });
  const rows = await soomgo.sense();
  assert.deepEqual(rows.map((r) => [r.kind, r.ref, r.unread]), [['message', '501', true], ['message', '502', false], ['request', 'r-9002', true]]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'customer', 'expiresAt', 'hired', 'kind', 'notice', 'platform', 'preview', 'quotable', 'quote', 'quoteCostKRW', 'ref', 'requestId', 'service', 'status', 'unread']);
  assert.equal(rows[0].at, '2026-10-25T10:12:00.000+09:00');
  assert.deepEqual(rows[0].quote, { priceKRW: 300000, unit: 'total', opened: true });
  assert.match(rows[1].notice, /결제한 금액/);
  assert.deepEqual([rows[2].quotable, rows[2].expiresAt], [true, '2026-10-27T09:13:00.000+09:00']);
  assert.equal(soomgo.session.remaining(), 0);
  const kmong = await openSurface('kmong', { replay: fixture('kmong') });
  const inbox = await kmong.sense();
  assert.deepEqual(inbox.map((r) => [r.ref, r.unread, r.customer]), [['111', true, '의뢰인A'], ['112', false, '의뢰인B']]);
});

test('read gives a soomgo chat with its platform notices, and a request as one inbound message', async () => {
  const items = [
    { date: '2026년 10월 25일 일요일' },
    { kind: 'text', outbound: false, text: '견적 부탁드려요', time: '오전 10:12' },
    { kind: 'system', type: 'SP_ST_002', outbound: false, text: '숨고페이\n고객에게 거래를 요청했어요\n서비스 금액: 300,000원', time: '오전 10:20' },
  ];
  const s = fakeSession({
    pageChats: [{ id: 5, customer: '고객A', newMessages: 0 }], pageOpenChat: true, pageChatThread: { url: 'u', items, composer: { found: true } },
    pageRequestDetail: { url: 'u', service: '웹 개발', pairs: ['예산', '100만원~200만원', '페이지 수', '1페이지'], customerText: '', form: { sendLabel: '1,990 캐시로 견적 보내기' } },
  });
  const surface = await openSurface('soomgo', { session: s });
  const chat = await surface.read('5');
  assert.deepEqual(chat.messages, [{ direction: 'in', text: '견적 부탁드려요', at: '2026-10-25T10:12:00+09:00', externalId: '5:0' }]);
  assert.deepEqual(chat.notices, [{ kind: 'SP_ST_002', text: '숨고페이\n고객에게 거래를 요청했어요\n서비스 금액: 300,000원', at: '2026-10-25T10:20:00+09:00' }]);
  const request = await surface.read('r-1', { kind: 'request' });
  assert.deepEqual([request.kind, request.title, request.quoteCostKRW, request.budget], ['request', '웹 개발', 1990, { minKRW: 1000000, maxKRW: 2000000 }]);
  assert.deepEqual(request.messages, [{ direction: 'in', text: '웹 개발\n예산: 100만원~200만원\n페이지 수: 1페이지', at: null, externalId: 'request' }]);
  assert.deepEqual(request.notices, []);
});

test('a recorded session replays the same answers in order, and a diverging call fails by name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-rec-'));
  try {
    const file = join(dir, 'r.jsonl');
    const live = fakeSession({ pageChats: [{ id: 9, customer: 'x', newMessages: 0 }], pageRequests: [] });
    const first = await (await openSurface('soomgo', { session: live, record: file })).sense();
    const calls = readRecording(file);
    assert.deepEqual(calls.map((c) => c.op + ' ' + c.name), ['navigate https://soomgo.com/pro/chats', 'evaluate pageChats', 'navigate https://soomgo.com/requests/received', 'evaluate pageRequests']);
    const again = await (await openSurface('soomgo', { replay: file })).sense();
    assert.deepEqual(again, first);
    const wrong = await openSurface('soomgo', { replay: file });
    await assert.rejects(wrong.login(), { code: 'FSW_REPLAY_DIVERGED' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a recorded error replays as the same error, and a platform without a surface is refused', async () => {
  const s = replaySession([{ seq: 0, op: 'navigate', name: 'https://soomgo.com/mypage', arg: null, error: { message: 'navigation timed out', code: 'FSW_NAV' } }]);
  await assert.rejects(s.navigate('https://soomgo.com/mypage'), { code: 'FSW_NAV', message: 'navigation timed out' });
  assert.equal(s.remaining(), 0);
  await assert.rejects(openSurface('wishket', { session: fakeSession({}) }), { code: 'FSW_NO_SURFACE' });
});

test('read takes kind message or request: kmong refuses a request and an unknown kind is refused before any page loads', async () => {
  for (const [platform, kind] of [['kmong', 'request'], ['soomgo', 'order'], ['kmong', 'order']]) {
    const s = fakeSession({});
    const surface = await openSurface(platform, { session: s });
    await assert.rejects(surface.read('1', { kind }), { code: 'FSW_READ_KIND' });
    assert.deepEqual(s.log, []);
  }
});

test('soomgo orders count hired chats with no counters, so no counter alert can rise', async () => {
  const soomgo = await openSurface('soomgo', { replay: readRecording(fixture('soomgo')).slice(0, 2) });
  assert.deepEqual(await soomgo.orders(), { counts: null, total: 1, gap: 'soomgo has no order list; hires are chat rows from sense', orders: null });
});
