// One-time import of the 2c77326 operator approvals (operator/approvals/<id>.json) into the outbox,
// keyed by approval_id so a second run imports nothing. The files stay where they are: a rollback to the
// old code still reads them, and nothing here writes to that directory.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { outboxKey } from './ledger.mjs';

// The id format of src/brain/approvals.mjs:10 at 2c77326, kept as the outbox approval_id.
export const APPROVAL_ID = /^[0-9]{8}-[a-z0-9_]+-[0-9a-f]{8}$/;

// Old approval kinds and statuses mapped onto the outbox contract (003). A kind or status with no
// counterpart is reported by name and left in its file, never forced into a row.
export const KIND_OF = { message: 'message', quote: 'quote', pay_request: 'pay_request', delivery: 'delivery', project_proposal: 'proposal' };
export const STATUS_OF = { open: 'awaiting_operator', approved: 'approved', rejected: 'rejected', dropped: 'rejected', sent: 'observed', expired: 'stale', blocked: 'blocked', unobserved: 'unobserved' };

// A file in one of these statuses records that the 2c77326 code sent or closed the item; a v0 row still
// open under it follows the file at the next import, so a forward move after a rollback never sends it again.
export const FINAL_FILE = ['sent', 'rejected', 'dropped', 'expired', 'blocked', 'unobserved'];
export const OPEN_ROW = ['planned', 'awaiting_operator', 'approved'];
// Of two files holding the same item (one outbox key), a later file that sent it, or may have, closes the
// older file's row too; a later rejection of a duplicate leaves the other one open, as the old code did.
export const SENT_FILE = ['sent', 'unobserved'];
// A row v0 was sending may already have gone out, so a final file moves it too: a sent file closes it as
// observed, and any other final file leaves it unobserved for the operator, never closed or sent again.
const FOLLOWS = [...OPEN_ROW, 'sending'];
const followed = (fileStatus, rowStatus) => (rowStatus === 'sending' ? (fileStatus === 'sent' ? 'observed' : 'unobserved') : STATUS_OF[fileStatus]);

// pipeline names the code that sent it: the deal sweep never applies again a send the old code recorded.
const receiptOf = (status) => (status === 'observed' ? { observed: true, reason: 'sent by the d605c5d pipeline', pipeline: 'd605c5d' } : status === 'unobserved' ? { observed: false, reason: 'unobserved by the d605c5d pipeline', pipeline: 'd605c5d' } : null);

// An old approval whose send was not observed: status unobserved, or open with unobserved true (the queue
// path of src/pipeline/thread.mjs at 7b9524e). Approving it again could send it twice, so it imports as
// unobserved, and a press the adapter recorded (pressed {at, costKRW}) stays on the receipt for quotaUsage.
const fileStatusOf = (a) => (a.status === 'open' && a.unobserved === true ? 'unobserved' : a.status);
const statusOf = (a) => STATUS_OF[fileStatusOf(a)];
const pressOf = (a) => (a.pressed ? { pressed: true, pressedAt: a.pressed.at ?? null, costKRW: a.pressed.costKRW ?? null } : {});

// A quote the 2c77326 pipeline refused at send time only because the Seoul day's cash caps were spent
// (isDeferredForBudget, src/pipeline/thread.mjs:102 on main: open, no orderItem, and deferredForBudget set or
// a reason starting "cash quote refused: daily "). The old code sent it in auto mode, oldest first, once a
// later day's budget paid for it, and left it to the operator only when its service was no longer answered
// or no day could pay it (thread.mjs:270-300). It imports as a planned quote, so the drain holds it under
// budget.cash and sends it when the caps allow, exactly like a row v0 deferred (b223ed7); authorize sends
// the other two cases to the operator (decision.answered, budget.unpayable).
export const deferredForBudget = (a) => a.status === 'open' && a.unobserved !== true && !a.orderItem && a.kind === 'quote' && (a.deferredForBudget != null || /^cash quote refused: daily /.test(a.reason ?? ''));

// What the drain and authorize read on a planned quote, rebuilt from the old file: the request thread its
// cash is charged for, the price row the gate checks the amount against, and the decision authorize judges.
// The old decision kept only its service and intent; it had already passed the confidence and operator rules
// when it was deferred.
function deferredPayload(ledger, a, threadId) {
  const threadKind = a.threadKind ?? 'message';
  return {
    priceType: a.quote?.priceType ?? 'fixed',
    service: a.service ?? null,
    priceRow: a.priceRow ?? null,
    serviceLabel: null,
    requestId: threadKind === 'request' ? String(a.threadRef) : null,
    customer: ledger.getThread(threadId)?.customer ?? null,
    thread: { ...(a.item?.thread ?? {}), kind: threadKind, stage: a.item?.thread?.stage ?? 'pre_order' },
    decision: { intent: a.intent ?? 'quote_request', service: a.service ?? null, quote: a.quote ?? null, reply: a.draft ?? null, needsOperator: false, operatorReason: null },
  };
}

function threadIdFor(ledger, a) {
  if (Number.isInteger(a.threadId) && ledger.getThread(a.threadId)) return a.threadId;
  if (a.threadRef == null) return null;
  return ledger.db.prepare('SELECT id FROM threads WHERE platform = ? AND external_id = ?').get(a.platform, String(a.threadRef))?.id ?? null;
}

// What planProposal (src/projects/job.mjs) writes on a proposal row, rebuilt from a 2c77326
// project_proposal file (queueProposal at a8ae31c kept project, proposal, critic, violations and service on
// the file and the operator summary as its reason), so syncProposals, expireProposals and the drain read an
// imported proposal as they read their own.
function proposalPayload(a) {
  const summary = a.reason ?? null;
  return {
    service: a.service ?? null,
    summary,
    thread: { kind: 'project', stage: 'pre_order' },
    decision: { intent: 'quote_request', service: a.service ?? null, language: 'ko', reply: a.draft ?? null, quote: null, needsOperator: true, operatorReason: summary, confidence: 1, claimsUsed: [] },
    project: a.project ?? null,
    proposal: a.proposal ?? null,
    critic: a.critic ?? null,
    violations: a.violations ?? [],
  };
}

export function rowFromApproval(ledger, a) {
  const kind = KIND_OF[a.kind];
  if (!kind) return { skip: 'kind ' + a.kind + ' has no outbox kind' };
  const threadId = threadIdFor(ledger, a);
  // A deferred quote whose thread the ledger lacks has nothing to send to, so it keeps the operator's mapping.
  const deferred = deferredForBudget(a) && threadId != null;
  const status = deferred ? 'planned' : statusOf(a);
  if (!status) return { skip: 'status ' + a.status + ' has no outbox status' };
  if (!a.platform || a.threadRef == null) return { skip: 'no platform or threadRef' };
  const text = a.finalText ?? a.draft ?? null;
  const files = a.files ?? [];
  const amountKRW = a.quote?.amountKRW ?? a.amountKRW ?? null;
  const resolved = a.resolvedAt ? { resolvedAt: a.resolvedAt, finalText: a.finalText ?? null, edited: a.edited === true, resolutionReason: a.resolutionReason ?? null } : null;
  return {
    row: {
      key: outboxKey({ platform: a.platform, threadRef: String(a.threadRef), kind, text, amountKRW, files }),
      platform: a.platform,
      threadId,
      jobId: a.jobId && ledger.getJob(a.jobId) ? a.jobId : null,
      kind,
      payload: { text: a.draft ?? null, amountKRW, split: a.quote?.split ?? null, scope: a.quote?.scope ?? null, deliveryDays: a.quote?.deliveryDays ?? null, files, costKRW: a.costKRW ?? a.deferredForBudget?.costKRW ?? null, threadRef: String(a.threadRef), importedFrom: 'operator/approvals/' + a.id + '.json', ...(deferred ? deferredPayload(ledger, a, threadId) : {}), ...(kind === 'proposal' ? proposalPayload(a) : {}) },
      verdict: null,
      status,
      reason: a.reason ?? null,
      approvalId: a.id,
      operator: resolved,
      receipt: receiptOf(status) ? { ...receiptOf(status), ...pressOf(a) } : null,
      createdAt: a.createdAt ?? new Date().toISOString(),
      updatedAt: a.closedAt ?? a.resolvedAt ?? a.createdAt ?? new Date().toISOString(),
    },
  };
}

// Moves an imported row to the status its file's final state implies, as a compare-and-set with one
// outbox.status event; false when the row moved since it was read.
function follow(ledger, row, a, fileStatus, reason) {
  const to = followed(fileStatus, row.status);
  const moved = ledger.updateOutbox(row.id, { status: to, reason, receipt: receiptOf(to) ? { ...receiptOf(to), ...pressOf(a) } : row.receipt, updatedAt: a.closedAt ?? a.resolvedAt ?? undefined }, { from: row.status });
  if (moved) ledger.addEvent({ kind: 'outbox.status', platform: row.platform, ref: String(row.id), payload: { id: row.id, kind: row.kind, from: row.status, to, reason } });
  return Boolean(moved);
}

// Returns {read, imported, already, reconciled, skipped: [{file, reason}]}. Approvals go in the order the old store
// listed them (createdAt, then id; src/brain/approvals.mjs:50), so of two files holding the same item the
// older one owns the row. One transaction for the whole directory.
export function importApprovals(ledger, approvalsDir) {
  const out = { read: 0, imported: 0, already: 0, reconciled: 0, skipped: [] };
  if (!existsSync(approvalsDir)) return out;
  const skip = (file, reason) => out.skipped.push({ file, reason });
  const found = [];
  for (const file of readdirSync(approvalsDir).filter((f) => f.endsWith('.json')).sort()) {
    out.read += 1;
    const id = file.slice(0, -5);
    if (!APPROVAL_ID.test(id)) {
      skip(file, 'not an approval id');
      continue;
    }
    let a;
    try {
      a = JSON.parse(readFileSync(join(approvalsDir, file), 'utf8'));
    } catch (err) {
      skip(file, 'unreadable: ' + err.message);
      continue;
    }
    if (a.id !== id) {
      skip(file, 'id ' + a.id + ' differs from the file name');
      continue;
    }
    found.push({ file, a });
  }
  found.sort((x, y) => String(x.a.createdAt ?? '').localeCompare(String(y.a.createdAt ?? '')) || x.a.id.localeCompare(y.a.id));
  ledger.db.exec('BEGIN');
  try {
    for (const { file, a } of found) {
      const have = ledger.outboxByApproval(a.id);
      // An open file the old code could not observe (unobserved: true) is final for these rules too.
      const fileStatus = fileStatusOf(a);
      if (have) {
        if (FINAL_FILE.includes(fileStatus) && FOLLOWS.includes(have.status) && follow(ledger, have, a, fileStatus, 'approval file ' + fileStatus + ' under the d605c5d code')) out.reconciled += 1;
        else out.already += 1;
        continue;
      }
      const mapped = rowFromApproval(ledger, a);
      if (mapped.skip) {
        skip(file, mapped.skip);
        continue;
      }
      const same = ledger.outboxByKey(mapped.row.key);
      if (same) {
        if (SENT_FILE.includes(fileStatus) && FOLLOWS.includes(same.status) && follow(ledger, same, a, fileStatus, 'approval file ' + a.id + ' holding the same item ' + fileStatus + ' under the d605c5d code')) out.reconciled += 1;
        else skip(file, 'same key as outbox row ' + same.id);
        continue;
      }
      ledger.addOutbox(mapped.row);
      out.imported += 1;
    }
    ledger.db.exec('COMMIT');
  } catch (err) {
    ledger.db.exec('ROLLBACK');
    throw err;
  }
  return out;
}
