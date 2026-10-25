import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../src/cli/services.mjs';
import { tempDir } from './tmp.mjs';

function setup(decisions) {
  const dir = tempDir('fsw-services-');
  writeFileSync(join(dir, 'soomgo-service-items.json'), JSON.stringify(decisions));
  const events = [];
  const ctx = { instance: { paths: { platforms: dir } }, session: {}, ledger: { addEvent: (e) => events.push(e) }, log: () => {} };
  return { dir, events, ctx };
}

const DECISIONS = { _note: 'ignored', '웹 개발': { q: ['a'] }, '챗봇 개발': { q: ['b'] } };

test('a dry run ticks every decided service without saving or recording anything', async () => {
  const { dir, events, ctx } = setup(DECISIONS);
  const calls = [];
  ctx.setServiceItems = async (s, name, wanted, opts) => (calls.push([name, opts.dryRun]), { name, ticked: 1, saved: false, dryRun: true });
  try {
    assert.equal(await run(['soomgo'], ctx), 0);
    assert.deepEqual(calls, [['웹 개발', true], ['챗봇 개발', true]]);
    assert.equal(events.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an applied service is recorded only when soomgo kept its items, and one it did not keep fails the run', async () => {
  const { dir, events, ctx } = setup(DECISIONS);
  ctx.setServiceItems = async (s, name) => (name === '웹 개발' ? { name, ticked: 3, saved: true } : { name, ticked: 2, saved: false, notKept: 'q / b' });
  try {
    assert.equal(await run(['soomgo', '--apply'], ctx), 1);
    assert.deepEqual(events.map((e) => [e.kind, e.ref, e.payload.ticked]), [['platform.service_items', '웹 개발', 3]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--only limits the run to one service and other platforms are refused', async () => {
  const { dir, ctx } = setup(DECISIONS);
  const names = [];
  ctx.setServiceItems = async (s, name) => (names.push(name), { name, ticked: 0 });
  try {
    assert.equal(await run(['soomgo', '--only', '챗봇 개발'], ctx), 0);
    assert.deepEqual(names, ['챗봇 개발']);
    await assert.rejects(run(['kmong'], ctx), /usage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

