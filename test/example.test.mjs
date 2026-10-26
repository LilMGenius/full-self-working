import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExample, findReads, loadExample, missingKeys } from '../scripts/check-example.mjs';

test('findReads sees direct reads, optional chains and one alias hop', () => {
  const src = [
    'const a = instance.config?.pipeline?.minAutoConfidence;',
    'const brain = instance.config?.brain ?? {};',
    'use(brain.model, brain?.effort);',
    'const t = profile.person.nameKo; // config.notAKey',
  ].join('\n');
  const keys = findReads(src).map((r) => r.root + '.' + r.path.join('.'));
  assert.ok(keys.includes('config.pipeline.minAutoConfidence'));
  assert.ok(keys.includes('config.brain.model'));
  assert.ok(keys.includes('config.brain.effort'));
  assert.ok(keys.includes('profile.person.nameKo'));
  assert.ok(!keys.some((k) => k.includes('notAKey')));
});

test('a key the code reads and the example lacks is reported, and a present one is not', () => {
  const example = loadExample();
  const reads = new Map([['x.mjs', [{ root: 'config', path: ['brain', 'model'] }, { root: 'config', path: ['brain', 'neverShipped'] }, { root: 'config', path: ['platforms', 'anyplatform', 'mode'] }]]]);
  const missing = missingKeys(reads, example);
  assert.deepEqual(missing.map((m) => m.key), ['brain.neverShipped']);
});

test('a platform option no example platform shows is reported', () => {
  const example = loadExample();
  for (const p of Object.values(example.config.platforms)) delete p.maxCashPerDay;
  assert.ok(missingKeys(new Map(), example).some((m) => m.key === 'platforms.<id>.maxCashPerDay'));
});

test('every key the repository code reads is in examples/instance', () => {
  assert.deepEqual(checkExample(), []);
});
