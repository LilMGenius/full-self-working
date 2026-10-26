import { test } from 'node:test';
import assert from 'node:assert/strict';
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

