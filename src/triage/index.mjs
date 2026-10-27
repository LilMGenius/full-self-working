// triage(inbound, ledgerRow, ctx) -> {action, reason}: what one listed item gets this tick, decided from
// its list row and the ledger alone, so nothing is opened to decide it (architect D8). Rules carried
// from src/supervisor/run.mjs:173-182 (needsWork), src/pipeline/thread.mjs:45-54 (reply window),
// :128-152 (pending approval, notices, catalog, observe) and src/brain/approvals.mjs:53-59 (the hold,
// now an outbox query) at 2c77326; the answered-services park from src/pipeline/thread.mjs:145-152 at
// 14d2f17, the retry of a failed pass from src/supervisor/run.mjs:174-190 at f600545, and the park key
// of 22fbb4b (src/supervisor/run.mjs:180-183 there; parkKey itself is src/economics/catalog.mjs).
import { catalogServicesFor } from '../economics/catalog.mjs';
import { isSystemNotice } from '../core/notices.mjs';

// Outbox rows that hold a conversation: a reply or quote still in play. Payment requests and deliveries
// do not hold it, since the customer may write while one waits (src/brain/approvals.mjs:55-56).
// An unobserved row may already have gone out, so it holds its thread until the operator settles it.
export const HOLDING_KINDS = ['message', 'quote'];
export const HOLDING_STATUSES = ['planned', 'awaiting_operator', 'approved', 'sending', 'unobserved'];

// The ledger event each park reason is counted under; the digest and the supply report read these kinds.
const PARK_EVENTS = [['notice:', 'thread.system'], ['expired', 'thread.skipped'], ['stale:', 'thread.skipped'], ['catalog:', 'thread.operator']];
export const parkEvent = (reason) => PARK_EVENTS.find(([prefix]) => String(reason).startsWith(prefix))?.[1] ?? 'thread.skipped';

// The outbound kind that answers a buyer request: a proposal on a bidding board, a quote elsewhere
// (registry MODELS).
export const answerKind = (descriptor) => ([descriptor?.model].flat().includes('bidding') ? 'proposal' : 'quote');

// A thread whose pass threw (a rejected model decision, a page that did not load) was already read, so
// its list row no longer looks new; it gets this many passes in all before it is left to the operator.
export const THREAD_ATTEMPTS = 3;

// New to the ledger, unread, newer than what the ledger holds, or failed with passes left and nothing
// sent since. An item parked at the list time it still shows waits for a newer message, while the settings
// it was parked under (key, parkKey of src/economics/catalog.mjs) hold; a park without a key is checked once.
// An item a pass already read at the list time it still shows (meta.settled, e5d20eb) waits the same way,
// except that a read in observe mode holds only while the tick observes, so the first tick inside the
// outbound hours still decides.
export function needsWork(inbound, row, key, mode = 'auto') {
  if (!row) return true;
  // A list row may carry a revision (inbound.rev) when its time cannot move on an edit, such as a board that
  // shows only the posted day; a park or read recorded under another revision is not the same item.
  const rev = inbound.rev ?? null;
  const same = (rec) => rec.at === (inbound.at ?? null) && (rec.rev ?? null) === rev;
  const skipped = row.meta?.skipped;
  if (skipped && same(skipped)) {
    if (skipped.key === key) return false;
    // A paid quote the value gate dropped (reason "gate: ...") was read and decided, so its list row shows
    // nothing new; a moved setting is the only thing that can change its verdict, and it is judged again.
    if (String(skipped.reason).startsWith('gate: ')) return true;
  }
  if (inbound.unread) return true;
  const failed = row.meta?.failed;
  if (failed && failed.count < THREAD_ATTEMPTS && !(Date.parse(row.lastOutboundAt ?? 0) > Date.parse(failed.at))) return true;
  if (!inbound.at) return false;
  const settled = row.meta?.settled;
  if (settled && same(settled) && settled.key === key && (settled.by !== 'observe' || mode === 'observe')) return false;
  const last = settled ?? skipped;
  if (rev !== null && last && (last.rev ?? null) !== rev) return true;
  const seen = Math.max(Date.parse(row.lastInboundAt ?? 0) || 0, Date.parse(row.lastOutboundAt ?? 0) || 0);
  return Date.parse(inbound.at) > seen;
}

// Why a listed item gets no answer: the platform closed the request, or its newest message is older than
// the reply window, where an answer reads as a bot waking up.
export function skipReason(inbound, now, settings) {
  if (inbound.kind === 'request' && (inbound.quotable === false || (inbound.expiresAt && Date.parse(inbound.expiresAt) <= now.getTime()))) return 'expired';
  if (!inbound.at) return null;
  const windowHours = settings.replyWindowHours[inbound.kind === 'request' ? 'request' : 'message'];
  const ageHours = (now.getTime() - Date.parse(inbound.at)) / 3_600_000;
  return ageHours > windowHours ? 'stale: newest message is ' + Math.round(ageHours) + ' hours old, window ' + windowHours : null;
}

// A request that already holds the most quotes its platform takes (descriptor bidCost.maxPerRequest; soomgo
// refused an eleventh with a notice and no charge on 2026-10-26) can take no quote from us, so it parks as
// expired, read from the list row or, after a read, from the request page.
export function fullReason(item, descriptor) {
  const max = descriptor?.bidCost?.maxPerRequest;
  if (item.kind !== 'request' || !Number.isInteger(max) || !Number.isInteger(item.quoteCount) || item.quoteCount < max) return null;
  return 'expired: the request already has ' + item.quoteCount + ' quotes and ' + descriptor.id + ' takes ' + max;
}

export function triage(inbound, ledgerRow, { mode, now, settings, descriptor, openOutbox = [], parkKey = null }) {
  if (!needsWork(inbound, ledgerRow, parkKey, mode)) return { action: 'wait', reason: 'unchanged' };
  const holding = openOutbox.find((r) => HOLDING_KINDS.includes(r.kind) && HOLDING_STATUSES.includes(r.status));
  if (holding) return { action: 'wait', reason: 'outbox item ' + holding.id + ' is ' + holding.status };
  const unread = inbound.unread !== false;
  if (unread && inbound.preview && isSystemNotice({ text: inbound.preview })) return { action: 'park', reason: 'notice: ' + inbound.preview };
  // A request whose answering form the platform lists unmapped (descriptor forms) could never be answered, so
  // it is only observed: recorded and counted, with no model call (wp8).
  if (inbound.kind === 'request' && descriptor?.forms?.[answerKind(descriptor)]?.mapped === false) return { action: 'observe', reason: 'form unmapped' };
  if (mode !== 'observe') {
    const skip = skipReason(inbound, now, settings);
    if (skip) return { action: 'park', reason: skip };
    const full = fullReason(inbound, descriptor);
    if (full) return { action: 'park', reason: full };
    const labelled = catalogServicesFor(descriptor, inbound.service);
    if (labelled?.length === 0) return { action: 'park', reason: 'catalog: service ' + inbound.service + ' is not in the catalog' };
    // A labelled item in a service this instance does not answer on the platform (config
    // platforms.<id>.services, which the loop passes as settings.answered; lessons by default) is the
    // operator's own business: it stays unread and costs no model call.
    if (labelled && !labelled.some((id) => settings.answered.includes(id))) return { action: 'park', reason: 'catalog: service ' + inbound.service + ' is ' + labelled.join(', ') + ', which config platforms.' + descriptor.id + '.services does not answer' };
    return { action: 'open', reason: 'new inbound' + (inbound.service ? ' in ' + inbound.service : '') };
  }
  return { action: 'observe', reason: unread ? 'observe mode leaves an unread item unread' : 'observe mode reads without replying' };
}

// awaiting_reply (003 Triage): the newest message is inbound, nothing observed outbound after it (the
// ledger holds an outbound message only once the outbox observed it), and it is inside the reply window.
export function awaitingReply(row, messages, { now, settings }) {
  const last = messages.at(-1);
  if (!last || last.direction !== 'in') return false;
  const windowHours = settings.replyWindowHours[row.kind === 'request' ? 'request' : 'message'];
  return (now.getTime() - Date.parse(last.at)) / 3_600_000 <= windowHours;
}
