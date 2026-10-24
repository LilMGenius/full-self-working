import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeHandover, probeNewCode, RESTART_EXIT } from '../src/supervisor/run.mjs';
import { run } from '../src/cli/run.mjs';
import { repoRoot } from '../src/core/instance.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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
