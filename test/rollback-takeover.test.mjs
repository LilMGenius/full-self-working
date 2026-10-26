// scripts/rollback-takeover.mjs: its steps, a dry run, the git steps on a scratch repository and the
// rollback under a recording task controller and clock; no scheduled task, live repository or live
// instance is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLedger } from '../src/core/ledger.mjs';
import { realIo, runRollback, steps } from '../scripts/rollback-takeover.mjs';
import { tempDir } from './tmp.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const args = (over = {}) => ({ repo: 'R', code: 'C', instance: 'I', old: A, from: B, task: 'fsw-supervisor', 'abort-after-min': '6', ...over });

test('the nine steps put the write-back before the compare-and-swap, the two switches around it, and steps 7 and 8 always', () => {
  const s = steps(args());
  assert.equal(s.length, 9);
  const at = (re) => s.findIndex(([, cmd]) => re.test(cmd));
  const wb = at(/approvals-writeback\.mjs --instance I --apply/);
  const detach = at(/switch --detach --quiet/);
  const cas = at(/update-ref -m rollback refs\/heads\/main a{40} b{40}/);
  const back = at(/switch --quiet main/);
  assert.deepEqual([at(/^Stop-ScheduledTask -TaskName fsw-supervisor$/), wb, detach, cas, back], [0, 2, 3, 4, 5]);
  assert.match(s[4][1], /skipped when refs\/heads\/main already is a{40}/);
  assert.match(s[6][1], /git -C C checkout --detach --quiet a{40} \(always: finally after step 1\)/);
  assert.match(s[7][1], /Start-ScheduledTask -TaskName fsw-supervisor \(always: finally after step 1\)/);
});

// A scratch repository with main checked out at B and A one commit behind, a deploy worktree at B and an
// instance whose ledger is still at version 3 (nothing for the write-back to do).
function scratch({ lastTickMinAgo = 4 } = {}) {
  const root = tempDir('fsw-rollback-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=', '-C', repo, ...a], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'f.txt'), 'old\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'old');
  const a = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'f.txt'), 'new\n');
  writeFileSync(join(repo, 'g.txt'), 'only in v0\n');
  git('add', 'f.txt', 'g.txt');
  git('commit', '-q', '-m', 'new');
  const b = git('rev-parse', 'HEAD');
  const code = join(root, 'code');
  git('worktree', 'add', '-q', '--detach', code, b);
  const instance = join(root, 'instance');
  mkdirSync(join(instance, 'run'), { recursive: true });
  const l = openLedger(join(instance, 'ledger.sqlite'));
  l.addEvent({ at: new Date(Date.now() - lastTickMinAgo * 60_000).toISOString(), kind: 'supervisor.tick', payload: {} });
  l.close();
  writeFileSync(join(instance, 'run', 'supervisor.pid'), '999999\n');
  return { root, repo, code, instance, a, b, git };
}

test('a dry run prints the nine numbered steps and runs nothing', () => {
  const s = scratch();
  const r = spawnSync(process.execPath, ['scripts/rollback-takeover.mjs', '--repo', s.repo, '--code', s.code, '--instance', s.instance, '--old', s.a, '--from', s.b], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split(/\r?\n/);
  assert.deepEqual(lines.map((l) => l.split('.')[0]), ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.match(lines[2], /^3\. write approval outcomes back: /);
  assert.match(lines[4], /^5\. move main back: .*update-ref/);
  assert.deepEqual([s.git('rev-parse', 'refs/heads/main'), execFileSync('git', ['-C', s.code, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()], [s.b, s.b]);
  const short = spawnSync(process.execPath, ['scripts/rollback-takeover.mjs', '--repo', s.repo, '--code', s.code, '--instance', s.instance, '--old', s.a.slice(0, 7), '--from', s.b], { encoding: 'utf8', windowsHide: true });
  assert.equal(short.status, 3);
});

// The real git, write-back, lock and ledger reads on the scratch instance, with the scheduled task and the
// clock replaced: Start-ScheduledTask "starts" a supervisor by taking the lock and writing a tick.
function injected(s, a) {
  const io = realIo(a);
  const calls = [];
  let clock = Date.now();
  return {
    calls,
    io: {
      ...io,
      ps: (cmd) => {
        calls.push(cmd);
        if (cmd.startsWith('Start-ScheduledTask')) {
          writeFileSync(join(s.instance, 'run', 'supervisor.pid'), process.pid + '\n');
          const l = openLedger(join(s.instance, 'ledger.sqlite'));
          l.addEvent({ at: new Date(clock + 1000).toISOString(), kind: 'supervisor.tick', payload: {} });
          l.close();
        }
        return '';
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      log: () => {},
    },
  };
}

test('--apply on a scratch repository leaves main, the checkout, its files and the deploy worktree at the old line, and main fast-forwards again', async () => {
  const s = scratch();
  const a = { repo: s.repo, code: s.code, instance: s.instance, old: s.a, from: s.b, task: 'fsw-test-task', 'abort-after-min': '6' };
  const { io, calls } = injected(s, a);
  assert.equal(await runRollback(a, io), 0);
  assert.deepEqual(calls, ['Stop-ScheduledTask -TaskName fsw-test-task -ErrorAction SilentlyContinue', 'Start-ScheduledTask -TaskName fsw-test-task']);
  assert.deepEqual([s.git('rev-parse', 'refs/heads/main'), s.git('symbolic-ref', 'HEAD'), s.git('status', '--porcelain'), readFileSync(join(s.repo, 'f.txt'), 'utf8')], [s.a, 'refs/heads/main', '', 'old\n']);
  assert.equal(execFileSync('git', ['-C', s.code, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), s.a);
  assert.equal(spawnSync('git', ['-C', s.repo, 'merge', '--ff-only', '-q', s.b], { encoding: 'utf8' }).status, 0);
  // A rerun whose main already is --old changes nothing and still comes back live (the stopped supervisor
  // left a lock naming a pid that is gone).
  s.git('update-ref', 'refs/heads/main', s.a, s.b);
  s.git('reset', '-q', '--hard', s.a);
  writeFileSync(join(s.instance, 'run', 'supervisor.pid'), '999999\n');
  assert.equal(await runRollback(a, injected(s, a).io), 0);
  assert.equal(s.git('rev-parse', 'refs/heads/main'), s.a);
});

test('moving main under a checked-out branch without the two switches leaves the old files as changes (the case the switches cover)', () => {
  const s = scratch();
  s.git('update-ref', 'refs/heads/main', s.a, s.b);
  assert.notEqual(s.git('status', '--porcelain'), '');
});

test('the deadline is the newest tick plus --abort-after-min, so a tick four minutes old leaves two minutes', async () => {
  const s = scratch({ lastTickMinAgo: 4 });
  const a = { repo: s.repo, code: s.code, instance: s.instance, old: s.a, from: s.b, task: 'fsw-test-task', 'abort-after-min': '6' };
  const { io } = injected(s, a);
  const t0 = io.now();
  const r = await runRollback(a, { ...io, ps: () => '' });
  assert.equal(r, 2);
  const waited = (io.now() - t0) / 60_000;
  assert.ok(waited >= 2 && waited < 2.2, 'waited ' + waited + ' min');
});

// A recording io with no real side effect: git answers from a table, the task controller records.
function recording({ main = B, onMain = true, writebackStatus = 0, updateRefThrows = false, lastTickAgoMs = 60_000 } = {}) {
  const calls = [];
  let clock = Date.parse('2026-10-26T14:31:00.000Z');
  let started = false;
  return {
    calls,
    io: {
      ps: (cmd) => {
        calls.push('ps ' + cmd);
        if (cmd.startsWith('Start-ScheduledTask')) started = true;
        return '';
      },
      git: (args) => {
        calls.push('git ' + args.join(' '));
        if (args[2] === 'rev-parse') return main;
        if (args[2] === 'update-ref' && updateRefThrows) throw new Error('cannot lock ref refs/heads/main');
        return '';
      },
      gitQuiet: () => ({ stdout: onMain ? 'refs/heads/main\n' : '' }),
      writeback: () => (calls.push('writeback'), { status: writebackStatus, stdout: '', stderr: writebackStatus ? 'boom' : '' }),
      lastTick: (since) => (since ? (started ? new Date(clock).toISOString() : null) : new Date(clock - lastTickAgoMs).toISOString()),
      pidNow: () => (started ? 2 : 1),
      alive: (pid) => pid === 1 || (started && pid === 2),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      log: () => {},
    },
  };
}

const after = (calls, a, b) => calls.indexOf(b) > calls.indexOf(a) && calls.indexOf(a) >= 0;

test('a write-back that fails still checks the old line out, starts the task and returns 1 once a fresh tick is seen', async () => {
  const r = recording({ writebackStatus: 1 });
  assert.equal(await runRollback(args(), r.io), 1);
  assert.ok(!r.calls.some((c) => c.includes('update-ref')));
  assert.ok(after(r.calls, 'git -C C checkout --detach --quiet ' + A, 'ps Start-ScheduledTask -TaskName fsw-supervisor'));
  assert.ok(r.calls.includes('ps Stop-Process -Id 1 -Force'));
});

test('an update-ref that throws switches the checkout back to main, then checks out the old line and starts the task', async () => {
  const r = recording({ updateRefThrows: true });
  assert.equal(await runRollback(args(), r.io), 1);
  const cas = r.calls.findIndex((c) => c.startsWith('git -C R update-ref'));
  assert.deepEqual(r.calls.slice(cas - 1, cas + 2), ['git -C R switch --detach --quiet', 'git -C R update-ref -m rollback: main to the archive tip refs/heads/main ' + A + ' ' + B, 'git -C R switch --quiet main']);
  assert.ok(after(r.calls, 'git -C R switch --quiet main', 'git -C C checkout --detach --quiet ' + A));
  assert.ok(after(r.calls, 'git -C C checkout --detach --quiet ' + A, 'ps Start-ScheduledTask -TaskName fsw-supervisor'));
});

test('a checkout that is not on main is moved without switches, and a main already at --old records no update-ref and repeats the same commands', async () => {
  const detached = recording({ onMain: false });
  assert.equal(await runRollback(args(), detached.io), 0);
  assert.ok(detached.calls.some((c) => c.startsWith('git -C R update-ref')) && !detached.calls.some((c) => c.startsWith('git -C R switch')));
  const first = recording({ main: A });
  assert.equal(await runRollback(args(), first.io), 0);
  assert.ok(!first.calls.some((c) => c.startsWith('git -C R update-ref') || c.startsWith('git -C R switch')));
  assert.ok(first.calls.includes('git -C C checkout --detach --quiet ' + A));
  const second = recording({ main: A });
  assert.equal(await runRollback(args(), second.io), 0);
  assert.deepEqual(second.calls, first.calls);
});
