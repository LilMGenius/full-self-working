// A supervisor that returned is gone within a bounded time whatever its children do: the launcher
// (scripts/task.ps1) waits for the process and starts the next code only once it exits. Each case runs
// fsw run's handler in its own node process, the way bin/fsw.mjs does, with real child processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exampleDir, repoRoot } from '../src/core/instance.mjs';
import { tempDir } from './tmp.mjs';

const src = (p) => JSON.stringify(pathToFileURL(join(repoRoot, 'src', p)).href);

// A stand-in for bsk daemon start --foreground: the first start takes the lock and runs until killed,
// a later one finds the lock held and exits at once, as bsk did at 2026-10-26T17:20:48Z.
const FAKE_DAEMON = [
  "const fs = require('node:fs');",
  "fs.appendFileSync('pids', process.pid + '\\n');",
  "try { fs.closeSync(fs.openSync('daemon.lock', 'wx')); } catch { process.exit(1); }",
  'setInterval(() => {}, 1000);',
].join('\n');

function supervisorScript(body) {
  return [
    'import { run } from ' + src('cli/run.mjs') + ';',
    'import { createBrowserKeeper } from ' + src('supervisor/keepalive.mjs') + ';',
    'import { loadInstance } from ' + src('core/instance.mjs') + ';',
    "import { spawn } from 'node:child_process';",
    "import { appendFileSync } from 'node:fs';",
    'const instance = loadInstance({ dir: process.argv[2] });',
    'process.chdir(process.argv[3]);',
    'const base = { instance, log: () => {}, holdAwake: async () => ({ pid: 0, stop() {} }), probe: () => ({ ok: true }), checkout: () => true, sleep: async () => {} };',
    body,
    'process.exitCode = await run(argv, ctx);',
  ].join('\n');
}

function setup(body) {
  const dir = tempDir('fsw-exit-inst-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const work = tempDir('fsw-exit-work-');
  writeFileSync(join(work, 'daemon.js'), FAKE_DAEMON);
  writeFileSync(join(work, 'supervisor.mjs'), supervisorScript(body));
  return { dir, work };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function runSupervisorProcess({ dir, work }) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(work, 'supervisor.mjs'), dir, work], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  const pids = existsSync(join(work, 'pids')) ? readFileSync(join(work, 'pids'), 'utf8').split(/\s+/).filter(Boolean).map(Number) : [];
  return { status: r.status, seconds: (Date.now() - started) / 1000, stderr: r.stderr, pids };
}

function killAll(pids) {
  for (const pid of pids) if (alive(pid)) process.kill(pid);
}

test('a supervisor that hands over ends the daemon it started and exits 75, also after a second start lost the bsk lock', () => {
  // A bsk status read that times out under load reads as no daemon, so the keeper starts a second one,
  // which loses the lock and exits; the first daemon must still end with the supervisor.
  const paths = setup([
    'let reads = 0;',
    'const status = async () => { reads += 1; return reads === 1 || reads === 3 ? { daemon: false } : { daemon: true, browsers: 1 }; };',
    'const states = [{ head: "a", detached: true, target: "a" }, { head: "a", detached: true, target: "b" }];',
    'let i = 0;',
    'const argv = [];',
    'const ctx = { ...base, codeState: () => states[Math.min(i++, 1)],',
    '  createBrowserKeeper: (o) => createBrowserKeeper({ ...o, bin: process.execPath, status, notify: async () => ({ written: false }), settleMs: 1000 }),',
    '  runTick: async ({ keeper }) => { await keeper.check(); await keeper.check(); return { jobs: [], failures: 0 }; } };',
  ].join('\n'));
  const r = runSupervisorProcess(paths);
  try {
    assert.equal(r.pids.length, 2, 'the keeper started two daemons: ' + r.stderr);
    assert.equal(r.status, 75, 'the supervisor exits with the restart code in time: ' + r.seconds + ' s, ' + r.stderr);
    assert.ok(r.seconds < 15, 'exited after ' + r.seconds + ' s');
    assert.equal(alive(r.pids[0]), false, 'the daemon that held the lock ended with the supervisor');
  } finally {
    killAll(r.pids);
  }
});

test('a supervisor whose child outlives its stop still exits with its code within the grace period', () => {
  const paths = setup([
    "const child = spawn(process.execPath, ['daemon.js'], { stdio: ['ignore', 'pipe', 'pipe'] });",
    'const argv = ["--once"];',
    'const ctx = { ...base, codeState: () => ({ head: "a", detached: true, target: "a" }),',
    '  createBrowserKeeper: () => ({ stop() {}, check: async () => ({ status: "test" }) }),',
    '  runTick: async () => ({ jobs: [], failures: 0 }) };',
  ].join('\n'));
  const r = runSupervisorProcess(paths);
  try {
    assert.equal(r.pids.length, 1, r.stderr);
    assert.equal(r.status, 0, 'a stopped supervisor exits 0 in time: ' + r.seconds + ' s, ' + r.stderr);
    assert.ok(r.seconds < 15, 'exited after ' + r.seconds + ' s');
  } finally {
    killAll(r.pids);
  }
});
