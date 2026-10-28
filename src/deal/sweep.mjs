// sweep(ledger, ctx) -> Effect[]: the plan_outbox effects a committed transition should have produced,
// derived again from ledger state. A crash between advance's commit and the effect applier only delays
// them: plan is idempotent on its key, so a re-planned item is the row that already exists, whatever
// status the operator gave it. 040's orders job runs it every 5-minute tick (pattern of
// queueDeliveries, src/orders/delivery.mjs:57-84).
import { loadDescriptor } from '../platforms/registry.mjs';
import { deliveryEffects, handOverEffect, payRequestEffect } from './effects.mjs';
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

// The kinds whose observed send the deal turns into a signal, and the deal event each one writes.
const APPLIED_EVENT = { quote: 'deal.quote_observed', delivery: 'deal.delivery_observed', pay_request: 'deal.pay_requested' };

// unappliedObserved(ledger, {platform}) -> outbox rows: observed sends whose deal signal never ran, because
// the process stopped between the drain's commit and advance (or advance threw). The deal's own events carry
// the outboxId of every signal it applied or refused. A row the 2c77326 code sent was recorded by that code
// (its quote row is already in the ledger) and is left out: one imported from an approval file
// (payload.importedFrom) and one v0 planned that the old code sent after a rollback, which the import marks
// receipt.pipeline 2c77326 when it follows the file.
export function unappliedObserved(ledger, { platform }) {
  const kinds = Object.keys(APPLIED_EVENT);
  const rows = ledger.listOutbox({ platform, statuses: ['observed'], kinds }).filter((r) => !r.payload.importedFrom && r.receipt?.pipeline !== 'd605c5d');
  if (!rows.length) return [];
  const marks = Object.values(APPLIED_EVENT).map(() => '?').join(', ');
  const applied = new Set(ledger.db.prepare('SELECT payload FROM events WHERE kind IN (' + marks + ')').all(...Object.values(APPLIED_EVENT)).map((e) => JSON.parse(e.payload ?? 'null')?.outboxId).filter((id) => id != null));
  return rows.filter((r) => !applied.has(r.id));
}
