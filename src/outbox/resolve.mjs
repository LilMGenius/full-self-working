// resolve(ledger, approvalId, {approve, editedText, reason}) -> row: the operator's answer to one
// awaiting item (fsw approve). An edit stays on the same row as operator.finalText with operator.edited
// true (003 Outbox), and drain authorizes and sends that text, as flushApprovals did
// (src/pipeline/thread.mjs:215-224). Replaces resolveApproval (src/brain/approvals.mjs:61-76 at 2c77326).
// A reject also closes a send the surface could not observe and the operator found not sent, and an
// approved row the drain has not claimed (an approved cash quote no day can pay); settleSent closes one
// the operator saw go out (fsw approve <id> --sent, settleSent of src/cli/approvals.mjs at 7b9524e).
import { filesHash, reviewDrift } from '../core/reviewed.mjs';
import { transaction } from '../core/tx.mjs';
import { setStatus } from './plan.mjs';

const ID_RE = /^[0-9]{8}-[a-z0-9_]+-[0-9a-f]{8}$/; // src/brain/approvals.mjs:10

export function resolve(ledger, approvalId, { approve, editedText, reason } = {}) {
  if (!ID_RE.test(String(approvalId))) throw new RangeError('not an approval id: ' + approvalId);
  if (typeof approve !== 'boolean') throw new TypeError('resolve needs approve true or false');
  const row = ledger.outboxByApproval(approvalId);
  if (!row) throw Object.assign(new Error('no outbox item has approval id ' + approvalId), { code: 'FSW_OUTBOX_NO_APPROVAL' });
  const resolved = () => Object.assign(new Error('approval ' + approvalId + ' is already ' + ledger.getOutbox(row.id).status), { code: 'FSW_OUTBOX_RESOLVED' });
  const from = row.status;
  if (from !== 'awaiting_operator' && !(['unobserved', 'approved'].includes(from) && approve === false)) throw resolved();
  // wp7: a delivery is approved only after a passed review of the bytes it holds now (src/work/review.mjs,
  // src/core/reviewed.mjs), or with the operator's stated reason; the approval stamps the hash of its files, which
  // the drain checks before it sends. A file the review never read (one an operator step added after the run) is
  // unreviewed bytes the stamp would cover, so it needs the stated reason as a changed file does.
  const delivery = row.kind === 'delivery';
  const review = delivery ? row.payload.review?.verdict ?? 'error' : null;
  const stated = Boolean((reason ?? '').trim());
  if (approve && delivery && review !== 'pass' && !stated) throw Object.assign(new Error('delivery ' + approvalId + ' has review ' + review + '; approving it needs --reason'), { code: 'FSW_REVIEW_NOT_PASSED' });
  if (approve && delivery && review === 'pass' && !stated) {
    const drift = reviewDrift(row.payload.review, row.payload.files ?? []);
    if (drift.changed) throw Object.assign(new Error('delivery ' + approvalId + ' changed since its review; approving it needs --reason'), { code: 'FSW_REVIEW_CHANGED' });
    if (drift.unreviewed.length) throw Object.assign(new Error('delivery ' + approvalId + ' holds files its review never read: ' + drift.unreviewed.join(', ') + '; approving it needs --reason'), { code: 'FSW_REVIEW_UNREVIEWED' });
  }
  const edited = typeof editedText === 'string' && editedText.trim() ? editedText.trim() : null;
  const draft = row.payload.text ?? null;
  const operator = { resolvedAt: new Date().toISOString(), finalText: approve ? edited ?? draft : null, edited: approve && edited !== null && edited !== draft, resolutionReason: reason ?? null, ...(approve && delivery ? { filesHash: filesHash(row.payload.files ?? []) } : {}) };
  const done = setStatus(ledger, row.id, { from, to: approve ? 'approved' : 'rejected', operator });
  if (!done) throw resolved();
  return done;
}

// settleSent(ledger, approvalId, {costKRW, now}) -> {row, receipt}: the operator saw on the platform that a
// send the surface could not observe went out. The row moves unobserved -> observed with a receipt marked
// confirmedBy operator and the outbound message is written in the same transaction, as an observed send
// records it; the caller applies signalOf(row, receipt, now) through the deal, which writes the quote row
// with the cash the press cost. The cost is --cost, else the press the surface recorded, else the planned
// cost (settleSent at 7b9524e); a proposal keeps it as the bids it spent, which bidUsage counts.
export function settleSent(ledger, approvalId, { costKRW = null, now = new Date() } = {}) {
  if (!ID_RE.test(String(approvalId))) throw new RangeError('not an approval id: ' + approvalId);
  if (costKRW != null && !(Number.isInteger(costKRW) && costKRW >= 0)) throw new RangeError('--cost needs a whole KRW amount, got ' + costKRW);
  const row = ledger.outboxByApproval(approvalId);
  if (!row) throw Object.assign(new Error('no outbox item has approval id ' + approvalId), { code: 'FSW_OUTBOX_NO_APPROVAL' });
  if (row.status !== 'unobserved') throw Object.assign(new Error(approvalId + ' is ' + row.status + '; --sent settles only a send the surface could not observe'), { code: 'FSW_OUTBOX_RESOLVED' });
  const cost = costKRW ?? row.receipt?.costKRW ?? row.payload.costKRW ?? null;
  const receipt = { ...(row.receipt ?? {}), observed: true, confirmedBy: 'operator', confirmedAt: now.toISOString(), ...(row.kind === 'quote' || row.kind === 'proposal' ? { cashSpentKRW: cost } : {}) };
  const done = transaction(ledger, () => {
    const moved = setStatus(ledger, row.id, { from: 'unobserved', to: 'observed', receipt, reason: 'the operator confirmed the send' });
    if (moved && row.kind !== 'pay_request') ledger.addMessage({ threadId: row.threadId, direction: 'out', body: row.operator?.finalText ?? row.payload.text ?? '', externalId: null, attachments: [], gate: row.verdict ?? null });
    return moved;
  });
  if (!done) throw Object.assign(new Error('approval ' + approvalId + ' is already ' + ledger.getOutbox(row.id).status), { code: 'FSW_OUTBOX_RESOLVED' });
  return { row: done, receipt };
}

// The approval-shaped view caseFromApproval (src/learning/outcomes.mjs) reads, so the learning case rule
// stays verbatim.
export const approvalView = (row) => ({
  status: row.status, platform: row.platform, service: row.payload.service ?? null, threadRef: row.payload.threadRef ?? null,
  draft: row.payload.text ?? '', reason: row.reason, resolutionReason: row.operator?.resolutionReason ?? null,
  edited: row.operator?.edited === true, finalText: row.operator?.finalText ?? null,
});
