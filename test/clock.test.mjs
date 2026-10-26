import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextMark, isActive, dayKey, hourKey, nowSeoul, seoulParts } from '../src/core/clock.mjs';

// 08:07 Seoul on 2026-10-25 is 23:07 UTC on 2026-10-24.
const at0807 = new Date('2026-10-24T23:07:30Z');

test('nextMark aligns to Seoul minute marks', () => {
  assert.equal(nextMark(at0807, 5).toISOString(), '2026-10-24T23:10:00.000Z');
  assert.equal(nextMark(at0807, 60).toISOString(), '2026-10-25T00:00:00.000Z');
  assert.equal(nextMark(at0807, 1440).toISOString(), '2026-10-25T15:00:00.000Z');
  assert.equal(seoulParts(nextMark(at0807, 1440)).hour, 0);
});

test('nextMark is strictly after a time already on a mark', () => {
  assert.equal(nextMark(new Date('2026-10-24T23:10:00Z'), 5).toISOString(), '2026-10-24T23:15:00.000Z');
});

test('nextMark rejects a period that cannot align to minute 0', () => {
  assert.throws(() => nextMark(at0807, 7), RangeError);
});

test('isActive includes the start and excludes the end', () => {
  const hours = ['08:00', '23:00'];
  assert.equal(isActive(new Date('2026-10-24T22:59:00Z'), hours), false); // 07:59 Seoul
  assert.equal(isActive(new Date('2026-10-24T23:00:00Z'), hours), true); // 08:00
  assert.equal(isActive(new Date('2026-10-25T13:59:00Z'), hours), true); // 22:59
  assert.equal(isActive(new Date('2026-10-25T14:00:00Z'), hours), false); // 23:00
  assert.equal(isActive(new Date('2026-10-25T15:30:00Z'), ['22:00', '02:00']), true); // 00:30 wraps
});

test('day and hour keys use the Seoul date', () => {
  assert.equal(dayKey(at0807), '20261025');
  assert.equal(hourKey(at0807), '2026102508');
  const n = nowSeoul(at0807);
  assert.equal(n.ymd, '2026-10-25');
  assert.equal(n.hm, '08:07');
  assert.equal(n.iso, '2026-10-25T08:07:30.000+09:00');
});
