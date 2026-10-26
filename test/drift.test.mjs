// Synthetic fixtures only: test/fixtures/surfaces holds hand-written answers, never recorded pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRecording } from '../src/surface/recorder.mjs';
import { driftReport, shapesOf } from '../src/surface/drift.mjs';

const fixture = (platform) => join('test', 'fixtures', 'surfaces', platform, 'sense.jsonl');

test('answer shape drift is reported per extractor, and null or an empty list is not drift', () => {
  const base = shapesOf(readRecording(fixture('soomgo')));
  const rec = (answer) => [{ op: 'evaluate', name: 'pageChats', answer }];
  const row = readRecording(fixture('soomgo'))[1].answer[0];
  assert.deepEqual(driftReport(base, shapesOf(rec([row]))), []);
  assert.deepEqual(driftReport(base, shapesOf(rec([]))), []);
  assert.deepEqual(driftReport(base, shapesOf(rec([{ ...row, quotePrice: null }]))), []);
  const { newMessages, ...renamed } = row;
  assert.deepEqual(driftReport(base, shapesOf(rec([{ ...renamed, new_message_count: 1 }]))), [
    { extractor: 'evaluate pageChats', path: '[].newMessages', before: 'number', after: 'missing' },
    { extractor: 'evaluate pageChats', path: '[].new_message_count', before: 'missing', after: 'number' },
  ]);
  assert.deepEqual(driftReport(base, shapesOf([{ op: 'evaluate', name: 'pageQuotesTop', answer: null }])), [{ extractor: 'evaluate pageQuotesTop', path: '.', before: 'unrecorded', after: 'new' }]);
  assert.deepEqual(driftReport(JSON.parse(readFileSync('test/fixtures/surfaces/soomgo/shapes.json', 'utf8')), base), []);
});

test('each committed baseline holds the shapes of its fixture', () => {
  for (const platform of ['kmong', 'soomgo']) {
    const baseline = JSON.parse(readFileSync(join('test', 'fixtures', 'surfaces', platform, 'shapes.json'), 'utf8'));
    assert.deepEqual(driftReport(baseline, shapesOf(readRecording(fixture(platform)))), []);
  }
});
