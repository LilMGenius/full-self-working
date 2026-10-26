import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, linkSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { acquireLock, effectiveMode, pidAlive, readLock, releaseLock, runSupervisor, runTick, STUCK_POLLS } from '../src/supervisor/run.mjs';
import { writeDigest } from '../src/supervisor/digest.mjs';
import { dueJobs, JOBS, nextWake, periodKey } from '../src/supervisor/schedule.mjs';
import { advance, moneyToSignals } from '../src/deal/index.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { scriptedSurface } from './helpers/surface.mjs';
import { tempDir } from './tmp.mjs';

const at = (iso) => new Date(iso);
const job = (id) => JOBS.find((j) => j.id === id);
const ran = (now) => Object.fromEntries(dueJobs({}, now).map((d) => [d.id, d.period]));
const ids = (list) => list.map((d) => d.id);

test('a fresh state runs every job once and the same slot runs nothing again', () => {
  const t = at('2026-10-24T15:03:00Z'); // 00:03 Seoul, Sunday 2026-10-25
  assert.deepEqual(ids(dueJobs({}, t)), JOBS.map((j) => j.id));
  const last = ran(t);
  assert.deepEqual(dueJobs(last, at('2026-10-24T15:04:59Z')), []);
  assert.deepEqual(ids(dueJobs(last, at('2026-10-24T15:05:00Z'))), ['poll', 'orders']);
});

test('the hour mark at minute 0 Seoul opens the hourly period', () => {
  const last = ran(at('2026-10-25T01:58:00Z')); // 10:58 Seoul
  assert.deepEqual(ids(dueJobs(last, at('2026-10-25T01:59:59Z'))), []);
  assert.deepEqual(ids(dueJobs(last, at('2026-10-25T02:00:00Z'))), ['hourly', 'poll', 'orders', 'projects', 'listings', 'market-hour']);
});

test('a missed mark runs once on catch-up and never twice', () => {
  const last = ran(at('2026-10-24T00:10:00Z')); // 09:10 Seoul on 2026-10-24, digest period 20261024
  const wake = at('2026-10-26T01:30:00Z'); // the machine slept until 10:30 Seoul on 2026-10-26
  const due = dueJobs(last, wake);
  assert.equal(due.filter((d) => d.id === 'digest').length, 1);
  assert.equal(due.find((d) => d.id === 'digest').period, '20261026');
  const after = { ...last, ...Object.fromEntries(due.map((d) => [d.id, d.period])) };
  assert.deepEqual(ids(dueJobs(after, at('2026-10-26T01:35:00Z'))), ['poll', 'orders']);
});

test('daily 00:00 and 09:00 Seoul marks fall on 15:00 and 00:00 UTC', () => {
  assert.equal(periodKey(job('market'), at('2026-10-24T14:59:59Z')), '20261024');
  assert.equal(periodKey(job('market'), at('2026-10-24T15:00:00Z')), '20261025');
  assert.equal(periodKey(job('digest'), at('2026-10-25T23:59:59Z')), '20261025'); // 08:59:59 Seoul on the 26th
  assert.equal(periodKey(job('digest'), at('2026-10-26T00:00:00Z')), '20261026'); // 09:00 Seoul
});

test('the supervisor wakes on the next 5-minute Seoul mark', () => {
  assert.equal(nextWake(at('2026-10-25T02:03:10Z')).toISOString(), '2026-10-25T02:05:00.000Z');
  assert.equal(nextWake(at('2026-10-25T02:05:00Z')).toISOString(), '2026-10-25T02:10:00.000Z');
});

function makeInstance(platforms) {
  const dir = tempDir('fsw-sup-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  if (platforms) config.platforms = platforms;
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

// A surface that logs its login and sense calls, for the order of a tick's first page.
const loggingSurface = (calls, inbound = []) => ({
  login: async () => (calls.push('login'), { loggedIn: true }),
  sense: async () => (calls.push('sense'), inbound),
  read: async (ref) => ({ ref, messages: [], notices: [] }),
  stop: async () => {},
});
const unreadInbound = (platform, ref, over = {}) => ({ platform, ref, kind: 'message', at: '2026-10-25T01:00:00Z', unread: true, service: null, preview: '문의드립니다', notice: null, status: null, hired: null, quotable: null, expiresAt: null, quoteCostKRW: null, requestId: null, customer: 'c1', quote: null, ...over });
const quiet = async () => ({ written: false });

test('the pid lock refuses a second live supervisor and takes over a stale one', () => {
  const instance = makeInstance();
  assert.deepEqual(acquireLock(instance, { pid: 111, alive: () => true }), { acquired: true, pid: 111, tookOverFrom: null });
  assert.deepEqual(acquireLock(instance, { pid: 222, alive: (pid) => pid === 111 }), { acquired: false, heldBy: 111 });
  assert.equal(readLock(instance).pid, 111);
  const taken = acquireLock(instance, { pid: 333, alive: () => false });
  assert.deepEqual(taken, { acquired: true, pid: 333, tookOverFrom: 111 });
  assert.equal(readLock(instance).pid, 333);
  releaseLock(instance, 333);
  assert.equal(readLock(instance), null);
});

test('two contenders that read the same dead pid in a stale lock leave exactly one holder', () => {
  const instance = makeInstance();
  acquireLock(instance, { pid: 111, alive: () => true });
  const alive = (p) => p !== 111;
  const real = { openSync, writeFileSync, closeSync, readFileSync, renameSync, linkSync, unlinkSync };
  // B has read the dead pid 111 and is paused at its first change to the lock file while A takes the lock whole.
  let a = null;
  const pauseB = (fn) => (...args) => {
    if (!a) a = acquireLock(instance, { pid: 222, alive });
    return fn(...args);
  };
  const b = acquireLock(instance, { pid: 333, alive, fs: { ...real, renameSync: pauseB(renameSync), unlinkSync: pauseB(unlinkSync) } });
  assert.deepEqual(a, { acquired: true, pid: 222, tookOverFrom: 111 });
  assert.deepEqual(b, { acquired: false, heldBy: 222 });
  assert.equal(readLock(instance).pid, 222);
  assert.deepEqual(readdirSync(dirname(readLock(instance).file)).filter((f) => f.startsWith('supervisor.pid')), ['supervisor.pid']);
});

test('the real liveness check sees this process alive and a finished one dead', () => {
  assert.equal(pidAlive(process.pid), true);
  const done = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(pidAlive(done.pid), false);
});

test('runTick isolates a throwing platform step and records its error', async () => {
  const instance = makeInstance({ kmong: { enabled: true, mode: 'auto' }, soomgo: { enabled: true, mode: 'auto' } });
  const ledger = openLedger(':memory:');
  const kmong = scriptedSurface({ sense: [unreadInbound('kmong', 't1')] });
  const openSurface = async (id) => (id === 'soomgo' ? { login: async () => { throw new Error('page crashed'); }, stop: async () => {} } : kmong);
  const s = await runTick({ instance, ledger, now: new Date('2026-10-25T02:03:00Z'), state: { lastRuns: {} }, only: ['poll'], openSurface, notify: quiet, forceMode: 'observe', persist: false });
  const poll = s.jobs.find((j) => j.job === 'poll');
  const byId = Object.fromEntries(poll.platforms.map((p) => [p.platform, p]));
  assert.equal(byId.kmong.status, 'ok');
  assert.deepEqual(byId.kmong.threads, { observed: 1 });
  assert.equal(byId.soomgo.status, 'failed');
  assert.equal(byId.soomgo.error, 'page crashed');
  assert.equal(poll.status, 'partial');
  assert.equal(s.failures, 1);
  const events = ledger.db.prepare("SELECT platform, payload FROM events WHERE kind = 'supervisor.platform'").all();
  assert.match(events.find((e) => e.platform === 'soomgo').payload, /page crashed/);
  assert.equal(ledger.listThreads({ platform: 'kmong' }).length, 1);
});

test('a tick with work checks the browser keeper once before its first job opens a page', async () => {
  const instance = makeInstance({ kmong: { enabled: true, mode: 'auto' } });
  const calls = [];
  const keeper = { check: async () => (calls.push('check'), { status: 'daemon started', daemon: true, browsers: 1, started: 4242 }) };
  const state = { lastRuns: {} };
  const tick = (iso) => runTick({ instance, ledger: openLedger(':memory:'), now: new Date(iso), state, only: ['hourly', 'poll'], keeper, openSurface: async () => loggingSurface(calls), notify: quiet, forceMode: 'observe', persist: false });
  const s = await tick('2026-10-25T02:03:00Z');
  assert.deepEqual(calls, ['check', 'login', 'sense']);
  assert.equal(s.browser.status, 'daemon started');
  assert.equal(s.jobs.find((j) => j.job === 'hourly').browser.status, 'daemon started');
  const idle = await tick('2026-10-25T02:04:00Z');
  assert.deepEqual([idle.jobs.length, calls.length], [0, 3]);
});

test('a keeper check that throws is reported on the tick, and every due job still runs', async () => {
  const instance = makeInstance({});
  const keeper = { check: async () => { throw Object.assign(new Error('bsk not found at C:/none/bsk.exe'), { code: 'FSW_BSK_MISSING' }); } };
  const s = await runTick({ instance, ledger: openLedger(':memory:'), now: new Date('2026-10-25T02:03:00Z'), state: { lastRuns: {} }, only: ['hourly', 'orders'], keeper, notify: quiet, persist: false });
  assert.deepEqual(s.browser, { status: 'keeper check failed', code: 'FSW_BSK_MISSING', detail: 'bsk not found at C:/none/bsk.exe' });
  assert.deepEqual(s.jobs.map((j) => [j.job, j.status]), [['hourly', 'partial'], ['orders', 'ok']]);
});

test('a platform without a surface fails its step and counts as a failure', async () => {
  const instance = makeInstance({ kmong: { enabled: true, mode: 'draft' } });
  const openSurface = async () => { throw Object.assign(new Error('no surface for kmong in this build'), { code: 'FSW_SURFACE_MISSING' }); };
  const s = await runTick({ instance, ledger: openLedger(':memory:'), now: new Date('2026-10-25T02:03:00Z'), state: { lastRuns: {} }, only: ['poll'], openSurface, notify: quiet, persist: false });
  const [p] = s.jobs[0].platforms;
  assert.deepEqual([p.status, p.code, s.jobs[0].status, s.failures], ['failed', 'FSW_SURFACE_MISSING', 'failed', 2]);
});

test('a forced mode only lowers a platform mode and observe never sends', async () => {
  assert.equal(effectiveMode('auto', 'observe'), 'observe');
  assert.equal(effectiveMode('observe', 'auto'), 'observe');
  assert.equal(effectiveMode('draft', null), 'draft');
  assert.throws(() => effectiveMode('auto', 'loud'), RangeError);
  const instance = makeInstance({ kmong: { enabled: true, mode: 'auto' } });
  const surface = scriptedSurface({ sense: [unreadInbound('kmong', 't1')] });
  const decide = async () => assert.fail('observe never asks the model');
  const s = await runTick({ instance, ledger: openLedger(':memory:'), now: new Date('2026-10-25T02:03:00Z'), state: { lastRuns: {} }, only: ['poll'], openSurface: async () => surface, decide, notify: quiet, forceMode: 'observe', persist: false });
  assert.equal(s.jobs[0].platforms[0].mode, 'observe');
  assert.equal(surface.count('send'), 0);
});

test('the tick event names the commit the process runs', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  await runTick({ instance, ledger, now: new Date('2026-10-25T02:03:00Z'), state: { lastRuns: {} }, only: ['poll'], handlers: { poll: async () => ({ status: 'ok' }) }, code: 'a'.repeat(40), persist: false });
  const tick = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'supervisor.tick'").get();
  assert.equal(JSON.parse(tick.payload).code, 'a'.repeat(40));
});

test('a job that throws is recorded as failed and the next job still runs', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const handlers = { hourly: async () => { throw new Error('boom'); }, poll: async () => ({ status: 'ok' }) };
  const state = { lastRuns: {} };
  const s = await runTick({ instance, ledger, now: new Date('2026-10-25T02:03:00Z'), state, only: ['hourly', 'poll'], handlers, persist: false });
  assert.deepEqual(s.jobs.map((j) => [j.job, j.status]), [['hourly', 'failed'], ['poll', 'ok']]);
  assert.equal(state.lastRuns.hourly, '2026102511');
  const again = await runTick({ instance, ledger, now: new Date('2026-10-25T02:04:00Z'), state, only: ['hourly', 'poll'], handlers, persist: false });
  assert.deepEqual(again.jobs, []);
});

test('a platform that fails its poll STUCK_POLLS ticks in a row is reported to the operator once', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const state = { lastRuns: {} };
  let fail = true;
  const handlers = { poll: async () => ({ status: fail ? 'failed' : 'ok', platforms: [{ platform: 'kmong', status: fail ? 'failed' : 'ok', error: fail ? 'tool RPC timed out after 47s' : undefined }] }) };
  const tick = (i) => runTick({ instance, ledger, now: new Date(Date.parse('2026-10-25T04:00:00Z') + i * 300_000), state, only: ['poll'], handlers, persist: false });
  const requests = () => { try { return readFileSync(join(instance.paths.operator, 'requests.md'), 'utf8'); } catch { return ''; } };
  for (let i = 0; i < STUCK_POLLS - 1; i++) await tick(i);
  assert.doesNotMatch(requests(), /failed 6 polls in a row/);
  await tick(STUCK_POLLS - 1);
  assert.match(requests(), /kmong failed 6 polls in a row/);
  await tick(STUCK_POLLS);
  assert.equal(requests().match(/kmong failed 6 polls in a row/g).length, 1);
  fail = false;
  await tick(STUCK_POLLS + 1);
  assert.equal(state.pollFailures.kmong, 0);
});

test('a deploy skipped by a forced observe pass stays due for the next unforced tick', async () => {
  const instance = makeInstance();
  const state = { lastRuns: {} };
  const s = await runTick({ instance, ledger: openLedger(':memory:'), now: new Date('2026-10-25T02:03:00Z'), state, only: ['publish'], forceMode: 'observe', persist: false });
  assert.equal(s.jobs[0].status, 'skipped');
  assert.equal(state.lastRuns.publish, undefined);
});

test('the orders job re-plans a lost deposit request and starts a paid job', async () => {
  const instance = makeInstance({ soomgo: { enabled: true, mode: 'auto', maxQuotesPerDay: 5, maxCashPerDay: 5000 } });
  const ledger = openLedger(':memory:');
  const descriptor = loadDescriptor('soomgo');
  const now = new Date('2026-10-20T06:00:00Z');
  const t = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  const signal = (s) => advance(ledger, s, { instance, descriptor, now });
  signal({ type: 'quote_observed', platform: 'soomgo', threadId: t.id, at: '2026-10-20T01:05:00Z', amountKRW: 300000, evidence: { outboxId: 1, service: 'landing_page_web', scope: ['한 페이지'], deliveryDays: 7, split: { parts: [{ amountKRW: 150000 }, { amountKRW: 150000 }] }, costKRW: 990, cashSpentKRW: 990 } });
  for (const s of moneyToSignals({ platform: 'soomgo', threadId: t.id, inbound: {}, notices: [{ text: '숨고 알리미\n고용이 확정됐어요\n10월 24일 (금) 오전 10:00분까지\n고용을 취소할 수 있습니다.', at: '2026-10-20T01:58:00Z' }], now })) signal(s);
  const spawned = [];
  const state = { lastRuns: {} };
  const tick = (iso) => runTick({ instance, ledger, now: new Date(iso), state, only: ['orders'], spawnJob: (_i, id) => (spawned.push(id), { pid: 1, log: 'runner.log' }), notify: quiet, persist: false });
  const first = await tick('2026-10-20T06:00:00Z');
  assert.equal(first.jobs[0].planned, 1);
  assert.deepEqual(ledger.listOutbox({ kinds: ['pay_request'] }).map((r) => r.status), ['planned']);
  await tick('2026-10-20T06:05:00Z');
  assert.equal(ledger.listOutbox({ kinds: ['pay_request'] }).length, 1, 'a second tick plans no second request');
  assert.deepEqual(spawned, []);
  for (const s of moneyToSignals({ platform: 'soomgo', threadId: t.id, inbound: {}, notices: [{ text: '숨고페이\n고객이 결제한 금액을 숨고가\n안전하게 보관하고 있어요\n협의한 날짜와 금액이 맞는지 확인해 주세요.\n\n서비스명: 웹 개발\n서비스 금액: 150,000원', at: '2026-10-20T06:07:00Z' }], now })) signal(s);
  const paid = await tick('2026-10-20T06:10:00Z');
  assert.deepEqual([spawned.length, paid.jobs[0].started.length], [1, 1]);
});

test('an unanswered service gets no allocation arm', async () => {
  const instance = makeInstance({ soomgo: { enabled: true, mode: 'auto', services: ['landing_page_web'] } });
  const ledger = openLedger(':memory:');
  const s = await runTick({ instance, ledger, now: new Date('2026-10-25T15:03:00Z'), state: { lastRuns: {} }, only: ['allocation'], notify: quiet, persist: false });
  const { weights } = JSON.parse(readFileSync(s.jobs[0].file, 'utf8'));
  const soomgo = weights.filter((w) => w.platform === 'soomgo').map((w) => w.service);
  assert.ok(soomgo.includes('landing_page_web'), JSON.stringify(soomgo));
  assert.deepEqual(soomgo.filter((x) => x !== 'landing_page_web'), []);
});

// 크몽 signed out at 07:52 Seoul on 2026-10-26 and stayed out until the operator typed his password (36400c4).
test('a signed-out platform is signed in again from the logins file at most once an hour, and the password goes nowhere else', async () => {
  const instance = makeInstance({ kmong: { enabled: true, mode: 'auto' } });
  const file = join(tempDir('fsw-logins-'), 'logins.json');
  writeFileSync(file, JSON.stringify({ kmong: { method: 'email', email: 'seller@example.invalid', password: 'not-a-real-password' } }));
  instance.config.logins = file;
  const ledger = openLedger(':memory:');
  let signedIn = false;
  const signIns = [];
  const surface = {
    login: async () => ({ loggedIn: signedIn }),
    signIn: async (login) => (signIns.push(login), { signedIn: false, reason: 'still signed out after the form was sent' }),
    sense: async () => [],
    stop: async () => {},
  };
  const state = { lastRuns: {} };
  const tick = async (min) => (await runTick({ instance, ledger, now: new Date(Date.parse('2026-10-26T01:00:00Z') + min * 60_000), state, only: ['poll'], openSurface: async () => surface, notify: quiet, persist: false })).jobs[0].platforms[0];
  assert.deepEqual([(await tick(0)).status, signIns.length], ['failed', 1]);
  assert.deepEqual([(await tick(5)).status, signIns.length], ['failed', 1]);
  surface.signIn = async (login) => (signIns.push(login), (signedIn = true), { signedIn: true });
  const back = await tick(61);
  assert.deepEqual([back.status, back.login.loggedIn, signIns.length], ['ok', true, 2]);
  assert.deepEqual(signIns[1], { email: 'seller@example.invalid', password: 'not-a-real-password' });
  const events = ledger.db.prepare('SELECT kind, payload FROM events').all();
  assert.deepEqual(events.filter((e) => e.kind === 'platform.sign_in').map((e) => JSON.parse(e.payload).ok), [false, true]);
  assert.equal(events.some((e) => String(e.payload ?? '').includes('not-a-real-password')), false);
});

test('a sign-in that throws after the form went out counts against the hour, and its error never carries the password', async () => {
  const instance = makeInstance({ kmong: { enabled: true, mode: 'auto' } });
  const file = join(tempDir('fsw-logins-'), 'logins.json');
  const password = 'pw-in-the-error-7731';
  writeFileSync(file, JSON.stringify({ kmong: { method: 'email', email: 'seller@example.invalid', password } }));
  instance.config.logins = file;
  const ledger = openLedger(':memory:');
  let signIns = 0;
  const surface = {
    login: async () => ({ loggedIn: false }),
    signIn: async (login) => {
      signIns += 1;
      throw Object.assign(new Error('tool RPC timed out: fill #password with "' + login.password + '"'), { code: 'FSW_TOOL_TIMEOUT' });
    },
    sense: async () => [],
    stop: async () => {},
  };
  const state = { lastRuns: {} };
  const tick = async (min) => (await runTick({ instance, ledger, now: new Date(Date.parse('2026-10-26T01:00:00Z') + min * 60_000), state, only: ['poll'], openSurface: async () => surface, notify: quiet, persist: false })).jobs[0].platforms[0];
  const first = await tick(0);
  const second = await tick(5);
  assert.equal(signIns, 1);
  assert.deepEqual([first.status, first.code], ['failed', 'FSW_TOOL_TIMEOUT']);
  assert.match(first.error, /tool RPC timed out/);
  const signInEvents = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'platform.sign_in'").all().map((e) => JSON.parse(e.payload));
  assert.deepEqual(signInEvents.map((e) => [e.ok, e.code]), [[false, 'FSW_TOOL_TIMEOUT']]);
  assert.equal(JSON.stringify([first, second]).includes(password), false);
  assert.equal(ledger.db.prepare('SELECT payload FROM events').all().some((e) => String(e.payload ?? '').includes(password)), false);
  const written = readdirSync(instance.dir, { recursive: true }).map((f) => join(instance.dir, f)).filter((f) => statSync(f).isFile());
  assert.ok(written.some((f) => /events-.*\.jsonl$/.test(f)), 'the tick wrote an events log');
  assert.deepEqual(written.filter((f) => readFileSync(f, 'utf8').includes(password)), []);
});

test('a poll over a platform id no descriptor names fails that platform alone and records the others', async () => {
  const instance = makeInstance({ soomg: { enabled: true, mode: 'auto' }, kmong: { enabled: true, mode: 'auto' } });
  const ledger = openLedger(':memory:');
  const opened = [];
  const s = await runTick({ instance, ledger, now: new Date('2026-10-26T01:00:00Z'), state: { lastRuns: {} }, only: ['poll'], openSurface: async (id) => (opened.push(id), loggingSurface([])), notify: quiet, persist: false });
  const poll = s.jobs[0];
  assert.deepEqual(poll.platforms.map((r) => [r.platform, r.status, r.code ?? null]), [['soomg', 'failed', 'FSW_DESCRIPTOR_INVALID'], ['kmong', 'ok', null]]);
  assert.equal(poll.status, 'partial');
  assert.deepEqual(opened, ['kmong']);
  const recorded = ledger.db.prepare("SELECT ref, payload FROM events WHERE kind = 'supervisor.platform' ORDER BY id").all().map((e) => [e.ref, JSON.parse(e.payload).status]);
  assert.deepEqual(recorded, [['soomg', 'failed'], ['kmong', 'ok']]);
});

// A chat whose list time a platform notice moved past its newest stored message, as 숨고 chat 239668351
// was on 2026-10-25, when it went through the model on every tick for an hour (e5d20eb).
function noticeMovedChat() {
  const state = { listAt: '2026-10-25T13:30:00Z', reads: 0, decisions: 0 };
  const surface = {
    login: async () => ({ loggedIn: true }),
    sense: async () => [unreadInbound('soomgo', 'c1', { unread: false, at: state.listAt, customer: null, preview: null })],
    read: async (ref) => (state.reads += 1, { ref, messages: [{ direction: 'in', text: '견적 확인했어요. 생각해 보고 연락드릴게요.', externalId: 'm1', at: '2026-10-25T13:00:00Z' }], notices: [] }),
    stop: async () => {},
  };
  const decide = async () => (state.decisions += 1, {
    modelCalls: 1, item: null,
    decision: { intent: 'inquiry', service: 'detail_page_design', language: 'ko', reply: null, quote: null, needsOperator: false, operatorReason: null, confidence: 0.99, claimsUsed: [] },
  });
  return { state, surface, decide };
}
const chatTick = (instance, ledger, chat, runState, iso) => runTick({ instance, ledger, now: new Date(iso), state: runState, only: ['poll'], openSurface: async () => chat.surface, decide: chat.decide, notify: quiet, persist: false });
const minutes = (iso, i) => new Date(Date.parse(iso) + i * 300_000).toISOString();

test('a chat decided with nothing to send goes through the model again only when its list time moves', async () => {
  const instance = makeInstance({ soomgo: { enabled: true, mode: 'auto' } });
  instance.config.activeHours = { ...instance.config.activeHours, outbound: ['00:00', '00:00'] };
  const ledger = openLedger(':memory:');
  const chat = noticeMovedChat();
  const runState = { lastRuns: {} };
  for (let i = 0; i < 3; i++) await chatTick(instance, ledger, chat, runState, minutes('2026-10-25T14:00:00Z', i));
  assert.deepEqual([chat.state.reads, chat.state.decisions], [1, 1]);
  chat.state.listAt = '2026-10-25T14:20:00Z';
  await chatTick(instance, ledger, chat, runState, minutes('2026-10-25T14:00:00Z', 3));
  assert.deepEqual([chat.state.reads, chat.state.decisions], [2, 2]);
});

test('a chat read at night is read once, then decided once when the outbound hours open', async () => {
  const instance = makeInstance({ soomgo: { enabled: true, mode: 'auto' } });
  instance.config.activeHours = { ...instance.config.activeHours, outbound: ['08:00', '22:00'] };
  const ledger = openLedger(':memory:');
  const chat = noticeMovedChat();
  chat.state.listAt = '2026-10-25T14:00:00Z';
  const runState = { lastRuns: {} };
  for (let i = 0; i < 3; i++) await chatTick(instance, ledger, chat, runState, minutes('2026-10-25T14:30:00Z', i)); // 23:30 Seoul
  assert.deepEqual([chat.state.reads, chat.state.decisions], [1, 0]);
  for (let i = 0; i < 3; i++) await chatTick(instance, ledger, chat, runState, minutes('2026-10-25T23:00:00Z', i)); // 08:00 Seoul
  assert.deepEqual([chat.state.reads, chat.state.decisions], [2, 1]);
});

// A config that stops parsing between ticks keeps the last good one (run.mjs, config reload).
test('a config reload failure keeps the last good config and tells the operator once', async () => {
  const instance = makeInstance();
  const file = join(instance.dir, 'config.json');
  const prev = process.env.FSW_INSTANCE;
  process.env.FSW_INSTANCE = instance.dir;
  const lines = [];
  const seen = [];
  let ticks = 0;
  try {
    await runSupervisor({
      log: (l) => lines.push(l), holdAwake: async () => ({ pid: 0, stop() {} }), createBrowserKeeper: () => ({ stop() {} }),
      codeState: () => ({ head: 'a'.repeat(40), detached: false, target: 'a'.repeat(40) }),
      runTick: async (c) => {
        ticks += 1;
        seen.push(c.instance.config.notify);
        if (ticks === 1) writeFileSync(file, '{ not json');
        // Stops the loop after this tick, as a Ctrl+C would.
        if (ticks === 2) process.emit('SIGINT');
        return { jobs: [], failures: 0 };
      },
      sleep: async () => {}, clock: () => Date.parse('2026-10-25T02:03:00Z') + ticks * 300_000,
      once: false, forceMode: null, notify: quiet,
    }).catch((e) => lines.push('threw ' + e.message));
  } finally {
    if (prev === undefined) delete process.env.FSW_INSTANCE;
    else process.env.FSW_INSTANCE = prev;
  }
  assert.ok(lines.some((l) => l.startsWith('config reload failed, keeping the last good config')), lines.join('\n'));
  assert.equal(ticks, 2);
  assert.deepEqual(seen[1], seen[0]);
  assert.match(readFileSync(join(instance.paths.operator, 'requests.md'), 'utf8'), /The instance config did not load/);
});

// ---- digest ----

test('the digest counts only the previous Seoul day from the ledger', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const now = new Date('2026-10-26T00:00:00Z'); // 09:00 Seoul on 2026-10-26, digest covers 2026-10-25
  const t = ledger.upsertThread({ platform: 'kmong', externalId: 'a', kind: 'message' });
  ledger.db.prepare('UPDATE threads SET created_at = ? WHERE id = ?').run('2026-10-24T15:30:00Z', t.id); // 00:30 Seoul on the 25th
  const old = ledger.upsertThread({ platform: 'kmong', externalId: 'b', kind: 'message' });
  ledger.db.prepare('UPDATE threads SET created_at = ? WHERE id = ?').run('2026-10-24T14:30:00Z', old.id); // 23:30 Seoul on the 24th
  ledger.addMessage({ threadId: t.id, direction: 'out', body: 'hi', at: '2026-10-25T05:00:00Z' });
  ledger.addQuote({ platform: 'soomgo', amountKRW: 300000, costKRW: 4000, at: '2026-10-25T06:00:00Z' });
  ledger.addEvent({ kind: 'supervisor.platform', platform: 'soomgo', payload: { status: 'failed', error: 'adapter missing' }, at: '2026-10-25T07:00:00Z' });
  const notes = [];
  const d = await writeDigest({ instance, ledger, now, notify: async (_, n) => (notes.push(n), { written: true }) });
  assert.equal(d.numbers.day, '20261025');
  assert.equal(d.numbers.leads.total, 1);
  assert.equal(d.numbers.repliesSent.total, 1);
  assert.equal(d.numbers.quotesSent.cashSpentKRW, 4000);
  assert.deepEqual(d.numbers.errors, { soomgo: { 'adapter missing': 1 } });
  assert.match(readFileSync(d.file, 'utf8'), /- leads: 1 \(kmong 1\)/);
  assert.match(d.file, /digest-20261026\.md$/);
  assert.equal(notes[0].dedupeKey, 'digest:20261026');
});
