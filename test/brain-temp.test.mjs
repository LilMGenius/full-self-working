import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runCodex } from '../src/brain/codex.mjs';
import { runJwc } from '../src/brain/jwc.mjs';
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

test('runJwc removes its directory when the thinking level is invalid', async () => {
  assert.deepEqual(await leftBehind(() => runJwc({ prompt: 'x', thinking: 'bogus', cwd: '.' })), []);
});

