// Payment rules the deal, the outbox readiness and the work runner share, carried unchanged from
// src/jobs/run.mjs:42-76, src/orders/money.mjs:85-90, src/orders/delivery.mjs:151-159 and
// src/orders/requests.mjs:13-30 at 2c77326.
import { splitPayment } from '../economics/pricing.mjs';

const paidOf = (payments) => payments.reduce((s, p) => s + p.amountKRW, 0);

// A payment counts only when it came through a channel the platform allows: the platform itself, or a
// direct bank transfer where the descriptor permits off-platform payment. A row without a channel is not
// evidence of where the money sits.
export function countedPayments(payments, descriptor) {
  const channels = descriptor.offPlatformPayment === true ? [descriptor.id, 'bank'] : [descriptor.id];
  return payments.filter((p) => p.evidence && p.amountKRW > 0 && channels.includes(p.channel));
}

// Platforms that hold the whole order in escrow before work starts (크몽 reorders phases as separate
// orders, so a phase order is a job row of its own); an unknown split mechanism is treated the same way.
const wholeOrderEscrow = (descriptor) => descriptor.escrow === true && ['reorder', 'none', 'unknown'].includes(descriptor.milestones);

export function paymentLevelMet(level, job, payments, descriptor) {
  const counted = countedPayments(payments, descriptor);
  const paidKRW = counted.reduce((s, p) => s + p.amountKRW, 0);
  const base = { level, paidKRW, priceKRW: job.priceKRW ?? null, payments: counted.map((p) => p.id) };
  if (level === 'none') return { ok: true, ...base, reason: 'recipe needs no payment' };
  if (level === 'full' || (level === 'deposit' && wholeOrderEscrow(descriptor))) {
    if (!(job.priceKRW > 0)) return { ok: false, ...base, reason: 'job has no price to compare payments with' };
    if (paidKRW >= job.priceKRW) return { ok: true, ...base, reason: level === 'full' ? 'full price received' : 'order held in ' + descriptor.id + ' escrow' };
    return { ok: false, ...base, reason: level === 'full' || descriptor.milestones !== 'unknown'
      ? 'needs the full ' + job.priceKRW + ' KRW ' + (descriptor.escrow ? 'held in escrow' : 'paid') + ' on ' + descriptor.id + ', has ' + paidKRW
      : 'split mechanism of ' + descriptor.id + ' is unknown, so the full order must be held first; has ' + paidKRW };
  }
  if (level === 'deposit') {
    if (counted.some((p) => ['deposit', 'milestone', 'full'].includes(p.kind))) return { ok: true, ...base, reason: 'deposit received' };
    return { ok: false, ...base, reason: 'needs a deposit payment on ' + descriptor.id + ' before work starts' };
  }
  return { ok: false, ...base, reason: 'unknown payment level ' + level };
}

export const startAllowed = (job, ledger, descriptor, recipe) => paymentLevelMet(recipe.payment.beforeStart, job, ledger.jobPayments(job.id), descriptor);
// Whether the finished result may be sent, from payment rows and descriptor rules only.
export const deliveryAllowed = (job, ledger, descriptor, recipe) => paymentLevelMet(recipe.payment.beforeDelivery, job, ledger.jobPayments(job.id), descriptor);

// deposit, balance, full or milestone, from what the job already received and its agreed price.
export function paymentKind(priceKRW, paidKRW, amountKRW) {
  if (!(priceKRW > 0)) return 'full';
  if (paidKRW + amountKRW >= priceKRW) return paidKRW > 0 ? 'balance' : 'full';
  return paidKRW > 0 ? 'milestone' : 'deposit';
}

// Every payment received, and on an escrow platform each one confirmed or remitted.
export function settled(job, ledger, descriptor) {
  const payments = ledger.jobPayments(job.id);
  if (!payments.length || !(job.priceKRW > 0) || paidOf(payments) < job.priceKRW) return false;
  if (!descriptor.escrow) return true;
  const done = new Set(ledger.listMoneyEvents({ jobId: job.id }).filter((e) => ['confirmed', 'remitted'].includes(e.event) && e.paymentId).map((e) => e.paymentId));
  return payments.every((p) => done.has(p.id));
}

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
