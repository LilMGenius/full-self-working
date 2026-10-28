// The kmong proposal writer behind the surface (003 propose): what reaches the projects page module, and
// what the drain is told. The reader and the seller are scripted; no page is loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterRefusal } from '../src/platforms/kit.mjs';
import { NOT_TYPED, PROJECT_CLOSED, openKmongSurface, proposalDryRun } from '../src/surface/kmong.mjs';
import { tokenFor } from './helpers/surface.mjs';

const SEND = (text) => tokenFor('kmong', 'project:7', 'proposal', text);
const session = { stop: async () => {} };

function fakes({ status = 'APPROVAL', deadlineDays = 3, result = { observed: true, submitted: true, status: 'waiting', label: '응답 대기중' } } = {}) {
  const calls = [];
  const reader = { readProject: async (id) => (calls.push(['read', id]), { id, title: '웹 시스템', status, deadlineDays }), close: async () => calls.push(['close']) };
  const seller = { propose: async (project, proposal, opts) => (calls.push(['propose', project.id, proposal, opts]), result), stop: async () => calls.push(['stop']) };
  return {
    calls,
    open: (over = {}) => openKmongSurface({ session, openReader: async () => (calls.push(['openReader']), reader), openSeller: async (o) => (calls.push(['openSeller', o?.session === session]), seller), business: () => ({ taxInvoice: true }), ...over }),
  };
}

test('propose without a send verdict refuses and opens no reader or seller', async () => {
  const f = fakes();
  const s = await f.open();
  const r = await s.propose('project:7', { text: '제안', amountKRW: 1000000, authorized: { verdict: 'operator' } });
  assert.equal(r.observed, false);
  assert.match(r.reason, /not authorized/);
  assert.deepEqual(f.calls, []);
});

test('propose with a send verdict reads the project, fills the form through the shared session and returns the label as snippet', async () => {
  const f = fakes();
  const s = await f.open();
  const r = await s.propose('project:7', { text: '제안 내용', amountKRW: 14000000, phases: [{ title: 'a' }], authorized: SEND('제안 내용') });
  assert.deepEqual(r, { observed: true, snippet: '응답 대기중' });
  const call = f.calls.find((c) => c[0] === 'propose');
  assert.deepEqual([call[1], call[2], call[3]], [7, { text: '제안 내용', totalKRW: 14000000, phases: [{ title: 'a' }] }, { gate: { ok: true }, taxInvoice: true }]);
  assert.deepEqual(f.calls.map((c) => c[0]), ['openReader', 'read', 'close', 'openSeller', 'propose']);
  assert.equal(f.calls.find((c) => c[0] === 'openSeller')[1], true, 'the seller shares the surface session');
});

test('a closed project is refused as closed before anything is typed, and the seller never opens', async () => {
  const f = fakes({ status: 'CLOSED' });
  await assert.rejects((await f.open()).propose('project:7', { text: 'x', amountKRW: 1, authorized: SEND('x') }), (err) => err instanceof AdapterRefusal && err.code === PROJECT_CLOSED && /project 7 is CLOSED; nothing was typed$/.test(err.message));
  assert.equal(f.calls.some((c) => c[0] === 'openSeller'), false);
});

test('a spent quota or a missing enterprise profile is thrown as a refusal for the drain to return the row', async () => {
  for (const code of NOT_TYPED) {
    const f = fakes({ result: { observed: false, submitted: false, code, reason: 'refused ' + code } });
    await assert.rejects((await f.open()).propose('project:7', { text: 'x', amountKRW: 1, authorized: SEND('x') }), (err) => err instanceof AdapterRefusal && err.code === code);
  }
  const other = fakes({ result: { observed: false, submitted: true, code: 'FSW_KMONG_FORM_UNMAPPED', reason: 'form' } });
  assert.deepEqual(await (await other.open()).propose('project:7', { text: 'x', amountKRW: 1, authorized: SEND('x') }), { observed: false, reason: 'form' });
});

test('the dry run passes dryRun and stops its own seller', async () => {
  const f = fakes({ result: { observed: true, submitted: false, dryRun: true, steps: [] } });
  const seller = { propose: async (p, proposal, opts) => (f.calls.push(['propose', opts]), { observed: true }), stop: async () => f.calls.push(['stop']) };
  const r = await proposalDryRun({ id: 7 }, { text: 'x', totalKRW: 1 }, { gate: { ok: true }, openSeller: async () => seller, business: () => ({ taxInvoice: false }) });
  assert.equal(r.observed, true);
  assert.deepEqual(f.calls, [['propose', { gate: { ok: true }, dryRun: true, taxInvoice: false }], ['stop']]);
});
