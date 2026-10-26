import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bskStatus } from '../src/core/bsk.mjs';
import { createBrowserKeeper } from '../src/supervisor/keepalive.mjs';
import { tempDir } from './tmp.mjs';

test('bsk status reports a missing binary by code, for the keeper and fsw doctor alike', async () => {
  await assert.rejects(bskStatus({ bin: join(tempDir('fsw-bsk-'), 'bsk.exe') }), { code: 'FSW_BSK_MISSING' });
});

test('the keeper notice names chromeName(config): Chrome, or Chrome with the configured profile', async () => {
  for (const [profile, want] of [[null, /^Open Chrome with/], ['X', /^Open Chrome \(profile X\) with/]]) {
    const notes = [];
    const instance = { config: { browser: { chromeProfile: profile } }, paths: { logs: tempDir('fsw-keeper-') } };
    const keeper = createBrowserKeeper({ instance, canStart: false, status: async () => ({ daemon: true, browsers: 0 }), notify: async (_i, n) => (notes.push(n), { written: true }) });
    const r = await keeper.check(new Date('2026-10-26T01:00:00Z'));
    assert.equal(r.status, 'no browser');
    assert.match(notes[0].body, want);
  }
});

test('stop ends the daemon the keeper started even after a second start lost the bsk lock and exited', async () => {
  // A bsk status read that times out under load reads as no daemon, so the keeper starts a second one,
  // which finds the lock held and exits (2026-10-26T17:20:48Z); stop must still end the first.
  const work = tempDir('fsw-keeper-daemon-');
  writeFileSync(join(work, 'daemon.js'), "const fs = require('node:fs');\ntry { fs.closeSync(fs.openSync('daemon.lock', 'wx')); } catch { process.exit(1); }\nsetInterval(() => {}, 1000);\n");
  const cwd = process.cwd();
  process.chdir(work);
  let first = null;
  try {
    let reads = 0;
    const status = async () => ((reads += 1), reads === 1 || reads === 3 ? { daemon: false } : { daemon: true, browsers: 1 });
    const keeper = createBrowserKeeper({ instance: { config: {}, paths: { logs: work } }, bin: process.execPath, status, settleMs: 1000 });
    assert.equal((await keeper.check()).status, 'daemon started');
    first = keeper.child;
    await keeper.check();
    assert.equal(first.exitCode, null, 'the first daemon still runs after the second start exited');
    const ended = once(first, 'exit');
    keeper.stop();
    await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('the first daemon is still running after stop')), 5000).unref())]);
  } finally {
    process.chdir(cwd);
    if (first && first.exitCode === null && first.signalCode === null) first.kill();
  }
});

