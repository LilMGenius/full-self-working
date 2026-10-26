// scripts/rehearsal-effects.mjs on synthetic rows and on a scratch copy ledger; no live instance is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { openLedger } from '../src/core/ledger.mjs';
import { EFFECT_EVENTS, effects } from '../scripts/rehearsal-effects.mjs';
import { tempDir } from './tmp.mjs';

const tick = (i, forceMode = 'observe') => ({ at: '2026-10-26T14:0' + i + ':00.000Z', forceMode });
const eight = Array.from({ length: 8 }, (_, i) => tick(i));
const clean = { ticks: eight, events: [], messagesOut: 0, quotes: 0, outboxMoves: [] };

test('eight observe ticks with no effect pass', () => {
  assert.deepEqual(effects(clean, 8), []);
  assert.deepEqual(effects({ ...clean, events: [{ kind: 'outbox.status', at: 'x', payload: { to: 'planned' } }, { kind: 'listing.refresh', at: 'x', payload: { rows: [{ refresh: true, result: { submitted: false } }] } }, { kind: 'supervisor.job', at: 'x', payload: {} }] }, 8), []);
});

test('every listed effect kind is named', () => {
  assert.deepEqual(EFFECT_EVENTS, ['listing.publish', 'platform.profile_edit', 'platform.service_items', 'platform.identity_request', 'platform.onboarding', 'project.proposed', 'message.sent', 'quote.sent', 'settings.changed']);
  const events = EFFECT_EVENTS.map((kind) => ({ kind, at: 't-' + kind, payload: {} }));
  assert.deepEqual(effects({ ...clean, events }, 8), EFFECT_EVENTS.map((k) => 'outbound event ' + k + ' at t-' + k));
});

test('a submitted listing.refresh, an outbox row moved toward a send, new messages, quotes and outbox rows are named', () => {
  const events = [{ kind: 'listing.refresh', at: 'r', payload: { rows: [{ result: { submitted: true } }] } }, ...['sending', 'observed', 'unobserved'].map((to) => ({ kind: 'outbox.status', at: to, payload: { to } }))];
  assert.deepEqual(effects({ ...clean, events, messagesOut: 2, quotes: 1, outboxMoves: [{ id: 7, status: 'observed' }] }, 8), ['a submitted listing.refresh at r', 'an outbox row moved to sending at sending', 'an outbox row moved to observed at observed', 'an outbox row moved to unobserved at unobserved', '2 new outbound messages', '1 new quotes', 'outbox row 7 is observed after the mark']);
});

test('a tick that ran unforced and a tick count other than --ticks are named', () => {
  assert.deepEqual(effects({ ...clean, ticks: [...eight.slice(0, 7), tick(7, null)] }, 8), ['a tick at 2026-10-26T14:07:00.000Z ran with forceMode null']);
  assert.deepEqual(effects({ ...clean, ticks: eight.slice(0, 7) }, 8), ['7 supervisor.tick events after the mark, expected 8']);
});

const cli = (...args) => spawnSync(process.execPath, ['scripts/rehearsal-effects.mjs', ...args], { encoding: 'utf8', windowsHide: true });

test('the CLI marks the copy, then counts only rows after the mark', () => {
  const dir = tempDir('fsw-effects-');
  const file = join(dir, 'ledger.sqlite');
  const markFile = join(dir, 'mark.json');
  const l = openLedger(file);
  const thread = l.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  const old = '2026-10-20T00:00:00.000Z';
  l.addMessage({ threadId: thread.id, direction: 'out', body: 'before the mark', at: old });
  l.addQuote({ threadId: thread.id, platform: 'soomgo', amountKRW: 1000, at: old });
  l.addOutbox({ key: 'k-old', platform: 'soomgo', kind: 'message', payload: { text: 'x' }, status: 'observed', createdAt: old, updatedAt: old });
  l.addEvent({ kind: 'listing.publish', at: old, payload: {} });
  assert.equal(cli('--ledger', file, '--mark', markFile).status, 0);
  l.addEvent({ kind: 'supervisor.tick', payload: { forceMode: 'observe' } });
  l.addEvent({ kind: 'supervisor.tick', payload: { forceMode: 'observe' } });
  l.addMessage({ threadId: thread.id, direction: 'in', body: 'an inbound read is no effect' });
  l.addOutbox({ key: 'k-new', platform: 'soomgo', kind: 'message', payload: { text: 'y' }, status: 'planned' });
  const pass = cli('--ledger', file, '--since-mark', markFile, '--ticks', '2');
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /^findings: 0$/m);
  assert.deepEqual(JSON.parse(pass.stdout.trim().split(/\r?\n/).at(-2)), { ticks: 2, events: 2, messagesOut: 0, quotes: 0, outboxMoves: 0, findings: 0 });
  l.addMessage({ threadId: thread.id, direction: 'out', body: 'sent in the rehearsal' });
  l.updateOutbox(l.outboxByKey('k-new').id, { status: 'observed' });
  l.close();
  const fail = cli('--ledger', file, '--since-mark', markFile, '--ticks', '2');
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /^1 new outbound messages$/m);
  assert.match(fail.stdout, /^outbox row 2 is observed after the mark$/m);
  assert.match(fail.stdout, /^findings: 2$/m);
  assert.equal(cli('--ledger', file).status, 2);
});
