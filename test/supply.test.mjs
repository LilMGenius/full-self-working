// The lead supply report: what the hourly job writes per platform and what leads the 09:00 digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { notifyOperator } from '../src/core/notify.mjs';
import { plan, setStatus } from '../src/outbox/index.mjs';
import { expansionCandidates, latestSupply, parkedCounts, supplyLines, supplyReport, writeSupply } from '../src/supervisor/supply.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { runTick } from '../src/supervisor/run.mjs';
import { writeDigest } from '../src/supervisor/digest.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-supply-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms = { kmong: { ...config.platforms.kmong, enabled: true }, soomgo: { ...config.platforms.soomgo, enabled: true } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}
const NOW = new Date('2026-10-25T03:00:00Z'); // 12:00 Seoul
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const quiet = async () => ({ written: false });
const surfaceWith = (services, over = {}) => async () => ({ login: async () => ({ loggedIn: true }), supply: async () => ({ platform: 'soomgo', listings: null, services }), stop: async () => {}, ...over });

test('parked counts distinct threads per reason over the last seven days', () => {
  const ledger = openLedger(':memory:');
  const park = (kind, ref, reason, at) => ledger.addEvent({ kind, platform: 'soomgo', ref, payload: { reason }, at });
  park('thread.operator', 'r1', 'catalog: 피아노 레슨', hoursAgo(1));
  park('thread.operator', 'r1', 'catalog: 피아노 레슨', hoursAgo(2));
  park('thread.skipped', 'r2', 'stale: 80h', hoursAgo(3));
  park('thread.skipped', 'r3', 'expired', hoursAgo(4));
  park('thread.system', 'c1', 'notice: unread quote', hoursAgo(5));
  park('thread.skipped', 'r9', 'stale: 90h', hoursAgo(24 * 8));
  ledger.addEvent({ kind: 'thread.operator', platform: 'kmong', ref: 'x', payload: { reason: 'catalog: x' }, at: hoursAgo(1) });
  assert.deepEqual(parkedCounts(ledger, 'soomgo', NOW), { outOfCatalog: 1, stale: 1, expired: 1, notice: 1, gate: 0 });
});

test('a park the quote value gate wrote is its own bucket, not stale', () => {
  const ledger = openLedger(':memory:');
  const park = (ref, reason, at = hoursAgo(1)) => ledger.addEvent({ kind: 'thread.skipped', platform: 'soomgo', ref, payload: { reason }, at });
  park('g1', 'gate: value.negative');
  park('g1', 'gate: value.negative', hoursAgo(2));
  park('g2', 'gate: fit.low');
  park('s1', 'stale: 80h');
  assert.deepEqual(parkedCounts(ledger, 'soomgo', NOW), { outOfCatalog: 0, stale: 1, expired: 0, notice: 0, gate: 2 });
});

test('the report counts the Seoul day\'s quote verdicts by reason and the pace holds, and the digest prints one line', async () => {
  const ledger = openLedger(':memory:');
  const judged = (ref, reason, at = hoursAgo(1)) => ledger.addEvent({ kind: 'quote.judged', platform: 'soomgo', ref, payload: { verdict: reason === 'gate: value.positive' ? 'send' : 'drop', reason }, at });
  judged('r1', 'gate: value.positive');
  judged('r2', 'gate: value.negative');
  judged('r2', 'gate: value.negative', hoursAgo(2));
  judged('r3', 'gate: fit.low');
  judged('r4', 'expired: the request already has 10 quotes and soomgo takes 10');
  judged('r5', 'gate: value.negative', hoursAgo(20)); // yesterday in Seoul
  ledger.addEvent({ kind: 'quote.pace_held', platform: 'soomgo', ref: 'r6', payload: {}, at: hoursAgo(1) });
  ledger.addEvent({ kind: 'quote.judged', platform: 'kmong', ref: 'k1', payload: { reason: 'gate: fit.low' }, at: hoursAgo(1) });
  const report = await supplyReport('soomgo', { instance: makeInstance(), ledger, now: NOW, openSurface: surfaceWith([]) });
  assert.deepEqual(report.judged, { day: '20261025', byReason: { 'value.positive': 1, 'value.negative': 1, 'fit.low': 1, expired: 1 }, paceHeld: 1 });
  const line = supplyLines({ reports: [report] })[0];
  assert.match(line, /; quote gate 20261025: value\.positive 1, value\.negative 1, fit\.low 1, expired 1, pace held 1(;|$)/);
  const none = await supplyReport('soomgo', { instance: makeInstance(), ledger: openLedger(':memory:'), now: NOW, openSurface: surfaceWith([]) });
  assert.doesNotMatch(supplyLines({ reports: [none] })[0], /quote gate/);
});

// 088 unit 4: requests a board only observed, by catalog service and for an unmapped form, from thread.observed.
test('the report counts observed requests by catalog service and those waiting for an unmapped form, and the digest prints one line', async () => {
  const ledger = openLedger(':memory:');
  const seen = (ref, service, reason = 'form unmapped', at = hoursAgo(1)) => ledger.addEvent({ kind: 'thread.observed', platform: 'wishket', ref, payload: { unread: false, reason, service }, at });
  seen('1', '랜딩ㆍ소개 페이지');
  seen('1', '랜딩ㆍ소개 페이지', 'form unmapped', hoursAgo(2));
  seen('2', '랜딩ㆍ소개 페이지');
  seen('3', '스크래핑ㆍAPI', 'observe mode reads without replying');
  seen('4', 'IoTㆍ블루투스');
  seen('5', null);
  seen('old', '랜딩ㆍ소개 페이지', 'form unmapped', hoursAgo(24 * 8));
  ledger.addEvent({ kind: 'thread.observed', platform: 'soomgo', ref: 's1', payload: { reason: 'form unmapped', service: '웹 개발' }, at: hoursAgo(1) });
  const instance = makeInstance((c) => ({ ...c, platforms: { ...c.platforms, wishket: { enabled: true, mode: 'observe' } } }));
  const report = await supplyReport('wishket', { instance, ledger, now: NOW, openSurface: async () => ({ login: async () => ({ loggedIn: false }), stop: async () => {} }) });
  assert.deepEqual([report.observedCounts, report.observedUnmapped], [{ landing_page_web: 2, data_crawling: 1, 'IoTㆍ블루투스 (no service)': 1, 'no label': 1 }, 4]);
  assert.match(supplyLines({ reports: [report] })[0], /; observed in 7 days: landing_page_web 2, data_crawling 1, IoTㆍ블루투스 \(no service\) 1, no label 1, 4 of them wait for an unmapped form(;|$)/);
  const none = await supplyReport('soomgo', { instance: makeInstance(), ledger: openLedger(':memory:'), now: NOW, openSurface: surfaceWith([]) });
  assert.deepEqual([none.observedCounts, none.observedUnmapped], [{}, 0]);
  assert.doesNotMatch(supplyLines({ reports: [none] })[0], /observed in/);
});

test('a wishket request the step observes for its unmapped form carries the reason and service the report counts', async () => {
  const { step } = await import('../src/loop/index.mjs');
  const { openWishketSurface } = await import('../src/surface/wishket.mjs');
  const instance = makeInstance((c) => ({ ...c, platforms: { ...c.platforms, wishket: { enabled: true, mode: 'auto' } } }));
  const ledger = openLedger(':memory:');
  const project = { id: 700001, title: '예약 웹', description: '예약 웹을 만들고 싶습니다', amountKRW: 12000000, projectType: 'task_based', private: false, field: '랜딩ㆍ소개 페이지', postedOn: '2026-10-24' };
  const reader = { listProjects: async () => ({ projects: [project], total: 1, skipped: 0 }), readProject: async () => project, close: async () => {} };
  const r = await step('wishket', { instance, ledger, now: NOW, notify: quiet, openSurface: async () => openWishketSurface({ reader }) });
  assert.deepEqual([r.status, r.mode, r.threads.observed], ['ok', 'observe', 1]);
  const observed = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'thread.observed'").all().map((e) => JSON.parse(e.payload));
  assert.deepEqual(observed.map((p) => [p.reason, p.service]), [['form unmapped', '랜딩ㆍ소개 페이지']]);
  const report = await supplyReport('wishket', { instance, ledger, now: NOW, openSurface: async () => ({ login: async () => ({ loggedIn: false }), stop: async () => {} }) });
  assert.deepEqual([report.observedCounts, report.observedUnmapped], [{ landing_page_web: 1 }, 1]);
});

test('the labels behind the out-of-catalog count are listed as expansion candidates, top five by threads', async () => {
  const ledger = openLedger(':memory:');
  const park = (ref, service, at = hoursAgo(1), reason = 'catalog: service ' + service + ' is not in the catalog') => ledger.addEvent({ kind: 'thread.operator', platform: 'soomgo', ref, payload: { reason, service }, at });
  park('p1', '피아노 레슨');
  park('p1', '피아노 레슨', hoursAgo(2));
  park('p2', '피아노 레슨');
  park('m1', '음악 작곡');
  park('m2', '음악 작곡');
  for (const [i, label] of ['3D 모델링', '보컬 레슨', '드럼 레슨', '기타 레슨'].entries()) park('x' + i, label);
  park('old', '피아노 레슨', hoursAgo(24 * 8));
  park('g1', '게임 개발');
  park('l1', '프로그래밍/코딩 레슨', hoursAgo(1), 'catalog: service 프로그래밍/코딩 레슨 is lesson_tutoring, which config platforms.soomgo.services does not answer');
  park('u1', null, hoursAgo(1), 'unsupported: a game bot');
  const soomgo = loadDescriptor('soomgo');
  assert.deepEqual(expansionCandidates(ledger, soomgo, NOW), [
    { label: '음악 작곡', threads: 2 },
    { label: '피아노 레슨', threads: 2 },
    { label: '3D 모델링', threads: 1 },
    { label: '기타 레슨', threads: 1 },
    { label: '드럼 레슨', threads: 1 },
  ]);
  const report = await supplyReport('soomgo', { instance: makeInstance(), ledger, now: NOW, openSurface: surfaceWith([]) });
  assert.equal(report.candidates.length, 5);
  assert.match(supplyLines({ reports: [report] })[0], /; labels no service covers yet: 음악 작곡 2, 피아노 레슨 2, 3D 모델링 1, 기타 레슨 1, 드럼 레슨 1;/);
});

test('a report lists gigs by review state, offered services without items and the awaiting reply count', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const dir = join(instance.dir, 'listings');
  for (const [service, status, last] of [['logo_brand', '승인 전', null], ['landing_page_web', '판매중', 'selling']]) {
    mkdirSync(join(dir, service), { recursive: true });
    writeFileSync(join(dir, service, 'publish-20261025.json'), JSON.stringify({ service, gigId: service.length, status, submitted: true }));
    if (last) writeFileSync(join(dir, service, 'review.json'), JSON.stringify({ lastStatus: last }));
  }
  const waiting = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  ledger.addMessage({ threadId: waiting.id, direction: 'in', body: '문의', at: hoursAgo(2) });
  const old = ledger.upsertThread({ platform: 'soomgo', externalId: 'c2', kind: 'message' });
  ledger.addMessage({ threadId: old.id, direction: 'in', body: '문의', at: hoursAgo(100) });
  const answered = ledger.upsertThread({ platform: 'soomgo', externalId: 'c3', kind: 'message' });
  ledger.addMessage({ threadId: answered.id, direction: 'in', body: '문의', at: hoursAgo(3) });
  ledger.addMessage({ threadId: answered.id, direction: 'out', body: '답변', at: hoursAgo(2) });
  const row = plan(ledger, { platform: 'soomgo', threadId: waiting.id, kind: 'message', payload: { text: '답변 초안' } });
  setStatus(ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261025-soomgo-0000abcd' });
  const offered = [{ name: '웹 개발', itemsSet: false, ref: 'a' }, { name: '로고 디자인', itemsSet: true, ref: 'b' }, { name: '피아노 레슨', itemsSet: false, ref: 'c' }];
  const soomgo = await supplyReport('soomgo', { instance, ledger, now: NOW, openSurface: surfaceWith(offered) });
  assert.deepEqual([soomgo.status, soomgo.awaitingReply, soomgo.waiting.awaiting_operator], ['ok', 1, 1]);
  assert.deepEqual(soomgo.services, { offered: 3, withoutItems: ['웹 개발'] });
  const kmong = await supplyReport('kmong', { instance, ledger, now: NOW, openSurface: async () => ({ login: async () => ({ loggedIn: true }), stop: async () => {} }) });
  assert.deepEqual(kmong.listings, { published: 2, byStatus: { waiting: 1, selling: 1 } });
  assert.equal(kmong.services, null);
});

test('a platform whose supply has no services list reports no services line', async () => {
  const instance = makeInstance();
  const kmong = await supplyReport('kmong', { instance, ledger: openLedger(':memory:'), now: NOW, openSurface: async () => ({ login: async () => ({ loggedIn: true }), supply: async () => ({ platform: 'kmong', listings: [], services: null }), stop: async () => {} }) });
  assert.deepEqual([kmong.status, kmong.services], ['ok', null]);
  assert.doesNotMatch(supplyLines({ reports: [kmong] })[0], /request items/);
});

test('a failing read, a missing login and a missing pipeline setting each leave a partial report with the reason', async () => {
  const ledger = openLedger(':memory:');
  const instance = makeInstance();
  const broken = await supplyReport('soomgo', { instance, ledger, now: NOW, openSurface: surfaceWith([], { supply: async () => { throw new Error('tool RPC timed out'); } }) });
  assert.deepEqual([broken.status, broken.services], ['partial', null]);
  assert.match(broken.notes.join(), /tool RPC timed out/);
  const out = await supplyReport('soomgo', { instance, ledger, now: NOW, openSurface: surfaceWith([], { login: async () => ({ loggedIn: false }) }) });
  assert.match(out.notes.join(), /FSW_SUPPLY_LOGIN not logged in/);
  const bare = makeInstance((c) => ({ ...c, pipeline: undefined }));
  const noPipeline = await supplyReport('soomgo', { instance: bare, ledger, now: NOW, openSurface: surfaceWith([]) });
  assert.equal(noPipeline.awaitingReply, null);
  assert.match(noPipeline.notes.join(), /pipeline/);
});

test('the hourly job writes one supply file per Seoul hour, and latestSupply reads the newest', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const openSurface = surfaceWith([{ name: '웹 개발', itemsSet: false, ref: 'a' }]);
  const state = { lastRuns: {} };
  const tick = (iso) => runTick({ instance, ledger, now: new Date(iso), state, only: ['hourly'], openSurface, notify: quiet, persist: false });
  const first = await tick('2026-10-25T03:00:00Z');
  assert.match(first.jobs[0].supply.file, /supply-2026102512\.json$/);
  assert.equal(latestSupply(instance).file, 'supply-2026102512.json');
  await tick('2026-10-25T03:30:00Z');
  assert.equal(latestSupply(instance).file, 'supply-2026102512.json', 'the same hour runs once');
  await tick('2026-10-25T04:00:00Z');
  const latest = latestSupply(instance);
  assert.deepEqual([latest.file, latest.hour, latest.reports.map((r) => r.platform)], ['supply-2026102513.json', '2026102513', ['kmong', 'soomgo']]);
  assert.equal(ledger.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'supervisor.supply'").get().n, 2);
});

test('the digest leads with the lead supply section, and its notice opens with the same lines', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  ledger.addEvent({ kind: 'thread.operator', platform: 'soomgo', ref: 'r1', payload: { reason: 'catalog: 피아노 레슨' }, at: hoursAgo(1) });
  await writeSupply({ instance, ledger, now: NOW, openSurface: surfaceWith([{ name: '웹 개발', itemsSet: false, ref: 'a' }]) });
  const notes = [];
  const d = await writeDigest({ instance, ledger, now: new Date('2026-10-26T00:00:00Z'), notify: async (_i, n) => (notes.push(n), { written: true }) });
  const lines = readFileSync(d.file, 'utf8').split('\n');
  assert.equal(lines[2], '## Lead supply (supply-2026102512.json)');
  assert.match(lines[5], /^- soomgo: 0 awaiting reply; parked in 7 days: out of catalog 1; offered services without request items: 웹 개발$/);
  assert.equal(lines.indexOf('## Activity') > 5, true);
  assert.match(notes[0].body, /^kmong: .* \| soomgo: 0 awaiting reply/);
  assert.deepEqual(supplyLines(null), ['- none yet (the hourly job writes it)']);
});

test('approvals waiting in the digest counts outbox rows awaiting the operator', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const t = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  const a = plan(ledger, { platform: 'soomgo', threadId: t.id, kind: 'message', payload: { text: '하나' } });
  plan(ledger, { platform: 'soomgo', threadId: t.id, kind: 'message', payload: { text: '둘' } });
  setStatus(ledger, a.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261025-soomgo-0000abcd' });
  const d = await writeDigest({ instance, ledger, now: new Date('2026-10-26T00:00:00Z'), notify: quiet });
  assert.equal(d.numbers.approvalsWaiting, 1);
  assert.match(readFileSync(d.file, 'utf8'), /- approvals waiting now: 1/);
});


// A soomgo account whose smart quote campaigns spend beside fsw: one campaign within the limit, one over it.
const SPEND = { today: { day: '2026-10-25', quotesKRW: 4490, quotes: 1, smartQuotesKRW: 5980, smartQuotes: 3, otherKRW: 0, complete: true }, campaigns: [{ id: 'a1', name: '웹 개발 스마트견적', dailyBudgetKRW: 20000, maxPerDay: 10 }, { id: 'b2', name: '앱 개발', dailyBudgetKRW: 1000000, maxPerDay: 502 }] };

test('the supply report prints spend by source and each campaign budget, and a budget over the setting is told once a day', async () => {
  const instance = makeInstance((c) => ({ ...c, platforms: { soomgo: { ...c.platforms.soomgo, platformSpendMaxPerDay: 30000 } } }));
  const ledger = openLedger(':memory:');
  const openSurface = surfaceWith([], { spend: async () => SPEND });
  const told = [];
  const notify = async (i, n) => {
    const r = await notifyOperator(i, n);
    told.push([n.title, n.dedupeKey, r.written]);
    return r;
  };
  const first = await writeSupply({ instance, ledger, now: NOW, openSurface, notify });
  const soomgo = first.reports[0];
  assert.deepEqual(soomgo.spend.over.map((c) => c.id), ['b2']);
  assert.equal(soomgo.spend.limitKRW, 30000);
  await writeSupply({ instance, ledger, now: new Date(NOW.getTime() + 3_600_000), openSurface, notify });
  await writeSupply({ instance, ledger, now: new Date(NOW.getTime() + 86_400_000), openSurface, notify });
  assert.deepEqual(told.map((t) => [t[1], t[2]]), [['platform-spend:soomgo:20261025', true], ['platform-spend:soomgo:20261025', false], ['platform-spend:soomgo:20261026', true]]);
  const line = supplyLines({ reports: [soomgo] })[0];
  assert.match(line, /cash spent 2026-10-25: quotes 4,490 KRW \(1\), smart quotes 5,980 KRW \(3\), other 0 KRW; campaign 웹 개발 스마트견적: 20,000 KRW a day, at most 10 quotes, campaign 앱 개발: 1,000,000 KRW a day, at most 502 quotes; 1 over platformSpendMaxPerDay 30,000 KRW/);
  const unlimited = await supplyReport('soomgo', { instance: makeInstance(), ledger, now: NOW, openSurface });
  assert.deepEqual([unlimited.spend.limitKRW, unlimited.spend.over], [null, []]);
});

test('the supply line prints the quote funnel, and says when opens are not recorded yet', () => {
  const report = (funnel) => ({ platform: 'soomgo', awaitingReply: 0, parked: { outOfCatalog: 0, stale: 0, expired: 0, notice: 0 }, waiting: {}, status: 'ok', notes: [], funnel });
  const f = { days: 7, sent: 3, opened: 1, hiredUs: 0, hiredOther: 1, noAnswer: 2, unlinked: 0, opensKnown: true };
  assert.match(supplyLines({ reports: [report(f)] })[0], /; quotes in 7 days: 3 sent, 1 opened, 0 hired us, 1 hired another pro, 2 no answer yet$/);
  assert.match(supplyLines({ reports: [report({ ...f, opened: 0, opensKnown: false, unlinked: 2 })] })[0], /quotes in 7 days: 3 sent, opens not recorded yet, 0 hired us, 1 hired another pro, 2 no answer yet, 2 chats not linked to an fsw quote$/);
  assert.doesNotMatch(supplyLines({ reports: [report({ ...f, sent: 0, unlinked: 0 })] })[0], /quotes in/);
});

test('the supply report carries the quote funnel of its platform', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const t = ledger.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  ledger.addQuote({ threadId: t.id, platform: 'soomgo', service: 'detail_page_design', amountKRW: 300000, costKRW: 4000, status: 'sent', at: hoursAgo(5) });
  const report = await supplyReport('soomgo', { instance, ledger, now: NOW, openSurface: surfaceWith([]) });
  assert.deepEqual(report.funnel, { days: 7, sent: 1, opened: 0, hiredUs: 0, hiredOther: 0, noAnswer: 1, unlinked: 0, opensKnown: false });
});
