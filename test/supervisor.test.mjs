import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, linkSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { acquireLock, pidAlive, readLock, releaseLock } from '../src/supervisor/lock.mjs';
import { effectiveMode, runSupervisor, runTick, STUCK_POLLS } from '../src/supervisor/run.mjs';
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

test('a lock holder is live only while its pid has the recorded start time; an old pid-only lock keeps the node rule', () => {
  const instance = makeInstance();
  const procs = { 111: { image: 'node', startedAt: '2026-10-26T01:00:00.0000000Z' } };
  const processInfo = (p) => procs[p] ?? null;
  assert.deepEqual(acquireLock(instance, { pid: 111, processInfo }), { acquired: true, pid: 111, tookOverFrom: null });
  const text = readFileSync(readLock(instance).file, 'utf8');
  assert.equal(text, '111\n2026-10-26T01:00:00.0000000Z\n');
  // The 2c77326 readLock parses the whole file with Number.parseInt, which still reads the pid.
  assert.equal(Number.parseInt(text, 10), 111);
  procs[222] = { image: 'node', startedAt: '2026-10-26T02:00:00.0000000Z' };
  assert.deepEqual(acquireLock(instance, { pid: 222, processInfo }), { acquired: false, heldBy: 111 });
  // The supervisor crashed and another node process got pid 111.
  procs[111] = { image: 'node', startedAt: '2026-10-26T03:00:00.0000000Z' };
  assert.deepEqual(acquireLock(instance, { pid: 222, processInfo }), { acquired: true, pid: 222, tookOverFrom: 111 });
  assert.deepEqual([readLock(instance).pid, readLock(instance).startedAt], [222, '2026-10-26T02:00:00.0000000Z']);
  writeFileSync(readLock(instance).file, '444\n');
  procs[444] = { image: 'node', startedAt: '2026-10-26T04:00:00.0000000Z' };
  assert.deepEqual(acquireLock(instance, { pid: 555, processInfo }), { acquired: false, heldBy: 444 });
  procs[444] = { image: 'Code', startedAt: '2026-10-26T04:00:00.0000000Z' };
  assert.deepEqual(acquireLock(instance, { pid: 555, processInfo }), { acquired: true, pid: 555, tookOverFrom: 444 });
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

test('a daemon busy past its status timeout makes the hourly job partial', async () => {
  const instance = makeInstance({});
  const keeper = { check: async () => ({ status: 'daemon busy', daemon: false, busy: true, pid: 4242, detail: 'daemon pid 4242 is listening on bsk-daemon-x but bsk status did not answer within 20000 ms' }) };
  const s = await runTick({ instance, ledger: openLedger(':memory:'), now: new Date('2026-10-25T02:03:00Z'), state: { lastRuns: {} }, only: ['hourly', 'orders'], keeper, notify: quiet, persist: false });
  assert.equal(s.browser.status, 'daemon busy');
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

test('a job a forced observe pass skips with keepDue stays due for the next unforced tick', async () => {
  const instance = makeInstance();
  const state = { lastRuns: {} };
  const handlers = { 'listings-refresh': async (ctx) => (ctx.forceMode === 'observe' ? { status: 'skipped', detail: 'observe mode', keepDue: true } : { status: 'ok' }) };
  const tick = (forceMode) => runTick({ instance, ledger: openLedger(':memory:'), now: new Date('2026-10-25T02:03:00Z'), state, only: ['listings-refresh'], handlers, forceMode, persist: false });
  assert.equal((await tick('observe')).jobs[0].status, 'skipped');
  assert.equal(state.lastRuns['listings-refresh'], undefined);
  const second = await tick(null);
  assert.equal(second.jobs[0].status, 'ok');
  assert.equal(state.lastRuns['listings-refresh'], second.jobs[0].period);
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

// 크몽 at 14:50Z on 2026-10-26: the dashboard read signed out while it rendered, the sign-in found no form
// because the account was signed in, and the attempt held every real sign-in for an hour.
test('a sign-in that finds the account signed in already is no attempt and does not hold a real one for the hour', async () => {
  const instance = makeInstance({ kmong: { enabled: true, mode: 'auto' } });
  const file = join(tempDir('fsw-logins-'), 'logins.json');
  writeFileSync(file, JSON.stringify({ kmong: { method: 'email', email: 'seller@example.invalid', password: 'not-a-real-password' } }));
  instance.config.logins = file;
  const ledger = openLedger(':memory:');
  const reads = [false, true, false];
  let typed = 0;
  const surface = {
    login: async () => ({ loggedIn: reads.length ? reads.shift() : false }),
    signIn: async () => (typed ? { signedIn: false, reason: 'still signed out after the form was sent' } : ((typed = 1), { signedIn: true, alreadySignedIn: true })),
    sense: async () => [],
    stop: async () => {},
  };
  const calls = [];
  const spy = { ...surface, signIn: async (l) => (calls.push(l.email), surface.signIn(l)) };
  const state = { lastRuns: {} };
  const tick = async (min) => (await runTick({ instance, ledger, now: new Date(Date.parse('2026-10-26T14:50:00Z') + min * 60_000), state, only: ['poll'], openSurface: async () => spy, notify: quiet, persist: false })).jobs[0].platforms[0];
  const first = await tick(0);
  assert.deepEqual([first.status, first.login.loggedIn], ['ok', true]);
  const second = await tick(5);
  assert.deepEqual([second.status, calls.length], ['failed', 2]);
  const kinds = ledger.db.prepare("SELECT kind, payload FROM events WHERE kind LIKE 'platform.%' ORDER BY id").all().map((e) => [e.kind, JSON.parse(e.payload).ok]);
  assert.deepEqual(kinds, [['platform.login_reread', true], ['platform.sign_in', false]]);
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

// freelancer signs in with the operator's Google account (080 order 6): the logins file names the method,
// the identity file the email, and a failure asks once. id and mode set up another board the same way.
function googleSetup(identity, id = 'freelancer', mode = 'auto') {
  const instance = makeInstance({ [id]: { enabled: true, mode } });
  const dir = tempDir('fsw-google-');
  writeFileSync(join(dir, 'logins.json'), JSON.stringify({ [id]: { method: 'google' } }));
  writeFileSync(join(dir, 'identity.json'), JSON.stringify(identity));
  instance.config.logins = join(dir, 'logins.json');
  instance.config.onboarding = { ...instance.config.onboarding, identity: join(dir, 'identity.json') };
  const ledger = openLedger(':memory:');
  const state = { lastRuns: {} };
  const tick = async (surface, min) => (await runTick({ instance, ledger, now: new Date(Date.parse('2026-10-28T01:00:00Z') + min * 60_000), state, only: ['poll'], openSurface: async () => surface, persist: false })).jobs[0].platforms[0];
  const signIns = () => ledger.db.prepare("SELECT payload FROM events WHERE kind = 'platform.sign_in' ORDER BY id").all().map((e) => JSON.parse(e.payload));
  const notices = (key) => readFileSync(join(instance.paths.operator, 'requests.md'), 'utf8').split(/\r?\n/).filter((l) => l === '- dedupe: ' + key).length;
  const requests = () => notices('sign-in:' + id + ':google');
  const rereads = () => ledger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'platform.login_reread'").get().n;
  return { tick, signIns, requests, rereads, notices };
}
const IDENTITY = { person: { google_login_email: 'operator@example.invalid', date_of_birth: '1990-01-01', phone: '+82 10-0000-0000' }, business: { address_en: { street: '1 Example Road', city: 'Seoul', postal_code: '00000', country: 'South Korea' } } };
+
// 088 unit 3: upwork's surface has no signIn until 080 order 8 maps a positive signed-in marker, so a signed-out
// upwork with a google login entry gets no sign-in attempt and no sign-in event; the step asks the operator once a
// Seoul day, and nothing ever records an upwork sign-in as successful (success only on login() reading true).
test('a signed-out upwork with a google login is never signed in: no attempt, no event, one login notice a day', async () => {
  const g = googleSetup(IDENTITY, 'upwork', 'draft');
  const { openUpworkSurface } = await import('../src/surface/upwork.mjs');
  const loads = [];
  const login = 'https://www.upwork.com/ab/account-security/login?redir=%2Fnx%2Ffind-work%2F';
  const session = { navigate: async (url) => (loads.push(url), login), evaluate: async () => ({ url: login, title: 'Log in to Upwork', text: 'Continue with Google' }), stop: async () => {} };
  const surface = await openUpworkSurface({ session });
  const first = await g.tick(surface, 0);
  const second = await g.tick(surface, 5);
  for (const r of [first, second]) assert.deepEqual([r.platform, r.status, r.error, r.login.loggedIn], ['upwork', 'failed', 'not logged in', false]);
  assert.deepEqual([g.signIns(), g.rereads()], [[], 0]);
  assert.equal(g.notices('login:upwork:20261028'), 1);
  assert.deepEqual(loads, ['https://www.upwork.com/nx/find-work/', 'https://www.upwork.com/nx/find-work/'], 'each tick loads only the sign-in probe');
});

test('a signed-out platform with a google login signs in once an hour with the identity file email, and a failure asks once', async () => {
  const g = googleSetup(IDENTITY);
  let signedIn = false;
  const calls = [];
  const surface = { publicSense: true, login: async () => ({ loggedIn: signedIn }), signIn: async (a) => (calls.push(a), { signedIn: false, reason: 'still on the login page' }), sense: async () => [], stop: async () => {} };
  assert.deepEqual([(await g.tick(surface, 0)).status, calls], ['ok', [{ email: 'operator@example.invalid' }]]);
  assert.equal((await g.tick(surface, 5)).status, 'ok');
  assert.equal(calls.length, 1);
  await g.tick(surface, 61);
  assert.equal(calls.length, 2);
  assert.equal(g.requests(), 1);
  surface.signIn = async (a) => (calls.push(a), (signedIn = true), { signedIn: true });
  const back = await g.tick(surface, 122);
  assert.deepEqual([back.login.loggedIn, calls.length], [true, 3]);
  assert.deepEqual(g.signIns().map((e) => [e.ok, e.method]), [[false, 'google'], [false, 'google'], [true, 'google']]);
});

test('a google sign-in whose login check cannot read the account is a failure that asks once', async () => {
  const g = googleSetup(IDENTITY);
  const surface = { publicSense: true, login: async () => ({ loggedIn: null, detail: 'the self API gave no answer to read: Error 502' }), signIn: async () => ({ signedIn: true }), sense: async () => [], stop: async () => {} };
  await g.tick(surface, 0);
  await g.tick(surface, 61);
  assert.deepEqual(g.signIns().map((e) => e.ok), [false, false]);
  assert.match(g.signIns()[0].reason, /login check reads null/);
  assert.equal(g.requests(), 1);
});

test('a login page that redirects to an error page is no sign-in: nothing is pressed, the failure is recorded and asks once', async () => {
  const g = googleSetup(IDENTITY);
  const { openFreelancerSurface } = await import('../src/surface/freelancer.mjs');
  let pressed = 0;
  const session = { navigate: async (url) => (url.endsWith('/login') ? 'https://www.freelancer.com/maintenance' : url), evaluate: async () => ({ title: 'Service unavailable', text: 'Try again later' }), stop: async () => {} };
  const surface = await openFreelancerSurface({ session, targets: [], google: async () => (pressed += 1) });
  await g.tick(surface, 0);
  assert.equal(pressed, 0);
  assert.deepEqual(g.signIns().map((e) => e.ok), [false]);
  assert.match(g.signIns()[0].reason, /went to \/maintenance/);
  assert.equal(g.requests(), 1);
  assert.equal(g.rereads(), 0);
});

test('an email sign-in that found the account signed in but whose login check still reads signed out counts against the hour', async () => {
  const instance = makeInstance({ kmong: { enabled: true, mode: 'auto' } });
  const file = join(tempDir('fsw-logins-'), 'logins.json');
  writeFileSync(file, JSON.stringify({ kmong: { method: 'email', email: 'seller@example.invalid', password: 'not-a-real-password' } }));
  instance.config.logins = file;
  const ledger = openLedger(':memory:');
  let calls = 0;
  const surface = { login: async () => ({ loggedIn: false }), signIn: async () => ((calls += 1), { signedIn: true, alreadySignedIn: true }), sense: async () => [], stop: async () => {} };
  const state = { lastRuns: {} };
  const tick = async (min) => (await runTick({ instance, ledger, now: new Date(Date.parse('2026-10-26T14:50:00Z') + min * 60_000), state, only: ['poll'], openSurface: async () => surface, notify: quiet, persist: false })).jobs[0].platforms[0];
  assert.equal((await tick(0)).status, 'failed');
  await tick(5);
  assert.equal(calls, 1);
  const kinds = ledger.db.prepare("SELECT kind, payload FROM events WHERE kind LIKE 'platform.%' ORDER BY id").all().map((e) => [e.kind, JSON.parse(e.payload).ok]);
  assert.deepEqual(kinds, [['platform.sign_in', false]]);
});

test('a login check that throws after the Google pick is a failed sign-in: recorded with its cause, held for the hour and asked once', async () => {
  const g = googleSetup(IDENTITY);
  let picks = 0;
  let checks = 0;
  const surface = {
    publicSense: true,
    login: async () => {
      checks += 1;
      if (checks % 2 === 0) throw Object.assign(new Error('self read timed out'), { code: 'ETIMEDOUT' });
      return { loggedIn: false };
    },
    signIn: async () => ((picks += 1), { signedIn: true }),
    sense: async () => [],
    stop: async () => {},
  };
  await g.tick(surface, 0);
  await g.tick(surface, 5);
  assert.equal(picks, 1);
  assert.deepEqual(g.signIns().map((e) => [e.ok, e.code]), [[false, 'ETIMEDOUT']]);
  assert.match(g.signIns()[0].reason, /the login check threw: self read timed out/);
  assert.equal(g.requests(), 1);
});

test('an email login check that throws after the form went out counts against the hour and never carries the password', async () => {
  const instance = makeInstance({ kmong: { enabled: true, mode: 'auto' } });
  const file = join(tempDir('fsw-logins-'), 'logins.json');
  const password = 'pw-in-the-check-4410';
  writeFileSync(file, JSON.stringify({ kmong: { method: 'email', email: 'seller@example.invalid', password } }));
  instance.config.logins = file;
  const ledger = openLedger(':memory:');
  let typed = 0;
  let checks = 0;
  const surface = {
    login: async () => {
      checks += 1;
      if (checks === 2) throw Object.assign(new Error('dashboard read failed with "' + password + '"'), { code: 'FSW_TOOL_TIMEOUT' });
      return { loggedIn: false };
    },
    signIn: async () => ((typed += 1), { signedIn: true }),
    sense: async () => [],
    stop: async () => {},
  };
  const state = { lastRuns: {} };
  const tick = async (min) => (await runTick({ instance, ledger, now: new Date(Date.parse('2026-10-26T01:00:00Z') + min * 60_000), state, only: ['poll'], openSurface: async () => surface, notify: quiet, persist: false })).jobs[0].platforms[0];
  await tick(0);
  await tick(5);
  assert.equal(typed, 1);
  const events = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'platform.sign_in'").all().map((e) => JSON.parse(e.payload));
  assert.deepEqual(events.map((e) => [e.ok, e.code]), [[false, 'FSW_TOOL_TIMEOUT']]);
  assert.equal(ledger.db.prepare('SELECT payload FROM events').all().some((e) => String(e.payload ?? '').includes(password)), false);
});

test('a google login without an email in the identity file records the failure and presses nothing', async () => {
  const g = googleSetup({ ...IDENTITY, person: { ...IDENTITY.person, google_login_email: null } });
  let called = 0;
  const surface = { publicSense: true, login: async () => ({ loggedIn: false }), signIn: async () => ((called += 1), { signedIn: true }), sense: async () => [], stop: async () => {} };
  await g.tick(surface, 0);
  await g.tick(surface, 61);
  assert.equal(called, 0);
  assert.deepEqual(g.signIns().map((e) => e.ok), [false, false]);
  assert.match(g.signIns()[0].reason, /google_login_email/);
  assert.equal(g.requests(), 1);
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
