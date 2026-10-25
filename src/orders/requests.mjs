// Payment requests and the operator items that carry them. On a platform that splits payments in the
// chat (soomgo, descriptor milestones multi_pay), fsw asks for each part through the platform's own
// request (숨고페이 요청) with the splitPayment amount. Every request is an operator approval: no real
// request has been watched going out yet, so none is sent on fsw's own authority.
// On kmong the customer's order is the payment, held in escrow; a large job is split into phase orders
// (playbooks/kmong.md) that the customer places, so fsw has no request to send there.
import { closeApproval, listApprovals, queueApproval } from '../brain/approvals.mjs';
import { splitPayment } from '../economics/pricing.mjs';
import { notifyOperator } from '../core/notify.mjs';

export const ORDER_KINDS = ['pay_request', 'delivery'];

const paidOf = (payments) => payments.reduce((s, p) => s + p.amountKRW, 0);

// The part the customer pays next: the first splitPayment part not yet covered by what was received,
// for the amount still missing up to its end, or with rest everything still unpaid (the balance asked
// for at delivery). null when nothing is due or the platform has no split request.
export function nextPart(job, payments, config, descriptor, { rest = false } = {}) {
  if (descriptor.milestones !== 'multi_pay' || !(job.priceKRW > 0)) return null;
  const paid = paidOf(payments);
  if (paid >= job.priceKRW) return null;
  if (rest) return { index: null, of: null, label: paid > 0 ? 'Balance' : 'Full amount', amountKRW: job.priceKRW - paid, last: true };
  const parts = splitPayment(job.priceKRW, config, descriptor).parts;
  let end = 0;
  for (let i = 0; i < parts.length; i++) {
    end += parts[i].amountKRW;
    if (end > paid) return { index: i, of: parts.length, label: parts[i].label_en, amountKRW: end - paid, last: i === parts.length - 1 };
  }
  return null;
}

// An order item for this job and kind that is still in play: open, or approved and not closed.
export const pendingOrderItem = (instance, jobId, kind) =>
  listApprovals(instance).find((a) => a.orderItem && a.jobId === jobId && a.kind === kind && (a.status === 'open' || (a.status === 'approved' && !a.closedAt))) ?? null;

export async function queuePayRequest({ instance, ledger, descriptor, job, why, rest = false, title = null }) {
  if (job.meta?.manual) return { queued: false, reason: job.meta.manual };
  const part = nextPart(job, ledger.jobPayments(job.id), instance.config, descriptor, { rest });
  if (!part) return { queued: false, reason: job.priceKRW > 0 ? 'nothing is due or the platform has no split request' : 'the job has no agreed total price' };
  if (pendingOrderItem(instance, job.id, 'pay_request')) return { queued: false, reason: 'a payment request for this job is already waiting' };
  const thread = ledger.getThread(job.threadId);
  const paidBeforeKRW = paidOf(ledger.jobPayments(job.id));
  const approval = await queueApproval(instance, {
    orderItem: true, platform: job.platform, kind: 'pay_request', threadRef: thread.externalId, threadId: thread.id, jobId: job.id,
    amountKRW: part.amountKRW, rest, paidBeforeKRW, part: part.label + (part.of ? ' (' + (part.index + 1) + ' of ' + part.of + ')' : ''),
    reason: why + ': request ' + part.label + ' of ' + part.amountKRW + ' KRW through ' + descriptor.name + ' for job ' + job.id + ' (total ' + job.priceKRW + ' KRW)',
    draft: descriptor.name + ' payment request: ' + part.amountKRW + ' KRW, ' + part.label,
    title: title ?? job.platform + ' payment request ' + part.amountKRW + ' KRW for job ' + job.id,
  });
  ledger.addEvent({ kind: 'order.pay_request_queued', platform: job.platform, ref: job.id, payload: { approvalId: approval.id, amountKRW: part.amountKRW, part: part.label } });
  return { queued: true, approval };
}

// Sends one approved payment request, after checking that nothing was paid since it was queued and the
// amount is still what is due; a deposit and a balance can be the same amount.
export async function sendPayRequest({ instance, ledger, descriptor, adapter, approval, notify = notifyOperator }) {
  const job = ledger.getJob(approval.jobId);
  const payments = job ? ledger.jobPayments(job.id) : [];
  const due = job ? nextPart(job, payments, instance.config, descriptor, { rest: approval.rest === true }) : null;
  if (!due || due.amountKRW !== approval.amountKRW || paidOf(payments) !== approval.paidBeforeKRW) {
    closeApproval(instance, approval.id, { status: 'stale', detail: due ? 'paid ' + paidOf(payments) + ' since, now due ' + due.amountKRW : 'nothing is due' });
    ledger.addEvent({ kind: 'order.pay_request_stale', platform: approval.platform, ref: approval.jobId, payload: { approvalId: approval.id } });
    return { id: approval.id, action: 'stale' };
  }
  if (typeof adapter.payRequest !== 'function') {
    closeApproval(instance, approval.id, { status: 'blocked', detail: job.platform + ' has no payment request in its adapter' });
    return { id: approval.id, action: 'blocked' };
  }
  const r = await adapter.payRequest(approval.threadRef, { amountKRW: approval.amountKRW, approved: true });
  const status = r?.observed === true ? 'sent' : 'unobserved';
  closeApproval(instance, approval.id, { status, result: { reason: r?.reason ?? null, observedSnippet: r?.observedSnippet ?? null } });
  ledger.addEvent({ kind: 'order.pay_request_' + status, platform: job.platform, ref: job.id, payload: { approvalId: approval.id, amountKRW: approval.amountKRW, reason: r?.reason ?? null } });
  if (status !== 'sent') {
    await notify(instance, { kind: 'order', title: job.platform + ' payment request for job ' + job.id + ' was not observed', body: (r?.reason ?? 'no reason given') + '\nCheck the chat before asking again.', dedupeKey: 'payreq-unobserved:' + approval.id });
  }
  return { id: approval.id, action: status };
}

