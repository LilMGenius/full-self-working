// D16 parity: every job the live supervisor runs is ported with its run id and cadence, none is left as a
// stub, and the daemon's start and log lines are what 050's takeover reads (003 Takeover).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { JOB_HANDLERS, readState, runSupervisor, runTick } from '../src/supervisor/run.mjs';
import { JOBS } from '../src/supervisor/schedule.mjs';
import { tempDir } from './tmp.mjs';

// The ids and cadences of src/supervisor/schedule.mjs at 9101c1c, the lastRuns keys run/state.json holds.
const LIVE_JOBS = [
  ['hourly', 'hour'], ['poll', 'slot5'], ['orders', 'slot5'], ['projects', 'hour'], ['listings', 'hour'], ['market-hour', 'hour'],
  ['market', 'day 00:00'], ['price', 'day 00:00'], ['allocation', 'day 00:00'], ['portfolio', 'day 00:00'], ['listings-refresh', 'day 00:00'],
  ['publish', 'day 00:00'], ['learn', 'day 00:00'], ['digest', 'day 09:00'],
];

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-parity-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms = {};
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}
const noModel = async () => { throw new Error('the model is not called on an instance with no cases'); };
const quiet = async () => ({ written: false });

test('JOBS holds the 14 live ids in the b6b952d order with the same cadences', () => {
  assert.deepEqual(JOBS.map((j) => [j.id, j.every + (j.at ? ' ' + j.at : '')]), LIVE_JOBS);
});

test('every JOBS id has a handler, and a forced observe tick on a fresh state runs each one and leaves only publish due', async () => {
  assert.deepEqual(Object.keys(JOB_HANDLERS).sort(), JOBS.map((j) => j.id).sort());
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const state = { lastRuns: {} };
  const s = await runTick({ instance, ledger, now: new Date('2026-10-26T00:00:00Z'), state, forceMode: 'observe', runCodex: noModel, notify: quiet, persist: false });
  assert.deepEqual(s.jobs.map((j) => j.job), JOBS.map((j) => j.id));
  for (const j of s.jobs) assert.ok(['ok', 'partial', 'skipped', 'failed'].includes(j.status) && j.status !== 'not wired', j.job + ' ' + j.status);
  // price has no market summary on a fresh instance and says so by name; it is the only failed job.
  assert.deepEqual(s.jobs.filter((j) => j.status === 'failed').map((j) => [j.job, j.code]), [['price', 'FSW_MARKET_NO_SUMMARY']]);
  assert.deepEqual(Object.keys(state.lastRuns).sort(), JOBS.map((j) => j.id).filter((id) => id !== 'publish').sort());
  assert.equal(Object.keys(state.lastRuns).length, 13);
  assert.equal(s.jobs.find((j) => j.job === 'publish').detail, 'FSW_FORCE_MODE=observe skips the site deploy');
});

// The daemon with every side effect replaced; codeState and the clock are scripted per tick.
function daemon(instance, { heads, ticks, lines, onTick = () => {} }) {
  let i = 0;
  return {
    log: (l) => lines.push(l),
    holdAwake: async () => ({ pid: 0, stop() {} }),
    createBrowserKeeper: () => ({ stop() {}, check: async () => ({ status: 'test' }) }),
    codeState: () => heads[Math.min(i++, heads.length - 1)],
    probe: () => ({ ok: true }),
    checkout: () => true,
    notify: quiet,
    runTick: async (c) => {
      ticks.push(c);
      onTick(ticks.length);
      return { jobs: [{ job: 'poll', status: 'ok' }, { job: 'orders', status: 'ok' }], failures: 0 };
    },
    sleep: async () => {},
    clock: () => Date.parse('2026-10-26T01:00:00Z') + ticks.length * 300_000,
    ...(instance ? { instance } : {}),
  };
}
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('a setting changed between two ticks is seen by the second tick', async () => {
  const instance = makeInstance();
  const file = join(instance.dir, 'config.json');
  const prev = process.env.FSW_INSTANCE;
  process.env.FSW_INSTANCE = instance.dir;
  const ticks = [];
  try {
    const ctx = daemon(null, { heads: [{ head: A, detached: false, target: A }], ticks, lines: [], onTick: (n) => {
      if (n === 1) writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), activeHours: { outbound: ['09:00', '18:00'] } }));
      if (n === 2) process.emit('SIGINT');
    } });
    await runSupervisor(ctx);
  } finally {
    if (prev === undefined) delete process.env.FSW_INSTANCE;
    else process.env.FSW_INSTANCE = prev;
  }
  assert.deepEqual(ticks.map((c) => c.instance.config.activeHours.outbound), [['08:00', '23:00'], ['09:00', '18:00']]);
  assert.deepEqual(ticks.map((c) => c.code), [A, A], 'each tick names the commit the process runs');
});

const approval = (id, fields) => ({ id, createdAt: '2026-10-20T01:00:00.000Z', reason: 'needs the operator', ...fields });
function writeApprovals(instance, extra = {}) {
  mkdirSync(instance.paths.approvals, { recursive: true });
  const files = {
    '20261020-kmong-11111111.json': approval('20261020-kmong-11111111', { platform: 'kmong', kind: 'message', threadRef: 'T1', status: 'open', draft: '안녕하세요' }),
    '20261020-soomgo-22222222.json': approval('20261020-soomgo-22222222', { platform: 'soomgo', kind: 'message', threadRef: 'R2', status: 'sent', draft: '네 가능합니다', finalText: '네 가능합니다', closedAt: '2026-10-20T03:05:00.000Z' }),
    '20261021-kmong-33333333.json': approval('20261021-kmong-33333333', { platform: 'kmong', kind: 'project_proposal', threadRef: 'project:7', status: 'dropped', createdAt: '2026-10-21T01:00:00.000Z', draft: '제안서' }),
    ...extra,
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(instance.paths.approvals, name), JSON.stringify(body, null, 2) + '\n');
}

test('runSupervisor imports approval files once at start, logs it, and names a file it skipped to the operator once', async () => {
  const instance = makeInstance();
  writeApprovals(instance);
  const start = async () => {
    const lines = [];
    // The real notifier with no toast and no webhook writes operator/requests.md once per dedupe key.
    await runSupervisor({ ...daemon(instance, { heads: [{ head: A, detached: false, target: A }], ticks: [], lines }), notify: undefined, once: true });
    return lines;
  };
  const first = await start();
  assert.match(first[0], /^supervisor pid \d+$/);
  assert.equal(first[1], 'approvals import read 3, imported 3, already 0, reconciled 0, skipped 0');
  const second = await start();
  assert.equal(second[1], 'approvals import read 3, imported 0, already 3, reconciled 0, skipped 0');
  const ledger = openLedger(instance.paths.ledger);
  try {
    assert.deepEqual(ledger.listOutbox({}).map((r) => r.status).sort(), ['awaiting_operator', 'observed', 'rejected']);
  } finally {
    ledger.close();
  }
  writeFileSync(join(instance.paths.approvals, 'notes.json'), '{}');
  const third = await start();
  assert.equal(third[1], 'approvals import read 4, imported 0, already 3, reconciled 0, skipped 1: notes.json (not an approval id)');
  await start();
  const requests = readFileSync(join(instance.paths.operator, 'requests.md'), 'utf8');
  assert.equal(requests.match(/Approval files the outbox could not import/g).length, 1);
  assert.match(requests, /notes\.json: not an approval id/);
});

test('runSupervisor logs the four supervisor.log formats 050 reads, each with an ISO prefix', async () => {
  const instance = makeInstance();
  const printed = [];
  const original = console.log;
  console.log = (l) => printed.push(String(l));
  try {
    const ctx = daemon(instance, { heads: [{ head: A, detached: true, target: A }, { head: A, detached: true, target: B }], ticks: [], lines: [] });
    delete ctx.log;
    const r = await runSupervisor(ctx);
    assert.equal(r.status, 'restart');
  } finally {
    console.log = original;
  }
  const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z ';
  const formats = ['supervisor pid \\d+', 'tick \\S+:\\S+( \\S+:\\S+)* failures=\\d+', 'code moved from \\w{7} to \\w{7}; restarting', 'supervisor exiting for a restart'].map((f) => new RegExp('^' + ISO + f + '$'));
  const hits = formats.map((re) => printed.findIndex((l) => re.test(l)));
  assert.ok(hits.every((i) => i >= 0), printed.join('\n'));
  assert.deepEqual([...hits].sort((x, y) => x - y), hits, 'in that order');
  assert.ok(printed.some((l) => new RegExp('^' + ISO + 'approvals import read 0, imported 0').test(l)));
});

test('state written by a pass is read back with the same ids', async () => {
  const instance = makeInstance();
  await runTick({ instance, ledger: openLedger(':memory:'), now: new Date('2026-10-26T00:00:00Z'), only: ['orders', 'digest'], forceMode: 'observe', notify: quiet });
  assert.deepEqual(Object.keys(readState(instance).lastRuns).sort(), ['digest', 'orders']);
});
