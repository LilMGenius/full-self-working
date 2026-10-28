// advance(ledger, signal, ctx) -> {transitions, effects}: the one writer of jobs.status, quotes.status,
// payments, reviews and money_events (architect D4). Each signal is applied in one SQLite transaction;
// effects come back for the loop to carry out after the commit, so the deal never calls the outbox, the
// work runner or the portfolio. Rules carried from src/orders/money.mjs:92-238,
// src/orders/delivery.mjs:145,168-185, src/orders/revision.mjs:11-45 and src/jobs/run.mjs:335,362 at
// 2c77326. A signal the current state does not accept is refused and recorded as a deal.refused event.
import { transaction } from '../core/tx.mjs';
import { answeredServices, catalogServicesFor, operatorDelivered } from '../economics/catalog.mjs';
import catalog from '../economics/services.json' with { type: 'json' };
import { OPERATOR_START_LEVEL, caseEffect, deliveryEffects, handOverEffect, makesFiles, notifyEffect, payRequestEffect } from './effects.mjs';
import { nextPart, paymentLevelMet, settled } from './levels.mjs';
import { findJob, isLive, moneyKey, quotesOf, settleOrWrite } from './match.mjs';
import { MONEY_LOOKBACK_DAYS, jobIdFor } from './signals.mjs';

// 003 Deal signal types, amended 2026-10-25 15:40.
export const SIGNAL_TYPES = ['quote_observed', 'ordered', 'order_cancelled', 'hired', 'hire_cancelled', 'pay_requested', 'paid', 'confirmed', 'remitted', 'pay_cancelled', 'run_started', 'run_accepted', 'run_failed', 'handoff_done', 'delivery_observed', 'revision_requested', 'permission_granted', 'permission_conditional', 'permission_refused', 'review', 'expired'];
// Signals read from platform notices or list rows: each is recorded once in money_events under its key.
export const MONEY_TYPES = ['ordered', 'order_cancelled', 'hired', 'hire_cancelled', 'pay_requested', 'paid', 'confirmed', 'remitted', 'pay_cancelled', 'review'];
// Each package includes one revision round (src/orders/revision.mjs:11).
export const INCLUDED_REVISIONS = 1;
const OPEN_FOR_ORDER = ['lead', 'quoted', 'lost'];

export class DealError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DealError';
    this.code = code;
  }
}

function move(ledger, out, job, to, patch = {}) {
  const from = job.status ?? null;
  const next = ledger.upsertJob({ ...patch, id: job.id, status: to });
  if (from !== to) {
    out.transitions.push({ jobId: job.id, from, to });
    ledger.addEvent({ kind: 'deal.transition', platform: next.platform, ref: job.id, payload: { jobId: job.id, from, to, signal: out.type } });
  }
  return next;
}

function refuse(ledger, out, signal, job, reason) {
  ledger.addEvent({ kind: 'deal.refused', platform: signal.platform, ref: job?.id ?? null, payload: { type: signal.type, jobId: job?.id ?? null, status: job?.status ?? null, reason } });
}

// The hire or the escrowed order: the newest sent quote becomes accepted (a quote made outside fsw is
// recorded from the row's own quote) and the job moves to ordered (src/orders/money.mjs:107-131).
function accept(ledger, out, { signal, thread, descriptor, config }) {
  const ev = signal.evidence ?? {};
  const sent = quotesOf(ledger, signal.platform, thread, ev.requestId, 'sent').at(-1) ?? null;
  let quote = sent ? ledger.updateQuote(sent.id, { status: 'accepted' }) : quotesOf(ledger, signal.platform, thread, ev.requestId, 'accepted').at(-1) ?? null;
  if (!quote) {
    const q = ev.rowQuote;
    quote = ledger.addQuote({ threadId: thread.id, platform: signal.platform, service: thread.service ?? null, amountKRW: q?.unit === 'total' ? q.priceKRW : signal.amountKRW ?? null, scope: null, costKRW: 0, status: 'accepted', at: signal.at ?? undefined });
  }
  const at = signal.at ?? new Date().toISOString();
  const existing = findJob(ledger, signal.platform, thread, ev.requestId);
  if (existing) {
    const job = OPEN_FOR_ORDER.includes(existing.status) ? move(ledger, out, existing, 'ordered', { priceKRW: existing.priceKRW ?? quote.amountKRW ?? null, meta: { ...(existing.meta ?? {}), acceptedAt: at, quoteId: quote.id } }) : existing;
    return { quote, job };
  }
  const ids = catalogServicesFor(descriptor, ev.label ?? null);
  const service = quote.service ?? thread.service ?? (ids?.length === 1 ? ids[0] : null);
  // A deal in a service the catalog does not hold, or in one this instance does not answer on the
  // platform (a lesson, unless config platforms.<id>.services lists it), is the operator's own work: its
  // money is recorded and the work runner never starts it (src/orders/money.mjs:120-131 at 14d2f17).
  const manual = !service ? 'no catalog service for the label ' + (ev.label ?? 'none')
    : !answeredServices(config, signal.platform).includes(service) ? 'service ' + service + ' is not answered on ' + signal.platform + ' (config platforms.' + signal.platform + '.services)' : null;
  const job = move(ledger, out, { id: jobIdFor(signal.platform, thread.externalId), status: null }, 'ordered', {
    threadId: thread.id, platform: signal.platform, service, title: catalog[service]?.ko ?? null, priceKRW: quote.amountKRW ?? null,
    meta: {
      acceptedAt: at, quoteId: quote.id, requestId: ev.requestId ?? null, label: ev.label ?? null,
      ...(quote.amountKRW == null && ev.rowQuote?.unit === 'hour' ? { hourlyKRW: ev.rowQuote.priceKRW } : {}),
      ...(manual ? { manual } : {}),
    },
  });
  return { quote, job };
}

// A delivered job closes when settled; so does a job the operator delivers (handed over below), whose full
// payment and the platform's confirmation are the evidence the sessions took place, and whose close time
// is recorded as its delivery (src/orders/delivery.mjs:166-190 at 206d360).
function close(ledger, out, job, descriptor, now) {
  const operatorJob = job.status === 'in_progress' && job.meta?.operator;
  if (!(job.status === 'delivered' || operatorJob) || !settled(job, ledger, descriptor)) return job;
  const payments = ledger.jobPayments(job.id);
  const thread = job.threadId ? ledger.getThread(job.threadId) : null;
  const at = now.toISOString();
  const deliveredAt = job.deliveredAt ?? at;
  const closed = move(ledger, out, job, 'closed', { closedAt: at, ...(job.deliveredAt ? {} : { deliveredAt: at }) });
  out.effects.push(caseEffect({
    kind: 'job_closed', platform: job.platform, service: job.service, threadRef: thread?.externalId ?? null, jobId: job.id,
    text: 'job ' + job.id + ' (' + job.service + ') closed: ' + payments.reduce((s, p) => s + p.amountKRW, 0) + ' KRW in ' + payments.length + ' payment(s), delivered ' + deliveredAt + ', ' + Math.round(job.agentMinutes ?? 0) + ' agent minutes',
    note: 'portfolio permission ' + (job.meta?.portfolio?.permission ?? 'pending'),
  }), { type: 'sync_portfolio' });
  return closed;
}

// An operator-delivered job (a lesson) runs no recipe. Once its deposit is recorded it moves to
// in_progress and the operator gets the schedule-the-sessions item; where no balance request applies it
// is a plain notice (src/orders/run.mjs:51-75 at 206d360).
function handOver(ledger, out, { job, thread, instance, descriptor, now }) {
  const payments = ledger.jobPayments(job.id);
  if (!paymentLevelMet(OPERATOR_START_LEVEL, job, payments, descriptor).ok) return job;
  const at = now.toISOString();
  const moved = move(ledger, out, job, 'in_progress', { startedAt: job.startedAt ?? at, meta: { ...(job.meta ?? {}), operator: { handedOverAt: at } } });
  // A deposit request still open although the client paid on their own is no longer due: the loop moves
  // it to stale through close_outbox (003 Deal) before the balance item below is planned
  // (src/orders/run.mjs:64-66 at 206d360).
  out.effects.push({ type: 'close_outbox', jobId: job.id, kind: 'pay_request', reason: 'the client paid ' + payments.reduce((s, p) => s + p.amountKRW, 0) + ' KRW before the hand-over' });
  const part = descriptor.milestones === 'multi_pay' ? nextPart(moved, payments, instance.config, descriptor, { rest: true }) : null;
  if (part) out.effects.push(handOverEffect({ job: moved, thread, part, descriptor, paidBeforeKRW: payments.reduce((s, p) => s + p.amountKRW, 0) }));
  else out.effects.push(notifyEffect(job.platform + ' job ' + job.id + ': schedule the sessions', 'Deposit received for ' + job.service + ' job ' + job.id + '. Schedule the sessions with the client in the ' + descriptor.name + ' chat and teach them. No balance request applies: ' + (job.priceKRW > 0 ? 'nothing is due or the platform has no split request' : 'the job has no agreed total price'), 'handover:' + job.id));
  return moved;
}

// Losing a deal that never received money; a deal with payments keeps its status for the operator.
function lose(ledger, out, { signal, thread, job, note }) {
  for (const q of ledger.listQuotes({ threadId: thread.id, status: 'accepted' })) ledger.updateQuote(q.id, { status: 'declined' });
  const paid = job ? ledger.jobPayments(job.id).length > 0 : false;
  if (job && !paid && job.status !== 'lost') {
    move(ledger, out, job, 'lost');
    out.effects.push(caseEffect({ kind: 'lead_lost', platform: signal.platform, service: job.service, threadRef: thread.externalId, jobId: job.id, text: String(signal.evidence?.text ?? note), note }));
  }
  return note + (job ? ', job ' + job.id + (paid ? ' keeps its payments' : ' lost') : '');
}

// The operator entered the review of a job he already recorded. The same rating, text and liked change
// nothing. Different ones correct that one row, since a client leaves one review and a second entry is
// the operator fixing what he typed; keeping both would rank the job on two reviews. The old values stay
// in the deal.review_corrected event.
// The correction is a review case of its own, naming what it replaced, so the learning reads the rating
// the operator settled on.
function correctReview(ledger, out, signal, thread, prior) {
  const ev = signal.evidence;
  const id = JSON.parse(prior.evidence).reviewId;
  const row = ledger.jobReviews(prior.jobId).find((r) => r.id === id);
  const next = { rating: ev.rating ?? null, text: ev.text ?? null, liked: ev.liked ?? null };
  if (row.rating === next.rating && row.text === next.text && row.liked === next.liked) return;
  ledger.updateReview(id, next);
  ledger.addEvent({ kind: 'deal.review_corrected', platform: signal.platform, ref: prior.jobId, payload: { jobId: prior.jobId, reviewId: id, from: { rating: row.rating, text: row.text, liked: row.liked }, to: next } });
  const job = ledger.getJob(prior.jobId);
  out.effects.push({ type: 'sync_portfolio' }, caseEffect({ kind: 'review', platform: signal.platform, service: job?.service ?? null, threadRef: thread.externalId, jobId: prior.jobId, text: String(next.text ?? 'review'), ...(next.rating != null ? { rating: next.rating } : {}), note: 'corrects the review recorded with rating ' + (row.rating ?? 'none') + ' (review ' + id + ')' }));
}

function money(ledger, out, signal, thread, { instance, descriptor, now }) {
  const ev = signal.evidence ?? {};
  // A payment request the outbox observed is a fact of fsw's own send, not a platform notice: an event.
  if (signal.type === 'pay_requested' && ev.outboxId != null) {
    ledger.addEvent({ kind: 'deal.pay_requested', platform: signal.platform, ref: thread.externalId, payload: { outboxId: ev.outboxId, amountKRW: signal.amountKRW ?? null, part: ev.part ?? null } });
    return;
  }
  const live = isLive(ledger, signal, thread, now);
  // A chat row keeps status hired after the hire notice scrolls out of it; read again once this round's
  // hire is recorded, it is that hire repeated, never a past hire to record as history.
  if (signal.type === 'hired' && !live && ev.source === 'row-status' && ledger.getMoneyEvent(moneyKey(ledger, signal, thread, true))) return;
  const key = moneyKey(ledger, signal, thread, live);
  // A review belongs to the job it names (the operator's fsw deal entry, a parsed row matched to a job),
  // never to the newest one on the thread, which can be a later job for the same client. A review signal
  // that names none, such as the chat notice that a review was posted, is refused: which job it rates is
  // unknown, and the operator records it with fsw deal <jobId> review.
  const named = signal.type === 'review' && signal.jobId ? ledger.getJob(signal.jobId) : null;
  if (signal.type === 'review' && !signal.jobId) return refuse(ledger, out, signal, null, 'a review signal names no job id; a review is recorded only on the job it names');
  if (signal.type === 'review' && named?.threadId !== thread.id) return refuse(ledger, out, signal, named, 'review names job ' + signal.jobId + ', which ' + (named ? 'is not on thread ' + thread.externalId : 'does not exist'));
  const prior = ledger.getMoneyEvent(key);
  if (prior) {
    if (signal.type === 'review' && ev.source === 'operator') correctReview(ledger, out, signal, thread, prior);
    return;
  }
  let job = named ?? findJob(ledger, signal.platform, thread, ev.requestId);
  let applied = false;
  let paymentId = null;
  let reviewId = null;
  let closes = false;
  let note = live ? null : 'history: older than ' + MONEY_LOOKBACK_DAYS + ' days or a hire fsw never quoted';
  if (live) {
    if (signal.type === 'hired' || signal.type === 'ordered') {
      const r = accept(ledger, out, { signal, thread, descriptor, config: instance.config });
      job = r.job;
      applied = true;
      note = 'quote ' + r.quote.id + ' accepted, job ' + job.id + ' ' + job.status;
      if (signal.type === 'ordered' && signal.amountKRW > 0) {
        // An escrowed order holds its amount on the platform; it is the payment (src/jobs/run.mjs:50-52).
        const w = settleOrWrite(ledger, { platform: signal.platform, job, signal, key });
        paymentId = w.paymentId;
        note += '; ' + w.note;
        if (w.written && !job.meta?.manual) out.effects.push({ type: 'start_run', jobId: job.id });
      }
      const payments = ledger.jobPayments(job.id);
      const part = signal.type === 'hired' && !job.meta?.manual && descriptor.milestones === 'multi_pay' && !payments.length ? nextPart(job, payments, instance.config, descriptor) : null;
      if (part) {
        out.effects.push(payRequestEffect({ job, thread: ledger.getThread(job.threadId), part, descriptor, paidBeforeKRW: 0, rest: false, why: 'hired' }));
        note += '; deposit request of ' + part.amountKRW + ' KRW planned for the operator';
      } else if (signal.type === 'hired' && descriptor.milestones === 'multi_pay') note += '; no payment request: ' + (job.meta?.manual ?? (job.priceKRW > 0 ? 'nothing is due' : 'the job has no agreed total price'));
    } else if (signal.type === 'hire_cancelled' || signal.type === 'order_cancelled') {
      note = lose(ledger, out, { signal, thread, job, note: signal.type === 'hire_cancelled' ? 'hire cancelled' : 'order cancelled' });
      job = job ? ledger.getJob(job.id) : null;
      applied = true;
    } else if (['paid', 'confirmed', 'remitted'].includes(signal.type)) {
      const settles = job && ledger.jobPayments(job.id).length > 0 && signal.type !== 'paid';
      if (!(signal.amountKRW > 0) && !settles) {
        // Left unrecorded so the read that shows the amount still counts (src/orders/money.mjs:207-213).
        out.effects.push(notifyEffect(signal.platform + ' ' + signal.type + ' notice without a readable amount in thread ' + thread.externalId, 'No payment row was written; check the chat. Evidence: ' + String(ev.text ?? '').slice(0, 160), 'money-noamount:' + key));
        return;
      }
      if (!job) job = accept(ledger, out, { signal, thread, descriptor, config: instance.config }).job;
      const r = settleOrWrite(ledger, { platform: signal.platform, job, signal, key });
      paymentId = r.paymentId;
      applied = paymentId != null;
      note = r.note;
      job = ledger.getJob(job.id);
      if (signal.type === 'paid' && r.written && job.status === 'ordered' && !job.meta?.manual) {
        if (operatorDelivered(job.service)) job = handOver(ledger, out, { job, thread, instance, descriptor, now });
        else out.effects.push({ type: 'start_run', jobId: job.id });
      }
      closes = signal.type !== 'paid';
    } else if (signal.type === 'review') {
      if (job && ['delivered', 'closed'].includes(job.status)) {
        reviewId = ledger.addReview({ jobId: job.id, platform: signal.platform, rating: ev.rating ?? null, text: ev.text ?? null, liked: ev.liked ?? null, at: signal.at ?? undefined }).id;
        out.effects.push({ type: 'sync_portfolio' }, caseEffect({ kind: 'review', platform: signal.platform, service: job.service, threadRef: thread.externalId, jobId: job.id, text: String(ev.text ?? 'review'), ...(ev.rating != null ? { rating: ev.rating } : {}) }));
        applied = true;
        note = 'review recorded for job ' + job.id;
      } else {
        note = 'review without a delivered job; recorded for the operator';
        // The operator's own entry on a job not delivered yet is refused to him (fsw deal exits 1) and keeps
        // no key, so his entry once the job is delivered is recorded.
        if (ev.source === 'operator') return void ledger.addEvent({ kind: 'money.review', platform: signal.platform, ref: thread.externalId, payload: { key, applied: false, note, paymentId: null, amountKRW: null } });
      }
    } else {
      // pay_requested from a notice and pay_cancelled: recorded and reported; a refund after
      // pay_cancelled is not modelled (no observed sample, src/orders/money.mjs:220-222).
      note = signal.type + ' recorded for the operator';
    }
  }
  ledger.addMoneyEvent({ key, platform: signal.platform, threadId: thread.id, jobId: job?.id ?? null, event: signal.type, amountKRW: signal.amountKRW ?? null, at: signal.at, applied, note, paymentId, evidence: { text: ev.text ?? null, source: ev.source ?? null, ...(reviewId != null ? { reviewId } : {}) } });
  ledger.addEvent({ kind: 'money.' + signal.type, platform: signal.platform, ref: thread.externalId, payload: { key, applied, note, paymentId, amountKRW: signal.amountKRW ?? null } });
  // A confirmation closes a settled job only once its own link is recorded above, since settled reads the
  // confirmed and remitted links from money_events.
  if (closes) job = close(ledger, out, ledger.getJob(job.id), descriptor, now);
  if (live) out.effects.push(notifyEffect(signal.platform + ' ' + signal.type + (signal.amountKRW ? ' ' + signal.amountKRW + ' KRW' : '') + ' in thread ' + thread.externalId, [note, job ? 'job ' + job.id + ' (' + (ledger.getJob(job.id)?.status ?? '') + ')' : null, 'evidence: ' + String(ev.text ?? '').slice(0, 160)].filter(Boolean).join('\n'), 'money:' + key));
}

// Only the operator's word (fsw deal, source operator) grants without a checked quote or lifts a denial or a
// condition; any other grant must carry the client's sentence from after the delivery and after the last
// recorded answer. A condition the client set (conditional) keeps the work private like a denial until the
// operator scopes it; it never replaces a denial.
const permission = (value) => (ledger, out, s, { job }) => {
  // A refusal or a condition keeps the work private on any job delivered once (a revision or its rerun
  // included); a grant needs the delivered or closed work it publishes.
  if (value === 'denied' && !job?.deliveredAt) return refuse(ledger, out, s, job, 'a portfolio refusal needs a job that was delivered');
  if (value === 'conditional' && !job?.deliveredAt) return refuse(ledger, out, s, job, 'a portfolio condition needs a job that was delivered');
  if (value === 'granted' && !(job && ['delivered', 'closed'].includes(job.status))) return refuse(ledger, out, s, job, 'portfolio permission needs a delivered or closed job');
  const prior = job.meta?.portfolio ?? {};
  if (value === 'conditional' && prior.permission === 'denied') return refuse(ledger, out, s, job, 'a portfolio denial stands over a later condition');
  if (value === 'granted' && s.evidence?.source !== 'operator') {
    if (prior.permission === 'denied') return refuse(ledger, out, s, job, 'only the operator lifts a portfolio denial');
    if (prior.permission === 'conditional') return refuse(ledger, out, s, job, 'only the operator lifts a portfolio condition');
    const quoteAt = Date.parse(s.evidence?.quoteAt ?? '');
    const floor = Math.max(Date.parse(job.deliveredAt ?? ''), prior.answeredAt ? Date.parse(prior.answeredAt) : -Infinity);
    if (!s.evidence?.quote || !(quoteAt > floor)) return refuse(ledger, out, s, job, 'a grant needs the client sentence from after the delivery and the last answer');
  }
  ledger.upsertJob({ id: job.id, meta: { ...(job.meta ?? {}), portfolio: { ...(job.meta?.portfolio ?? {}), permission: value, answeredAt: s.at, quote: s.evidence?.quote ?? null, quoteAt: s.evidence?.quoteAt ?? null, source: s.evidence?.source ?? null } } });
  out.effects.push({ type: 'sync_portfolio' });
};

const RECORDED_BY_RULE = ['quote_observed'];

const RULES = {
  quote_observed(ledger, out, s, { thread, job, record }) {
    const ev = s.evidence ?? {};
    const parts = ev.split?.parts ?? [];
    const deposit = parts.length > 1 ? parts[0].amountKRW : null;
    const quote = ledger.addQuote({ threadId: thread.id, platform: s.platform, service: ev.service ?? null, amountKRW: s.amountKRW, depositKRW: deposit, balanceKRW: deposit == null ? null : s.amountKRW - deposit, scope: ev.scope ?? null, deliveryDays: ev.deliveryDays ?? null, costKRW: ev.cashSpentKRW ?? ev.costKRW ?? 0, status: 'sent', at: s.at });
    // The signal's event names the quote beside the row it came from, the one place both are known
    // (src/economics/quote-results.mjs links a quote's pricing basis by it).
    record({ quoteId: quote.id });
    const meta = { quoteId: quote.id, scope: ev.scope ?? null, deliveryDays: ev.deliveryDays ?? null, requestId: thread.kind === 'request' ? thread.externalId : null };
    if (!job) return void move(ledger, out, { id: jobIdFor(s.platform, thread.externalId), status: null }, 'quoted', { threadId: thread.id, platform: s.platform, service: ev.service ?? null, title: catalog[ev.service]?.ko ?? null, priceKRW: s.amountKRW, meta });
    if (OPEN_FOR_ORDER.includes(job.status)) return void move(ledger, out, job, 'quoted', { priceKRW: s.amountKRW, service: ev.service ?? job.service, meta: { ...(job.meta ?? {}), ...meta } });
    ledger.addEvent({ kind: 'deal.quote_extra', platform: s.platform, ref: job.id, payload: { quoteId: quote.id, status: job.status } });
  },
  expired(ledger, out, s, { thread, job }) {
    if (!job || job.status !== 'quoted') return refuse(ledger, out, s, job, 'only a quoted job expires');
    for (const q of ledger.listQuotes({ threadId: thread.id, status: 'sent' })) ledger.updateQuote(q.id, { status: 'expired' });
    move(ledger, out, job, 'lost');
    out.effects.push(caseEffect({ kind: 'lead_lost', platform: s.platform, service: job.service, threadRef: thread.externalId, jobId: job.id, text: 'quote of ' + (job.priceKRW ?? 'unknown') + ' KRW on ' + thread.externalId + ' expired without a hire', note: 'request expired' }));
  },
  run_started(ledger, out, s, { job }) {
    if (!job || !['ordered', 'revision'].includes(job.status)) return refuse(ledger, out, s, job, 'a run starts only on an ordered or revision job');
    move(ledger, out, job, 'in_progress', { startedAt: job.startedAt ?? s.at });
  },
  run_accepted(ledger, out, s, { job, instance, descriptor }) {
    if (!job || job.status !== 'in_progress') return refuse(ledger, out, s, job, 'a run result needs an in_progress job');
    const ev = s.evidence ?? {};
    const next = ledger.upsertJob({ id: job.id, agentMinutes: (job.agentMinutes ?? 0) + (ev.minutes ?? 0), meta: { ...(job.meta ?? {}), lastRun: { ...ev.lastRun, files: ev.files ?? [], captures: ev.captures ?? [], handoffs: ev.handoffs ?? [], review: ev.review ?? null } } });
    out.effects.push(...deliveryEffects(ledger, { job: next, descriptor, config: instance.config }));
  },
  // fsw job handoff: the operator finished one step of the last run that produces files, with those files,
  // or found that a conditional step does not apply (no files).
  handoff_done(ledger, out, s, { job, instance, descriptor }) {
    const run = job?.meta?.lastRun;
    if (!job || job.status !== 'in_progress' || !run?.ok) return refuse(ledger, out, s, job, 'an operator step is recorded only on an in_progress job whose run passed acceptance');
    const step = s.evidence?.step;
    const h = (run.handoffs ?? []).find((x) => x.id === step);
    if (!h) return refuse(ledger, out, s, job, 'step ' + step + ' is not an operator step of the last run');
    if (!makesFiles(h)) return refuse(ledger, out, s, job, 'step ' + step + ' makes no files; confirm it when you approve the delivery');
    const files = s.evidence.files ?? [];
    if (files.length < h.produces.length && !(h.when && !files.length)) return refuse(ledger, out, s, job, 'step ' + step + ' makes ' + h.produces.join(', ') + ' but ' + files.length + ' files were given' + (h.when ? '; give none when it does not apply (' + h.when + ')' : ''));
    const handoffs = { ...(job.meta.handoffs ?? {}), [step]: { at: s.at, runAt: run.at, files } };
    const next = ledger.upsertJob({ id: job.id, meta: { ...job.meta, handoffs } });
    out.effects.push(...deliveryEffects(ledger, { job: next, descriptor, config: instance.config }));
  },
  run_failed(ledger, out, s, { job }) {
    if (!job || job.status !== 'in_progress') return refuse(ledger, out, s, job, 'a run result needs an in_progress job');
    const ev = s.evidence ?? {};
    ledger.upsertJob({ id: job.id, agentMinutes: (job.agentMinutes ?? 0) + (ev.minutes ?? 0), meta: { ...(job.meta ?? {}), lastRun: ev.lastRun } });
  },
  delivery_observed(ledger, out, s, { job, descriptor, now }) {
    if (!job || job.status !== 'in_progress') return refuse(ledger, out, s, job, 'a delivery lands only on an in_progress job');
    // A redelivery after a revision asks again but keeps the answer the client already gave.
    const portfolio = { ...(job.meta?.portfolio ?? {}), permission: job.meta?.portfolio?.permission ?? 'pending', askedAt: s.at };
    const delivered = move(ledger, out, job, 'delivered', { deliveredAt: s.at, meta: { ...(job.meta ?? {}), delivery: { at: s.at, outboxId: s.evidence?.outboxId ?? null, files: s.evidence?.files ?? null }, portfolio } });
    // The delivery message asked the client about the portfolio (deliveryText); their answer and a review
    // reach the deal through the operator's fsw deal verbs wherever no parser reads them (060 U6.7).
    out.effects.push(notifyEffect(job.platform + ' job ' + job.id + ' delivered: record the client\'s answers', 'The delivery asked the client whether the work may be shown in the portfolio. Record their answer with: fsw deal ' + job.id + ' permission granted (or denied)\nRecord a review they leave with: fsw deal ' + job.id + ' review --rating <1-5> --text "<review>"', 'portfolio-answer:' + job.id));
    // Confirmations can arrive before the files land (kmong 구매 확정 after an early look): settle now too.
    close(ledger, out, delivered, descriptor, now);
  },
  revision_requested(ledger, out, s, { thread, job }) {
    const text = String(s.evidence?.text ?? '').trim();
    if (!text || !job || job.status !== 'delivered') return refuse(ledger, out, s, job, 'a revision request needs a delivered job and its text');
    const revisions = job.meta?.revisions ?? [];
    if (revisions.some((r) => r.text === text)) return void ledger.addEvent({ kind: 'deal.revision_duplicate', platform: s.platform, ref: job.id, payload: { text } });
    const round = revisions.filter((r) => !r.extra).length + 1;
    const extra = round > INCLUDED_REVISIONS;
    const meta = { ...(job.meta ?? {}), revisions: [...revisions, { at: s.at, text, round, extra }] };
    out.effects.push(caseEffect({ kind: 'revision_request', platform: s.platform, service: job.service, threadRef: thread.externalId, jobId: job.id, text, note: extra ? 'beyond the included rounds' : 'round ' + round }));
    if (extra) {
      ledger.upsertJob({ id: job.id, meta });
      // Gap: no operator verb runs an extra round free; quoting it in the chat is the only path until one exists.
      out.effects.push(notifyEffect('job ' + job.id + ': revision beyond the included round', 'The package includes ' + INCLUDED_REVISIONS + ' revision round. Quote the extra round in the chat.\nRequest: ' + text, 'revision-extra:' + job.id + ':' + revisions.length));
      return;
    }
    move(ledger, out, job, 'revision', { meta });
    out.effects.push({ type: 'start_run', jobId: job.id });
  },
  permission_granted: permission('granted'),
  permission_conditional: permission('conditional'),
  permission_refused: permission('denied'),
};

export function advance(ledger, signal, ctx = {}) {
  if (!SIGNAL_TYPES.includes(signal?.type)) throw new DealError('FSW_DEAL_SIGNAL', 'unknown deal signal ' + signal?.type);
  if (!signal.platform) throw new DealError('FSW_DEAL_SIGNAL', 'a deal signal needs its platform');
  const { instance, descriptor, now = new Date() } = ctx;
  if (!instance || !descriptor) throw new TypeError('advance needs ctx.instance and ctx.descriptor');
  const out = { type: signal.type, transitions: [], effects: [] };
  transaction(ledger, () => {
    const job0 = signal.jobId ? ledger.getJob(signal.jobId) : null;
    const thread = signal.threadId != null ? ledger.getThread(signal.threadId) : job0?.threadId ? ledger.getThread(job0.threadId) : null;
    if (!thread) throw new DealError('FSW_DEAL_SIGNAL', signal.type + ' needs a threadId or a job with a thread');
    if (MONEY_TYPES.includes(signal.type)) return money(ledger, out, signal, thread, { instance, descriptor, now });
    const job = job0 ?? findJob(ledger, signal.platform, thread, signal.evidence?.requestId);
    // outboxId names the observed send a signal came from, so sweep can tell an applied send from a lost one. A rule
    // that adds a row the event should name (quote_observed, its quote id) writes the event itself, before its moves.
    const record = (extra = {}) => ledger.addEvent({ kind: 'deal.' + signal.type, platform: signal.platform, ref: job?.id ?? thread.externalId, payload: { jobId: job?.id ?? null, amountKRW: signal.amountKRW ?? null, outboxId: signal.evidence?.outboxId ?? null, ...extra } });
    if (!RECORDED_BY_RULE.includes(signal.type)) record();
    RULES[signal.type](ledger, out, signal, { thread, job, instance, descriptor, now, record });
  });
  return { transitions: out.transitions, effects: out.effects };
}
