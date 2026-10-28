import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkImports } from '../scripts/check-imports.mjs';
import { tempDir } from './tmp.mjs';

// A throwaway tree under the OS temp directory (tempDir, 003 Temporary directories): {path: source}.
function withTree(files, fn) {
  const root = tempDir('fsw-imports-');
  try {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the v0 tree has no forbidden edge and no import cycle', () => {
  assert.deepEqual(checkImports('.'), []);
});

test('a clean tree passes, with core leaves, page code under browser and a dynamic import', () => withTree({
  'src/core/clock.mjs': 'export const now = () => 0;\n',
  'src/browser/driver.mjs': "import { now } from '../core/clock.mjs';\nexport { now };\n",
  'src/surface/index.mjs': "import { now } from '../browser/driver.mjs';\nexport const open = () => import('./kmong.mjs');\n",
  'src/surface/kmong.mjs': "import { now } from '../core/clock.mjs';\nexport { now };\n",
}, (root) => assert.deepEqual(checkImports(root), [])));

test('a forbidden import fails with file, line and edge, static or dynamic', () => withTree({
  'src/core/clock.mjs': "// clock\nimport { x } from '../surface/index.mjs';\nexport const now = () => x;\n",
  'src/surface/index.mjs': "export const x = 1;\nexport const l = () => import('../core/ledger.mjs');\n",
  'src/core/ledger.mjs': 'export const y = 1;\n',
  'src/browser/driver.mjs': "export { x } from '../surface/index.mjs';\n",
}, (root) => assert.deepEqual(checkImports(root), [
  'src/browser/driver.mjs:1 platforms -> surface is forbidden',
  'src/core/clock.mjs:2 core -> surface is forbidden',
  'src/surface/index.mjs:2 surface -> src/core/ledger.mjs is forbidden',
])));

test('a file-level cycle and a module without a row fail by name', () => withTree({
  'src/economics/a.mjs': "import { b } from './b.mjs';\nexport const a = 1;\n",
  'src/economics/b.mjs': "\nimport { a } from './a.mjs';\nexport const b = 2;\n",
  'src/gadgets/x.mjs': 'export const x = 1;\n',
}, (root) => assert.deepEqual(checkImports(root), [
  'src/gadgets/x.mjs:1 module gadgets has no row in the module table',
  'src/economics/b.mjs:2 import cycle src/economics/a.mjs -> src/economics/b.mjs -> src/economics/a.mjs',
])));

test('a package import anywhere the deploy worktree loads from src/cli/run.mjs fails; ajv inside validateConfig passes', () => withTree({
  'src/cli/run.mjs': "import { go } from '../supervisor/run.mjs';\nexport const run = go;\n",
  'src/supervisor/run.mjs': "import Ajv from 'ajv';\nimport { join } from 'node:path';\nexport const go = () => import('./digest.mjs');\n",
  'src/supervisor/digest.mjs': "export const d = () => import('lodash');\n",
  'src/core/config.mjs': "export const v = async () => (await import('ajv/dist/2020.js')).default;\n",
  'src/cli/settings.mjs': "import { v } from '../core/config.mjs';\nimport chalk from 'chalk';\nexport const s = v;\n",
}, (root) => assert.deepEqual(checkImports(root), [
  'src/supervisor/digest.mjs:1 src/supervisor/digest.mjs imports lodash, which the deploy worktree cannot resolve (no node_modules)',
  'src/supervisor/run.mjs:1 src/supervisor/run.mjs imports ajv, which the deploy worktree cannot resolve (no node_modules)',
])));

test('ajv imported statically in src/core/config.mjs fails once the supervisor graph reaches it', () => withTree({
  'src/cli/run.mjs': "import { v } from '../core/config.mjs';\nexport const run = v;\n",
  'src/core/config.mjs': "import Ajv2020 from 'ajv/dist/2020.js';\nexport const v = Ajv2020;\n",
}, (root) => assert.deepEqual(checkImports(root), ['src/core/config.mjs:1 src/core/config.mjs imports ajv/dist/2020.js, which the deploy worktree cannot resolve (no node_modules)'])));

test('only the outbox mints a surface write token: a surface that names mintAuthorization fails, the drain passes', () => withTree({
  'src/core/authz.mjs': 'export const mintAuthorization = () => ({});\nexport const verifyAuthorization = () => null;\n',
  'src/outbox/drain.mjs': "import { mintAuthorization } from '../core/authz.mjs';\nexport const d = mintAuthorization;\n",
  'src/surface/kmong.mjs': "import { verifyAuthorization } from '../core/authz.mjs';\nimport { mintAuthorization } from '../core/authz.mjs';\nexport const k = [verifyAuthorization, mintAuthorization];\n",
}, (root) => assert.deepEqual(checkImports(root), [
  'src/surface/kmong.mjs:2 mintAuthorization outside src/outbox: only the drain mints a surface write token',
  'src/surface/kmong.mjs:3 mintAuthorization outside src/outbox: only the drain mints a surface write token',
])));
