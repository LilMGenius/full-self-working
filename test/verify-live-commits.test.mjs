// Synthetic manifests and stub git predicates only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check, fill } from '../scripts/verify-live-commits.mjs';

const id = (c) => c.repeat(40);
const [A, B, C, OWN, TARGET] = [id('a'), id('b'), id('c'), id('1'), id('2')];
const entry = (commit, fields = {}) => ({ commit, subject: 's', owner: ['010'], paths: ['src/x.mjs'], ownerCommit: OWN, ...fields });
const base = { base: id('0'), entries: [entry(A), entry(B)], pathMap: [] };
const yes = { isAncestor: () => true, existsAt: () => true, target: TARGET };
const run = (manifest, over = {}) => check(manifest, { liveIds: [A, B], ...yes, ...over });

test('a manifest that lists every live commit with an ancestor owner and present paths passes', () => {
  assert.deepEqual(run(base), []);
});

test('a live commit the manifest lacks fails, and so does an entry that is not a live commit', () => {
  assert.deepEqual(run({ ...base, entries: [entry(A)] }), ['live commit missing from the manifest: ' + B]);
  assert.deepEqual(check(base, { liveIds: [A], ...yes }), ['manifest names a commit that is not on old main after the base: ' + B]);
});

test('an entry listed twice or by a short id fails, so no substring matches a commit', () => {
  assert.deepEqual(run({ ...base, entries: [entry(A), entry(B), entry(A)] }), ['listed twice: ' + A]);
  assert.deepEqual(run({ ...base, entries: [entry(A), entry('bbbbbbb')] }), ['not a full 40-character commit id: bbbbbbb', 'live commit missing from the manifest: ' + B]);
});

test('an owner that is not an ancestor of the target, or a carried path missing at the owner, fails', () => {
  assert.deepEqual(run(base, { isAncestor: (x) => x !== OWN }), ['aaaaaaa: owner 1111111 is not an ancestor of the target 2222222', 'bbbbbbb: owner 1111111 is not an ancestor of the target 2222222']);
  assert.deepEqual(run({ ...base, entries: [entry(A), entry(B, { paths: ['src/gone.mjs'] })] }, { existsAt: (at, p) => !(at === OWN && p === 'src/gone.mjs') }), ['bbbbbbb: src/gone.mjs is missing at the owner 1111111']);
  assert.deepEqual(run({ ...base, entries: [entry(A), entry(B, { ownerCommit: null, owner: [] })] }), ['bbbbbbb names no owner doc', 'bbbbbbb has no owner commit']);
});

test('a pathMap entry with v0 null is skipped and a moved path is checked at its new path', () => {
  const seen = [];
  const manifest = { ...base, entries: [entry(A, { paths: ['src/old/a.mjs', 'src/old/b.mjs'] }), entry(B)], pathMap: [{ old: 'src/old/a.mjs', v0: null, reason: 'split' }, { old: 'src/old/b.mjs', v0: 'src/new/b.mjs', reason: 'moved' }] };
  assert.deepEqual(run(manifest, { existsAt: (at, p) => (seen.push(p), p !== 'src/old/b.mjs') }), []);
  assert.ok(!seen.includes('src/old/a.mjs') && !seen.includes('src/old/b.mjs') && seen.includes('src/new/b.mjs'));
});

test('fill sets the owner commit only where the last owner doc matches and none is set', () => {
  const manifest = { ...base, entries: [entry(A, { owner: ['010', '030'], ownerCommit: null }), entry(B, { owner: ['030', '010'], ownerCommit: null }), entry(C, { owner: ['010'] })] };
  const out = fill(manifest, '010', TARGET);
  assert.deepEqual(out.entries.map((e) => e.ownerCommit), [null, TARGET, OWN]);
  assert.equal(manifest.entries[1].ownerCommit, null);
  assert.throws(() => fill(manifest, '010', '2222222'), RangeError);
});

test('the committed manifest lists full unique ids, each with an owner doc and no owner commit yet', () => {
  const manifest = JSON.parse(readFileSync('docs/live-commits.json', 'utf8'));
  const ids = manifest.entries.map((e) => e.commit);
  const findings = check(manifest, { liveIds: ids, ...yes });
  assert.deepEqual(findings, ids.map((c) => c.slice(0, 7) + ' has no owner commit'));
});
