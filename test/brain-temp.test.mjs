import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodex } from '../src/brain/codex.mjs';
import { tempDir } from './tmp.mjs';

// A call that fails while it prepares its files, before any child starts, must still remove its directory.
async function leftBehind(call) {
  const scratch = tempDir('fsw-prep-');
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: scratch, TMP: scratch, TMPDIR: scratch });
  try {
    await assert.rejects(call);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(tmpdir() === scratch, false);
  return readdirSync(scratch);
}

test('runCodex removes its directory when the schema cannot be serialized', async () => {
  const schema = {};
  schema.self = schema;
  assert.deepEqual(await leftBehind(() => runCodex({ prompt: 'x', schema, cwd: '.' })), []);
});

// Node stands in for codex: a preloaded script answers with the npm cache the turn was started with, so the
// test reads the environment codex would see.
test('a workspace-write turn starts codex with its own npm cache in the turn folder, and a read-only turn does not', async () => {
  const dir = tempDir('fsw-env-');
  const preload = join(dir, 'answer.cjs');
  writeFileSync(preload, "const a = process.argv; require('node:fs').writeFileSync(a[a.indexOf('--output-last-message') + 1], JSON.stringify({ cache: process.env.npm_config_cache ?? null })); process.exit(0);\n");
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require "' + preload.replace(/\\/g, '/') + '"';
  try {
    const turn = (sandbox) => runCodex({ prompt: 'x', schema: { type: 'object' }, cwd: dir, sandbox, network: true, proxyUrl: 'none', bin: process.execPath });
    const write = (await turn('workspace-write')).data.cache;
    assert.match(write ?? '', /fsw-codex-[^\\/]+[\\/]npm-cache$/);
    assert.ok(write.startsWith(tmpdir()) && !write.startsWith(dir));
    assert.equal(existsSync(write), false);
    assert.equal((await turn('read-only')).data.cache, process.env.npm_config_cache ?? null);
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
});

