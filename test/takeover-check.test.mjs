// scripts/takeover-check.mjs and scripts/tick-gaps.mjs on synthetic supervisor.log lines in the formats of
// a8ae31c and v0, on scratch ledgers and on a scratch git repository; no live instance is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLedger } from '../src/core/ledger.mjs';
import { evaluate, FORMATS, gaps, isSupervisor, newestHandover, parseLog, resolveWindow, timeOf } from '../scripts/takeover-check.mjs';
import { measure } from '../scripts/tick-gaps.mjs';
import { tempDir } from './tmp.mjs';

const T0 = Date.parse('2026-10-26T14:05:00.000Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const handover = (from, to, m) => [at(m) + ' tick poll:ok orders:ok failures=0', at(m + 0.1) + ' code moved from ' + from.slice(0, 7) + ' to ' + to.slice(0, 7) + '; restarting', at(m + 0.2) + ' supervisor exiting for a restart', at(m + 0.3) + ' supervisor pid 4242', at(m + 0.4) + ' approvals import read 3, imported 3, already 0, reconciled 0, skipped 0', at(m + 5) + ' tick poll:ok failures=0'];

test('every supervisor.log format of 59a9948 and v0 parses, the import line with or without skipped files', () => {
  assert.match(at(0) + ' supervisor pid 12', FORMATS.pid);
  assert.match(at(0) + ' supervisor pid 12, took over the stale lock of pid 9', FORMATS.pid);
  assert.match(at(0) + ' tick poll:ok hourly:skipped failures=1', FORMATS.tick);
  assert.match(at(0) + ' code moved from 59a9948 to 671d2b2; restarting', FORMATS.moved);
  assert.match(at(0) + ' supervisor exiting for a restart', FORMATS.exiting);
  assert.match(at(0) + ' supervisor stopped', FORMATS.stopped);
  assert.match(at(0) + ' approvals import read 4, imported 1, already 2, reconciled 1, skipped 1: x.json (not an approval id)', FORMATS.imports);
  assert.doesNotMatch(at(0) + ' supervisor already running as pid 12', FORMATS.pid);
});

test('one complete handover parses as one move with no problem and no restart', () => {
  assert.deepEqual(parseLog(handover(A, B, 0)), { moves: [{ from: 'aaaaaaa', to: 'bbbbbbb' }], restarts: 0, imports: 1, problems: [], restartAfterMove: false });
});

test('only a line that starts with an ISO time has a time, so an old stack trace never falls inside --since', () => {
  assert.equal(timeOf(at(0) + ' supervisor stopped'), T0);
  assert.ok(Number.isNaN(timeOf('file:///C:/repo/src/supervisor/run.mjs:451')));
  assert.ok(Number.isNaN(timeOf('    at runSupervisor (file:///C:/repo/src/supervisor/run.mjs:451:7)')));
});

test('a handover with its exiting line missing, the pid before the exit, or no tick after the pid is named', () => {
  const lines = handover(A, B, 0);
  assert.ok(parseLog(lines.filter((l) => !l.endsWith('exiting for a restart'))).problems.includes('the handover to bbbbbbb has no exiting line next'));
  const pidFirst = [lines[0], lines[1], lines[3].replace(at(0.3), at(0.15)), lines[2].replace(at(0.2), at(0.25)), lines[5]];
  const p = parseLog(pidFirst);
  assert.ok(p.problems.includes('the handover to bbbbbbb has no exiting line next'));
  assert.equal(p.restarts, 1);
  assert.ok(parseLog(lines.slice(0, 5)).problems.includes('the handover to bbbbbbb has no tick from the new process'));
  assert.ok(parseLog(lines.slice(1)).problems.includes('the handover to bbbbbbb follows no tick'));
});

test('a second handover that starts where the first did not end, and a time that goes back, are problems', () => {
  const C = 'c'.repeat(40);
  const p = parseLog([...handover(A, B, 0), ...handover(C, A, 10)]);
  assert.equal(p.moves.length, 2);
  assert.ok(p.problems.includes('handover 2 starts at ccccccc, the one before ended at bbbbbbb'));
  assert.deepEqual(parseLog([...handover(A, B, 0), ...handover(B, A, 10)]).problems, []);
  assert.deepEqual(parseLog([at(5) + ' tick poll:ok failures=0', at(1) + ' tick poll:ok failures=0']).problems, ['log time goes back at ' + at(1)]);
});

test('a supervisor pid that no exiting line precedes counts as a restart', () => {
  const p = parseLog([at(0) + ' tick poll:ok failures=0', at(1) + ' supervisor pid 7', at(5) + ' tick poll:ok failures=0', at(6) + ' supervisor stopped', at(7) + ' supervisor pid 8']);
  assert.deepEqual([p.moves.length, p.restarts, p.problems], [0, 2, []]);
});

test('the gaps end with the trailing gap to now', () => {
  assert.deepEqual(gaps([T0, T0 + 5 * 60_000], T0 + 20 * 60_000), [5, 15]);
  assert.deepEqual(gaps([], T0), []);
  const m = measure([T0, T0 + 5 * 60_000, T0 + 12 * 60_000], T0 + 13 * 60_000);
  assert.deepEqual([m.ticks, m.gaps.map((g) => g.min), m.longest[0].min, m.trailingMin], [3, [5, 7, 1], 7, 1]);
});

// A state read() could return after one clean handover from A to B; each test breaks one thing.
const good = () => ({ now: T0 + 12 * 60_000, expect: B, from: A, main: B, deploy: B, lockPid: 4242, lockAlive: true, taskState: 'Running', version: 4, takeovers: [{ at: at(11), from: A, to: B }], ticks: [{ at: T0, code: A }, { at: T0 + 5 * 60_000, code: B }, { at: T0 + 10 * 60_000, code: B }], lines: handover(A, B, 0) });
const opts = { since: at(-1), task: 'fsw-supervisor', version: 4, gapMin: 8, moves: 1, restarts: 0, imports: 1, takeovers: 1 };
const failuresOf = (patch, o = {}) => evaluate({ ...good(), ...patch }, { ...opts, ...o }).failures;

test('a clean takeover state passes every option', () => {
  const r = evaluate(good(), opts);
  assert.deepEqual(r.failures, []);
  assert.deepEqual([r.report.ranBy, r.report.worstGapMin, r.report.trailingGapMin, r.report.imports], ['bbbbbbb', 5, 2, 1]);
});

test('--expect fails on local main, the deploy worktree and the commit the newest tick ran', () => {
  assert.deepEqual(failuresOf({ main: A }), ['local main at aaaaaaa, expected bbbbbbb']);
  assert.deepEqual(failuresOf({ deploy: A }), ['deploy worktree at aaaaaaa, expected bbbbbbb']);
  assert.deepEqual(failuresOf({ ticks: [{ at: T0 + 5 * 60_000, code: B }, { at: T0 + 10 * 60_000, code: A }] }), ['the newest tick ran aaaaaaa, expected bbbbbbb']);
});

test('a d605c5d tick has no code field, so the newest handover or the deploy HEAD names what it ran', () => {
  assert.deepEqual(failuresOf({ ticks: [{ at: T0 + 10 * 60_000, code: null }] }), []);
  assert.deepEqual(failuresOf({ ticks: [{ at: T0 + 10 * 60_000, code: null }], lines: [], expect: A, main: A, deploy: A, from: null, takeovers: [{ to: A }] }, { moves: 0, imports: 0 }), []);
});

test('the lock, the task and the ledger version are checked', () => {
  assert.deepEqual(failuresOf({ lockPid: 999999, lockAlive: false }), ['the lock names pid 999999, which is not a live node process']);
  assert.deepEqual(failuresOf({ taskState: 'Ready' }), ['task fsw-supervisor is Ready, expected Running']);
  assert.deepEqual(failuresOf({ taskState: '' }), ['task fsw-supervisor is missing, expected Running']);
  assert.deepEqual(failuresOf({ version: 3 }), ['ledger user_version 3, expected 4']);
});

test('--gap-min fails a gap between ticks and the trailing gap to now, and no tick at all fails', () => {
  assert.deepEqual(failuresOf({}, { gapMin: 4 }), ['a 5.0 min gap between supervisor ticks (the last gap runs to now)']);
  assert.deepEqual(failuresOf({ now: T0 + 19 * 60_000 }), ['a 9.0 min gap between supervisor ticks (the last gap runs to now)']);
  assert.deepEqual(failuresOf({ ticks: [] }), ['no supervisor.tick event since ' + at(-1)]);
});

test('the newest tick before --since opens the first gap, so a handover gap that starts before --since counts', () => {
  // The old code ticked at 23:05, --since is 23:06 and the first v0 tick came at 23:20.
  const s = { ...good(), before: T0 - 15 * 60_000, ticks: [{ at: T0, code: B }], now: T0 + 60_000, lines: [], from: null };
  assert.deepEqual(evaluate(s, { ...opts, moves: 0, imports: 0 }).failures, ['a 15.0 min gap between supervisor ticks (the last gap runs to now)']);
  assert.deepEqual(evaluate({ ...s, before: T0 - 5 * 60_000 }, { ...opts, moves: 0, imports: 0 }).failures, []);
  assert.equal(evaluate(s, opts).report.tickBeforeSince, new Date(T0 - 15 * 60_000).toISOString());
});

test('--moves, --from, --restarts and --imports are exact counts over the log since --since', () => {
  assert.deepEqual(failuresOf({}, { moves: 2 }), ['1 handovers since ' + at(-1) + ', expected 2']);
  assert.deepEqual(failuresOf({ from: 'c'.repeat(40) }), ['the first handover started at aaaaaaa, expected ccccccc']);
  assert.deepEqual(failuresOf({ lines: [...handover(A, B, 0), at(11) + ' supervisor pid 99'] }), ['1 restarts since ' + at(-1) + ', expected 0']);
  assert.deepEqual(failuresOf({}, { restarts: 1 }), ['0 restarts since ' + at(-1) + ', expected 1']);
  assert.deepEqual(failuresOf({}, { imports: 2 }), ['1 approval import lines since ' + at(-1) + ', expected 2']);
  assert.deepEqual(failuresOf({ lines: handover(B, A, 0), expect: B }), ['the newest handover moved to aaaaaaa, expected bbbbbbb', 'the first handover started at bbbbbbb, expected aaaaaaa']);
});

test('--takeovers counts takeover events and the newest must name --expect; without it the events are not checked', () => {
  assert.deepEqual(failuresOf({ takeovers: [] }), ['0 takeover events, expected 1']);
  assert.deepEqual(failuresOf({ takeovers: [{ from: B, to: A }] }), ['the newest takeover event names ' + A + ', expected ' + B]);
  assert.deepEqual(failuresOf({ takeovers: [] }, { takeovers: null }), []);
});

test('the lock holder must be the supervisor: bin/fsw.mjs run or a process started from the deploy worktree', () => {
  const code = 'C:\\Users\\x\\AppData\\Local\\fsw\\code';
  assert.equal(isSupervisor('"C:\\Program Files\\nodejs\\node.exe"  "C:\\Users\\x\\AppData\\Local\\fsw\\code\\bin\\fsw.mjs" run ', code), true);
  assert.equal(isSupervisor('node bin/fsw.mjs run', null), true);
  assert.equal(isSupervisor('node C:\\users\\X\\appdata\\local\\fsw\\code\\scripts\\x.mjs', code), true);
  assert.equal(isSupervisor('node --test test/a.test.mjs', code), false);
  assert.equal(isSupervisor('node bin/fsw.mjs runner', code), false);
  assert.deepEqual(failuresOf({ lockCommand: 'node --test test/a.test.mjs', code }), ['the lock names pid 4242, a node process that is not the supervisor: node --test test/a.test.mjs']);
  assert.deepEqual(failuresOf({ lockCommand: null, code }), []);
});

// A node process started from a scratch deploy worktree stands in for the supervisor holding the lock.
const holders = [];
process.on('exit', () => holders.forEach((h) => h.kill()));
function holderIn(code) {
  writeFileSync(join(code, 'hold.mjs'), 'setInterval(() => {}, 1e6);\n');
  const h = spawn(process.execPath, [join(code, 'hold.mjs')], { stdio: 'ignore', windowsHide: true });
  h.unref();
  holders.push(h);
  return h.pid;
}

// A scratch repository with commits A and B, main at B, a detached deploy worktree, and an instance
// whose ledger and supervisor.log hold one handover from A to B.
function scratch({ lockPid = null, prior = -22 } = {}) {
  const root = tempDir('fsw-takeover-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=', '-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'f.txt'), 'a\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'a');
  const a = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'f.txt'), 'b\n');
  git('commit', '-q', '-am', 'b');
  const b = git('rev-parse', 'HEAD');
  const code = join(root, 'code');
  git('worktree', 'add', '-q', '--detach', code, b);
  lockPid ??= holderIn(code);
  const instance = join(root, 'instance');
  mkdirSync(join(instance, 'run'), { recursive: true });
  mkdirSync(join(instance, 'logs'));
  const now = Date.now();
  const t = (min) => new Date(now + min * 60_000).toISOString();
  const ledger = openLedger(join(instance, 'ledger.sqlite'));
  for (const [min, c] of [[-40, a], [prior, a], [-18, a], [-13, a], [-8, b], [-3, b]]) ledger.addEvent({ at: t(min), kind: 'supervisor.tick', payload: { jobs: ['poll:ok'], failures: 0, forceMode: null, code: c } });
  ledger.addEvent({ at: t(-2), kind: 'takeover', payload: { from: a, to: b } });
  ledger.close();
  // An untimed stack line, as the launcher's redirect leaves in the live log, sits before --since.
  const log = [t(-40) + ' supervisor pid 100', 'file:///C:/repo/src/supervisor/run.mjs:451', t(-13) + ' tick poll:ok failures=0', t(-12.9) + ' code moved from ' + a.slice(0, 7) + ' to ' + b.slice(0, 7) + '; restarting', t(-12.8) + ' supervisor exiting for a restart', t(-12.7) + ' supervisor pid ' + lockPid, t(-12.6) + ' approvals import read 0, imported 0, already 0, reconciled 0, skipped 0', t(-8) + ' tick poll:ok failures=0'];
  writeFileSync(join(instance, 'logs', 'supervisor.log'), log.join('\r\n') + '\r\n');
  writeFileSync(join(instance, 'run', 'supervisor.pid'), lockPid + '\n');
  return { repo, code, instance, a, b, since: t(-20) };
}

const cli = (s, extra = []) => {
  const r = spawnSync(process.execPath, ['scripts/takeover-check.mjs', '--repo', s.repo, '--code', s.code, '--instance', s.instance, '--since', s.since, '--expect', 'main', '--from', s.a, '--version', '4', '--gap-min', '8', '--moves', '1', '--restarts', '0', '--imports', '1', '--takeovers', '1', '--task', 'fsw-test-no-such-task', ...extra], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
};

test('the CLI reads refs, lock, ledger and the log since --since, and names only what fails', () => {
  const s = scratch();
  const r = cli(s);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.out.failures, ['task fsw-test-no-such-task is missing, expected Running']);
  assert.deepEqual([r.out.main, r.out.deploy, r.out.expect, r.out.lockAlive, r.out.version, r.out.ticks, r.out.restarts, r.out.imports], [s.b.slice(0, 7), s.b.slice(0, 7), s.b.slice(0, 7), true, 4, 4, 0, 1]);
  assert.deepEqual(r.out.moves, [{ from: s.a.slice(0, 7), to: s.b.slice(0, 7) }]);
  assert.ok(r.out.logLinesSince.length === 6 && !r.out.logLinesSince.some((l) => l.startsWith('file:')));
  assert.ok(r.out.trailingGapMin >= 3 && r.out.trailingGapMin < 4);
  const strict = cli(s, ['--moves', '0', '--gap-min', '4', '--imports', '0']);
  assert.deepEqual(strict.out.failures.slice(1), ['a 5.0 min gap between supervisor ticks (the last gap runs to now)', '1 handovers since ' + s.since + ', expected 0', '1 approval import lines since ' + s.since + ', expected 0']);
});

test('the CLI fails a lock whose pid is no live node process', () => {
  const r = cli(scratch({ lockPid: 999999 }));
  assert.deepEqual(r.out.failures, ['the lock names pid 999999, which is not a live node process', 'task fsw-test-no-such-task is missing, expected Running']);
});

test('the CLI fails a lock held by a live node process that is not the supervisor', () => {
  const r = cli(scratch({ lockPid: process.pid }));
  assert.equal(r.out.failures[0].startsWith('the lock names pid ' + process.pid + ', a node process that is not the supervisor: '), true, r.out.failures.join('; '));
});

test('the CLI reads the newest tick before --since from the ledger', () => {
  const r = cli(scratch({ prior: -33 }));
  assert.ok(r.out.failures.includes('a 15.0 min gap between supervisor ticks (the last gap runs to now)'), r.out.failures.join('; '));
  assert.ok(Date.parse(r.out.tickBeforeSince) < Date.parse(r.out.logLinesSince[0].split(' ')[0]));
  assert.equal(cli(scratch()).out.failures.some((f) => f.includes('min gap')), false);
});

test('the CLI refuses a missing required option with exit 2', () => {
  const r = spawnSync(process.execPath, ['scripts/takeover-check.mjs', '--repo', '.'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--code is required/);
});

test('tick-gaps prints every gap in the window and the trailing gap to --until, and exits 0', () => {
  const s = scratch();
  const r = spawnSync(process.execPath, ['scripts/tick-gaps.mjs', '--instance', s.instance, '--since', s.since, '--until', new Date(Date.now()).toISOString()], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  const summary = JSON.parse(lines.at(-1));
  assert.equal(summary.ticks, 4);
  assert.equal(lines.length, 5);
  assert.deepEqual(summary.longest.slice(0, 3).map((g) => g.min), [5, 5, 5]);
  assert.ok(summary.trailingMin >= 3 && summary.trailingMin < 4);
});

test('a restart after the newest handover runs the deploy HEAD, so a rollback to the old line passes --expect old', () => {
  // The rollback script stops the supervisor and starts the task on the old line: a supervisor pid line with
  // no exiting line before it, after the handover to B. The old line's tick carries no code field.
  const lines = [...handover(A, B, 0), at(16) + ' supervisor pid 5151', at(20) + ' tick poll:ok orders:ok failures=0'];
  const state = { lines, expect: A, main: A, deploy: A, ticks: [{ at: T0 + 5 * 60_000, code: B }, { at: T0 + 10 * 60_000, code: B }, { at: T0 + 15 * 60_000, code: B }, { at: T0 + 16 * 60_000, code: null }, { at: T0 + 20 * 60_000, code: null }], now: T0 + 21 * 60_000, takeovers: [] };
  const r = evaluate({ ...good(), ...state }, { ...opts, restarts: 1, takeovers: 0 });
  assert.deepEqual(r.failures, []);
  assert.equal(r.report.ranBy, 'aaaaaaa');
  // Moving forward again is a second handover after the restart, and its target is checked again.
  const forward = [...lines, ...handover(A, B, 25)];
  assert.deepEqual(failuresOf({ lines: forward, ticks: [{ at: T0 + 25 * 60_000, code: null }, { at: T0 + 30 * 60_000, code: B }], now: T0 + 31 * 60_000, takeovers: [] }, { moves: 2, restarts: 1, imports: 2, takeovers: 0 }), []);
  assert.deepEqual(failuresOf({ lines: forward, expect: A, main: A, deploy: A, ticks: [{ at: T0 + 30 * 60_000, code: null }], now: T0 + 31 * 60_000, takeovers: [] }, { moves: 2, restarts: 1, imports: 2, takeovers: 0 }), ['the newest tick ran bbbbbbb, expected aaaaaaa', 'the newest handover moved to bbbbbbb, expected aaaaaaa']);
});

test('--since handover resolves to the tick before the newest handover and that handover\'s old commit', () => {
  const lines = [...handover(A, B, 0), at(7) + ' tick poll:ok orders:ok failures=0', ...handover(B, A, 10), at(16) + ' tick poll:ok orders:ok failures=0'];
  assert.deepEqual(newestHandover(lines), { since: at(10), from: 'bbbbbbb', to: 'aaaaaaa' });
  // An explicit time and --from pass through; handover fills only what was not given.
  assert.deepEqual(resolveWindow({ since: at(3), from: 'cafe' }, lines), { since: at(3), from: 'cafe' });
  assert.deepEqual(resolveWindow({ since: 'handover' }, lines), { since: at(10), from: 'bbbbbbb' });
  assert.deepEqual(resolveWindow({ since: 'handover', from: 'cafe' }, lines), { since: at(10), from: 'cafe' });
  // The window it names passes the check that a handover follows a tick inside the window.
  const window = lines.filter((l) => timeOf(l) >= Date.parse(at(10)));
  assert.deepEqual(parseLog(window).problems, []);
  // No handover in the log, or none with a tick before it, is a usage error, never an empty window.
  assert.throws(() => resolveWindow({ since: 'handover' }, [at(1) + ' tick poll:ok failures=0']), /no handover/);
  assert.throws(() => resolveWindow({ since: 'handover' }, [at(1) + ' code moved from aaaaaaa to bbbbbbb; restarting']), /no tick before/);
  assert.throws(() => resolveWindow({ since: 'yesterday' }, lines), /not an ISO time/);
});
