import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seoulParts } from '../src/core/clock.mjs';
import { dueJobs, JOBS, nextWake, periodKey } from '../src/supervisor/schedule.mjs';

const at = (iso) => new Date(iso);
const job = (id) => JOBS.find((j) => j.id === id);
const ran = (now) => Object.fromEntries(dueJobs({}, now).map((d) => [d.id, d.period]));
const ids = (list) => list.map((d) => d.id);

test('a fresh state runs every job once and the same slot runs nothing again', () => {
  const t = at('2026-10-24T15:03:00Z'); // 00:03 Seoul, Sunday 2026-10-25
  assert.deepEqual(ids(dueJobs({}, t)), JOBS.map((j) => j.id));
  const last = ran(t);
  assert.deepEqual(dueJobs(last, at('2026-10-24T15:04:59Z')), []);
  assert.deepEqual(ids(dueJobs(last, at('2026-10-24T15:05:00Z'))), ['poll']);
});

test('the hour mark at minute 0 Seoul opens the hourly period', () => {
  const last = ran(at('2026-10-25T01:58:00Z')); // 10:58 Seoul
  assert.deepEqual(ids(dueJobs(last, at('2026-10-25T01:59:59Z'))), []);
  assert.deepEqual(ids(dueJobs(last, at('2026-10-25T02:00:00Z'))), ['hourly', 'poll']);
});

test('a missed mark runs once on catch-up and never twice', () => {
  const last = ran(at('2026-10-24T00:10:00Z')); // 09:10 Seoul on 2026-10-24, digest period 20261024
  const wake = at('2026-10-26T01:30:00Z'); // the machine slept until 10:30 Seoul on 2026-10-26
  const due = dueJobs(last, wake);
  assert.equal(due.filter((d) => d.id === 'digest').length, 1);
  assert.equal(due.find((d) => d.id === 'digest').period, '20261026');
  const after = { ...last, ...Object.fromEntries(due.map((d) => [d.id, d.period])) };
  assert.deepEqual(ids(dueJobs(after, at('2026-10-26T01:35:00Z'))), ['poll']);
});

test('daily 00:00 and 09:00 Seoul marks fall on 15:00 and 00:00 UTC', () => {
  assert.equal(periodKey(job('market'), at('2026-10-24T14:59:59Z')), '20261024');
  assert.equal(periodKey(job('market'), at('2026-10-24T15:00:00Z')), '20261025');
  assert.equal(periodKey(job('digest'), at('2026-10-25T23:59:59Z')), '20261025'); // 08:59:59 Seoul on the 26th
  assert.equal(periodKey(job('digest'), at('2026-10-26T00:00:00Z')), '20261026'); // 09:00 Seoul
});

test('the weekly period turns at Monday 00:00 Seoul', () => {
  const monday = at('2026-10-25T15:00:00Z');
  assert.equal(seoulParts(monday).weekday, 'Mon');
  const before = periodKey(job('listings'), at('2026-10-25T14:59:59Z'));
  const after = periodKey(job('listings'), monday);
  assert.notEqual(before, after);
  assert.equal(after, '2026W44');
  assert.equal(periodKey(job('listings'), at('2026-11-01T14:59:59Z')), after); // Sunday 23:59:59 Seoul
});

test('the supervisor wakes on the next 5-minute Seoul mark', () => {
  assert.equal(nextWake(at('2026-10-25T02:03:10Z')).toISOString(), '2026-10-25T02:05:00.000Z');
  assert.equal(nextWake(at('2026-10-25T02:05:00Z')).toISOString(), '2026-10-25T02:10:00.000Z');
});
