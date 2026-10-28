import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deadExports, silentCatches } from '../scripts/check-code.mjs';

test('an export nothing imports is reported, one used only inside its file is marked internal, and imports of every form count', () => {
  const files = {
    'src/a/never.mjs': 'export const lonely = 1;\nexport function inner() { return 1; }\nexport const usesInner = () => inner();\n',
    'src/a/whole.mjs': 'export const viaNamespace = 1;\n',
    'src/a/tested.mjs': 'export const onlyInTests = 1;\n',
    'src/a/source.mjs': 'export const passedOn = 1;\nexport const dropped = 2;\n',
    'src/a/index.mjs': "export { passedOn } from './source.mjs';\n",
    'src/a/all.mjs': 'export const starred = 1;\n',
    'src/a/barrel.mjs': "export * from './all.mjs';\n",
    'src/a/lazy.mjs': 'export const picked = 1;\nexport const left = 2;\n',
    'src/cli/verb.mjs': 'export async function run() {}\n',
    'src/b/user.mjs': "import * as w from '../a/whole.mjs';\nimport { usesInner } from '../a/never.mjs';\nimport { passedOn } from '../a/index.mjs';\nimport { starred } from '../a/barrel.mjs';\nexport const go = async () => { const { picked } = await import('../a/lazy.mjs'); return [w, usesInner, passedOn, starred, picked]; };\n",
    'src/b/entry.mjs': "import { go } from './user.mjs';\ngo();\n",
    'test/a.test.mjs': "import { onlyInTests } from '../src/a/tested.mjs';\n",
  };
  const found = deadExports(files).map((d) => d.file + ' ' + d.name + (d.internal ? ' internal' : ''));
  assert.deepEqual(found.sort(), ['src/a/lazy.mjs left', 'src/a/never.mjs inner internal', 'src/a/never.mjs lonely', 'src/a/source.mjs dropped']);
});

test('a bare catch, a catch holding a short comment and a promise catch returning nothing are silent; a four-word reason or a handled error is not', () => {
  const text = [
    'try { a(); } catch {}',
    'try { a(); } catch (e) { // ignore',
    '}',
    'p.catch(() => {});',
    'q.catch(() => null);',
    '// cleanup: a closed tab needs nothing',
    'r.catch(() => {});',
    'try { a(); } catch { // the page may already be gone',
    '}',
    'try { a(); } catch (err) { log(err); }',
  ].join('\n');
  assert.deepEqual(silentCatches('src/x.mjs', text).map((c) => c.line), [1, 2, 4, 5]);
});
