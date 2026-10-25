import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { acquireLock, effectiveMode, pidAlive, readLock, releaseLock, runTick } from '../src/supervisor/run.mjs';
import { writeDigest } from '../src/supervisor/digest.mjs';
import { seoulParts } from '../src/core/clock.mjs';
import { dueJobs, JOBS, nextWake, periodKey } from '../src/supervisor/schedule.mjs';

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
  assert.deepEqual(ids(dueJobs(last, at('2026-10-25T02:00:00Z'))), ['hourly', 'poll', 'orders']);
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

test('the weekly period turns at Monday 00:00 Seoul', () => {
  const monday = at('2026-10-25T15:00:00Z');
  assert.equal(seoulParts(monday).weekday, 'Mon');
  const before = periodKey(job('listings'), at('2026-10-25T14:59:59Z'));
  const after = periodKey(job('listings'), monday);
  assert.notEqual(before, after);
  assert.equal(after, '2026W44');
  assert.equal(periodKey(job('listings'), at('2026-11-01T14:59:59Z')), after); // Sunday 23:59:59 Seoul
});

test('the supervisor wakes on the next 5-minute Seoul mark', () => {
  assert.equal(nextWake(at('2026-10-25T02:03:10Z')).toISOString(), '2026-10-25T02:05:00.000Z');
  assert.equal(nextWake(at('2026-10-25T02:05:00Z')).toISOString(), '2026-10-25T02:10:00.000Z');
});

// ---- run loop and lock ----

function makeInstance(platforms) {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-sup-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  if (platforms) config.platforms = platforms;
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

const okAdapter = (calls = []) => async () => ({
  async login() {
    calls.push('login');
    return { loggedIn: true };
  },
  async inbox() {
    calls.push('inbox');
    return [{ id: 't1', kind: 'message', unread: true, preview: '문의드립니다', customer: 'c1' }];
  },
  async stop() {},
});

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

test('the real liveness check sees this process alive and a finished one dead', () => {
  assert.equal(pidAlive(process.pid), true);
  const done = spawnSync(process.execPath, ['-e', '0']);
  assert.equal(pidAlive(done.pid), false);
});

test('runTick isolates a throwing platform pipeline and records its error', async () => {
  const instance = makeInstance({ kmong: { enabled: true, mode: 'auto' }, soomgo: { enabled: true, mode: 'auto' } });
  const ledger = openLedger(':memory:');
  const calls = [];
  const loadAdapter = async (id) => (id === 'soomgo' ? async () => ({ login: async () => { throw new Error('page crashed'); }, stop: async () => {} }) : okAdapter(calls));
  const s = await runTick({ instance, ledger, now: new Date('2026-10-25T02:03:00Z'), state: { lastRuns: {} }, only: ['poll'], loadAdapter, forceMode: 'observe', persist: false });
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

test('a missing adapter is reported as adapter missing and counted as a failure', async () => {
  const instance = makeInstance({ kmong: { enabled: true, mode: 'draft' } });
  const ledger = openLedger(':memory:');
  const s = await runTick({ instance, ledger, now: new Date('2026-10-25T02:03:00Z'), state: { lastRuns: {} }, only: ['poll'], loadAdapter: async () => null, persist: false });
  const [p] = s.jobs[0].platforms;
  assert.equal(p.status, 'failed');
  assert.equal(p.error, 'adapter missing');
  assert.equal(s.jobs[0].status, 'failed');
  assert.equal(s.failures, 2);
});

test('a forced mode only lowers a platform mode and observe never sends', async () => {
  assert.equal(effectiveMode('auto', 'observe'), 'observe');
  assert.equal(effectiveMode('observe', 'auto'), 'observe');
  assert.equal(effectiveMode('draft', null), 'draft');
  assert.throws(() => effectiveMode('auto', 'loud'), RangeError);
  const instance = makeInstance({ kmong: { enabled: true, mode: 'auto' } });
  const sent = [];
  const adapter = async () => ({ ...(await okAdapter()()), readThread: async () => ({ messages: [] }), send: async (...a) => sent.push(a) });
  const s = await runTick({ instance, ledger: openLedger(':memory:'), now: new Date('2026-10-25T02:03:00Z'), state: { lastRuns: {} }, only: ['poll'], loadAdapter: async () => adapter, forceMode: 'observe', persist: false });
  assert.equal(s.jobs[0].platforms[0].mode, 'observe');
  assert.equal(sent.length, 0);
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

test('a deploy skipped by a forced observe pass stays due for the next unforced tick', async () => {
  const instance = makeInstance();
  const state = { lastRuns: {} };
  const s = await runTick({ instance, ledger: openLedger(':memory:'), now: new Date('2026-10-25T02:03:00Z'), state, only: ['publish'], forceMode: 'observe', persist: false });
  assert.equal(s.jobs[0].status, 'skipped');
  assert.equal(state.lastRuns.publish, undefined);
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
