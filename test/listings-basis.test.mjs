// A gig's images follow the ranked portfolio (src/listings/proofs.mjs), but kmong reviews every image change for
// days, so a swap of two top items whose fame differs by less than listings.basisFameGap does not move the basis.
// The ranking itself stays exact (src/portfolio/rank.mjs); only the refresh decision collapses the near tie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../src/core/instance.mjs';
import { basisChanged } from '../src/listings/proofs.mjs';
import { refreshDecision } from '../src/listings/watch.mjs';

const fame = { a: 0.543, b: 0.546, c: 0.25, d: null, e: null };

test('a swap of two items whose fame differs by less than the gap leaves the basis unmoved', () => {
  assert.equal(basisChanged(['a', 'b'], ['b', 'a'], { fame, gap: 0.05 }), false);
  assert.equal(basisChanged(['a', 'c'], ['c', 'a'], { fame, gap: 0.05 }), true, 'a fame gap at or above the threshold moves it');
  assert.equal(basisChanged(['a', 'b'], ['b', 'a'], { fame, gap: 0 }), true, 'no gap set keeps every swap');
  assert.equal(basisChanged(['d', 'e'], ['e', 'd'], { fame, gap: 0.05 }), true, 'items without fame swapped on another key');
  assert.equal(basisChanged(['a', 'b'], ['a', 'c'], { fame, gap: 0.05 }), true, 'an item that enters or leaves always moves it');
  assert.equal(basisChanged(['a', 'b'], ['a', 'b'], { fame, gap: 0.05 }), false);
});

test('refreshDecision does not refresh a gig for a near tie and does for a real move', () => {
  const at = { status: '판매중', last: null, room: 1, today: new Date('2026-10-28T00:00:00Z') };
  assert.deepEqual(refreshDecision({ ...at, before: ['a', 'b'], now: ['b', 'a'], fame, gap: 0.05 }), { refresh: false, reason: 'top portfolio items unchanged' });
  assert.equal(refreshDecision({ ...at, before: ['a', 'c'], now: ['c', 'a'], fame, gap: 0.05 }).refresh, true);
});

test('listings.basisFameGap is a setting with its default and reason', () => {
  const schema = JSON.parse(readFileSync(join(repoRoot, 'src', 'core', 'config.schema.json'), 'utf8'));
  const key = schema.properties.listings.properties.basisFameGap;
  assert.equal(key.default, 0.05);
  assert.match(key.description, /kmong/);
  const example = JSON.parse(readFileSync(join(repoRoot, 'examples', 'instance', 'config.json'), 'utf8'));
  assert.equal(example.listings.basisFameGap, 0.05);
});
