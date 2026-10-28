// Synthetic approval files only: no value here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLedger, outboxKey } from '../src/core/ledger.mjs';
import { importApprovals } from '../src/core/approvals-import.mjs';
import { expireProposals, syncProposals } from '../src/projects/job.mjs';
import { tempDir } from './tmp.mjs';

// A temp ledger and an approvals directory; files is {name: object or raw string}.
function withApprovals(files, fn) {
  const dir = tempDir('fsw-approvals-');
  const approvals = join(dir, 'operator', 'approvals');
  mkdirSync(approvals, { recursive: true });
  const write = (name, body) => writeFileSync(join(approvals, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
  for (const [name, body] of Object.entries(files)) write(name, body);
  const ledger = openLedger(join(dir, 'ledger.sqlite'));
  try {
    return fn({ ledger, approvals, write, dir });
  } finally {
    ledger.close();
  }
}

// sha256 of every file in the directory, so a test can prove the import wrote none of them.
const hashes = (dir) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')]));
const approval = (id, fields) => ({ id, createdAt: '2026-10-20T01:00:00.000Z', reason: 'needs the operator', ...fields });
const statusEvents = (ledger) => ledger.db.prepare("SELECT payload FROM events WHERE kind = 'outbox.status' ORDER BY id").all().map((r) => JSON.parse(r.payload));

test('approval files become outbox rows by approval id, and kinds or files outside the contract are reported by name', () => withApprovals({
  '20261020-kmong-11111111.json': approval('20261020-kmong-11111111', { platform: 'kmong', kind: 'message', threadRef: 'T1', status: 'open', draft: '안녕하세요' }),
  '20261020-soomgo-22222222.json': approval('20261020-soomgo-22222222', { platform: 'soomgo', kind: 'quote', threadRef: 'R2', status: 'sent', createdAt: '2026-10-20T02:00:00.000Z', draft: '견적입니다', quote: { amountKRW: 300000, deliveryDays: 5 }, resolvedAt: '2026-10-20T03:00:00.000Z', finalText: '견적입니다', closedAt: '2026-10-20T03:05:00.000Z' }),
  '20261021-kmong-33333333.json': approval('20261021-kmong-33333333', { platform: 'kmong', kind: 'project_proposal', threadRef: 'project:7', status: 'dropped', createdAt: '2026-10-21T01:00:00.000Z', draft: '제안서' }),
  '20261021-soomgo-44444444.json': approval('20261021-soomgo-44444444', { platform: 'soomgo', kind: 'message', threadRef: 'R4', status: 'expired', createdAt: '2026-10-21T02:00:00.000Z', draft: '네' }),
  'notes.json': { hello: 'not an approval' },
  '20261022-kmong-ffffffff.json': '{ not json',
  '20261022-kmong-77777777.json': approval('20261022-kmong-77777777', { platform: 'kmong', kind: 'message', threadRef: 'T7', status: 'archived', createdAt: '2026-10-22T01:00:00.000Z', draft: 'x' }),
  '20261022-kmong-88888888.json': approval('20261022-kmong-00000000', { platform: 'kmong', kind: 'message', threadRef: 'T8', status: 'open', draft: 'y' }),
  '20261022-kmong-99999999.json': approval('20261022-kmong-99999999', { platform: 'kmong', kind: 'message', threadRef: 'T1', status: 'open', createdAt: '2026-10-22T02:00:00.000Z', draft: '안녕하세요' }),
}, ({ ledger, approvals }) => {
  const thread = ledger.upsertThread({ platform: 'kmong', externalId: 'T1', kind: 'message' });
  const before = hashes(approvals);
  const out = importApprovals(ledger, approvals);
  assert.equal(out.read, 9);
  assert.equal(out.imported, 4);
  assert.equal(out.already, 0);
  assert.equal(out.reconciled, 0);
  const first = ledger.outboxByApproval('20261020-kmong-11111111');
  assert.deepEqual(Object.fromEntries(out.skipped.map((s) => [s.file, s.reason.replace(/^unreadable: .*/, 'unreadable')])), {
    '20261022-kmong-88888888.json': 'id 20261022-kmong-00000000 differs from the file name',
    '20261022-kmong-99999999.json': 'same key as outbox row ' + first.id,
    '20261022-kmong-77777777.json': 'status archived has no outbox status',
    '20261022-kmong-ffffffff.json': 'unreadable',
    'notes.json': 'not an approval id',
  });
  assert.equal(first.status, 'awaiting_operator');
  assert.equal(first.kind, 'message');
  assert.equal(first.threadId, thread.id);
  assert.equal(first.key, outboxKey({ platform: 'kmong', threadRef: 'T1', kind: 'message', text: '안녕하세요', amountKRW: null, files: [] }));
  assert.equal(first.payload.importedFrom, 'operator/approvals/20261020-kmong-11111111.json');
  const quote = ledger.outboxByApproval('20261020-soomgo-22222222');
  assert.equal(quote.status, 'observed');
  assert.equal(quote.threadId, null);
  assert.equal(quote.payload.threadRef, 'R2');
  assert.equal(quote.payload.amountKRW, 300000);
  assert.equal(quote.receipt.observed, true);
  assert.equal(quote.operator.finalText, '견적입니다');
  assert.equal(quote.updatedAt, '2026-10-20T03:05:00.000Z');
  const proposal = ledger.outboxByApproval('20261021-kmong-33333333');
  assert.deepEqual([proposal.kind, proposal.status], ['proposal', 'rejected']);
  assert.equal(ledger.outboxByApproval('20261021-soomgo-44444444').status, 'stale');
  assert.deepEqual(ledger.listOutbox().map((r) => r.approvalId), ['20261020-kmong-11111111', '20261020-soomgo-22222222', '20261021-kmong-33333333', '20261021-soomgo-44444444']);
  assert.deepEqual(hashes(approvals), before);
}));

test('a row the old code sent or closed after a rollback follows its file and is never sent again', () => withApprovals({
  '20261020-kmong-aaaaaaaa.json': approval('20261020-kmong-aaaaaaaa', { platform: 'kmong', kind: 'message', threadRef: 'A', status: 'open', draft: 'a' }),
  '20261020-soomgo-bbbbbbbb.json': approval('20261020-soomgo-bbbbbbbb', { platform: 'soomgo', kind: 'quote', threadRef: 'B', status: 'open', draft: 'b', quote: { amountKRW: 200000 } }),
  '20261020-kmong-cccccccc.json': approval('20261020-kmong-cccccccc', { platform: 'kmong', kind: 'message', threadRef: 'C', status: 'open', draft: 'c' }),
}, ({ ledger, approvals, write }) => {
  assert.equal(importApprovals(ledger, approvals).imported, 3);
  const [a, b, c] = ['20261020-kmong-aaaaaaaa', '20261020-soomgo-bbbbbbbb', '20261020-kmong-cccccccc'].map((id) => ledger.outboxByApproval(id));
  // v0 approved A and sent C; then a rollback ran the old code, which sent A and rejected B in their files.
  ledger.updateOutbox(a.id, { status: 'approved' }, { from: 'awaiting_operator' });
  ledger.updateOutbox(c.id, { status: 'observed', receipt: { observed: true } }, { from: 'awaiting_operator' });
  write('20261020-kmong-aaaaaaaa.json', approval(a.approvalId, { platform: 'kmong', kind: 'message', threadRef: 'A', status: 'sent', draft: 'a', closedAt: '2026-10-21T00:00:00.000Z' }));
  write('20261020-soomgo-bbbbbbbb.json', approval(b.approvalId, { platform: 'soomgo', kind: 'quote', threadRef: 'B', status: 'rejected', draft: 'b', quote: { amountKRW: 200000 }, resolvedAt: '2026-10-21T00:00:00.000Z' }));
  const before = hashes(approvals);
  const out = importApprovals(ledger, approvals);
  assert.deepEqual([out.imported, out.reconciled, out.already, out.skipped.length], [0, 2, 1, 0]);
  const after = ledger.getOutbox(a.id);
  assert.equal(after.status, 'observed');
  assert.equal(after.receipt.observed, true);
  assert.equal(after.updatedAt, '2026-10-21T00:00:00.000Z');
  assert.equal(ledger.getOutbox(b.id).status, 'rejected');
  assert.equal(ledger.getOutbox(c.id).status, 'observed');
  assert.deepEqual(statusEvents(ledger).map((e) => [e.id, e.from, e.to]), [[a.id, 'approved', 'observed'], [b.id, 'awaiting_operator', 'rejected']]);
  // The rows a drain sends: none is left, so nothing goes out twice.
  assert.deepEqual(ledger.listOutbox({ statuses: ['planned', 'approved'] }), []);
  const third = importApprovals(ledger, approvals);
  assert.deepEqual([third.imported, third.reconciled, third.already], [0, 0, 3]);
  assert.deepEqual(hashes(approvals), before);
}));

test('a row v0 was sending follows a final file without being sent again: observed when sent, unobserved otherwise', () => withApprovals({
  '20261020-kmong-aaaaaaaa.json': approval('20261020-kmong-aaaaaaaa', { platform: 'kmong', kind: 'message', threadRef: 'A', status: 'approved', draft: 'a' }),
  '20261020-kmong-bbbbbbbb.json': approval('20261020-kmong-bbbbbbbb', { platform: 'kmong', kind: 'message', threadRef: 'B', status: 'approved', draft: 'b' }),
}, ({ ledger, approvals, write }) => {
  assert.equal(importApprovals(ledger, approvals).imported, 2);
  const [a, b] = ['20261020-kmong-aaaaaaaa', '20261020-kmong-bbbbbbbb'].map((id) => ledger.outboxByApproval(id));
  for (const row of [a, b]) ledger.updateOutbox(row.id, { status: 'sending' }, { from: 'approved' });
  write('20261020-kmong-aaaaaaaa.json', approval(a.approvalId, { platform: 'kmong', kind: 'message', threadRef: 'A', status: 'sent', draft: 'a' }));
  write('20261020-kmong-bbbbbbbb.json', approval(b.approvalId, { platform: 'kmong', kind: 'message', threadRef: 'B', status: 'rejected', draft: 'b' }));
  assert.equal(importApprovals(ledger, approvals).reconciled, 2);
  assert.deepEqual([ledger.getOutbox(a.id).status, ledger.getOutbox(b.id).status], ['observed', 'unobserved']);
  assert.deepEqual(ledger.listOutbox({ statuses: ['planned', 'approved', 'sending'] }), []);
}));

test('a later file that sent the same item closes the older file\'s open row, and a rejected duplicate does not', () => withApprovals({
  '20261020-kmong-11111111.json': approval('20261020-kmong-11111111', { platform: 'kmong', kind: 'message', threadRef: 'T1', status: 'open', draft: '같은 문장' }),
  '20261021-kmong-22222222.json': approval('20261021-kmong-22222222', { platform: 'kmong', kind: 'message', threadRef: 'T1', status: 'sent', createdAt: '2026-10-21T01:00:00.000Z', draft: '같은 문장' }),
  '20261020-kmong-33333333.json': approval('20261020-kmong-33333333', { platform: 'kmong', kind: 'message', threadRef: 'T3', status: 'open', draft: '다른 문장' }),
  '20261021-kmong-44444444.json': approval('20261021-kmong-44444444', { platform: 'kmong', kind: 'message', threadRef: 'T3', status: 'rejected', createdAt: '2026-10-21T02:00:00.000Z', draft: '다른 문장' }),
}, ({ ledger, approvals }) => {
  const out = importApprovals(ledger, approvals);
  assert.deepEqual([out.imported, out.reconciled], [2, 1]);
  assert.equal(ledger.outboxByApproval('20261020-kmong-11111111').status, 'observed');
  const open = ledger.outboxByApproval('20261020-kmong-33333333');
  assert.equal(open.status, 'awaiting_operator');
  assert.deepEqual(out.skipped, [{ file: '20261021-kmong-44444444.json', reason: 'same key as outbox row ' + open.id }]);
  assert.deepEqual(ledger.listOutbox({ statuses: ['planned', 'approved', 'awaiting_operator'] }).map((r) => r.approvalId), ['20261020-kmong-33333333']);
}));

test('a send the old pipeline could not observe imports as unobserved, with its press', () => withApprovals({
  '20261023-soomgo-dddddddd.json': approval('20261023-soomgo-dddddddd', { platform: 'soomgo', kind: 'quote', threadRef: 'D', status: 'open', unobserved: true, draft: 'd', quote: { amountKRW: 150000 }, pressed: { at: '2026-10-23T05:00:00.000Z', costKRW: 600 } }),
  '20261023-soomgo-eeeeeeee.json': approval('20261023-soomgo-eeeeeeee', { platform: 'soomgo', kind: 'quote', threadRef: 'E', status: 'unobserved', draft: 'e', quote: { amountKRW: 150000 } }),
}, ({ ledger, approvals }) => {
  assert.equal(importApprovals(ledger, approvals).imported, 2);
  const d = ledger.outboxByApproval('20261023-soomgo-dddddddd');
  assert.equal(d.status, 'unobserved');
  assert.deepEqual(d.receipt, { observed: false, reason: 'unobserved by the d605c5d pipeline', pipeline: 'd605c5d', pressed: true, pressedAt: '2026-10-23T05:00:00.000Z', costKRW: 600 });
  const e = ledger.outboxByApproval('20261023-soomgo-eeeeeeee');
  assert.equal(e.status, 'unobserved');
  assert.equal(e.receipt.pressed, undefined);
}));

test('a second import adds nothing and a missing directory reads nothing', () => withApprovals({
  '20261020-kmong-12345678.json': approval('20261020-kmong-12345678', { platform: 'kmong', kind: 'delivery', threadRef: 'O1', status: 'approved', draft: '납품합니다', files: ['result.zip'] }),
}, ({ ledger, approvals, dir }) => {
  const first = importApprovals(ledger, approvals);
  assert.equal(first.imported, 1);
  assert.equal(ledger.outboxByApproval('20261020-kmong-12345678').status, 'awaiting_operator');
  const second = importApprovals(ledger, approvals);
  assert.deepEqual([second.read, second.imported, second.already, second.reconciled], [1, 0, 1, 0]);
  assert.equal(ledger.counts().outbox, 1);
  assert.deepEqual(importApprovals(ledger, join(dir, 'missing')), { read: 0, imported: 0, already: 0, reconciled: 0, skipped: [] });
}));

// The shape queueProposal wrote at a8ae31c (project, proposal, critic, violations on the file).
const projectProposal = (id, projectId, fields) => approval(id, {
  platform: 'kmong', kind: 'project_proposal', orderItem: true, threadRef: 'project:' + projectId, service: 'web_app_dev', title: 'kmong 제안 검토: 과제 ' + projectId, draft: '제안서 ' + projectId,
  quote: { amountKRW: 2000000 }, project: { id: projectId, title: '과제 ' + projectId, amountKRW: 3000000, deadlineAt: '2026-10-30', url: 'https://kmong.com/enterprise/requests/' + projectId },
  proposal: { totalKRW: 2000000, phases: [{ title: '설계', priceKRW: 2000000 }], floorKRW: 1500000 }, critic: { score: 8, pass: true, problems: [] }, violations: [], warnings: [], ...fields,
});

test('imported project proposals carry the payload the projects job reads, and one the old code sent is not proposed again', async () => {
  const dir = tempDir('fsw-approvals-');
  const approvals = join(dir, 'operator', 'approvals');
  mkdirSync(approvals, { recursive: true });
  writeFileSync(join(approvals, '20261025-kmong-aaaa0001.json'), JSON.stringify(projectProposal('20261025-kmong-aaaa0001', 501, { status: 'sent', resolvedAt: '2026-10-25T03:00:00.000Z', finalText: '제안서 501', closedAt: '2026-10-25T03:05:00.000Z' })));
  writeFileSync(join(approvals, '20261025-kmong-aaaa0002.json'), JSON.stringify(projectProposal('20261025-kmong-aaaa0002', 502, { status: 'open', createdAt: '2026-10-25T04:00:00.000Z' })));
  const ledger = openLedger(join(dir, 'ledger.sqlite'));
  try {
    assert.equal(importApprovals(ledger, approvals).imported, 2);
    const sent = ledger.outboxByApproval('20261025-kmong-aaaa0001');
    const open = ledger.outboxByApproval('20261025-kmong-aaaa0002');
    assert.deepEqual([sent.status, open.status], ['observed', 'awaiting_operator']);
    assert.deepEqual([open.payload.project.id, open.payload.service, open.payload.proposal.phases.length, open.payload.critic.score, open.payload.summary], [502, 'web_app_dev', 1, 8, 'needs the operator']);
    const instance = { dir, config: {} };
    const now = new Date('2026-10-25T06:00:00.000Z');
    const synced = await syncProposals({ instance, ledger, now });
    assert.deepEqual(synced, []);
    assert.equal(ledger.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'project.proposed'").get().n, 0);
    const read = [];
    const expired = await expireProposals({ ledger, now }, { reader: { readProject: async (id) => (read.push(id), { id, status: 'CLOSED' }) } });
    assert.deepEqual(read, [502]);
    assert.deepEqual(expired, [{ id: 502, outboxId: open.id, action: 'stale' }]);
  } finally {
    ledger.close();
  }
});

// A 2c77326 delivery file carries no review, so an approved one is asked again rather than sent unreviewed.
test('an approved delivery from an old approval file lands awaiting the operator with review error', () => withApprovals({
  '20261020-kmong-12340001.json': approval('20261020-kmong-12340001', { platform: 'kmong', kind: 'delivery', threadRef: 'O2', status: 'approved', draft: '납품합니다', files: ['result.zip'], resolvedAt: '2026-10-20T02:00:00.000Z' }),
  '20261020-kmong-12340002.json': approval('20261020-kmong-12340002', { platform: 'kmong', kind: 'delivery', threadRef: 'O3', status: 'sent', draft: '납품합니다', files: ['other.zip'], closedAt: '2026-10-20T03:00:00.000Z' }),
}, ({ ledger, approvals }) => {
  importApprovals(ledger, approvals);
  const asked = ledger.outboxByApproval('20261020-kmong-12340001');
  assert.deepEqual([asked.status, asked.operator, asked.payload.review.verdict], ['awaiting_operator', null, 'error']);
  assert.match(asked.payload.review.findings[0].detail, /imported from a d605c5d approval file without a review/);
  const sent = ledger.outboxByApproval('20261020-kmong-12340002');
  assert.deepEqual([sent.status, sent.payload.review.verdict], ['observed', 'error']);
}));

// The operator's edit in the old file is the text the key was built from; asking again must keep it, and the row it
// becomes after the new approval must drain instead of reading as a payload changed after planning.
test('an approved delivery imported with an operator edit is asked again with that edit, and drains once re-approved', async () => {
  const { drain, resolve } = await import('../src/outbox/index.mjs');
  const { keyMatches } = await import('../src/outbox/plan.mjs');
  const { exampleDir, loadInstance } = await import('../src/core/instance.mjs');
  const { loadDescriptor } = await import('../src/platforms/registry.mjs');
  const { authorize } = await import('../src/policy/authorize.mjs');
  const dir = tempDir('fsw-approvals-');
  const approvals = join(dir, 'operator', 'approvals');
  mkdirSync(approvals, { recursive: true });
  writeFileSync(join(approvals, '20261020-kmong-12340003.json'), JSON.stringify(approval('20261020-kmong-12340003', { platform: 'kmong', kind: 'delivery', threadRef: 'O4', status: 'approved', draft: '납품합니다', finalText: '수정한 납품 안내입니다', edited: true, files: [], resolvedAt: '2026-10-20T02:00:00.000Z' })));
  const ledger = openLedger(join(dir, 'ledger.sqlite'));
  try {
    ledger.upsertThread({ platform: 'kmong', externalId: 'O4', kind: 'message' });
    importApprovals(ledger, approvals);
    const asked = ledger.outboxByApproval('20261020-kmong-12340003');
    assert.equal(asked.status, 'awaiting_operator');
    assert.equal(asked.payload.text, '수정한 납품 안내입니다', 'the operator edit is what is asked again');
    resolve(ledger, '20261020-kmong-12340003', { approve: true, reason: 'checked by hand' });
    assert.equal(keyMatches(ledger.getOutbox(asked.id)), true, 'the re-approved row still matches the key the import built');
    const sends = [];
    const surface = { platform: 'kmong', read: async () => ({ messages: [], notices: [] }), send: async (ref, args) => (sends.push(args.text), { observed: true }), quote: async () => ({ observed: false }), stop: async () => {} };
    const out = await drain(ledger, { platform: 'kmong', surface, authorize, ctx: { descriptor: loadDescriptor('kmong'), instance: loadInstance({ dir: exampleDir }), mode: 'auto', now: new Date('2026-10-20T12:00:00+09:00'), notify: async () => ({}) } });
    assert.deepEqual(out.map((x) => x.action), ['observed']);
    assert.deepEqual(sends, ['수정한 납품 안내입니다']);
  } finally {
    ledger.close();
  }
});
