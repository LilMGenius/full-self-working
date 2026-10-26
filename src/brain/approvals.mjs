// Operator approvals: one JSON file per item in operator/approvals/<id>.json plus an operator request.
// An item is open until resolved; the pipeline sends approved items and learning reads rejections.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { dayKey } from '../core/clock.mjs';
import { ensureDir } from '../core/instance.mjs';
import { notifyOperator } from '../core/notify.mjs';

const ID_RE = /^[0-9]{8}-[a-z0-9_]+-[0-9a-f]{8}$/;

function writeAtomic(path, value) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

const fileOf = (instance, id) => {
  if (!ID_RE.test(id)) throw new RangeError('not an approval id: ' + id);
  return join(instance.paths.approvals, id + '.json');
};

export async function queueApproval(instance, item) {
  if (!item?.platform || !item?.kind || !item?.reason) throw new TypeError('an approval needs platform, kind and reason');
  const dir = ensureDir(instance.paths.approvals);
  const id = dayKey() + '-' + item.platform + '-' + randomBytes(4).toString('hex');
  const record = { id, status: 'open', createdAt: new Date().toISOString(), ...item };
  writeAtomic(join(dir, id + '.json'), record);
  const lines = [
    'platform: ' + item.platform + (item.threadRef ? ', thread ' + item.threadRef : ''),
    'reason: ' + item.reason,
    ...(item.draft ? ['draft: ' + item.draft] : []),
    ...(item.violations?.length ? ['violations: ' + item.violations.map((v) => v.rule).join(', ')] : []),
    'resolve: fsw approve ' + id + ' [--text "..."] | fsw approve ' + id + ' --reject',
  ];
  // A quote deferred for the budget goes out on its own on a later day, so it asks nothing of the operator.
  const notified = item.deferredForBudget ? null : await notifyOperator(instance, { kind: 'approval', title: item.title ?? item.platform + ' ' + item.kind + ' needs approval', body: lines.join('\n'), dedupeKey: 'approval:' + id });
  return { ...record, notified };
}

export function getApproval(instance, id) {
  return JSON.parse(readFileSync(fileOf(instance, id), 'utf8'));
}

export function listApprovals(instance, { status } = {}) {
  if (!existsSync(instance.paths.approvals)) return [];
  return readdirSync(instance.paths.approvals)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(instance.paths.approvals, f), 'utf8')))
    .filter((a) => !status || a.status === status)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

// An open approval, or an approved one the pipeline has not sent yet, means the thread is waiting on
// the operator's item; asking the model again would cost a call and queue a duplicate.
// Order items (a 숨고페이 request, a delivery; src/orders/requests.mjs) do not hold the thread: the
// customer may write while one waits, and that message still needs its own answer.
export function openApprovalFor(instance, platform, threadRef) {
  return listApprovals(instance).find((a) => !a.orderItem && a.platform === platform && String(a.threadRef) === String(threadRef) && (a.status === 'open' || (a.status === 'approved' && !a.closedAt))) ?? null;
}

export function resolveApproval(instance, id, { approve, editedText, reason } = {}) {
  if (typeof approve !== 'boolean') throw new TypeError('resolveApproval needs approve true or false');
  const record = getApproval(instance, id);
  if (record.status !== 'open') throw new Error('approval ' + id + ' is already ' + record.status);
  const edited = typeof editedText === 'string' && editedText.trim() ? editedText.trim() : null;
  const next = {
    ...record,
    status: approve ? 'approved' : 'rejected',
    resolvedAt: new Date().toISOString(),
    finalText: approve ? edited ?? record.draft ?? null : null,
    edited: approve && edited !== null && edited !== record.draft,
    ...(reason ? { resolutionReason: reason } : {}),
  };
  writeAtomic(fileOf(instance, id), next);
  return next;
}

// Marks an approved item as sent or failed once the pipeline acted on it.
export function closeApproval(instance, id, patch) {
  const record = getApproval(instance, id);
  const next = { ...record, ...patch, closedAt: new Date().toISOString() };
  writeAtomic(fileOf(instance, id), next);
  return next;
}

// Records progress on an approved item that is not finished yet (a delivery waiting for its balance).
export function updateApproval(instance, id, patch) {
  const record = getApproval(instance, id);
  const next = { ...record, ...patch };
  writeAtomic(fileOf(instance, id), next);
  return next;
}
