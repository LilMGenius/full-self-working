import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeHandover, codeState, probeCommit, probeNewCode, RESTART_EXIT, runSupervisor } from '../src/supervisor/run.mjs';
import { run } from '../src/cli/run.mjs';
import { exampleDir, loadInstance, repoRoot } from '../src/core/instance.mjs';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const never = () => {
  throw new Error('the probe must not run');
};

test('the supervisor stays on its own commit and on a commit whose probe already failed', () => {
  assert.equal(codeHandover({ started: 'a', head: 'a', rejected: null, probe: never }).action, 'stay');
  assert.equal(codeHandover({ started: 'a', head: 'b', rejected: 'b', probe: never }).action, 'stay');
  assert.equal(codeHandover({ started: null, head: 'b', rejected: null, probe: never }).action, 'stay');
});

test('a newer commit that imports cleanly is a restart, and one that does not is rejected with its error', () => {
  assert.equal(codeHandover({ started: 'a', head: 'b', rejected: null, probe: () => ({ ok: true }) }).action, 'restart');
  assert.deepEqual(codeHandover({ started: 'a', head: 'c', rejected: 'b', probe: () => ({ ok: false, detail: 'SyntaxError' }) }), { action: 'reject', detail: 'SyntaxError' });
});

test('the probe imports the real supervisor graph and fails on a tree whose run module does not parse', () => {
  assert.equal(probeNewCode(repoRoot).ok, true);
  const broken = mkdtempSync(join(tmpdir(), 'fsw-probe-'));
  mkdirSync(join(broken, 'src', 'cli'), { recursive: true });
  writeFileSync(join(broken, 'src', 'cli', 'run.mjs'), 'export const = 1;\n');
  const r = probeNewCode(broken);
  assert.equal(r.ok, false);
  assert.match(r.detail, /SyntaxError/);
});

test('fsw run exits with the restart code only when the supervisor hands over', async () => {
  const exitFor = (status) => run([], { runSupervisor: async () => ({ status }) });
  assert.equal(await exitFor('restart'), RESTART_EXIT);
  assert.equal(await exitFor('stopped'), 0);
  assert.equal(await exitFor('already running'), 0);
});

function makeInstance() {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-daemon-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

// The daemon with every side effect replaced: no sleep hold, no browser keeper, no real tick or git.
function daemon(instance, { states, checkout = () => true, probe = () => ({ ok: true }) }) {
  const calls = { checkout: [], probe: [], ticks: 0 };
  let i = 0;
  const ctx = {
    instance,
    log: () => {},
    holdAwake: async () => ({ pid: 0, stop() {} }),
    createBrowserKeeper: () => ({ stop() {}, check: async () => ({ status: 'test' }) }),
    runTick: async () => {
      calls.ticks += 1;
      return { jobs: [], failures: 0 };
    },
    codeState: () => states[Math.min(i++, states.length - 1)],
    probe: (commit) => {
      calls.probe.push(commit);
      return probe(commit);
    },
    checkout: (commit) => {
      calls.checkout.push(commit);
      return checkout(commit);
    },
    sleep: async () => {
      throw Object.assign(new Error('end of test'), { code: 'TEST_END' });
    },
  };
  return { ctx, calls };
}

test('a deploy copy moves to newer main after a tick and the daemon reports a restart', async () => {
  const instance = makeInstance();
  const { ctx, calls } = daemon(instance, { states: [{ head: 'a', detached: true, target: 'a' }, { head: 'a', detached: true, target: 'b' }] });
  const r = await runSupervisor(ctx);
  assert.equal(r.status, 'restart');
  assert.deepEqual([calls.ticks, calls.probe, calls.checkout], [1, ['b'], ['b']]);
  assert.equal(existsSync(join(instance.dir, 'run', 'supervisor.pid')), false, 'the lock is released on the way out');
});

test('a deploy copy that cannot move keeps running its code and tells the operator once', async () => {
  const instance = makeInstance();
  const { ctx, calls } = daemon(instance, { states: [{ head: 'a', detached: true, target: 'a' }, { head: 'a', detached: true, target: 'b' }], checkout: () => false });
  await assert.rejects(runSupervisor(ctx), { code: 'TEST_END' });
  assert.deepEqual(calls.checkout, ['b']);
  assert.match(readFileSync(join(instance.paths.operator, 'requests.md'), 'utf8'), /New code does not load/);
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], { cwd, encoding: 'utf8' }).trim();

function scratchRepo(runSource) {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-code-'));
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'src', 'cli'), { recursive: true });
  writeFileSync(join(dir, 'src', 'cli', 'run.mjs'), runSource);
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'one');
  return dir;
}

test('a detached worktree follows main while a branch checkout follows its own HEAD', () => {
  const repo = scratchRepo('export {};\n');
  const deploy = join(mkdtempSync(join(tmpdir(), 'fsw-deploy-')), 'code');
  git(repo, 'worktree', 'add', '--detach', deploy, 'main');
  writeFileSync(join(repo, 'src', 'cli', 'run.mjs'), 'export const v = 2;\n');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'two');
  const main = git(repo, 'rev-parse', 'main');
  const d = codeState(deploy);
  assert.deepEqual([d.detached, d.target === main, d.head === main], [true, true, false]);
  const b = codeState(repo);
  assert.deepEqual([b.detached, b.target, b.head], [false, main, main]);
});

test('a commit is probed in its own worktree, so code that does not import never reaches the deploy copy', () => {
  const repo = scratchRepo('export {};\n');
  assert.equal(probeCommit(git(repo, 'rev-parse', 'HEAD'), repo).ok, true);
  writeFileSync(join(repo, 'src', 'cli', 'run.mjs'), 'export const = 1;\n');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-am', 'broken');
  const r = probeCommit(git(repo, 'rev-parse', 'HEAD'), repo);
  assert.equal(r.ok, false);
  assert.match(r.detail, /SyntaxError/);
  assert.equal(git(repo, 'worktree', 'list').split('\n').length, 1, 'the probe worktree is removed');
});
