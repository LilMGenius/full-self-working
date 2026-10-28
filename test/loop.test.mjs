import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { plan, setStatus } from '../src/outbox/index.mjs';
import { advance, moneyToSignals } from '../src/deal/index.mjs';
import { applyEffects, step } from '../src/loop/index.mjs';
import { decide } from '../src/brain/respond.mjs';
import { THREAD_ATTEMPTS } from '../src/triage/index.mjs';
import { scriptedSurface } from './helpers/surface.mjs';
import { readRecording } from '../src/surface/recorder.mjs';
import { openSurface } from '../src/surface/index.mjs';
import { notifyOperator } from '../src/core/notify.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-loop-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms.kmong = { ...config.platforms.kmong, enabled: true, mode: 'auto' };
  config.platforms.soomgo = { ...config.platforms.soomgo, enabled: true, mode: 'auto', maxQuotesPerDay: 5, maxCashPerDay: 5000 };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}
const NOON = new Date('2026-10-20T12:00:00+09:00');
const hoursBefore = (now, h) => new Date(now.getTime() - h * 3_600_000).toISOString();
const REPLY = '요청하신 구성으로 진행 가능합니다. 원하시는 일정을 알려 주세요.';
const decision = (over = {}) => ({ intent: 'inquiry', service: 'landing_page_web', language: 'ko', reply: REPLY, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null, ...over });
const ROW = { platform: 'soomgo', service: 'landing_page_web', category: '웹 개발', baseKRW: 300000, floorKRW: 100000, ceilingKRW: 1000000, costFloorKRW: 50000, viable: true, basis: { source: 'price-guide', median: 300000, p25: 100000, high: 1000000 } };
const NOTICE = {
  paid: (n) => '숨고페이\n고객이 결제한 금액을 숨고가\n안전하게 보관하고 있어요\n협의한 날짜와 금액이 맞는지 확인해 주세요.\n\n서비스명: 과외\n서비스 금액: ' + n + '원',
  hired: '숨고 알리미\n고용이 확정됐어요\n10월 24일 (금) 오전 10:00분까지\n고용을 취소할 수 있습니다.',
};

function codexWith(answer) {
  const fn = async () => {
    fn.calls += 1;
    const d = typeof answer === 'function' ? answer(fn.calls) : answer;
    if (d instanceof Error) throw d;
    return { data: d, durationMs: 1 };
  };
  fn.calls = 0;
  return fn;
}

function setup(edit) {
  const instance = makeInstance(edit);
  const ledger = openLedger(':memory:');
  const notes = [];
  const notify = async (_i, n) => (notes.push(n), { written: true });
  const spawned = [];
  const run = (platform, surface, over = {}) => step(platform, { instance, ledger, now: NOON, notify, openSurface: async () => surface, priceTable: [ROW], spawnJob: (_i, id) => (spawned.push(id), { pid: 1, log: 'runner.log' }), runCodex: codexWith(decision()), ...over });
  const events = (kind) => ledger.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind).map((e) => ({ ref: e.ref, ...JSON.parse(e.payload ?? 'null') }));
  return { instance, ledger, notes, notify, spawned, run, events };
}
const inbound = (platform, ref, over = {}) => ({ platform, ref, kind: 'message', at: hoursBefore(NOON, 1), unread: true, service: null, preview: '문의드립니다', notice: null, status: null, hired: null, quotable: null, expiresAt: null, quoteCostKRW: null, requestId: null, customer: null, quote: null, ...over });
const chat = (platform, ref, text = '랜딩 페이지 제작 가능한가요?', at = hoursBefore(NOON, 1)) => ({ platform, ref, kind: 'message', stage: 'pre_order', customer: null, title: null, language: null, quoteCostKRW: null, budget: null, messages: [{ direction: 'in', text, at, externalId: ref + ':' + at }], notices: [] });
const reads = (s) => s.calls.filter((c) => c.name === 'read');

test('an observe step reads nothing unread and never calls the model', async () => {
  const s = setup((c) => ({ ...c, platforms: { ...c.platforms, kmong: { ...c.platforms.kmong, mode: 'observe' } } }));
  const surface = scriptedSurface({ sense: [inbound('kmong', 'k1'), inbound('kmong', 'k2', { unread: false })], threads: (ref) => chat('kmong', ref) });
  const codex = codexWith(decision());
  const r = await s.run('kmong', surface, { runCodex: codex });
  assert.equal(r.mode, 'observe');
  assert.deepEqual(reads(surface).map((c) => [c.ref, c.opts.willReply]), [['k2', false]]);
  assert.equal(codex.calls, 0);
  assert.equal(r.threads.observed, 2);
});

test('a forced observe pass never signs a signed-out platform in, and a platform configured observe still does', async () => {
  const s = setup((c) => ({ ...c, platforms: { ...c.platforms, kmong: { ...c.platforms.kmong, mode: 'observe' } } }));
  const signIns = [];
  const signInAgain = async ({ id }) => (signIns.push(id), null);
  const forced = await s.run('kmong', scriptedSurface({ login: { loggedIn: false } }), { forceMode: 'observe', signInAgain });
  assert.deepEqual([forced.status, signIns], ['failed', []]);
  const configured = await s.run('kmong', scriptedSurface({ login: { loggedIn: false } }), { signInAgain });
  assert.deepEqual([configured.status, signIns], ['failed', ['kmong']]);
});

test('a login notice names chromeName(config): Chrome, or Chrome with the configured profile', async () => {
  for (const [profile, want] of [[null, /Sign in to .* in Chrome;/], ['X', /in Chrome \(profile X\);/]]) {
    const s = setup((c) => ({ ...c, browser: { ...c.browser, chromeProfile: profile } }));
    const r = await s.run('kmong', scriptedSurface({ login: { loggedIn: false } }));
    assert.equal(r.status, 'failed');
    assert.match(s.notes[0].body, want);
  }
});

test('an auto step outside the outbound hours runs as observe, and at 08:00 it reads to reply', async () => {
  const s = setup();
  const early = new Date('2026-10-20T07:59:00+09:00');
  const row = inbound('kmong', 'k1', { at: hoursBefore(early, 1) });
  const surface = scriptedSurface({ sense: [row], threads: (ref) => chat('kmong', ref) });
  const night = await s.run('kmong', surface, { now: early });
  assert.equal(night.mode, 'observe');
  assert.deepEqual([reads(surface).length, night.threads.observed], [0, 1]);
  const at8 = scriptedSurface({ sense: [row], threads: (ref) => chat('kmong', ref, '랜딩 페이지 제작 가능한가요?', hoursBefore(early, 1)) });
  const day = await s.run('kmong', at8, { now: new Date('2026-10-20T08:00:00+09:00') });
  assert.equal(day.mode, 'auto');
  assert.deepEqual(reads(at8).map((c) => c.opts.willReply), [true]);
});

test('items settled from the list do not use the 10 slots, and the rest wait for the next tick', async () => {
  const s = setup();
  const parked = Array.from({ length: 3 }, (_, i) => inbound('kmong', 'old' + i, { at: hoursBefore(NOON, 100) }));
  const fresh = Array.from({ length: 11 }, (_, i) => inbound('kmong', 'n' + i));
  const surface = scriptedSurface({ sense: [...parked, ...fresh], threads: (ref) => chat('kmong', ref, '랜딩 페이지 문의 ' + ref) });
  const r = await s.run('kmong', surface, { runCodex: codexWith((n) => decision({ reply: REPLY + ' ' + n })) });
  assert.equal(reads(surface).length, 10);
  assert.deepEqual([r.threads.parked, r.deferred], [3, 1]);
});

test('an unread chat whose row carries a money notice is recorded from the row and never opened', async () => {
  const s = setup();
  const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  advance(s.ledger, { type: 'quote_observed', platform: 'soomgo', threadId: t.id, at: hoursBefore(NOON, 3), amountKRW: 300000, evidence: { service: 'landing_page_web' } }, { instance: s.instance, descriptor: loadDescriptor('soomgo'), now: NOON });
  const surface = scriptedSurface({ sense: [inbound('soomgo', 'c1', { preview: NOTICE.hired, notice: NOTICE.hired })] });
  const r = await s.run('soomgo', surface);
  assert.equal(reads(surface).length, 0);
  assert.equal(s.ledger.getJob('soomgo-c1').status, 'ordered');
  assert.equal(r.threads.parked, 1);
  assert.equal(s.ledger.listOutbox({ kinds: ['pay_request'] })[0].status, 'awaiting_operator');
});

// The chat notice that a client posted a review carries no rating or text and names no job, so the step
// records it once and asks the operator to enter the review with fsw deal.
const REVIEW_POSTED = '고객님의 리뷰가 등록되었습니다';
function reviewThread(s, jobs) {
  const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'rv', kind: 'message' });
  for (const [id, status, deliveredAt] of jobs) s.ledger.upsertJob({ id, threadId: t.id, platform: 'soomgo', service: 'landing_page_web', status, priceKRW: 100000, deliveredAt });
  return scriptedSurface({ sense: [inbound('soomgo', 'rv', { preview: REVIEW_POSTED, notice: REVIEW_POSTED, at: hoursBefore(NOON, 1) })] });
}
const reviewNotes = (s) => s.notes.filter((n) => n.dedupeKey?.includes(':review_posted:'));

test('a posted-review notice read on three polls is recorded once, tells the operator once and writes no review', async () => {
  const s = setup();
  const surface = reviewThread(s, [['soomgo-rv', 'delivered', hoursBefore(NOON, 30)]]);
  for (let i = 0; i < 3; i++) await s.run('soomgo', surface);
  assert.equal(s.events('review.posted').length, 1);
  assert.equal(reviewNotes(s).length, 1);
  assert.deepEqual([s.ledger.jobReviews('soomgo-rv').length, s.events('deal.refused').length, s.ledger.listMoneyEvents({ event: 'review' }).length], [0, 0, 0]);
});

test('a posted-review notice names the one delivered job without a review', async () => {
  const s = setup();
  const surface = reviewThread(s, [['old', 'closed', hoursBefore(NOON, 300)], ['new', 'delivered', hoursBefore(NOON, 30)]]);
  s.ledger.addReview({ jobId: 'old', platform: 'soomgo', rating: 5, text: 'x', liked: null });
  await s.run('soomgo', surface);
  const [n] = reviewNotes(s);
  assert.equal(n.title, 'soomgo: a client posted a review on rv for job new');
  assert.match(n.body, /^a client posted a review on rv for job new; record it with fsw deal new review --rating <1-5> --text "\.\.\."/);
});

test('a posted-review notice lists every candidate when two jobs could be the one reviewed, and says so when none is', async () => {
  const s = setup();
  const surface = reviewThread(s, [['old', 'closed', hoursBefore(NOON, 300)], ['new', 'delivered', hoursBefore(NOON, 30)]]);
  await s.run('soomgo', surface);
  const [n] = reviewNotes(s);
  assert.equal(n.title, 'soomgo: a client posted a review on rv; 2 jobs could be the one reviewed');
  assert.match(n.body, /fsw deal old review --rating <1-5>/);
  assert.match(n.body, /fsw deal new review --rating <1-5>/);
  const none = setup();
  await none.run('soomgo', reviewThread(none, []));
  assert.equal(reviewNotes(none)[0].title, 'soomgo: a client posted a review on rv; no delivered job there lacks a review');
});

test('a posted-review notice months old, read when an old chat opens, is recorded without telling the operator', async () => {
  const s = setup();
  const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'rv', kind: 'message' });
  s.ledger.upsertJob({ id: 'soomgo-rv', threadId: t.id, platform: 'soomgo', service: 'landing_page_web', status: 'closed', priceKRW: 100000, deliveredAt: hoursBefore(NOON, 24 * 130) });
  const surface = scriptedSurface({ sense: [inbound('soomgo', 'rv', { preview: REVIEW_POSTED, notice: REVIEW_POSTED, at: hoursBefore(NOON, 24 * 120) })] });
  await s.run('soomgo', surface);
  await s.run('soomgo', surface);
  assert.deepEqual(s.events('review.posted').map((e) => e.stale), [true]);
  assert.equal(reviewNotes(s).length, 0);
});

test('an undated posted-review notice keeps no lasting key: a later one notifies again once the first entry is resolved', async () => {
  const s = setup();
  const requests = join(s.instance.paths.operator, 'requests.md');
  const notify = async (i, n) => (s.notes.push(n), notifyOperator(i, n));
  const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'rv', kind: 'message' });
  s.ledger.upsertJob({ id: 'first', threadId: t.id, platform: 'soomgo', service: 'landing_page_web', status: 'delivered', priceKRW: 100000, deliveredAt: hoursBefore(NOON, 30) });
  const surface = scriptedSurface({ sense: [inbound('soomgo', 'rv', { preview: REVIEW_POSTED, notice: REVIEW_POSTED, at: null })] });
  const written = () => (readFileSync(requests, 'utf8').match(/^## .*a client posted a review on rv/gm) ?? []).length;
  await s.run('soomgo', surface, { notify });
  await s.run('soomgo', surface, { notify });
  assert.equal(written(), 1, 'one open entry stops the repeats');
  assert.match(readFileSync(requests, 'utf8'), /for job first/);
  writeFileSync(requests, readFileSync(requests, 'utf8').replace('- status: open', '- status: resolved'));
  s.ledger.addReview({ jobId: 'first', platform: 'soomgo', rating: 5, text: 'x', liked: null });
  s.ledger.upsertJob({ id: 'second', threadId: t.id, platform: 'soomgo', service: 'landing_page_web', status: 'delivered', priceKRW: 100000, deliveredAt: hoursBefore(NOON, -48) });
  await s.run('soomgo', surface, { notify, now: new Date(NOON.getTime() + 3 * 86_400_000) });
  assert.equal(written(), 2);
  assert.match(readFileSync(requests, 'utf8').split('## ').at(-1), /for job second/);
  assert.equal(s.events('review.posted').length, 0, 'an undated notice is never recorded under a lasting key');
});

test('an undated posted-review notice still on the page asks nothing once every delivered job of the thread has its review', async () => {
  const s = setup();
  const requests = join(s.instance.paths.operator, 'requests.md');
  const notify = async (i, n) => (s.notes.push(n), notifyOperator(i, n));
  const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'rv', kind: 'message' });
  s.ledger.upsertJob({ id: 'only', threadId: t.id, platform: 'soomgo', service: 'landing_page_web', status: 'delivered', priceKRW: 100000, deliveredAt: hoursBefore(NOON, 30) });
  s.ledger.addMessage({ threadId: t.id, direction: 'in', body: '잘 받았습니다', externalId: 'm1', at: hoursBefore(NOON, 5) });
  const surface = scriptedSurface({ sense: [inbound('soomgo', 'rv', { preview: REVIEW_POSTED, notice: REVIEW_POSTED, at: null })] });
  const written = () => (readFileSync(requests, 'utf8').match(/^## .*a client posted a review on rv/gm) ?? []).length;
  await s.run('soomgo', surface, { notify });
  assert.equal(written(), 1);
  writeFileSync(requests, readFileSync(requests, 'utf8').replace('- status: open', '- status: resolved'));
  s.ledger.addReview({ jobId: 'only', platform: 'soomgo', rating: 5, text: '좋아요', liked: null, at: hoursBefore(NOON, -1) });
  await s.run('soomgo', surface, { notify, now: new Date(NOON.getTime() + 2 * 3_600_000) });
  assert.equal(written(), 1, 'the recorded review answers the notice still on the page');
});

test('a second real review on another job of the thread is told although an earlier review was recorded after the last chat message', async () => {
  const s = setup();
  const requests = join(s.instance.paths.operator, 'requests.md');
  const notify = async (i, n) => (s.notes.push(n), notifyOperator(i, n));
  const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'rv', kind: 'message' });
  s.ledger.upsertJob({ id: 'j1', threadId: t.id, platform: 'soomgo', service: 'landing_page_web', status: 'closed', priceKRW: 100000, deliveredAt: hoursBefore(NOON, 200) });
  s.ledger.addMessage({ threadId: t.id, direction: 'in', body: '감사합니다', externalId: 'm1', at: hoursBefore(NOON, 150) });
  s.ledger.addReview({ jobId: 'j1', platform: 'soomgo', rating: 5, text: '좋아요', liked: null, at: hoursBefore(NOON, 100) });
  s.ledger.upsertJob({ id: 'j2', threadId: t.id, platform: 'soomgo', service: 'landing_page_web', status: 'delivered', priceKRW: 100000, deliveredAt: hoursBefore(NOON, 20) });
  const surface = scriptedSurface({ sense: [inbound('soomgo', 'rv', { preview: REVIEW_POSTED, notice: REVIEW_POSTED, at: null })] });
  await s.run('soomgo', surface, { notify });
  const entries = readFileSync(requests, 'utf8').match(/^## .*a client posted a review on rv.*$/gm) ?? [];
  assert.deepEqual(entries.map((l) => l.replace(/^## \S+ \S+ /, '')), ['[order] soomgo: a client posted a review on rv for job j2']);
});

test('a revision decision on a delivered thread reopens its job', async () => {
  const s = setup();
  const t = s.ledger.upsertThread({ platform: 'kmong', externalId: 'k1', kind: 'message' });
  s.ledger.upsertJob({ id: 'kmong-k1', threadId: t.id, platform: 'kmong', service: 'landing_page_web', status: 'delivered', meta: { scope: ['one page'] } });
  const surface = scriptedSurface({ sense: [inbound('kmong', 'k1')], threads: (ref) => chat('kmong', ref, '메뉴 사진을 더 크게 바꿔 주세요.') });
  await s.run('kmong', surface, { runCodex: codexWith(decision({ intent: 'revision', reply: '말씀하신 대로 사진을 키워서 다시 보내 드리겠습니다.' })) });
  assert.equal(s.ledger.getJob('kmong-k1').status, 'revision');
  assert.deepEqual(s.spawned, ['kmong-k1']);
});

test('a config without pipeline settings fails before sense, and observe still reads', async () => {
  const s = setup((c) => ({ ...c, pipeline: undefined }));
  let sensed = 0;
  const surface = scriptedSurface({ sense: () => (sensed++, []) });
  const r = await s.run('kmong', surface);
  assert.deepEqual([r.status, r.code, sensed], ['failed', 'FSW_CONFIG_MISSING', 0]);
  const o = await s.run('kmong', surface, { forceMode: 'observe' });
  assert.deepEqual([o.status, sensed], ['ok', 1]);
});

test('a throwing thread is recorded and the next one runs; pacing stops the platform', async () => {
  const s = setup();
  const surface = scriptedSurface({ sense: [inbound('kmong', 'bad'), inbound('kmong', 'ok')], threads: (ref) => (ref === 'bad' ? new Error('page did not load') : chat('kmong', ref)) });
  const r = await s.run('kmong', surface);
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.errors.map((e) => e.ref), ['bad']);
  assert.equal(r.outbox.observed, 1);
  const p = setup();
  const pacing = scriptedSurface({ sense: [inbound('kmong', 'a'), inbound('kmong', 'b')], threads: () => Object.assign(new Error('pacing'), { code: 'FSW_PACING_LIMIT' }) });
  const pr = await p.run('kmong', pacing);
  assert.equal(reads(pacing).length, 1);
  assert.equal(pr.errors[0].code, 'FSW_PACING_LIMIT');
});

test('a thread whose pass threw is passed again on the next ticks, at most THREAD_ATTEMPTS times in all', async () => {
  const s = setup();
  let tick = 0;
  // The model rejects every decision for dead and the first two for flaky, after each read stored its message.
  const flakyDecide = (view, c) => (view.ref === 'dead' || tick < 3 ? Promise.reject(Object.assign(new Error('model decision rejected'), { code: 'FSW_BRAIN_BAD_DECISION' })) : decide(view, { ...c, runCodex: codexWith(decision()) }));
  const at = hoursBefore(NOON, 2);
  const surface = (unread) => scriptedSurface({ sense: [inbound('kmong', 'flaky', { unread, at }), inbound('kmong', 'dead', { unread, at })], threads: (ref) => chat('kmong', ref, '랜딩 페이지 제작 가능한가요? ' + ref, at) });
  for (tick = 1; tick <= 3; tick++) await s.run('kmong', surface(tick === 1), { decide: flakyDecide });
  assert.equal(s.ledger.listOutbox({ kinds: ['message'] }).length, 1);
  assert.equal(s.ledger.listThreads({ platform: 'kmong' }).find((t) => t.externalId === 'dead').meta.failed.count, THREAD_ATTEMPTS);
  const fourth = surface(false);
  await s.run('kmong', fourth, { decide: flakyDecide });
  assert.deepEqual(reads(fourth).map((c) => c.ref), []);
});


// soomgo chat 239686622 on 2026-10-26: one read timed out at 15:21Z, and the observe ticks after it read the
// unchanged chat again every five minutes, because a read that succeeded left the failure on the thread.
test('a read that succeeds after a failed one clears the failure, so an unchanged thread is not read again', async () => {
  const s = setup((c) => ({ ...c, platforms: { ...c.platforms, kmong: { ...c.platforms.kmong, mode: 'observe' } } }));
  const at = hoursBefore(NOON, 2);
  const row = inbound('kmong', 'k1', { unread: false, at });
  let fail = true;
  const surface = () => scriptedSurface({ sense: [row], threads: (ref) => (fail ? Object.assign(new Error('tool RPC timed out after 20s'), { code: 'timeout' }) : chat('kmong', ref, '문의드립니다', at)) });
  const first = surface();
  await s.run('kmong', first);
  fail = false;
  const second = surface();
  await s.run('kmong', second);
  const third = surface();
  await s.run('kmong', third);
  assert.deepEqual([reads(first).length, reads(second).length, reads(third).length], [1, 1, 0]);
  assert.equal(s.ledger.listThreads({ platform: 'kmong' }).find((t) => t.externalId === 'k1').meta.failed, undefined);
});


// A step after decide (the deal or the plan) that throws every tick: the failure count must still reach
// THREAD_ATTEMPTS, or the thread is read and the model called every five minutes for good.
test('a pass that fails after decide keeps counting toward THREAD_ATTEMPTS and stops reading the thread', async () => {
  const s = setup();
  const at = hoursBefore(NOON, 2);
  let decided = 0;
  const brokenPlan = async () => (decided++, { modelCalls: 1, decision: decision(), item: { kind: 'message', thread: { kind: 'message', stage: 'pre_order' }, get text() { throw Object.assign(new Error('payload failed'), { code: 'FSW_TEST_PLAN' }); } } });
  const surface = () => scriptedSurface({ sense: [inbound('kmong', 'k1', { unread: false, at })], threads: (ref) => chat('kmong', ref, '문의드립니다', at) });
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const sf = surface();
    await s.run('kmong', sf, { decide: brokenPlan });
    seen.push(reads(sf).length);
  }
  assert.deepEqual(seen, [1, 1, 1, 0, 0]);
  assert.equal(decided, THREAD_ATTEMPTS);
  assert.equal(s.ledger.listThreads({ platform: 'kmong' }).find((t) => t.externalId === 'k1').meta.failed.count, THREAD_ATTEMPTS);
});

test('a deposit request the client paid before the hand-over goes stale and is never sent', async () => {
  const s = setup((c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, services: ['landing_page_web', 'lesson_tutoring'] } } }));
  const descriptor = loadDescriptor('soomgo');
  const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'l1', kind: 'message' });
  const ctx = { instance: s.instance, descriptor, now: NOON };
  advance(s.ledger, { type: 'quote_observed', platform: 'soomgo', threadId: t.id, at: hoursBefore(NOON, 5), amountKRW: 100000, evidence: { service: 'lesson_tutoring' } }, ctx);
  const hire = advance(s.ledger, moneyToSignals({ platform: 'soomgo', threadId: t.id, notices: [{ text: NOTICE.hired, at: hoursBefore(NOON, 4) }], now: NOON })[0], ctx);
  await applyEffects(hire.effects, { instance: s.instance, ledger: s.ledger, notify: s.notify });
  const [deposit] = s.ledger.listOutbox({ kinds: ['pay_request'] });
  setStatus(s.ledger, deposit.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-soomgo-0000d001' });
  const surface = scriptedSurface({ sense: [inbound('soomgo', 'l1', { preview: NOTICE.paid('50,000'), notice: NOTICE.paid('50,000'), at: hoursBefore(NOON, 1) })] });
  await s.run('soomgo', surface);
  const after = s.ledger.getOutbox(deposit.id);
  assert.equal(after.status, 'stale');
  assert.match(after.reason, /the client paid 50000 KRW before the hand-over/);
  assert.equal(surface.count('payRequest'), 0);
  const balance = s.ledger.listOutbox({ kinds: ['pay_request'] }).find((r) => r.id !== deposit.id);
  assert.equal(balance.status, 'awaiting_operator');
});

test('a kmong order counter rise notifies once', async () => {
  const s = setup();
  let counts = { new: 0 };
  const surface = () => scriptedSurface({ methods: ['orders'], orders: () => ({ counts, total: 0, gap: 'rows not parsed', orders: null }) });
  await s.run('kmong', surface());
  counts = { new: 1 };
  await s.run('kmong', surface());
  await s.run('kmong', surface());
  assert.equal(s.notes.filter((n) => /order counters rose/.test(n.title)).length, 1);
});

test('a chat decided with nothing to send goes through the model again only when its list time moves', async () => {
  const s = setup();
  const codex = codexWith(decision({ reply: null, intent: 'smalltalk' }));
  const at = hoursBefore(NOON, 2);
  const surf = (when) => scriptedSurface({ sense: [inbound('kmong', 'k1', { unread: false, at: when })], threads: (ref) => chat('kmong', ref, '감사합니다', hoursBefore(NOON, 3)) });
  await s.run('kmong', surf(at), { runCodex: codex });
  await s.run('kmong', surf(at), { runCodex: codex });
  assert.equal(codex.calls, 1);
  await s.run('kmong', surf(hoursBefore(NOON, 1)), { runCodex: codex });
  assert.equal(codex.calls, 2);
});

test('a chat read at night is read once, then decided once when the outbound hours open', async () => {
  const s = setup();
  const codex = codexWith(decision({ reply: null, intent: 'smalltalk' }));
  const at = '2026-10-20T05:00:00+09:00';
  const surf = () => scriptedSurface({ sense: [inbound('kmong', 'k1', { unread: false, at })], threads: (ref) => chat('kmong', ref, '감사합니다', '2026-10-20T04:00:00+09:00') });
  const n1 = surf();
  const n2 = surf();
  await s.run('kmong', n1, { runCodex: codex, now: new Date('2026-10-20T06:00:00+09:00') });
  await s.run('kmong', n2, { runCodex: codex, now: new Date('2026-10-20T06:05:00+09:00') });
  assert.deepEqual([reads(n1).length, reads(n2).length, codex.calls], [1, 0, 0]);
  await s.run('kmong', surf(), { runCodex: codex, now: new Date('2026-10-20T08:00:00+09:00') });
  await s.run('kmong', surf(), { runCodex: codex, now: new Date('2026-10-20T08:05:00+09:00') });
  assert.equal(codex.calls, 1);
});

test('a soomgo buyer request decided unsupported plans no outbox row; the same decision on a chat goes to the operator', async () => {
  const s = setup();
  const unsupported = decision({ intent: 'unsupported', reply: '해당 작업은 진행이 어렵습니다.', operatorReason: 'breaks another service terms' });
  const req = inbound('soomgo', 'r1', { kind: 'request', service: '웹 개발', quotable: true, quoteCostKRW: 990 });
  const surface = scriptedSurface({ sense: [req], threads: (ref) => ({ ...chat('soomgo', ref, '웹 개발\n다른 사이트 크롤링 우회'), kind: 'request', quoteCostKRW: 990 }) });
  const r = await s.run('soomgo', surface, { runCodex: codexWith(unsupported) });
  assert.equal(r.threads.operator, 1);
  assert.equal(s.ledger.listOutbox().length, 0);
  assert.equal(surface.count('quote'), 0);
  assert.equal(s.events('thread.operator').at(-1).reason, 'unsupported: breaks another service terms');
  const c = setup();
  const cs = scriptedSurface({ sense: [inbound('soomgo', 'c1', { service: '웹 개발' })], threads: (ref) => chat('soomgo', ref, '웹 개발 문의드립니다') });
  await c.run('soomgo', cs, { runCodex: codexWith(unsupported) });
  assert.equal(c.ledger.listOutbox()[0].status, 'awaiting_operator');
});


test('a soomgo request at the most quotes it takes parks before the model, from its list row or from its page', async () => {
  const s = setup();
  const req = (quoteCount) => inbound('soomgo', 'r1', { kind: 'request', service: '웹 개발', quotable: true, quoteCostKRW: 990, quoteCount });
  const page = (quoteCount) => (ref) => ({ ...chat('soomgo', ref, '웹 개발\n회사 소개 랜딩 페이지가 필요합니다.'), kind: 'request', quoteCostKRW: 990, quoteCount });
  const codex = codexWith(decision({ intent: 'quote_request' }));
  const surface = scriptedSurface({ sense: [req(3)], threads: page(10) });
  const r = await s.run('soomgo', surface, { runCodex: codex });
  assert.deepEqual([codex.calls, r.threads.parked, s.ledger.listOutbox().length], [0, 1, 0]);
  assert.equal(s.events('thread.skipped').at(-1).reason, 'expired: the request already has 10 quotes and soomgo takes 10');
  const t = setup();
  const listed = scriptedSurface({ sense: [req(12)], threads: page(12) });
  await t.run('soomgo', listed, { runCodex: codex });
  assert.deepEqual([reads(listed).length, codex.calls], [0, 0]);
});

test('a buyer request is left unread with no model call while the day budget is spent, and read on the next day', async () => {
  const s = setup();
  const r0 = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'old', kind: 'request' });
  for (let i = 0; i < 5; i++) s.ledger.addQuote({ threadId: r0.id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 990, status: 'sent', at: NOON.toISOString() });
  const req = (now) => inbound('soomgo', 'r1', { kind: 'request', service: '웹 개발', quotable: true, quoteCostKRW: 990, at: hoursBefore(now, 1) });
  const thread = (ref) => ({ ...chat('soomgo', ref, '웹 개발\n회사 소개 랜딩 페이지가 필요합니다.'), kind: 'request', quoteCostKRW: 990 });
  // fit: the value gate drops a paid request quote whose fit the decision does not judge.
  const quote = decision({ intent: 'quote_request', reply: '요청하신 랜딩 페이지를 구성해 드리겠습니다. 결제는 착수금과 잔금으로 나누어 받습니다.', quote: { amountKRW: 1, scope: ['랜딩 페이지 1개'], deliveryDays: 7, priceType: 'fixed', complexity: 1 }, fit: 'strong', fitReason: 'synthetic' });
  const codex = codexWith(quote);
  const spent = scriptedSurface({ sense: [req(NOON)], threads: thread });
  const r = await s.run('soomgo', spent, { runCodex: codex });
  assert.deepEqual([r.threads.budget, reads(spent).length, codex.calls, s.ledger.listOutbox().length], [1, 0, 0, 0]);
  assert.equal(s.ledger.listThreads({ platform: 'soomgo' }).find((t) => t.externalId === 'r1').meta, null);
  const next = new Date('2026-10-21T09:00:00+09:00');
  const day2 = scriptedSurface({ sense: [req(next)], threads: thread, receipts: { quote: [{ observed: true, cashSpentKRW: 990 }] } });
  const r2 = await s.run('soomgo', day2, { runCodex: codex, now: next });
  assert.deepEqual([r2.threads.budget, reads(day2).length, codex.calls, day2.count('quote')], [undefined, 1, 1, 1]);
});

test('cash quotes still waiting from an earlier day fill the cap before a new request is read', async () => {
  const s = setup((c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, maxQuotesPerDay: 1 } } }));
  const waiting = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'w1', kind: 'request' });
  plan(s.ledger, { platform: 'soomgo', threadId: waiting.id, kind: 'quote', payload: { text: REPLY, amountKRW: 300000, costKRW: 990, thread: { kind: 'request', stage: 'pre_order' }, priceRow: ROW, decision: decision({ intent: 'quote_request' }) } });
  const codex = codexWith(decision());
  const surface = scriptedSurface({ sense: [inbound('soomgo', 'r2', { kind: 'request', service: '웹 개발', quotable: true, quoteCostKRW: 990 })] });
  const r = await s.run('soomgo', surface, { runCodex: codex });
  assert.deepEqual([r.threads.budget, codex.calls, reads(surface).length], [1, 0, 0]);
});

// The day's quote cash is spread over the Seoul day (quoteGate.pace even): at 12:00 a cap of 5,000 allows 2,500, so
// a request waits unread while 3,000 is spent, and opens once the day's share passes the spend.
test('a buyer request waits unread while the day\'s cash runs ahead of the Seoul day, is read once the share catches up, and pace off or draft mode never waits', async () => {
  const s = setup();
  const old = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'old', kind: 'request' });
  s.ledger.addQuote({ threadId: old.id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 3000, status: 'sent', at: hoursBefore(NOON, 2) });
  const req = (now) => inbound('soomgo', 'r1', { kind: 'request', service: '웹 개발', quotable: true, quoteCostKRW: 990, at: hoursBefore(now, 1) });
  const thread = (ref) => ({ ...chat('soomgo', ref, '웹 개발\n회사 소개 랜딩 페이지가 필요합니다.'), kind: 'request', quoteCostKRW: 990 });
  const codex = codexWith(decision({ intent: 'quote_request', reply: null }));
  for (const minutes of [0, 5]) {
    const surface = scriptedSurface({ sense: [req(NOON)], threads: thread });
    const r = await s.run('soomgo', surface, { runCodex: codex, now: new Date(NOON.getTime() + minutes * 60_000) });
    assert.deepEqual([r.threads.pace, r.threads.budget, reads(surface).length, codex.calls], [1, undefined, 0, 0]);
  }
  assert.equal(s.ledger.listThreads({ platform: 'soomgo' }).find((t) => t.externalId === 'r1').meta, null);
  // One event a request a Seoul day, however many ticks hold it.
  assert.deepEqual(s.events('quote.pace_held').map((e) => [e.ref, e.cashKRW]), [['r1', 3000]]);
  const evening = new Date('2026-10-20T18:00:00+09:00');
  const later = scriptedSurface({ sense: [req(evening)], threads: thread });
  const r = await s.run('soomgo', later, { runCodex: codex, now: evening });
  assert.deepEqual([r.threads.pace, reads(later).length, codex.calls], [undefined, 1, 1]);
  // quoteGate.pace off leaves only the day caps, and draft mode, where the operator approves each quote, is never paced.
  for (const edit of [(p) => ({ ...p, quoteGate: { pace: 'off' } }), (p) => ({ ...p, mode: 'draft' })]) {
    const s = setup((c) => ({ ...c, platforms: { ...c.platforms, soomgo: edit(c.platforms.soomgo) } }));
    const old = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'old', kind: 'request' });
    s.ledger.addQuote({ threadId: old.id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 3000, status: 'sent', at: hoursBefore(NOON, 2) });
    const codex = codexWith(decision({ intent: 'quote_request', reply: null }));
    const surface = scriptedSurface({ sense: [inbound('soomgo', 'r1', { kind: 'request', service: '웹 개발', quotable: true, quoteCostKRW: 990 })], threads: (ref) => ({ ...chat('soomgo', ref, '웹 개발\n회사 소개 랜딩 페이지가 필요합니다.'), kind: 'request', quoteCostKRW: 990 }) });
    const r = await s.run('soomgo', surface, { runCodex: codex });
    assert.deepEqual([r.threads.pace, reads(surface).length, codex.calls], [undefined, 1, 1]);
  }
});
// The value gate (src/economics/quote-gate.mjs) judges a paid quote on a buyer request after the decision and
// before it is planned. ROW prices a complexity 1 request at 300,000 KRW over a 50,000 cost floor, so with 2
// quotes on the request the win chance is 1/3 and the value 250,000 / 3 - 990.
const QUOTE_TEXT = '요청하신 랜딩 페이지를 구성해 드리겠습니다. 결제는 착수금과 잔금으로 나누어 받습니다.';
const paidQuote = (fit) => decision({ intent: 'quote_request', reply: QUOTE_TEXT, quote: { amountKRW: 1, scope: ['랜딩 페이지 1개'], deliveryDays: 7, priceType: 'fixed', complexity: 1 }, fit, fitReason: fit ? 'synthetic fit ' + fit : null });
const request = (ref) => inbound('soomgo', ref, { kind: 'request', service: '웹 개발', quotable: true, quoteCostKRW: 990, quoteCount: 2 });
const requestPage = (ref) => ({ ...chat('soomgo', ref, '웹 개발\n회사 소개 랜딩 페이지가 필요합니다.'), kind: 'request', quoteCostKRW: 990, quoteCount: 2 });

test('a paid quote under the fit floor parks with its gate reason, holds under the same settings, and is judged again once quoteGate.minFit changes', async () => {
  const s = setup();
  const codex = codexWith(paidQuote('none'));
  const tick = async (row = {}) => {
    const surface = scriptedSurface({ sense: [{ ...request('r1'), ...row }], threads: requestPage, receipts: { quote: [{ observed: true, cashSpentKRW: 990 }] } });
    const r = await s.run('soomgo', surface, { runCodex: codex });
    return { r, reads: reads(surface).length };
  };
  const first = await tick();
  assert.deepEqual([first.r.threads.parked, first.r.threads.planned, s.ledger.listOutbox().length, codex.calls], [1, undefined, 0, 1]);
  assert.deepEqual(s.events('quote.judged').map((e) => [e.ref, e.verdict, e.reason, e.fit, e.quoteCount, e.quoteCostKRW]), [['r1', 'drop', 'gate: fit.low', 'none', 2, 990]]);
  assert.equal(s.events('thread.skipped').at(-1).reason, 'gate: fit.low');
  // The same settings: the park holds with no read and no model call.
  const held = await tick();
  assert.deepEqual([held.reads, codex.calls], [0, 1]);
  // A changed gate setting judges it again, and a quote that clears it is planned and sent.
  s.instance.config.platforms.soomgo.quoteGate = { ...s.instance.config.platforms.soomgo.quoteGate, minFit: 'none' };
  const rejudged = await tick();
  assert.deepEqual([rejudged.reads, codex.calls, rejudged.r.threads.planned], [1, 2, 1]);
  assert.deepEqual(s.events('quote.judged').map((e) => e.verdict), ['drop', 'send']);
  // The send ended the park: once the list shows the request read, it is not read again at the same list time.
  const after = await tick({ unread: false });
  assert.deepEqual([after.reads, codex.calls], [0, 2]);
});

test('a paid quote with a positive value is planned and its verdict recorded, a negative one parks, and a chat quote is never judged', async () => {
  const s = setup();
  const surface = scriptedSurface({ sense: [request('r1')], threads: requestPage });
  const r = await s.run('soomgo', surface, { runCodex: codexWith(paidQuote('strong')) });
  assert.equal(r.threads.planned, 1);
  const [sent] = s.events('quote.judged');
  assert.deepEqual([sent.verdict, sent.reason, sent.p, sent.p0, sent.marginKRW, sent.fit, sent.fitReason], ['send', 'gate: value.positive', 1 / 3, 1 / 3, 250000, 'strong', 'synthetic fit strong']);
  assert.equal(Math.round(sent.evKRW), Math.round(250000 / 3 - 990));
  // A cost floor that leaves 1,000 KRW of margin: 1/3 x 1,000 - 990 is under zero.
  const thin = setup();
  const r2 = await thin.run('soomgo', scriptedSurface({ sense: [request('r2')], threads: requestPage }), { runCodex: codexWith(paidQuote('strong')), priceTable: [{ ...ROW, costFloorKRW: 299000 }] });
  assert.deepEqual([r2.threads.parked, thin.ledger.listOutbox().length, thin.events('thread.skipped').at(-1).reason], [1, 0, 'gate: value.negative']);
  // A quote in a soomgo chat costs no cash and asks no fit, so the gate leaves it alone.
  const c = setup();
  const cs = scriptedSurface({ sense: [inbound('soomgo', 'c1', { service: '웹 개발' })], threads: (ref) => chat('soomgo', ref, '웹 개발 견적 부탁드립니다') });
  await c.run('soomgo', cs, { runCodex: codexWith(decision({ intent: 'quote_request', reply: QUOTE_TEXT, quote: { amountKRW: 300000, scope: ['랜딩 페이지 1개'], deliveryDays: 7, priceType: 'fixed', complexity: 1 } })) });
  assert.deepEqual([c.ledger.listOutbox().map((x) => x.kind), c.events('quote.judged').length], [['quote'], 0]);
});

// A paid request quote planned before the value gate existed carries no verdict on its payload. Unapproved, the drain
// blocks it and the surface never quotes; the operator's approval is his own judgment and still sends it. A quote the
// step plans now carries the send verdict it was judged at.
test('a paid request quote planned without a value gate verdict is blocked unsent unless approved, and a new one carries its verdict', async () => {
  for (const approved of [false, true]) {
    const s = setup();
    const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
    const old = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'quote', payload: { text: QUOTE_TEXT, amountKRW: 300000, costKRW: 990, service: 'landing_page_web', serviceLabel: '웹 개발', thread: { kind: 'request', stage: 'pre_order' }, decision: paidQuote(undefined), priceRow: ROW } });
    if (approved) {
      setStatus(s.ledger, old.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-soomgo-00000001' });
      setStatus(s.ledger, old.id, { from: 'awaiting_operator', to: 'approved' });
    }
    const surface = scriptedSurface({ receipts: { quote: [{ observed: true, cashSpentKRW: 990 }] } });
    await s.run('soomgo', surface);
    assert.deepEqual([s.ledger.getOutbox(old.id).status, surface.count('quote')], approved ? ['observed', 1] : ['blocked', 0], 'approved ' + approved);
    if (!approved) assert.match(s.ledger.getOutbox(old.id).reason, /^gate\.unjudged /);
  }
  const s = setup();
  await s.run('soomgo', scriptedSurface({ sense: [request('r2')], threads: requestPage }), { runCodex: codexWith(paidQuote('strong')) });
  const [row] = s.ledger.listOutbox();
  assert.deepEqual([row.payload.gate.verdict, row.payload.gate.p, Math.round(row.payload.gate.evKRW), row.payload.gate.at], ['send', 1 / 3, Math.round(250000 / 3 - 990), NOON.toISOString()]);
});

// The pace is checked when a request is opened, and a quote planned then can still be retried later in the day. One the
// driver deferred (FSW_PACING_LIMIT) is retried at 12:00 with 3,000 of a 5,000 cap spent, ahead of the 2,500 the day
// allows: the drain holds it planned, uncharged, and sends it once the day's share passes the spend.
test('a paid quote retried while the day\'s cash runs ahead of the Seoul day stays planned until the share catches up', async () => {
  const s = setup();
  const limited = Object.assign(new Error('synthetic action limit'), { code: 'FSW_PACING_LIMIT' });
  const first = scriptedSurface({ sense: [request('r1')], threads: requestPage, receipts: { quote: [limited] } });
  await s.run('soomgo', first, { runCodex: codexWith(paidQuote('strong')) });
  const [row] = s.ledger.listOutbox();
  assert.equal(row.status, 'planned');
  const old = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'old', kind: 'request' });
  s.ledger.addQuote({ threadId: old.id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 3000, status: 'sent', at: NOON.toISOString() });
  const retry = scriptedSurface({ sense: [{ ...request('r1'), unread: false }], threads: requestPage, receipts: { quote: [{ observed: true, cashSpentKRW: 990 }] } });
  const r = await s.run('soomgo', retry, { runCodex: codexWith(paidQuote('strong')) });
  assert.deepEqual([r.outbox.held, retry.count('quote'), s.ledger.getOutbox(row.id).status], [1, 0, 'planned']);
  const evening = new Date('2026-10-20T18:00:00+09:00');
  const later = scriptedSurface({ sense: [{ ...request('r1'), unread: false }], threads: requestPage, receipts: { quote: [{ observed: true, cashSpentKRW: 990 }] } });
  await s.run('soomgo', later, { runCodex: codexWith(paidQuote('strong')), now: evening });
  assert.deepEqual([later.count('quote'), s.ledger.getOutbox(row.id).status], [1, 'observed']);
});
test('a read request keeps the snapshot it was decided on, rewritten only when its quote count, cost or budget moves', async () => {
  const s = setup();
  const codex = codexWith(decision({ intent: 'quote_request', reply: null }));
  const page = (quoteCount) => (ref) => ({ ...chat('soomgo', ref, '웹 개발\n회사 소개 랜딩 페이지가 필요합니다.'), kind: 'request', quoteCostKRW: 990, quoteCount, budget: { minKRW: 100000, maxKRW: 200000 } });
  const tick = async (hours, quoteCount) => {
    const now = new Date(NOON.getTime() + hours * 3_600_000);
    await s.run('soomgo', scriptedSurface({ sense: [inbound('soomgo', 'r1', { kind: 'request', service: '웹 개발', quotable: true, quoteCostKRW: 990, at: hoursBefore(now, 0.5) })], threads: page(quoteCount) }), { runCodex: codex, now });
    return s.ledger.listThreads({ platform: 'soomgo' }).find((t) => t.externalId === 'r1').meta.request;
  };
  const first = await tick(0, 2);
  assert.deepEqual(first, { quoteCount: 2, quoteCostKRW: 990, budget: { minKRW: 100000, maxKRW: 200000 }, readAt: NOON.toISOString() });
  assert.deepEqual(await tick(1, 2), first, 'an unchanged snapshot keeps the time it was first read');
  assert.deepEqual(await tick(2, 4), { ...first, quoteCount: 4, readAt: new Date(NOON.getTime() + 2 * 3_600_000).toISOString() });
  assert.equal(codex.calls, 3);
});
test('an expired request whose thread has a quoted job loses the job', async () => {
  const s = setup();
  const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'r9', kind: 'request' });
  advance(s.ledger, { type: 'quote_observed', platform: 'soomgo', threadId: t.id, at: hoursBefore(NOON, 30), amountKRW: 300000, evidence: { service: 'landing_page_web' } }, { instance: s.instance, descriptor: loadDescriptor('soomgo'), now: NOON });
  const surface = scriptedSurface({ sense: [inbound('soomgo', 'r9', { kind: 'request', quotable: false })] });
  await s.run('soomgo', surface);
  assert.equal(s.ledger.getJob('soomgo-r9').status, 'lost');
  assert.equal(s.ledger.listQuotes()[0].status, 'expired');
  assert.equal(s.events('thread.skipped').length, 1);
});

test('a list row whose money signal throws is recorded as that row\'s error and the other rows still run', async () => {
  const s = setup();
  const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'bad', kind: 'message' });
  advance(s.ledger, { type: 'quote_observed', platform: 'soomgo', threadId: t.id, at: hoursBefore(NOON, 3), amountKRW: 300000, evidence: { service: 'landing_page_web' } }, { instance: s.instance, descriptor: loadDescriptor('soomgo'), now: NOON });
  const real = s.ledger.addMoneyEvent;
  s.ledger.addMoneyEvent = (e) => {
    if (e.threadId === t.id) throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
    return real(e);
  };
  const surface = scriptedSurface({ sense: [inbound('soomgo', 'bad', { preview: NOTICE.hired, notice: NOTICE.hired }), inbound('soomgo', 'ok', { service: '웹 개발' })], threads: (ref) => chat('soomgo', ref, '웹 개발 문의드립니다') });
  const r = await s.run('soomgo', surface);
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.errors.map((e) => [e.ref, e.code]), [['bad', 'ERR_SQLITE_ERROR']]);
  assert.equal(s.ledger.getJob('soomgo-bad').status, 'quoted');
  assert.equal(r.outbox.observed, 1);
  assert.equal(s.events('thread.error').at(-1).stage, 'money');
});


test('a send observed in an earlier pass whose deal signal was lost is applied once, and one signal that throws does not drop the rest', async () => {
  const s = setup();
  const lost = (ref, cost) => {
    const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: ref, kind: 'request' });
    const row = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'quote', payload: { text: REPLY + ' ' + ref, amountKRW: 300000, costKRW: cost, service: 'landing_page_web', thread: { kind: 'request', stage: 'pre_order' } } });
    setStatus(s.ledger, row.id, { from: 'planned', to: 'sending' });
    setStatus(s.ledger, row.id, { from: 'sending', to: 'observed', receipt: { observed: true, cashSpentKRW: cost } });
    return t;
  };
  const broken = lost('r1', 990);
  const fine = lost('r2', 700);
  const real = s.ledger.addQuote;
  s.ledger.addQuote = (q) => {
    if (q.threadId === broken.id) throw new Error('disk I/O error');
    return real(q);
  };
  const r = await s.run('soomgo', scriptedSurface());
  assert.deepEqual(r.errors.map((e) => e.message), ['disk I/O error']);
  assert.deepEqual(s.ledger.listQuotes().map((q) => [q.threadId, q.costKRW]), [[fine.id, 700]]);
  s.ledger.addQuote = real;
  await s.run('soomgo', scriptedSurface());
  await s.run('soomgo', scriptedSurface());
  assert.deepEqual(s.ledger.listQuotes().map((q) => q.threadId).sort(), [broken.id, fine.id].sort());
  assert.deepEqual(s.ledger.listJobs().map((j) => j.status), ['quoted', 'quoted']);
});


test('sends the d605c5d code recorded are never applied again by the sweep after the takeover', async () => {
  const { importApprovals } = await import('../src/core/approvals-import.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const s = setup();
  const dir = s.instance.paths.approvals;
  mkdirSync(dir, { recursive: true });
  const write = (a) => writeFileSync(join(dir, a.id + '.json'), JSON.stringify(a));
  const oldQuote = (t) => s.ledger.addQuote({ threadId: t.id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 990, status: 'sent', at: hoursBefore(NOON, 2) });
  // A sent approval file the old code recorded, with its quote row already in the ledger.
  const t1 = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  oldQuote(t1);
  write({ id: '20261020-soomgo-0000ee01', platform: 'soomgo', kind: 'quote', threadRef: 'r1', status: 'sent', createdAt: hoursBefore(NOON, 3), draft: REPLY, quote: { amountKRW: 300000 }, closedAt: hoursBefore(NOON, 2) });
  // A quote v0 left waiting for the operator, which the old code sent after a rollback.
  const t2 = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'r2', kind: 'request' });
  const row = plan(s.ledger, { platform: 'soomgo', threadId: t2.id, kind: 'quote', payload: { text: REPLY + ' r2', amountKRW: 300000, costKRW: 990, thread: { kind: 'request', stage: 'pre_order' } } });
  setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-soomgo-0000ee02' });
  oldQuote(t2);
  write({ id: '20261020-soomgo-0000ee02', platform: 'soomgo', kind: 'quote', threadRef: 'r2', status: 'sent', createdAt: hoursBefore(NOON, 3), draft: REPLY + ' r2', quote: { amountKRW: 300000 }, closedAt: hoursBefore(NOON, 2) });
  const imported = importApprovals(s.ledger, dir);
  assert.deepEqual([imported.imported, imported.reconciled], [1, 1]);
  assert.deepEqual(s.ledger.listOutbox().map((r) => r.status), ['observed', 'observed']);
  await s.run('soomgo', scriptedSurface());
  assert.deepEqual(s.ledger.listQuotes().map((q) => q.threadId).sort(), [t1.id, t2.id].sort());
  assert.equal(s.ledger.listJobs().length, 0);
});


test('an approved quote no day can pay does not take the last quote of the day from a new request', async () => {
  const s = setup((c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, maxQuotesPerDay: 2 } } }));
  const old = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'old', kind: 'request' });
  s.ledger.addQuote({ threadId: old.id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 990, status: 'sent', at: NOON.toISOString() });
  const stuck = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'w1', kind: 'request' });
  const row = plan(s.ledger, { platform: 'soomgo', threadId: stuck.id, kind: 'quote', payload: { text: REPLY, amountKRW: 300000, costKRW: null, thread: { kind: 'request', stage: 'pre_order' }, priceRow: ROW, decision: decision({ intent: 'quote_request' }) } });
  setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-soomgo-0000ff01' });
  setStatus(s.ledger, row.id, { from: 'awaiting_operator', to: 'approved' });
  const quote = decision({ intent: 'quote_request', reply: '요청하신 랜딩 페이지를 구성해 드리겠습니다. 결제는 착수금과 잔금으로 나누어 받습니다.', quote: { amountKRW: 1, scope: ['랜딩 페이지 1개'], deliveryDays: 7, priceType: 'fixed', complexity: 1 } });
  const codex = codexWith(quote);
  const surface = scriptedSurface({ sense: [inbound('soomgo', 'r2', { kind: 'request', service: '웹 개발', quotable: true, quoteCostKRW: 990 })], threads: (ref) => ({ ...chat('soomgo', ref, '웹 개발\n회사 소개 랜딩 페이지가 필요합니다.'), kind: 'request', quoteCostKRW: 990 }) });
  const r = await s.run('soomgo', surface, { runCodex: codex });
  assert.deepEqual([r.threads.budget, codex.calls, reads(surface).length], [undefined, 1, 1]);
});


test('a deal signal that fails on every tick tells the operator once', async () => {
  const { readFileSync } = await import('node:fs');
  const s = setup();
  const t = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  const row = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'quote', payload: { text: REPLY, amountKRW: 300000, costKRW: 990, service: 'landing_page_web', thread: { kind: 'request', stage: 'pre_order' } } });
  setStatus(s.ledger, row.id, { from: 'planned', to: 'sending' });
  setStatus(s.ledger, row.id, { from: 'sending', to: 'observed', receipt: { observed: true, cashSpentKRW: 990 } });
  s.ledger.addQuote = () => {
    throw new Error('disk I/O error');
  };
  await s.run('soomgo', scriptedSurface(), { notify: undefined });
  await s.run('soomgo', scriptedSurface(), { notify: undefined });
  const requests = readFileSync(join(s.instance.paths.operator, 'requests.md'), 'utf8');
  assert.equal(requests.split('- dedupe: deal-signal-failed:' + row.id + '\n').length - 1, 1);
  assert.equal(s.events('deal.signal_failed').length, 2);
});

// The soomgo sense fixture through the real surface: chat 501 names request r-9001 and its quote was opened.
test('a step records the quote funnel from the rows it senses, and a second step over the same rows writes none', async () => {
  const s = setup((c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, mode: 'observe' } } }));
  const lines = readRecording(join('test', 'fixtures', 'surfaces', 'soomgo', 'sense.jsonl'));
  const inbound = await (await openSurface('soomgo', { replay: lines })).sense();
  const req = s.ledger.upsertThread({ platform: 'soomgo', externalId: 'r-9001', kind: 'request' });
  const q = s.ledger.addQuote({ threadId: req.id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 990, status: 'sent', at: hoursBefore(NOON, 20) });
  const surface = () => scriptedSurface({ sense: inbound });
  const first = await s.run('soomgo', surface());
  assert.equal(first.funnel, 1);
  assert.deepEqual(s.events('quote.opened').map((e) => [e.ref, e.quoteId, e.firstSeen]), [['501', q.id, true]]);
  const second = await s.run('soomgo', surface());
  assert.equal(second.funnel, 0);
  assert.equal(s.events('quote.opened').length, 1);
});

test('a chat whose newest message is ours is settled without a model call or a reply', async () => {
  const s = setup();
  const ours = { ...chat('kmong', 'k1'), messages: [{ direction: 'in', text: '상세페이지 문의', at: hoursBefore(NOON, 3), externalId: 'k1:in' }, { direction: 'out', text: '자료를 보내 주시면 확인하겠습니다. 진...', at: hoursBefore(NOON, 2), externalId: 'k1:out' }] };
  const surface = scriptedSurface({ sense: [inbound('kmong', 'k1')], threads: () => ours });
  const codex = codexWith(decision());
  await s.run('kmong', surface, { runCodex: codex });
  assert.equal(codex.calls, 0);
  assert.equal(s.ledger.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 0);
  assert.deepEqual(s.events('thread.wait').map((e) => e.reason), ['our message is the newest']);
  await s.run('kmong', scriptedSurface({ sense: [inbound('kmong', 'k1', { unread: false })], threads: () => ours }), { runCodex: codex });
  assert.equal(codex.calls, 0, 'the settled chat waits on the next poll');
});
