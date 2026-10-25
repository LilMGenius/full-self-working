// Money states from platform evidence only (docs/DESIGN.md, Ledger: "A payment row is written only from
// evidence"). A list row (its chat status and newest platform line) and an opened thread (its platform
// lines) are turned into signals by src/orders/notices.mjs; each signal is recorded once in money_events
// under a key built from the platform, the thread, the event and the minute the platform stamped, and only
// a fresh signal changes state: a hire accepts the quote and opens the job, a paid notice writes one
// payment row, a confirmation or remittance is matched to the payment it settles.
import { seoulParts } from '../core/clock.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { catalogServicesFor } from '../pipeline/thread.mjs';
import catalog from '../economics/services.json' with { type: 'json' };
import { classifyNotice } from './notices.mjs';

// A signal older than this is history (the account's past deals), recorded without effect.
export const MONEY_LOOKBACK_DAYS = 7;
const DAY_MS = 86_400_000;

export const jobIdFor = (platform, externalId) => (platform + '-' + externalId).replace(/[^A-Za-z0-9_-]/g, '_');

const pad = (n) => String(n).padStart(2, '0');
// The Seoul minute a platform stamped on a line; a list row and an opened thread print the same line at
// the same minute, which is what makes the two reads one signal.
export function minuteKey(at) {
  const t = Date.parse(at ?? '');
  if (!Number.isFinite(t)) return null;
  const p = seoulParts(new Date(t));
  return p.year + '-' + pad(p.month) + '-' + pad(p.day) + 'T' + pad(p.hour) + ':' + pad(p.minute);
}

// Signals in time order from a list row ({status, hired, notice, at}) and an opened thread's notices.
export function moneySignals({ threadRef = {}, notices = [] } = {}) {
  const out = [];
  const add = (c, at, text, source) => c?.class === 'money' && out.push({ event: c.event, amountKRW: c.amountKRW, at: at ?? null, text, source });
  if (threadRef.notice) add(classifyNotice({ text: threadRef.notice }), threadRef.at, threadRef.notice, 'row');
  for (const n of notices) add(classifyNotice(n), n.at, n.text, 'thread');
  out.sort((a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0));
  if (threadRef.status === 'hired') out.push({ event: 'hired', amountKRW: null, at: threadRef.at ?? null, text: 'chat status hired', source: 'row-status' });
  if (['customer_cancelled', 'rejected'].includes(threadRef.hired)) out.push({ event: 'hire_cancelled', amountKRW: null, at: threadRef.at ?? null, text: 'chat hire_status ' + threadRef.hired, source: 'row-status' });
  return out;
}

const fresh = (at, now) => {
  const t = Date.parse(at ?? '');
  return Number.isFinite(t) && now.getTime() - t <= MONEY_LOOKBACK_DAYS * DAY_MS;
};

export const jobOfThread = (ledger, platform, threadId) => ledger.listJobs({ platform }).find((j) => j.threadId === threadId) ?? null;

// Until the operator records a watched first order (config orders.watched true), every reply in an
// accepted or paid thread goes to the operator: that is where the payout account, deposits and delivery
// talk happen, and no real order has gone through fsw yet.
export const ordersWatched = (config) => config?.orders?.watched === true;

// The stage the ledger's evidence puts a thread in: a recorded payment means the order is running, an
// accepted quote or an opened job means the quote was accepted; null when there is no such evidence.
export function stageFromLedger(ledger, platform, threadId) {
  const job = jobOfThread(ledger, platform, threadId);
  if (job && ledger.jobPayments(job.id).length) return 'post_order';
  if ((job && job.status !== 'lost') || ledger.listQuotes({ threadId, status: 'accepted' }).length) return 'quote_accepted';
  return null;
}

// kmong shows order counters before any order row could be parsed: a rise in any counter is an order
// event the operator must see. Returns {changed, rises}.
// Gap: kmong order rows are not parsed (no order was ever observed on the account), so a rise opens no
// job and writes no payment; parsing /seller/order-list rows against a real order closes it.
export async function recordOrderCounters({ ledger, instance, platform, orders, notify = notifyOperator }) {
  const counts = orders?.counts;
  if (!counts) return { changed: false, rises: [] };
  const prev = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'orders.read' AND platform = ? ORDER BY id DESC LIMIT 1").get(platform);
  const before = prev ? JSON.parse(prev.payload)?.counts ?? null : null;
  ledger.addEvent({ kind: 'orders.read', platform, payload: { counts, total: orders.total ?? null, gap: orders.gap ?? null } });
  const rises = before ? Object.entries(counts).filter(([k, n]) => Number.isInteger(n) && n > (before[k] ?? 0)).map(([k, n]) => ({ counter: k, from: before[k] ?? 0, to: n })) : [];
  if (!rises.length) return { changed: false, rises };
  ledger.addEvent({ kind: 'orders.changed', platform, payload: { rises, gap: 'order rows are not parsed; no job or payment is recorded from a counter' } });
  await notify(instance, {
    kind: 'order',
    title: platform + ' order counters rose: ' + rises.map((r) => r.counter + ' ' + r.from + ' to ' + r.to).join(', '),
    body: 'fsw does not parse ' + platform + ' order rows yet, so no job or payment was recorded. Open the order list on ' + platform + ' and handle the order by hand.',
    dedupeKey: 'orders:' + platform + ':' + JSON.stringify(counts),
  });
  return { changed: true, rises };
}

// deposit, balance, full or milestone, from what the job already received and its agreed price.
export function paymentKind(priceKRW, paidKRW, amountKRW) {
  if (!(priceKRW > 0)) return 'full';
  if (paidKRW + amountKRW >= priceKRW) return paidKRW > 0 ? 'balance' : 'full';
  return paidKRW > 0 ? 'milestone' : 'deposit';
}

// soomgo sends a quote on the request (its own thread) and talks in a chat, whose row names the request;
// the quotes of a chat are its own plus its request's.
function quotesOf(ledger, platform, thread, threadRef, status) {
  const own = ledger.listQuotes({ threadId: thread.id, status });
  const req = threadRef?.requestId ? ledger.listThreads({ platform }).find((t) => t.kind === 'request' && t.externalId === String(threadRef.requestId)) : null;
  return req ? [...own, ...ledger.listQuotes({ threadId: req.id, status })].sort((a, b) => a.id - b.id) : own;
}

function serviceFor(descriptor, thread, threadRef, quote) {
  if (quote?.service) return quote.service;
  if (thread?.service) return thread.service;
  const ids = catalogServicesFor(descriptor, threadRef?.service ?? null);
  return ids?.length === 1 ? ids[0] : null;
}

// The hire: the newest sent quote becomes accepted (a quote made outside fsw is recorded from the row's
// own quote), and the job row opens as ordered.
function accept({ ledger, platform, descriptor, thread, threadRef, at }) {
  const sent = quotesOf(ledger, platform, thread, threadRef, 'sent').at(-1) ?? null;
  let quote = sent ? ledger.updateQuote(sent.id, { status: 'accepted' }) : quotesOf(ledger, platform, thread, threadRef, 'accepted').at(-1) ?? null;
  if (!quote) {
    const q = threadRef.quote;
    quote = ledger.addQuote({ threadId: thread.id, platform, service: thread.service ?? null, amountKRW: q?.unit === 'total' ? q.priceKRW : null, scope: null, costKRW: 0, status: 'accepted', at: at ?? undefined });
  }
  const id = jobIdFor(platform, thread.externalId);
  const existing = ledger.getJob(id);
  const service = serviceFor(descriptor, thread, threadRef, quote);
  const job = existing ?? ledger.upsertJob({
    id, threadId: thread.id, platform, service, title: catalog[service]?.ko ?? null, priceKRW: quote.amountKRW ?? null, status: 'ordered',
    meta: {
      acceptedAt: at ?? new Date().toISOString(), quoteId: quote.id, requestId: threadRef.requestId ?? null, label: threadRef.service ?? null,
      ...(quote.amountKRW == null && threadRef.quote?.unit === 'hour' ? { hourlyKRW: threadRef.quote.priceKRW } : {}),
      // A deal in a service the catalog does not hold (a lesson) is the operator's own work: its money is
      // recorded, and the order runner never starts it.
      ...(service ? {} : { manual: 'no catalog service for the label ' + (threadRef.service ?? 'none') }),
    },
  });
  if (existing && ['lead', 'quoted', 'lost'].includes(existing.status)) ledger.upsertJob({ id, status: 'ordered' });
  return { quote, job: ledger.getJob(job.id) };
}

// Payment-level links: which payment a confirmation or remittance settles, and which earlier paid notice
// a payment written from a later notice already stands for.
const linked = (ledger, jobId, event) => new Set(ledger.listMoneyEvents({ jobId, event }).map((e) => e.paymentId).filter(Boolean));

function settleOrWrite({ ledger, platform, job, signal, key }) {
  const payments = ledger.jobPayments(job.id);
  // Each payment is linked at most once per event kind: a paid notice to the payment it opened, a
  // confirmation and a remittance to the oldest payment they have not settled yet. A list row can show
  // the remittance before the opened thread shows the paid line, so links ignore arrival order.
  if (signal.event === 'paid') {
    const paidLinks = linked(ledger, job.id, 'paid');
    const match = payments.find((p) => !paidLinks.has(p.id) && p.amountKRW === signal.amountKRW);
    if (match) return { paymentId: match.id, note: 'matches payment ' + match.id + ' written from a later notice' };
  } else {
    const links = linked(ledger, job.id, signal.event);
    const open = payments.find((p) => !links.has(p.id));
    if (open) return { paymentId: open.id, note: signal.event + ' settles payment ' + open.id };
  }
  if (!(signal.amountKRW > 0)) return { paymentId: null, note: 'no amount readable in the notice; no payment row written' };
  const paid = payments.reduce((s, p) => s + p.amountKRW, 0);
  let priceKRW = job.priceKRW;
  // A deal started without a recorded price takes its price from the platform's own payment notice.
  if (!(priceKRW > 0)) {
    priceKRW = signal.amountKRW;
    ledger.upsertJob({ id: job.id, priceKRW });
  }
  const p = ledger.addPayment({
    jobId: job.id, kind: paymentKind(priceKRW, paid, signal.amountKRW), amountKRW: signal.amountKRW, channel: platform, receivedAt: signal.at ?? undefined,
    evidence: { key, event: signal.event, text: signal.text, at: signal.at, source: signal.source },
  });
  return { paymentId: p.id, note: 'payment ' + p.id + ' (' + p.kind + ') written', written: p };
}

// recordMoney: applies the signals of one list row or opened thread. Returns the newly recorded events.
export async function recordMoney({ ledger, instance, platform, descriptor, thread, threadRef = {}, notices = [], now = new Date(), notify = notifyOperator }) {
  const signals = moneySignals({ threadRef, notices });
  const out = [];
  if (!signals.length) return out;
  const base = platform + ':' + thread.externalId + ':';
  const sentQuote = quotesOf(ledger, platform, thread, threadRef, 'sent').length > 0;
  const freshHire = signals.some((s) => s.event === 'hired' && s.source !== 'row-status' && fresh(s.at, now));
  for (const s of signals) {
    // One hire and one cancellation per round of hiring, however many rows and notices repeat them;
    // every other signal is one per platform-stamped minute.
    const cancels = ledger.listMoneyEvents({ threadId: thread.id, event: 'hire_cancelled' }).length;
    const hires = ledger.listMoneyEvents({ threadId: thread.id, event: 'hired' }).length;
    // A status read from the row has no time of its own; a hire counts as new only when fsw quoted the
    // thread or the hire notice itself is fresh. Every other signal is judged by the time it carries.
    const live = s.source === 'row-status' && s.event === 'hired' ? sentQuote || freshHire : fresh(s.at, now);
    // A past hire read from the row is history under its own key, so a later quote or a fresh hire
    // notice in the same round still counts.
    const key = s.event === 'hired' ? base + 'hired#' + cancels + (live ? '' : ':history')
      : s.event === 'hire_cancelled' ? base + 'hire_cancelled#' + hires
        : base + s.event + ':' + (minuteKey(s.at) ?? 'undated');
    if (ledger.getMoneyEvent(key)) continue;
    let job = jobOfThread(ledger, platform, thread.id);
    let applied = false;
    let note = live ? null : 'history: older than ' + MONEY_LOOKBACK_DAYS + ' days or a hire fsw never quoted';
    let paymentId = null;
    if (live) {
      if (s.event === 'hired') {
        const r = accept({ ledger, platform, descriptor, thread, threadRef, at: s.at });
        job = r.job;
        applied = true;
        note = 'quote ' + r.quote.id + ' accepted, job ' + job.id + ' ordered';
      } else if (s.event === 'hire_cancelled') {
        for (const q of ledger.listQuotes({ threadId: thread.id, status: 'accepted' })) ledger.updateQuote(q.id, { status: 'declined' });
        if (job && !ledger.jobPayments(job.id).length) ledger.upsertJob({ id: job.id, status: 'lost' });
        applied = true;
        note = 'hire cancelled' + (job ? ', job ' + job.id + (ledger.jobPayments(job.id).length ? ' keeps its payments' : ' lost') : '');
      } else if (['paid', 'confirmed', 'remitted'].includes(s.event)) {
        // A payment line whose amount the page did not show is left unrecorded, so the read that shows
        // it (the opened thread) still counts; the operator hears about it now.
        const settles = job && ledger.jobPayments(job.id).length > 0 && s.event !== 'paid';
        if (!(s.amountKRW > 0) && !settles) {
          await notify(instance, { kind: 'order', title: platform + ' ' + s.event + ' notice without a readable amount in thread ' + thread.externalId, body: 'No payment row was written; check the chat. Evidence: ' + String(s.text).slice(0, 160), dedupeKey: 'money-noamount:' + key });
          continue;
        }
        if (!job) job = accept({ ledger, platform, descriptor, thread, threadRef, at: s.at }).job;
        const r = settleOrWrite({ ledger, platform, job, signal: s, key });
        paymentId = r.paymentId;
        applied = paymentId != null;
        note = r.note;
      } else {
        // pay_requested, pay_cancelled, ordered, order_cancelled and review are recorded and reported; a
        // refund after pay_cancelled and a kmong order row are not modelled yet (no observed sample).
        note = s.event + ' recorded for the operator';
      }
    }
    const row = ledger.addMoneyEvent({ key, platform, threadId: thread.id, jobId: job?.id ?? null, event: s.event, amountKRW: s.amountKRW ?? null, at: s.at, applied, note, paymentId, evidence: { text: s.text, source: s.source } });
    ledger.addEvent({ kind: 'money.' + s.event, platform, ref: thread.externalId, payload: { key, applied, note, paymentId, amountKRW: s.amountKRW ?? null } });
    out.push(row);
    if (live) {
      await notify(instance, {
        kind: 'order',
        title: platform + ' ' + s.event + (s.amountKRW ? ' ' + s.amountKRW + ' KRW' : '') + ' in thread ' + thread.externalId,
        body: [note, job ? 'job ' + job.id + ' (' + (ledger.getJob(job.id)?.status ?? '') + ')' : null, 'evidence: ' + String(s.text).slice(0, 160)].filter(Boolean).join('\n'),
        dedupeKey: 'money:' + key,
      });
    }
  }
  return out;
}

