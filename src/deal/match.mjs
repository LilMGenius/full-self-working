// Which job, quote and payment a deal signal belongs to, and the key it is recorded under once in money_events
// (src/deal/advance.mjs).
import { paymentKind } from './levels.mjs';
import { fresh, minuteKey } from './signals.mjs';

const newest = (jobs) => [...jobs].sort((a, b) => String(a.deliveredAt ?? a.startedAt ?? '').localeCompare(String(b.deliveredAt ?? b.startedAt ?? ''))).at(-1) ?? null;

// soomgo quotes on the request (its own thread) and talks in a chat whose row names the request; the
// quotes of a chat are its own plus its request's (src/orders/money.mjs:92-98).
export function quotesOf(ledger, platform, thread, requestId, status) {
  const own = ledger.listQuotes({ threadId: thread.id, status });
  const req = requestId ? ledger.listThreads({ platform }).find((t) => t.kind === 'request' && t.externalId === String(requestId)) : null;
  return req && req.id !== thread.id ? [...own, ...ledger.listQuotes({ threadId: req.id, status })].sort((a, b) => a.id - b.id) : own;
}

// The job of a thread: one opened on it, or the one opened on the request a soomgo chat names. The chat
// then becomes the job's thread, since the deposit, the files and the balance all go through it.
export function findJob(ledger, platform, thread, requestId) {
  const own = newest(ledger.listJobs({ platform }).filter((j) => j.threadId === thread.id));
  if (own || !requestId) return own;
  const req = ledger.listThreads({ platform }).find((t) => t.kind === 'request' && t.externalId === String(requestId));
  const job = req ? newest(ledger.listJobs({ platform }).filter((j) => j.threadId === req.id)) : null;
  if (!job) return null;
  return ledger.upsertJob({ id: job.id, threadId: thread.id, meta: { ...(job.meta ?? {}), requestThreadId: req.id } });
}

const linked = (ledger, jobId, event) => new Set(ledger.listMoneyEvents({ jobId, event }).map((e) => e.paymentId).filter(Boolean));

// Which payment a notice stands for or settles, or the payment row it writes (src/orders/money.mjs:137-164).
export function settleOrWrite(ledger, { platform, job, signal, key }) {
  const payments = ledger.jobPayments(job.id);
  const ev = signal.evidence ?? {};
  if (signal.type === 'paid' || signal.type === 'ordered') {
    const paidLinks = linked(ledger, job.id, signal.type);
    const match = payments.find((p) => !paidLinks.has(p.id) && p.amountKRW === signal.amountKRW);
    if (match) return { paymentId: match.id, note: 'matches payment ' + match.id + ' written from a later notice' };
  } else {
    const links = linked(ledger, job.id, signal.type);
    const open = payments.find((p) => !links.has(p.id));
    if (open) return { paymentId: open.id, note: signal.type + ' settles payment ' + open.id };
  }
  if (!(signal.amountKRW > 0)) return { paymentId: null, note: 'no amount readable in the notice; no payment row written' };
  const paid = payments.reduce((s, p) => s + p.amountKRW, 0);
  let priceKRW = job.priceKRW;
  if (!(priceKRW > 0)) {
    priceKRW = signal.amountKRW;
    ledger.upsertJob({ id: job.id, priceKRW });
  }
  const p = ledger.addPayment({ jobId: job.id, kind: paymentKind(priceKRW, paid, signal.amountKRW), amountKRW: signal.amountKRW, channel: platform, receivedAt: signal.at ?? undefined, evidence: { key, event: signal.type, text: ev.text ?? null, at: signal.at, source: ev.source ?? null } });
  return { paymentId: p.id, note: 'payment ' + p.id + ' (' + p.kind + ') written', written: p };
}

export function moneyKey(ledger, signal, thread, live) {
  // Parsed evidence (an order row, a review row) names its own key; a notice is keyed by its minute.
  if (typeof signal.evidence?.key === 'string' && signal.evidence.key) return signal.evidence.key + (live ? '' : ':history');
  const base = signal.platform + ':' + thread.externalId + ':';
  // A client leaves one review per job, so the operator's hand entry of it is keyed by the job: entered
  // again a minute later it is the same review (a correction, see correctReview), never a second one.
  if (signal.type === 'review' && signal.evidence?.source === 'operator' && signal.jobId) return base + 'review:operator:' + signal.jobId;
  if (signal.type === 'hired') return base + 'hired#' + ledger.listMoneyEvents({ threadId: thread.id, event: 'hire_cancelled' }).length + (live ? '' : ':history');
  if (signal.type === 'hire_cancelled') return base + 'hire_cancelled#' + ledger.listMoneyEvents({ threadId: thread.id, event: 'hired' }).length;
  return base + signal.type + ':' + (minuteKey(signal.at) ?? 'undated');
}

export function isLive(ledger, signal, thread, now) {
  const ev = signal.evidence ?? {};
  if (ev.source === 'row-status' && signal.type === 'hired') return quotesOf(ledger, signal.platform, thread, ev.requestId, 'sent').length > 0 || ev.freshHireInBatch === true;
  return fresh(signal.at, now);
}
