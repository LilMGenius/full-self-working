import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { initInstance, run } from '../src/cli/init.mjs';
import { tempDir } from './tmp.mjs';

const temp = () => tempDir('fsw-init-');

test('init copies every example file into a new directory and the result loads', () => {
  const dir = join(temp(), 'mine');
  const r = initInstance(dir);
  assert.deepEqual(r.created.sort(), readdirSync(exampleDir).sort());
  assert.equal(loadInstance({ dir }).config.timezone, 'Asia/Seoul');
});

test('init fails by name when the target already holds an instance, and touches nothing', () => {
  const dir = temp();
  writeFileSync(join(dir, 'profile.json'), '{"mine":true}');
  assert.throws(() => initInstance(dir), { code: 'FSW_INSTANCE_EXISTS' });
  assert.equal(readFileSync(join(dir, 'profile.json'), 'utf8'), '{"mine":true}');
  assert.equal(existsSync(join(dir, 'config.json')), false);
});

test('init keeps a stray file that is not an instance marker', () => {
  const dir = temp();
  writeFileSync(join(dir, 'background.md'), 'my own notes');
  const r = initInstance(dir);
  assert.deepEqual(r.skipped, ['background.md']);
  assert.equal(readFileSync(join(dir, 'background.md'), 'utf8'), 'my own notes');
});

test('the CLI reports the named failure with exit 1 and the steps with exit 0', async () => {
  const dir = join(temp(), 'x');
  const out = [];
  const err = [];
  assert.equal(await run([dir], { log: (l) => out.push(l), error: (l) => err.push(l) }), 0);
  assert.ok(out.join('\n').includes('fsw profile build'));
  assert.equal(await run([dir], { log: (l) => out.push(l), error: (l) => err.push(l) }), 1);
  assert.match(err.join('\n'), /FSW_INSTANCE_EXISTS/);
});
