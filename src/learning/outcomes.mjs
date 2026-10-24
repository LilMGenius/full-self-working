// Outcome cases: what happened to a lead, job or draft, appended to lessons/cases.jsonl. Lessons are
// written from these cases later (lessons.mjs); a case is evidence and is never rewritten.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureDir } from '../core/instance.mjs';
import { logEvent } from '../core/log.mjs';

export const CASE_KINDS = ['job_closed', 'lead_lost', 'review', 'revision_request', 'operator_correction', 'approval_rejected'];

export const casesFile = (instance) => join(instance.paths.lessons, 'cases.jsonl');

export function readCases(instance) {
  const file = casesFile(instance);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// text is the evidence a lesson and its regex are judged against: the customer message, the review,
// the rejected draft or the operator's edit. A case without it cannot teach anything checkable.
export function recordOutcome(instance, ledger, c) {
  if (!CASE_KINDS.includes(c?.kind)) throw new RangeError('case kind must be one of ' + CASE_KINDS.join(', ') + ', got ' + c?.kind);
  if (typeof c.text !== 'string' || !c.text.trim()) throw new TypeError('a case needs the text it is about');
  if (c.kind === 'operator_correction' && (typeof c.before !== 'string' || typeof c.after !== 'string')) throw new TypeError('an operator correction needs before and after');
  ensureDir(instance.paths.lessons);
  const record = {
    id: new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + randomBytes(4).toString('hex'),
    at: new Date().toISOString(),
    kind: c.kind,
    platform: c.platform ?? null,
    service: c.service ?? null,
    threadRef: c.threadRef ?? null,
    jobId: c.jobId ?? null,
    text: c.text.trim(),
    ...(c.before !== undefined ? { before: c.before } : {}),
    ...(c.after !== undefined ? { after: c.after } : {}),
    ...(c.rating !== undefined ? { rating: c.rating } : {}),
    ...(c.note ? { note: c.note } : {}),
  };
  appendFileSync(casesFile(instance), JSON.stringify(record) + '\n');
  ledger?.addEvent({ kind: 'learning.case', platform: record.platform, ref: record.id, payload: { kind: record.kind, service: record.service } });
  logEvent(instance, 'learning.case', { id: record.id, caseKind: record.kind, platform: record.platform });
  return record;
}

// A rejected approval is a case by itself: the draft the operator refused is what the next decision
// must not repeat; an approved edit is an operator correction.
export function caseFromApproval(approval) {
  if (approval.status === 'rejected') {
    return { kind: 'approval_rejected', platform: approval.platform, service: approval.service ?? null, threadRef: approval.threadRef, text: approval.draft ?? '', note: approval.resolutionReason ?? approval.reason };
  }
  if (approval.status === 'approved' && approval.edited) {
    return { kind: 'operator_correction', platform: approval.platform, service: approval.service ?? null, threadRef: approval.threadRef, text: approval.draft ?? '', before: approval.draft ?? '', after: approval.finalText ?? '' };
  }
  return null;
}
