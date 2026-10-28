import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LINES, oversized } from '../scripts/check-size.mjs';

const lines = (n) => Array.from({ length: n }, (_, i) => 'const a' + i + ' = ' + i + ';').join('\n') + '\n';

test('a source file over 400 lines is listed as failing, a test file as listed only, and data or short files not at all', () => {
  const files = { 'src/a.mjs': lines(401), 'src/b.mjs': lines(400), 'test/big.test.mjs': lines(900), 'scripts/c.js': lines(401), 'src/core/config.schema.json': lines(900) };
  assert.equal(MAX_LINES, 400);
  assert.deepEqual(oversized(Object.keys(files), (f) => files[f]), [
    { file: 'src/a.mjs', lines: 401, test: false },
    { file: 'test/big.test.mjs', lines: 900, test: true },
    { file: 'scripts/c.js', lines: 401, test: false },
  ]);
});

test('a final line without a newline still counts once', () => {
  assert.deepEqual(oversized(['src/x.mjs'], () => lines(401).trimEnd()), [{ file: 'src/x.mjs', lines: 401, test: false }]);
});
