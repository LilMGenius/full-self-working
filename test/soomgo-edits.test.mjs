import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendedDetail } from '../src/platforms/soomgo/edits.mjs';

test('the detail paragraph is appended after a blank line once and never twice', () => {
  assert.equal(appendedDetail('기존 소개입니다.\n', '외주도 맡습니다.'), '기존 소개입니다.\n\n외주도 맡습니다.');
  assert.equal(appendedDetail('기존 소개입니다.\n\n외주도 맡습니다.', '외주도 맡습니다.'), null);
  assert.equal(appendedDetail('', '외주도 맡습니다.'), '외주도 맡습니다.');
  assert.throws(() => appendedDetail('기존', '  '), RangeError);
});
