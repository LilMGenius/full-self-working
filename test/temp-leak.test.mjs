// Guards against tests leaking directories into the OS temp folder: runs representative test files in a child
// process whose temp folder is a fresh directory and requires it to be empty afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileProcesses } from '../src/render/profile.mjs';

// The outer runner's context variable would make a nested run skip the file's tests.
const { NODE_TEST_CONTEXT, ...env } = process.env;
const here = dirname(fileURLToPath(import.meta.url));
// Each file below made temp directories without removing them; together they cover the helper shapes in use.
const SAMPLES = ['fx.test.mjs', 'ledger.test.mjs', 'economics.test.mjs', 'instance.test.mjs', 'outbox.test.mjs', 'loop.test.mjs', 'listings.test.mjs'];

// A rendering sample's Chrome children (crashpad, gpu, utility) can outlive it for seconds under load and hold files
// in the scratch folder, so the removal waits until no process names the folder, within a deadline, and then ends any
// that are left: they belong to this test's children, since their command line names its scratch folder.
async function removeScratch(scratch, { deadlineMs = 60_000 } = {}) {
  const until = Date.now() + deadlineMs;
  const holders = async () => (await profileProcesses({ timeoutMs: Math.max(1000, until - Date.now()) })).filter((p) => p.commandLine.toLowerCase().includes(scratch.toLowerCase()));
  let left = await holders();
  while (left.length && Date.now() < until) {
    await sleep(500);
    left = await holders();
  }
  for (const p of left) {
    try {
      process.kill(p.pid);
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

test('test files leave nothing behind in the temp folder', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'fsw-leakguard-'));
  t.after(() => removeScratch(scratch));
  for (const file of SAMPLES) {
    const run = spawnSync(process.execPath, [join(here, file)], {
      env: { ...env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(run.status, 0, file + ' failed under a scratch temp folder:\n' + run.stdout.slice(-1500) + run.stderr.slice(-500));
    // Chrome keeps its own chrome_* scratch folders in the temp folder; only this repository's fsw-* ones are checked.
    assert.deepEqual(readdirSync(scratch).filter((n) => n.startsWith('fsw-')), [], file + ' left directories in the temp folder');
  }
});

