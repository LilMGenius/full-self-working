import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from '../src/core/instance.mjs';

// The supervisor's publish job keeps the last five output lines (src/supervisor/run.mjs), so they must
// carry the failure's code and cause.
test('a failed publish ends its output on the failure code and cause', () => {
  const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'publish.mjs'), '--bogus'], { cwd: repoRoot, encoding: 'utf8' });
  const tail = (r.stdout + r.stderr).trim().split('\n').slice(-5).join('\n');
  assert.equal(r.status, 1);
  assert.match(tail, /FSW_PUBLISH_ARGS unknown argument --bogus/);
});

