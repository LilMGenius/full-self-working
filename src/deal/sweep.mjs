// sweep(ledger, ctx) -> Effect[]: the plan_outbox effects a committed transition should have produced,
// derived again from ledger state. A crash between advance's commit and the effect applier only delays
// them: plan is idempotent on its key, so a re-planned item is the row that already exists, whatever
// status the operator gave it. 040's orders job runs it every 5-minute tick (pattern of
// queueDeliveries, src/orders/delivery.mjs:57-84).
import { loadDescriptor } from '../platforms/registry.mjs';
import { deliveryEffects, handOverEffect, payRequestEffect } from './advance.mjs';
import { nextPart } from './levels.mjs';

export function sweep(ledger, { instance }) {
  const effects = [];
  for (const job of ledger.listJobs({ status: 'ordered' })) {
    const descriptor = loadDescriptor(job.platform);
    if (job.meta?.manual || descriptor.milestones !== 'multi_pay' || ledger.jobPayments(job.id).length) continue;
    const thread = job.threadId ? ledger.getThread(job.threadId) : null;
    const part = thread ? nextPart(job, [], instance.config, descriptor) : null;
    if (part) effects.push(payRequestEffect({ job, thread, part, descriptor, paidBeforeKRW: 0, rest: false, why: 'hired' }));
  }
  for (const job of ledger.listJobs({ status: 'in_progress' })) {
    const descriptor = loadDescriptor(job.platform);
    effects.push(...deliveryEffects(ledger, { job, descriptor, config: instance.config }));
    // The handover's schedule-the-sessions item, planned again on the same key if a crash lost it.
    const thread = job.meta?.operator && job.threadId && descriptor.milestones === 'multi_pay' ? ledger.getThread(job.threadId) : null;
    const payments = thread ? ledger.jobPayments(job.id) : [];
    const part = thread ? nextPart(job, payments, instance.config, descriptor, { rest: true }) : null;
    if (part) effects.push(handOverEffect({ job, thread, part, descriptor, paidBeforeKRW: payments.reduce((s, p) => s + p.amountKRW, 0) }));
  }
  return effects;
}
