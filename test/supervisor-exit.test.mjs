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
  "let fd; try { fd = fs.openSync('daemon.lock', 'wx'); } catch { process.exit(1); }",
  'fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);',
  'setInterval(() => {}, 1000);',
].join('\n');

function supervisorScript(body) {
  return [
    'import { run } from ' + src('cli/run.mjs') + ';',
    'import { createBrowserKeeper } from ' + src('supervisor/keepalive.mjs') + ';',
    'import { loadInstance } from ' + src('core/instance.mjs') + ';',
    "import { spawn } from 'node:child_process';",
    "import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
    // Waits for an event a fake daemon writes to disk, so a check never runs ahead of a daemon that a
    // loaded machine has not started yet (a fixed settle lost that race under two concurrent suites).
    'const until = async (what, seen) => { const end = Date.now() + 30000; while (!seen()) { if (Date.now() > end) throw new Error("timed out waiting for " + what); await new Promise((r) => setTimeout(r, 25)); } };',
    "const pidsSeen = () => (existsSync('pids') ? readFileSync('pids', 'utf8').split(/\\s+/).filter(Boolean).map(Number) : []);",
    'const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };',
    'const instance = loadInstance({ dir: process.argv[2] });',
    'process.chdir(process.argv[3]);',
    'const base = { instance, log: () => {}, holdAwake: async () => ({ pid: 0, stop() {} }), probe: () => ({ ok: true }), checkout: () => true, sleep: async () => {} };',
    body,
    'process.exitCode = await run(argv, ctx);',
    "console.log('returned ' + Date.now());",
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
  const r = spawnSync(process.execPath, [join(work, 'supervisor.mjs'), dir, work], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
  const exited = Date.now();
  const pids = existsSync(join(work, 'pids')) ? readFileSync(join(work, 'pids'), 'utf8').split(/\s+/).filter(Boolean).map(Number) : [];
  const returned = Number(/^returned (\d+)$/m.exec(r.stdout ?? '')?.[1]);
  const lockHolder = existsSync(join(work, 'daemon.lock')) ? Number(readFileSync(join(work, 'daemon.lock'), 'utf8')) : null;
  // The bound is measured from the moment run() returned, the claim under test, rather than from the
  // start, which on a loaded machine includes every child's start-up.
  return { status: r.status, seconds: (exited - started) / 1000, afterReturn: returned ? (exited - returned) / 1000 : null, stdout: r.stdout, stderr: r.stderr, pids, lockHolder };
}

function killAll(pids) {
  for (const pid of pids) if (alive(pid)) process.kill(pid);
}

test('a supervisor that hands over ends the daemon it started and exits 75, also after a second start lost the bsk lock', () => {
  // A bsk status read that times out under load reads as no daemon, so the keeper starts a second one,
  // which loses the lock and exits; the first daemon must still end with the supervisor.
  const paths = setup([
    'let reads = 0;',
    // Read 2 answers once the first daemon holds the lock; read 4 once the second has started, lost the lock and exited.
    'const status = async () => {',
    '  reads += 1;',
    '  if (reads === 1 || reads === 3) return { daemon: false };',
    '  if (reads === 2) await until("the first daemon to take the lock", () => existsSync("daemon.lock") && readFileSync("daemon.lock", "utf8").length > 0);',
    '  if (reads === 4) await until("the second daemon to lose the lock and exit", () => pidsSeen().length === 2 && gone(pidsSeen()[1]));',
    '  return { daemon: true, browsers: 1 };',
    '};',
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
    assert.equal(r.status, 75, 'the supervisor exits with the restart code: ' + r.seconds + ' s, ' + r.stderr);
    assert.ok(r.afterReturn !== null && r.afterReturn < 10, 'exited ' + r.afterReturn + ' s after run() returned');
    assert.equal(r.lockHolder, r.pids[0], 'the first daemon held the lock');
    assert.equal(alive(r.lockHolder), false, 'the daemon that held the lock ended with the supervisor');
  } finally {
    killAll(r.pids);
  }
});

test('a supervisor whose child outlives its stop still exits with its code within the grace period', () => {
  const paths = setup([
    "const child = spawn(process.execPath, ['daemon.js'], { stdio: ['ignore', 'pipe', 'pipe'] });",
    'await until("the child to start", () => pidsSeen().length === 1);',
    'const argv = ["--once"];',
    'const ctx = { ...base, log: (line) => console.log(line), codeState: () => ({ head: "a", detached: true, target: "a" }),',
    '  createBrowserKeeper: () => ({ stop() {}, check: async () => ({ status: "test" }) }),',
    '  runTick: async () => ({ jobs: [], failures: 0 }) };',
  ].join('\n'));
  const r = runSupervisorProcess(paths);
  try {
    assert.equal(r.pids.length, 1, r.stderr);
    assert.equal(r.status, 0, 'a stopped supervisor exits 0: ' + r.seconds + ' s, ' + r.stderr);
    assert.ok(r.afterReturn !== null && r.afterReturn < 10, 'exited ' + r.afterReturn + ' s after run() returned');
    assert.match(r.stdout, /a handle was still open 5000 ms after the supervisor returned \(.*ProcessWrap.*\); exiting with 0/, 'the forced exit names what held the loop');
  } finally {
    killAll(r.pids);
  }
});
