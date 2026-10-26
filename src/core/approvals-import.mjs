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

const receiptOf = (status) => (status === 'observed' ? { observed: true, reason: 'sent by the d605c5d pipeline' } : status === 'unobserved' ? { observed: false, reason: 'unobserved by the d605c5d pipeline' } : null);

// An old approval whose send was not observed: status unobserved, or open with unobserved true (the queue
// path of src/pipeline/thread.mjs at 7b9524e). Approving it again could send it twice, so it imports as
// unobserved, and a press the adapter recorded (pressed {at, costKRW}) stays on the receipt for quotaUsage.
const statusOf = (a) => (a.status === 'open' && a.unobserved === true ? 'unobserved' : STATUS_OF[a.status]);
const pressOf = (a) => (a.pressed ? { pressed: true, pressedAt: a.pressed.at ?? null, costKRW: a.pressed.costKRW ?? null } : {});

function threadIdFor(ledger, a) {
  if (Number.isInteger(a.threadId) && ledger.getThread(a.threadId)) return a.threadId;
  if (a.threadRef == null) return null;
  return ledger.db.prepare('SELECT id FROM threads WHERE platform = ? AND external_id = ?').get(a.platform, String(a.threadRef))?.id ?? null;
}

export function rowFromApproval(ledger, a) {
  const kind = KIND_OF[a.kind];
  if (!kind) return { skip: 'kind ' + a.kind + ' has no outbox kind' };
  const status = statusOf(a);
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
      threadId: threadIdFor(ledger, a),
      jobId: a.jobId && ledger.getJob(a.jobId) ? a.jobId : null,
      kind,
      payload: { text: a.draft ?? null, amountKRW, split: a.quote?.split ?? null, scope: a.quote?.scope ?? null, deliveryDays: a.quote?.deliveryDays ?? null, files, costKRW: a.costKRW ?? null, threadRef: String(a.threadRef), importedFrom: 'operator/approvals/' + a.id + '.json' },
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
      if (have) {
        // An open file the old code could not observe (unobserved: true) is final for this rule too.
        const fileStatus = a.status === 'open' && a.unobserved === true ? 'unobserved' : a.status;
        const to = STATUS_OF[fileStatus];
        if (FINAL_FILE.includes(fileStatus) && OPEN_ROW.includes(have.status)) {
          const reason = 'approval file ' + fileStatus + ' under the d605c5d code';
          const moved = ledger.updateOutbox(have.id, { status: to, reason, receipt: receiptOf(to) ? { ...receiptOf(to), ...pressOf(a) } : have.receipt, updatedAt: a.closedAt ?? a.resolvedAt ?? undefined }, { from: have.status });
          if (moved) {
            ledger.addEvent({ kind: 'outbox.status', platform: have.platform, ref: String(have.id), payload: { id: have.id, kind: have.kind, from: have.status, to, reason } });
            out.reconciled += 1;
            continue;
          }
        }
        out.already += 1;
        continue;
      }
      const mapped = rowFromApproval(ledger, a);
      if (mapped.skip) {
        skip(file, mapped.skip);
        continue;
      }
      const same = ledger.outboxByKey(mapped.row.key);
      if (same) {
        skip(file, 'same key as outbox row ' + same.id);
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
