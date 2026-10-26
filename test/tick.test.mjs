// fsw tick: --once names the one pass, a typo stops before it, and a tick beside a live supervisor refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { run } from '../src/cli/tick.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance() {
  const dir = tempDir('fsw-tick-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}
const quietTick = (passes) => async (ctx) => (passes.push(ctx.only), { at: '2026-10-25T00:00:00.000Z', jobs: [], failures: 0 });

test('--once runs one pass and exits 0; an unknown flag exits 2 before a pass', async () => {
  const instance = makeInstance();
  const passes = [];
  const errors = [];
  assert.equal(await run(['--once', '--only', 'digest'], { instance, log: () => {}, runTick: quietTick(passes) }), 0);
  assert.deepEqual(passes, [['digest']]);
  assert.equal(await run(['--onse'], { instance, log: () => {}, error: (l) => errors.push(l), runTick: quietTick(passes) }), 2);
  assert.equal(passes.length, 1);
  assert.match(errors[0], /unknown --onse/);
});

test('a tick beside a live supervisor refuses and records nothing; with no live holder it takes and releases the lock', async () => {
  const instance = makeInstance();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  const lockFile = join(instance.dir, 'run', 'supervisor.pid');
  try {
    mkdirSync(join(instance.dir, 'run'), { recursive: true });
    writeFileSync(lockFile, child.pid + '\n');
    const passes = [];
    const errors = [];
    assert.equal(await run(['--once'], { instance, log: () => {}, error: (l) => errors.push(l), runTick: quietTick(passes) }), 1);
    assert.match(errors[0], new RegExp('^supervisor already running as pid ' + child.pid));
    assert.deepEqual([passes.length, readFileSync(lockFile, 'utf8').trim(), existsSync(join(instance.dir, 'run', 'state.json'))], [0, String(child.pid), false]);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  const passes = [];
  // The lock's first line is the pid; the holder's start time follows it.
  assert.equal(await run(['--once'], { instance, log: () => {}, runTick: async (ctx) => (passes.push(readFileSync(lockFile, 'utf8').split('\n')[0]), { at: 'x', jobs: [], failures: 0 }) }), 0);
  assert.deepEqual(passes, [String(process.pid)]);
  assert.equal(existsSync(lockFile), false);
});
