// A render whose profile folder cannot be removed keeps its result, the leftover is reported by name, and
// a start finds an older leftover whose Chrome is gone and removes it. Runs the real headless Chrome with
// the remover and the process list injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_CHROME, openRenderer } from '../src/render/html2png.mjs';
import { tempDir } from './tmp.mjs';

test('a locked profile does not fail the render, is reported with its folder, and an old leftover is swept', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed', timeout: 120000 }, async () => {
  const root = tempDir('fsw-renderroot-');
  const stale = join(root, 'fsw-render-stale1');
  mkdirSync(stale);
  writeFileSync(join(stale, 'first_party_sets.db-journal'), 'x');
  const hourAgo = (Date.now() - 3_600_000) / 1000;
  utimesSync(stale, hourAgo, hourAgo);
  const reported = [];
  const locked = (dir) => {
    if (basename(dir) !== 'fsw-render-stale1') throw Object.assign(new Error("EPERM, Permission denied: '" + dir + "'"), { code: 'EPERM' });
    rmSync(dir, { recursive: true, force: true });
  };
  const renderer = await openRenderer({ tempRoot: root, processes: async () => [], remove: locked, onLeftover: (x) => reported.push(x) });
  let shot;
  let closed;
  try {
    assert.equal(existsSync(stale), false, 'the start removes a leftover no process names');
    shot = await renderer.render({ html: '<p>leftover</p>', width: 320, height: 200, out: join(root, 'shot.png'), format: 'png' });
  } finally {
    closed = await renderer.close();
  }
  assert.ok(existsSync(shot.out));
  assert.equal(closed?.removed, false);
  assert.deepEqual(reported.map((x) => x.profile), [renderer.profile]);
  assert.match(reported[0].error, /^EPERM /);
  assert.ok(existsSync(renderer.profile));
  const { releaseProfile } = await import('../src/render/html2png.mjs');
  assert.equal((await releaseProfile(renderer.profile)).removed, true);
});

