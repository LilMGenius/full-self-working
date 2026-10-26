import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe, probeWindow, summarize } from '../scripts/probe.mjs';

test('the probe window opens after the live tick of the mark and closes a minute before the next', () => {
  const at = (hms) => new Date('2026-10-25T' + hms + '+09:00');
  assert.equal(probeWindow(at('10:01:30'), '2026-10-25T00:58:00.000Z').reason, 'waiting for the live tick of this mark');
  assert.equal(probeWindow(at('10:01:30'), '2026-10-25T01:00:50.000Z').wait, 0);
  assert.equal(probeWindow(at('10:04:10'), '2026-10-25T01:00:50.000Z').reason, 'too close to the next mark');
  assert.equal(probeWindow(at('10:01:00'), null).wait, 90_000);
  assert.equal(probeWindow(at('10:02:40'), '2026-10-24T20:00:00.000Z').wait, 0);
});

test('a probe summary keeps counts and field presence and drops every word', () => {
  assert.deepEqual(summarize({ ok: true, rows: [{ preview: '견적 문의', at: null }], name: '고객A' }), { ok: true, rows: { count: 1, fieldsPresent: { preview: 1, at: 0 } }, name: '<3 chars>' });
});

test('a probe refuses to read a row the list shows unread, and an unknown op is a usage error', async () => {
  const lines = [];
  const surface = { session: { loads: 1 }, sense: async () => [{ ref: '5', kind: 'message', unread: true }], read: async () => { throw new Error('opened'); }, stop: async () => {} };
  const code = await probe(['soomgo', 'read', '5', '--now'], { open: async () => surface, log: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.equal(JSON.parse(lines.at(-1)).code, 'FSW_PROBE_UNREAD');
  assert.equal(await probe(['soomgo', 'send', '5', '--now'], { open: async () => surface, log: () => {} }), 2);
});
