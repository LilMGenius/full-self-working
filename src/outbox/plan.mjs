// Every outbound item starts here (architect D5): one row per planned item, keyed so planning the same
// item twice returns the first row. Status changes go through setStatus, which writes one outbox.status
// event per change; that history is what the loop gate and the digest read. Every SQL statement on the
// outbox table lives in the ledger's outbox helpers (src/core/ledger.mjs, 003 Ledger v4); this module
// holds the key material, the transition rule and the event.
import { outboxKey } from '../core/ledger.mjs';
import { transaction } from '../core/tx.mjs';

// The moves a row may make; a terminal status has none. sending goes back to planned or approved only
// when the surface refused before it touched the page (drain, NOT_SENT).
export const TRANSITIONS = {
  planned: ['awaiting_operator', 'sending', 'blocked', 'stale'],
  awaiting_operator: ['approved', 'rejected', 'stale'],
  // An approved row nobody claimed yet can still be rejected (a cash quote no day can pay).
  approved: ['sending', 'blocked', 'stale', 'rejected'],
  sending: ['observed', 'unobserved', 'planned', 'approved'],
  // unobserved leaves only by the operator's word (settleSent or resolve reject, fsw approve; 7b9524e).
  unobserved: ['observed', 'rejected'],
  observed: [], blocked: [], rejected: [], stale: [],
};

export const baseName = (f) => String(f).split(/[\\/]/).pop();

// The file part of the key (003: platform:threadRef:kind:sha1(text|amount|files)): base names in order,
// and for a delivery its run stamp, so a revision round that ships files of the same names is a new item,
// not the first delivery again.
export function keyFiles(payload) {
  const files = (payload.files ?? []).map(baseName).sort();
  if (payload.runAt) files.push('run:' + payload.runAt);
  return files;
}

// Whether a row's payload still hashes to its key (003 key format); the drain checks it before a send, so a
// payload edited in the ledger after planning never leaves under the old key. A row imported from a 2c77326
// approval file was keyed by the import (src/core/approvals-import.mjs) on the file's final text and its files as
// stored; the planned text also counts, since an operator edit made in v0 moves only operator.finalText.
export function keyMatches(row) {
  const p = row.payload;
  if (!p.importedFrom) return outboxKey({ platform: row.platform, threadRef: p.threadRef, kind: row.kind, text: p.text, amountKRW: p.amountKRW, files: keyFiles(p) }) === row.key;
  return [row.operator?.finalText, p.text].some((text) => text != null && outboxKey({ platform: row.platform, threadRef: p.threadRef, kind: row.kind, text, amountKRW: p.amountKRW, files: p.files ?? [] }) === row.key);
}

export function plan(ledger, { platform, threadId, jobId = null, kind, payload }) {
  const thread = threadId != null ? ledger.getThread(threadId) : null;
  if (!thread) throw Object.assign(new Error('an outbox item needs a ledger thread, got ' + threadId), { code: 'FSW_OUTBOX_THREAD' });
  const body = { ...payload, threadRef: thread.externalId };
  const key = outboxKey({ platform, threadRef: thread.externalId, kind, text: body.text, amountKRW: body.amountKRW, files: keyFiles(body) });
  return transaction(ledger, () => {
    const found = ledger.outboxByKey(key);
    if (found) return { ...found, inserted: false };
    const row = ledger.addOutbox({ key, platform, threadId, jobId, kind, payload: body, status: 'planned' });
    ledger.addEvent({ kind: 'outbox.status', platform, ref: String(row.id), payload: { id: row.id, kind, from: null, to: 'planned', reason: null } });
    return { ...row, inserted: true };
  });
}

// One status change and the columns it sets, as a compare-and-set on from (updateOutbox with {from}):
// null when another step moved the row meanwhile (a second drain, an operator answer), and the caller
// leaves the row alone. A move outside TRANSITIONS is a programming error and throws.
export function setStatus(ledger, id, { from, to, reason, verdict, receipt, operator, approvalId }) {
  if (!TRANSITIONS[from]?.includes(to)) throw Object.assign(new Error('outbox row ' + id + ' cannot move from ' + from + ' to ' + to), { code: 'FSW_OUTBOX_STATE' });
  const patch = Object.fromEntries(Object.entries({ status: to, reason, verdict, receipt, operator, approvalId }).filter(([, v]) => v !== undefined));
  return transaction(ledger, () => {
    const row = ledger.updateOutbox(id, patch, { from });
    if (!row) return null;
    ledger.addEvent({ kind: 'outbox.status', platform: row.platform, ref: String(id), payload: { id, kind: row.kind, from, to, reason: reason ?? null } });
    return row;
  });
}
