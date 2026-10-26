// readiness(ledger, row, ctx) -> null | {hold} | {stale} | {block}: whether an outbox row about a deal can
// go now, from payment rows only. The loop passes it to drain as ctx.hold. Rules carried from
// sendPayRequest (src/orders/requests.mjs:56-64) and sendDelivery (src/orders/delivery.mjs:104-127).
import { existsSync } from 'node:fs';
import { deliveryAllowed, nextPart } from './levels.mjs';

const paidOf = (payments) => payments.reduce((s, p) => s + p.amountKRW, 0);

export function readiness(ledger, row, { instance, descriptor, loadRecipe }) {
  if (row.kind === 'pay_request') {
    const job = row.jobId ? ledger.getJob(row.jobId) : null;
    const payments = job ? ledger.jobPayments(job.id) : [];
    const due = job ? nextPart(job, payments, instance.config, descriptor, { rest: row.payload.rest === true }) : null;
    // A deposit and a balance can be the same amount, so what was paid before is part of the check.
    if (!due || due.amountKRW !== row.payload.amountKRW || paidOf(payments) !== row.payload.paidBeforeKRW) return { stale: due ? 'paid ' + paidOf(payments) + ' since, now due ' + due.amountKRW : 'nothing is due' };
    return null;
  }
  if (row.kind === 'delivery') {
    const job = row.jobId ? ledger.getJob(row.jobId) : null;
    if (!job || job.status !== 'in_progress' || job.meta?.lastRun?.at !== row.payload.runAt) return { stale: 'the job moved on since this delivery was planned' };
    const missing = (row.payload.files ?? []).filter((f) => !existsSync(f));
    if (missing.length) return { block: 'deliverables missing: ' + missing.join(', ') };
    if (typeof loadRecipe !== 'function') return { hold: 'no recipe loader to check the delivery payment level' };
    const allowed = deliveryAllowed(job, ledger, descriptor, loadRecipe(job.service));
    return allowed.ok ? null : { hold: allowed.reason };
  }
  return null;
}
