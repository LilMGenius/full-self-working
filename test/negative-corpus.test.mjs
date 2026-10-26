import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkCorpus } from '../scripts/check-negative-corpus.mjs';

const head = '# x\n\nPhase: wp2\n\n| # | Lesson | Kind | Holder | Anchor | Lands | Status | Source |\n|---|---|---|---|---|---|---|---|\n';

test('the committed negative corpus passes its own check', () => {
  assert.deepEqual(checkCorpus(readFileSync('docs/NEGATIVE-CORPUS.md', 'utf8')), []);
});

test('a held row whose holder lacks its anchor, or whose holder is missing, fails', () => {
  const text = head + '| 1 | a | gate | src/policy/gate.mjs | no such anchor anywhere | wp1 | held | s |\n| 2 | b | test | test/nope.test.mjs | t | wp1 | held | s |\n';
  assert.deepEqual(checkCorpus(text), ['row 1: src/policy/gate.mjs does not contain "no such anchor anywhere"', 'row 2: holder test/nope.test.mjs does not exist']);
});

test('a row still pending at or after its phase fails, and one for a later phase passes', () => {
  const text = head + '| 1 | a | test | - | - | wp2 | pending | s |\n| 2 | b | test | - | - | wp3 | pending | s |\n';
  assert.deepEqual(checkCorpus(text), ['row 1: still pending at wp2 though it lands in wp2']);
});

test('shape faults are named: numbering, kind, status, a held test without a holder and a missing source', () => {
  const text = head + '| 3 | a | rule | - | - | wp1 | done | - |\n| 2 | b | test | - | - | wp1 | held | s |\n';
  assert.deepEqual(checkCorpus(text), [
    'row 3: numbered 3, expected 1',
    'row 3: kind rule is not gate, test or note',
    'row 3: status done is not held or pending',
    'row 3: no source',
    'row 2: a held test names no holder file',
  ]);
  assert.deepEqual(checkCorpus('no phase here'), ['no "Phase: wpN" line']);
});
