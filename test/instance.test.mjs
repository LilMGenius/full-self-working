import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadInstance, exampleDir } from '../src/core/instance.mjs';
import { logEvent } from '../src/core/log.mjs';
import { notifyOperator } from '../src/core/notify.mjs';
import { dayKey } from '../src/core/clock.mjs';
import { tempDir } from './tmp.mjs';

function tempInstance(files = ['profile.json', 'business.json', 'config.json']) {
  const dir = tempDir('fsw-inst-');
  for (const f of files) copyFileSync(join(exampleDir, f), join(dir, f));
  return dir;
}

test('loadInstance returns absolute paths and throws a named error for a missing file', () => {
  const dir = tempInstance(['profile.json', 'config.json']);
  try {
    assert.throws(() => loadInstance({ dir }), (e) => e.code === 'FSW_INSTANCE_MISSING' && e.file === 'business.json');
    copyFileSync(join(exampleDir, 'business.json'), join(dir, 'business.json'));
    const inst = loadInstance({ dir });
    assert.equal(inst.config.timezone, 'Asia/Seoul');
    assert.equal(inst.paths.approvals, join(dir, 'operator', 'approvals'));
    assert.equal(existsSync(inst.paths.logs), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config.json falls back to the example only when allowed', () => {
  const dir = tempInstance(['profile.json', 'business.json']);
  try {
    assert.throws(() => loadInstance({ dir }), (e) => e.code === 'FSW_INSTANCE_MISSING' && e.file === 'config.json');
    assert.equal(loadInstance({ dir, allowExampleConfig: true }).config.platforms.kmong.mode, 'auto');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logEvent appends JSONL per Seoul day', () => {
  const dir = tempInstance();
  try {
    const inst = loadInstance({ dir });
    logEvent(inst, 'tick', { platform: 'kmong' });
    const entry = logEvent(inst, 'send', { ok: true });
    assert.equal(entry.kind, 'send');
    const lines = readFileSync(join(inst.paths.logs, `events-${dayKey(new Date(entry.at))}.jsonl`), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).platform, 'kmong');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notifyOperator writes once per open dedupeKey', async () => {
  const dir = tempInstance();
  try {
    const inst = loadInstance({ dir });
    inst.config.notify = { toast: false, webhookUrl: null };
    const a = await notifyOperator(inst, { kind: 'login', title: 'kmong login needed', body: 'sign in again', dedupeKey: 'login:kmong' });
    const b = await notifyOperator(inst, { kind: 'login', title: 'kmong login needed', dedupeKey: 'login:kmong' });
    assert.deepEqual(a, { written: true, toasted: false, posted: false });
    assert.equal(b.written, false);
    const file = join(inst.paths.operator, 'requests.md');
    const md = readFileSync(file, 'utf8');
    assert.equal(md.match(/login:kmong/g).length, 1);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, md.replace('- status: open', '- status: resolved'));
    assert.equal((await notifyOperator(inst, { kind: 'login', title: 'again', dedupeKey: 'login:kmong' })).written, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
