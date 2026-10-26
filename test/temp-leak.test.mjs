// Guards against tests leaking directories into the OS temp folder: runs representative test files in a child
// process whose temp folder is a fresh directory and requires it to be empty afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The outer runner's context variable would make a nested run skip the file's tests.
const { NODE_TEST_CONTEXT, ...env } = process.env;
const here = dirname(fileURLToPath(import.meta.url));
// Each file below made temp directories without removing them; together they cover the helper shapes in use.
const SAMPLES = ['fx.test.mjs', 'ledger.test.mjs', 'economics.test.mjs', 'instance.test.mjs'];

test('test files leave nothing behind in the temp folder', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'fsw-leakguard-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
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

