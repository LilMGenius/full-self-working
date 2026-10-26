// scripts/approvals-writeback.mjs on synthetic approval files in the shape src/brain/approvals.mjs wrote at
// a8ae31c (status open, approved, rejected, dropped, sent, expired, blocked, unobserved) and on a scratch
// instance whose outbox imported them through importApprovals; no live instance is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLedger, outboxKey } from '../src/core/ledger.mjs';
import { importApprovals } from '../src/core/approvals-import.mjs';
import { assignIds, disagreement, duplicateNext, fileKey, fileOutcome, nextRecord, planWriteback, v0OnlyFile, writeback } from '../scripts/approvals-writeback.mjs';
import { tempDir } from './tmp.mjs';

const AT = '2026-10-26T14:30:00.000Z';
const row = (status, more = {}) => ({ id: 1, kind: 'message', status, updatedAt: AT, payload: { text: 'draft' }, operator: null, receipt: null, reason: null, ...more });

test('fileOutcome maps each outbox status onto the approval file status the old code reads', () => {
  assert.deepEqual(fileOutcome(row('observed')), { status: 'sent', closedAt: AT, finalText: 'draft' });
  assert.deepEqual(fileOutcome(row('observed', { operator: { finalText: 'edited' } })).finalText, 'edited');
  assert.deepEqual(fileOutcome(row('unobserved', { kind: 'quote', reason: 'no receipt', receipt: { pressed: true, pressedAt: '2026-10-26T14:00:00.000Z', costKRW: 4490 } })), { status: 'unobserved', closedAt: AT, detail: 'no receipt', pressed: { at: '2026-10-26T14:00:00.000Z', costKRW: 4490 } });
  assert.deepEqual(fileOutcome(row('blocked', { reason: 'gate' })), { status: 'blocked', closedAt: AT, detail: 'gate' });
  assert.deepEqual(fileOutcome(row('rejected', { operator: { resolvedAt: AT } })), { status: 'rejected', resolvedAt: AT });
  assert.deepEqual(fileOutcome(row('rejected', { reason: 'job closed' })), { status: 'dropped', closedAt: AT, detail: 'job closed' });
  assert.deepEqual(fileOutcome(row('stale', { kind: 'proposal', reason: 'project closed' })), { status: 'expired', closedAt: AT, detail: 'project closed' });
  assert.deepEqual(fileOutcome(row('stale')).status, 'dropped');
  assert.deepEqual(fileOutcome(row('sending')), { status: 'unobserved', closedAt: AT, detail: 'interrupted under v0; check the thread' });
  assert.deepEqual(fileOutcome(row('planned')), { status: 'open' });
  assert.deepEqual(fileOutcome(row('awaiting_operator')), { status: 'open' });
  assert.deepEqual(fileOutcome(row('approved', { operator: { resolvedAt: AT, finalText: 'ok', edited: true } })), { status: 'approved', resolvedAt: AT, finalText: 'ok', edited: true });
});

test('disagreement passes a row that matches its file either way and names any other pair', () => {
  assert.equal(disagreement(row('observed'), { status: 'sent' }), null);
  assert.equal(disagreement(row('awaiting_operator'), { status: 'open' }), null);
  assert.equal(disagreement(row('planned'), { status: 'open', deferredForBudget: {} }), null);
  assert.equal(disagreement(row('rejected'), { status: 'dropped' }), null);
  assert.equal(disagreement(row('unobserved'), { status: 'open', unobserved: true }), null);
  assert.equal(disagreement(row('approved'), { status: 'sent' }), 'row 1 is approved, its file is sent');
  assert.equal(disagreement(row('awaiting_operator'), { status: 'approved' }), 'row 1 is awaiting_operator, its file is approved');
});

test('a file the old code already sent or closed is never rewritten, and one that agrees is left alone', () => {
  for (const status of ['sent', 'rejected', 'dropped', 'expired', 'blocked', 'unobserved']) assert.equal(nextRecord(row('approved'), { status }), null);
  assert.equal(nextRecord(row('observed'), { status: 'open', unobserved: true }), null);
  assert.equal(nextRecord(row('planned'), { status: 'open', deferredForBudget: {} }), null);
  assert.equal(nextRecord(row('approved'), { status: 'approved' }), null);
  assert.deepEqual(nextRecord(row('observed'), { id: 'x', status: 'approved', draft: 'draft' }), { id: 'x', status: 'sent', draft: 'draft', closedAt: AT, finalText: 'draft' });
});

const ID = { sent: '20261025-soomgo-0000000a', deferred: '20261026-soomgo-0000000b', rejected: '20261025-soomgo-0000000c', proposal: '20261025-kmong-0000000d', dropped: '20261025-soomgo-0000000e', approved: '20261025-soomgo-0000000f', oldSent: '20261024-soomgo-00000010' };
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// A scratch instance whose outbox imported seven old files, then moved under v0 the way the drain and fsw
// approve move rows: one sent, one still deferred by the cash caps, one rejected by the operator, one
// proposal gone stale, one dropped by the job, one approved and unsent, one the old code had sent.
function instanceWithOutbox() {
  const instance = tempDir('fsw-writeback-');
  const dir = join(instance, 'operator', 'approvals');
  mkdirSync(dir, { recursive: true });
  const file = (id, body) => writeFileSync(join(dir, id + '.json'), JSON.stringify({ id, createdAt: '2026-10-25T01:00:00.000Z', reason: 'needs approval', ...body }, null, 2) + '\n');
  const l = openLedger(join(instance, 'ledger.sqlite'));
  l.upsertThread({ platform: 'soomgo', externalId: 'r2', kind: 'request' });
  file(ID.sent, { status: 'open', platform: 'soomgo', kind: 'message', threadRef: 'r1', draft: 'hello' });
  file(ID.deferred, { status: 'open', platform: 'soomgo', kind: 'quote', threadRef: 'r2', threadKind: 'request', draft: 'quote text', quote: { amountKRW: 300000, priceType: 'fixed' }, service: 'detail_page_design', costKRW: 4490, reason: 'cash quote refused: daily cash budget spent (12000 + 4490 over 10000)' });
  file(ID.rejected, { status: 'open', platform: 'soomgo', kind: 'quote', threadRef: 'r3', draft: 'q', quote: { amountKRW: 50000 } });
  file(ID.proposal, { status: 'open', platform: 'kmong', kind: 'project_proposal', threadRef: '701', draft: 'proposal', project: { id: 701 } });
  file(ID.dropped, { status: 'open', platform: 'soomgo', kind: 'message', threadRef: 'r5', draft: 'later' });
  file(ID.approved, { status: 'approved', platform: 'soomgo', kind: 'message', threadRef: 'r6', draft: 'go', resolvedAt: '2026-10-25T02:00:00.000Z', finalText: 'go', edited: false });
  file(ID.oldSent, { status: 'sent', platform: 'soomgo', kind: 'message', threadRef: 'r7', draft: 'done', closedAt: '2026-10-24T03:00:00.000Z' });
  assert.equal(importApprovals(l, dir).imported, 7);
  const by = (id) => l.outboxByApproval(id);
  assert.deepEqual([by(ID.deferred).status, by(ID.proposal).kind, by(ID.proposal).payload.project], ['planned', 'proposal', { id: 701 }]);
  l.updateOutbox(by(ID.sent).id, { status: 'observed', operator: { resolvedAt: AT, finalText: 'hello there', edited: true }, receipt: { observed: true }, updatedAt: AT });
  l.updateOutbox(by(ID.rejected).id, { status: 'rejected', operator: { resolvedAt: AT, finalText: null, edited: false }, updatedAt: AT });
  l.updateOutbox(by(ID.proposal).id, { status: 'stale', reason: 'project closed', updatedAt: AT });
  l.updateOutbox(by(ID.dropped).id, { status: 'rejected', reason: 'job closed', updatedAt: AT });
  // A reply v0 planned and sent to the operator itself: the drain gave it an approval id.
  l.addOutbox({ key: 'v0-only', platform: 'soomgo', threadId: l.listThreads({ platform: 'soomgo' })[0].id, kind: 'message', payload: { text: 'v0', threadRef: 'r2', thread: { kind: 'request', stage: 'pre_order' } }, status: 'awaiting_operator', approvalId: '20261026-soomgo-0000abcd' });
  l.close();
  return { instance, dir, path: (id) => join(dir, id + '.json'), read: (id) => JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8')) };
}

// A task name no machine registers, so the guard reads no real scheduled task.
const cli = (instance, ...flags) => spawnSync(process.execPath, ['scripts/approvals-writeback.mjs', '--instance', instance, '--task', 'fsw-test-no-such-task', ...flags], { encoding: 'utf8', windowsHide: true });
const hashes = (s) => Object.fromEntries(Object.values(ID).map((id) => [id, hash(s.path(id))]));

test('a dry run writes nothing; --apply writes only the changed files and a second --apply writes none', () => {
  const s = instanceWithOutbox();
  const before = hashes(s);
  const dry = cli(s.instance);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(hashes(s), before);
  assert.match(dry.stdout, /^20261026-soomgo-0000abcd: none \(v0 row 8\) -> open \(dry run\)/m);
  assert.match(dry.stdout, /^approvals-writeback: 8 outbox rows, 5 file\(s\) to write$/m);
  assert.ok(!existsSync(join(s.dir, '20261026-soomgo-0000abcd.json')));
  const applied = cli(s.instance, '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, new RegExp('^' + ID.sent + ': open -> sent sha256 [0-9a-f]{12} -> [0-9a-f]{12}$', 'm'));
  assert.deepEqual([s.read(ID.sent).status, s.read(ID.sent).finalText, s.read(ID.sent).closedAt], ['sent', 'hello there', AT]);
  assert.deepEqual([s.read(ID.rejected).status, s.read(ID.rejected).resolvedAt], ['rejected', AT]);
  assert.deepEqual([s.read(ID.proposal).status, s.read(ID.proposal).detail, s.read(ID.proposal).project], ['expired', 'project closed', { id: 701 }]);
  assert.deepEqual([s.read(ID.dropped).status, s.read(ID.dropped).detail], ['dropped', 'job closed']);
  const after = hashes(s);
  for (const id of [ID.deferred, ID.approved, ID.oldSent]) assert.equal(after[id], before[id], id + ' changed');
  assert.equal(s.read(ID.deferred).status, 'open');
  assert.ok(!readdirSync(s.dir).some((f) => f.endsWith('.tmp')));
  const again = cli(s.instance, '--apply');
  assert.match(again.stdout, /^approvals-writeback: 8 outbox rows, 0 file\(s\) written$/m);
  assert.deepEqual(hashes(s), after);
  assert.equal(cli(s.instance, '--check').status, 0);
});

test('--check names a row the old code sent after a rollback and writes nothing; --reconcile settles it', () => {
  const s = instanceWithOutbox();
  cli(s.instance, '--apply');
  writeFileSync(s.path(ID.approved), JSON.stringify({ ...s.read(ID.approved), status: 'sent', closedAt: AT }, null, 2) + '\n');
  const filesBefore = hashes(s);
  const check = cli(s.instance, '--check');
  assert.equal(check.status, 1);
  assert.match(check.stdout, new RegExp('^' + ID.approved + ': row 6 is approved, its file is sent$', 'm'));
  assert.match(check.stdout, /^approvals-writeback --check: 8 outbox rows, 1 disagreement\(s\)$/m);
  assert.deepEqual(hashes(s), filesBefore);
  const db = new DatabaseSync(join(s.instance, 'ledger.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT status FROM outbox WHERE approval_id = ?').get(ID.approved).status, 'approved');
  db.close();
  const rec = cli(s.instance, '--reconcile');
  assert.equal(rec.status, 0, rec.stdout);
  assert.match(rec.stdout, /"reconciled":1/);
  const db2 = new DatabaseSync(join(s.instance, 'ledger.sqlite'), { readOnly: true });
  assert.equal(db2.prepare('SELECT status FROM outbox WHERE approval_id = ?').get(ID.approved).status, 'observed');
  db2.close();
  assert.deepEqual(hashes(s), filesBefore);
});

test('a ledger still at version 3 has no outbox, and every mode says so and exits 0', () => {
  const instance = tempDir('fsw-writeback-v3-');
  const db = new DatabaseSync(join(instance, 'ledger.sqlite'));
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY); PRAGMA user_version = 3');
  db.close();
  for (const flags of [[], ['--apply'], ['--check'], ['--reconcile']]) {
    const r = cli(instance, ...flags);
    assert.equal(r.status, 0, flags.join(' '));
    assert.match(r.stdout, /ledger at version 3, no outbox yet/);
  }
  const db2 = new DatabaseSync(join(instance, 'ledger.sqlite'), { readOnly: true });
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version, 3);
  db2.close();
  assert.equal(cli(instance, '--apply', '--check').status, 2);
});

test('one unreadable file stops --apply before any file is written, and the run names it', () => {
  const s = instanceWithOutbox();
  writeFileSync(join(s.dir, '20261025-soomgo-00000099.json'), '{"id": "20261025-soomgo-00000099", "status": ');
  const before = hashes(s);
  const r = cli(s.instance, '--apply');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^20261025-soomgo-00000099\.json: unreadable: /m);
  assert.match(r.stdout, /^approvals-writeback: 1 problem\(s\); nothing written/m);
  assert.deepEqual(hashes(s), before);
  assert.equal(s.read(ID.sent).status, 'open');
  assert.ok(!readdirSync(s.dir).some((f) => f.endsWith('.tmp')));
  assert.equal(cli(s.instance, '--check').status, 1);
});

test('planWriteback names every unreadable file and every row with no file status, and plans the rest', () => {
  const rec = (id, status) => [id, { file: id + '.json', text: '{}', record: { id, status } }];
  const imported = (id, approvalId, status) => ({ id, approvalId, status, kind: 'message', updatedAt: AT, payload: { text: 't', importedFrom: 'operator/approvals/' + approvalId + '.json' }, operator: null, receipt: null, reason: null });
  const records = new Map([rec('f1', 'open'), rec('f2', 'open'), rec('f3', 'sent')]);
  const p = planWriteback([imported(1, 'f1', 'observed'), imported(2, 'f2', 'mystery'), imported(3, 'f3', 'mystery'), imported(4, 'f4', 'observed')], { records, unreadable: ['bad.json: unreadable: x'] });
  assert.deepEqual(p.problems, ['bad.json: unreadable: x', 'f2.json: row 2 is mystery, which has no approval file status']);
  assert.deepEqual(p.writes.map((w) => [w.id, w.next.status]), [['f1', 'sent']]);
  assert.deepEqual(p.notes, ['row 4: f4.json is gone']);
});

// Two files holding one item (the same platform, thread, kind, text and amount): the older owns the outbox
// row and the newer is skipped by the importer as 'same key as outbox row N'.
function instanceWithDuplicates() {
  const instance = tempDir('fsw-writeback-dup-');
  const dir = join(instance, 'operator', 'approvals');
  mkdirSync(dir, { recursive: true });
  const file = (id, createdAt, body) => writeFileSync(join(dir, id + '.json'), JSON.stringify({ id, createdAt, platform: 'soomgo', kind: 'message', reason: 'r', ...body }, null, 2) + '\n');
  file('20261025-soomgo-000000a1', '2026-10-25T01:00:00.000Z', { status: 'open', threadRef: 'd1', draft: 'same reply' });
  file('20261025-soomgo-000000a2', '2026-10-25T02:00:00.000Z', { status: 'approved', threadRef: 'd1', draft: 'same reply', finalText: 'same reply', resolvedAt: '2026-10-25T03:00:00.000Z' });
  file('20261025-soomgo-000000b1', '2026-10-25T01:00:00.000Z', { status: 'open', threadRef: 'd2', draft: 'other reply' });
  file('20261025-soomgo-000000b2', '2026-10-25T02:00:00.000Z', { status: 'approved', threadRef: 'd2', draft: 'other reply', finalText: 'other reply', resolvedAt: '2026-10-25T03:00:00.000Z' });
  const l = openLedger(join(instance, 'ledger.sqlite'));
  const imp = importApprovals(l, dir);
  assert.deepEqual([imp.imported, imp.skipped.map((s) => s.reason.startsWith('same key as outbox row'))], [2, [true, true]]);
  // v0 sent the first item; the second still waits for the operator.
  l.updateOutbox(l.outboxByApproval('20261025-soomgo-000000a1').id, { status: 'observed', receipt: { observed: true }, updatedAt: AT });
  l.close();
  return { instance, read: (id) => JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8')) };
}

test('a second file holding an item v0 sent is written sent too, and one whose row is still open is left alone', () => {
  const s = instanceWithDuplicates();
  const check = cli(s.instance, '--check');
  assert.equal(check.status, 1);
  assert.match(check.stdout, /^20261025-soomgo-000000a2: holds the same item as row 1, which is observed, and the file is approved$/m);
  const r = cli(s.instance, '--apply');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual([s.read('20261025-soomgo-000000a1').status, s.read('20261025-soomgo-000000a2').status], ['sent', 'sent']);
  assert.match(s.read('20261025-soomgo-000000a2').detail, /^the same item as 20261025-soomgo-000000a1/);
  assert.deepEqual([s.read('20261025-soomgo-000000b1').status, s.read('20261025-soomgo-000000b2').status], ['open', 'approved']);
  assert.equal(cli(s.instance, '--check').status, 0);
  assert.match(cli(s.instance, '--apply').stdout, /0 file\(s\) written/);
});

test('duplicateNext follows only a send: a rejected or stale row leaves the other file as it is', () => {
  assert.equal(duplicateNext(row('rejected', { operator: { resolvedAt: AT } }), { status: 'approved' }), null);
  assert.equal(duplicateNext(row('stale'), { status: 'open' }), null);
  assert.equal(duplicateNext(row('observed'), { status: 'sent' }), null);
  assert.equal(duplicateNext(row('sending'), { status: 'approved' }).status, 'unobserved');
  assert.equal(fileKey({ kind: 'nope', platform: 'soomgo', threadRef: 'x' }), null);
});

const v0row = (status, kind, more = {}) => ({ id: 9, key: 'soomgo:r9:' + kind + ':k', platform: 'soomgo', threadId: 3, jobId: null, kind, status, reason: null, approvalId: null, operator: null, receipt: null, createdAt: '2026-10-26T01:00:00.000Z', updatedAt: AT, payload: { text: 'hi', threadRef: 'r9', amountKRW: kind === 'quote' ? 300000 : null, costKRW: kind === 'quote' ? 4490 : null, thread: { kind: 'request', stage: 'pre_order' } }, ...more });

test('a row v0 planned itself becomes a d605c5d file: awaiting open, approved approved, sending and unobserved unobserved with the press, planned open', () => {
  assert.equal(v0OnlyFile(v0row('awaiting_operator', 'message')).record.status, 'open');
  const approved = v0OnlyFile(v0row('approved', 'message', { operator: { resolvedAt: AT, finalText: 'edited', edited: true } })).record;
  assert.deepEqual([approved.status, approved.finalText, approved.edited, approved.threadRef, approved.threadId, approved.kind], ['approved', 'edited', true, 'r9', 3, 'message']);
  const sending = v0OnlyFile(v0row('sending', 'quote')).record;
  assert.deepEqual([sending.status, sending.pressed, sending.quote.amountKRW, sending.costKRW], ['unobserved', { at: AT, costKRW: 4490 }, 300000, 4490]);
  assert.equal(v0OnlyFile(v0row('unobserved', 'quote', { receipt: { pressed: false } })).record.pressed, undefined);
  assert.equal(v0OnlyFile(v0row('unobserved', 'message')).record.pressed, undefined);
  // planned: nothing proves the old pipeline plans the item again from its thread, so it is written open.
  assert.equal(v0OnlyFile(v0row('planned', 'quote')).record.status, 'open');
  for (const s of ['observed', 'rejected', 'stale', 'blocked']) assert.equal(v0OnlyFile(v0row(s, 'message')), null);
  assert.match(v0OnlyFile(v0row('planned', 'message')).record.id, /^20261026-soomgo-[0-9a-f]{8}$/);
  assert.equal(v0OnlyFile(v0row('planned', 'message', { approvalId: '20261026-soomgo-12345678' })).record.id, '20261026-soomgo-12345678');
  const proposal = v0OnlyFile(v0row('approved', 'proposal', { platform: 'kmong', payload: { text: 'p', threadRef: 'project:7', project: { id: 7 }, proposal: { text: 'p' }, critic: { score: 9 } } })).record;
  assert.deepEqual([proposal.kind, proposal.project, proposal.status], ['project_proposal', { id: 7 }, 'approved']);
  const pay = v0OnlyFile(v0row('awaiting_operator', 'pay_request', { jobId: 'j1', payload: { text: 'pay', threadRef: 'r9', amountKRW: 150000, part: 'Deposit (1 of 2)', rest: false, paidBeforeKRW: 0 } })).record;
  assert.deepEqual([pay.orderItem, pay.jobId, pay.amountKRW, pay.paidBeforeKRW, pay.rest], [true, 'j1', 150000, 0, false]);
  assert.match(v0OnlyFile(v0row('planned', 'message', { payload: { text: 'x' } })).problem, /no thread ref/);
});

test('--apply writes the file of a planned v0 row, gives the row that id, and a later import finds the row instead of adding one', () => {
  const instance = tempDir('fsw-writeback-v0-');
  const dir = join(instance, 'operator', 'approvals');
  const l = openLedger(join(instance, 'ledger.sqlite'));
  const t = l.upsertThread({ platform: 'soomgo', externalId: 'r9', kind: 'request' });
  const planned = l.addOutbox({ key: outboxKey({ platform: 'soomgo', threadRef: 'r9', kind: 'quote', text: 'quote text', amountKRW: 300000, files: [] }), platform: 'soomgo', threadId: t.id, kind: 'quote', status: 'planned', createdAt: '2026-10-26T01:00:00.000Z', payload: { text: 'quote text', threadRef: 'r9', amountKRW: 300000, costKRW: 4490, thread: { kind: 'request', stage: 'pre_order' } } });
  l.close();
  const r = cli(instance, '--apply');
  assert.equal(r.status, 0, r.stdout);
  const db = new DatabaseSync(join(instance, 'ledger.sqlite'), { readOnly: true });
  const approvalId = db.prepare('SELECT approval_id FROM outbox WHERE id = ?').get(planned.id).approval_id;
  db.close();
  assert.match(approvalId, /^20261026-soomgo-[0-9a-f]{8}$/);
  const file = JSON.parse(readFileSync(join(dir, approvalId + '.json'), 'utf8'));
  assert.deepEqual([file.status, file.kind, file.threadRef, file.threadId, file.draft, file.quote.amountKRW, file.fromOutbox], ['open', 'quote', 'r9', t.id, 'quote text', 300000, planned.id]);
  assert.match(cli(instance, '--apply').stdout, /0 file\(s\) written/);
  const again = openLedger(join(instance, 'ledger.sqlite'));
  const imp = importApprovals(again, dir);
  assert.deepEqual([imp.imported, imp.already, again.counts().outbox], [0, 1, 1]);
  again.close();
});

// The rules a8ae31c applies to an approval file, copied as they read there: the chat pipeline's
// flushApprovals takes approved files for its platform unless closed or an order item
// (src/pipeline/thread.mjs:278-280), and the projects job takes approved kmong project_proposal files
// that are not closed (src/projects/job.mjs:147-148) and reads project.id and the final text or draft.
const oldChatFlushTakes = (a, platform) => a.status === 'approved' && !(a.platform !== platform || a.closedAt || a.orderItem);
const oldProjectsJobTakes = (a) => a.status === 'approved' && !(a.kind !== 'project_proposal' || a.platform !== 'kmong' || a.closedAt);

test('a v0 proposal file is an order item: the old chat flush skips it and the old projects job sends it', () => {
  const p = { text: 'proposal text', threadRef: 'project:701', amountKRW: 2000000, service: 'web_dev', project: { id: 701, title: 't', amountKRW: 3000000, deadlineAt: null, url: 'u' }, proposal: { totalKRW: 2000000, phases: [], floorKRW: 1500000 }, critic: { score: 8 }, violations: [] };
  const file = v0OnlyFile(v0row('approved', 'proposal', { platform: 'kmong', payload: p, operator: { resolvedAt: AT, finalText: 'proposal text', edited: false } })).record;
  assert.equal(oldChatFlushTakes(file, 'kmong'), false);
  assert.equal(oldProjectsJobTakes(file), true);
  assert.deepEqual([file.orderItem, file.project.id, file.quote, file.warnings, file.finalText ?? file.draft], [true, 701, { amountKRW: 2000000 }, [], 'proposal text']);
  assert.equal(oldChatFlushTakes(v0OnlyFile(v0row('approved', 'message', { operator: { resolvedAt: AT, finalText: 'x' } })).record, 'soomgo'), true);
});

test('--apply and --reconcile refuse while a live supervisor holds the lock or the task serving the instance runs, and write nothing', () => {
  const s = instanceWithOutbox();
  const before = hashes(s);
  mkdirSync(join(s.instance, 'run'), { recursive: true });
  writeFileSync(join(s.instance, 'run', 'supervisor.pid'), process.pid + '\n');
  for (const flag of ['--apply', '--reconcile']) {
    const r = cli(s.instance, flag);
    assert.equal(r.status, 1, flag);
    assert.match(r.stdout, new RegExp('^approvals-writeback ' + flag + ' refused: pid ' + process.pid + ' holds the instance lock; .*nothing was written$', 'm'));
  }
  assert.equal(cli(s.instance).status, 0);
  writeFileSync(join(s.instance, 'run', 'supervisor.pid'), '999999\n');
  const running = writeback(s.instance, 'apply', { alive: () => false, task: () => ({ state: 'Running', instance: s.instance }) });
  assert.equal(running.exit, 1);
  assert.match(running.lines[0], /refused: the scheduled task reads Running for this instance/);
  assert.deepEqual(hashes(s), before);
  assert.equal(writeback(s.instance, 'apply', { alive: () => false, task: () => ({ state: 'Running', instance: join(s.instance, 'other') }) }).exit, 0);
});

test('the id of a written v0 file goes onto its row only while the row keeps its status, and updatedAt stays', () => {
  const instance = tempDir('fsw-writeback-cas-');
  const file = join(instance, 'ledger.sqlite');
  const l = openLedger(file);
  const t = l.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  const row = l.addOutbox({ key: 'k1', platform: 'soomgo', threadId: t.id, kind: 'message', status: 'planned', payload: { text: 'x', threadRef: 'r1' }, createdAt: '2026-10-26T01:00:00.000Z' });
  const other = l.addOutbox({ key: 'k2', platform: 'soomgo', threadId: t.id, kind: 'message', status: 'planned', payload: { text: 'y', threadRef: 'r1' }, createdAt: '2026-10-26T01:00:00.000Z' });
  l.updateOutbox(other.id, { status: 'sending' });
  l.close();
  const moved = assignIds(file, [{ rowId: row.id, approvalId: '20261026-soomgo-00000001', status: 'planned', updatedAt: row.updatedAt }, { rowId: other.id, approvalId: '20261026-soomgo-00000002', status: 'planned', updatedAt: other.updatedAt }]);
  assert.deepEqual(moved.map((m) => m.rowId), [other.id]);
  const db = new DatabaseSync(file, { readOnly: true });
  const got = db.prepare('SELECT id, approval_id, updated_at FROM outbox ORDER BY id').all();
  db.close();
  assert.deepEqual(got.map((g) => [g.approval_id, g.id === row.id ? g.updated_at === row.updatedAt : true]), [['20261026-soomgo-00000001', true], [null, true]]);
});
