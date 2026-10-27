// What became of every quote fsw sent, replayed from the ledger (docs/DESIGN.md, Economics): won, lost,
// expired, refused, superseded or still open, each with the price index it went out at when its pricing
// basis is known.
// Nothing here writes; the same ledger state and the same day give the same list, which the price table
// (price-learning.mjs) and the allocation (yield.mjs) both read, so neither counts a quote its own way.
import { listDescriptors, loadDescriptor } from '../platforms/registry.mjs';

export const QUOTE_RESULTS = ['won', 'lost', 'expired', 'refused', 'superseded', 'open'];
// The events src/loop/funnel.mjs writes from the soomgo chat list.
export const FUNNEL_EVENTS = ['quote.opened', 'quote.unread', 'quote.hired_us', 'quote.hired_other', 'quote.hired_other_cancelled', 'quote.other_status'];
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// Threads whose deal already moved past its quotes: one holding an accepted quote, and the thread of a job
// past lead and quoted together with the request thread a soomgo chat job names (meta.requestThreadId, set
// by findJob in src/deal/advance.mjs). A still-sent quote on such a thread was passed over for another quote
// of the same deal (superseded), and the allocation (yield.mjs) leaves the job to count that deal's result.
export function decidedThreads(ledger) {
  const out = new Set(ledger.listQuotes({ status: 'accepted' }).map((q) => q.threadId).filter((t) => t != null));
  for (const job of ledger.listJobs()) if (!['lead', 'quoted'].includes(job.status)) for (const t of [job.threadId, job.meta?.requestThreadId]) if (t != null) out.add(t);
  return out;
}

// 00:00 Seoul of a dayKey (YYYYMMDD, src/core/clock.mjs): the instant a day's table and allocation are
// computed as of. It cuts which quotes count by when they went out; their status is read as the ledger holds
// it now, since the ledger keeps no time a quote was decided, so a hire recorded later the same day changes
// a rerun of that day's table.
export function dayStart(day) {
  if (!/^\d{8}$/.test(String(day))) throw new RangeError('day must be YYYYMMDD, got ' + day);
  return new Date(day.slice(0, 4) + '-' + day.slice(4, 6) + '-' + day.slice(6, 8) + 'T00:00:00+09:00');
}

// amount / (complexity x the unlearned reference it was priced from): the row base before learning
// (basis.reference; an older row basis names it base). null without a basis, and null for a request quote priced
// from the guide average (a guideAvg basis that is not a price-row one), which every request quote was until
// 2026-10-27: its index reads against the market middle, while the factor now multiplies the row's tiered base, so a
// loss at the average would pull a first-tier base down that never lost. Such a quote counts in the win rate only.
export function priceIndex(amountKRW, pricing) {
  if (pricing?.guideAvg != null && pricing.source !== 'price-row') return null;
  const ref = pricing?.reference ?? pricing?.guideAvg ?? pricing?.base;
  const cx = pricing?.complexity;
  return amountKRW > 0 && ref > 0 && cx > 0 ? amountKRW / (cx * ref) : null;
}

// The observed outbox row each quote came from, by quote id. The deal names both on deal.quote_observed (outboxId and
// quoteId, src/deal/advance.mjs), and that link decides. Rows with no such link pair one to one within a thread and
// amount: rows whose event predates the quote id, in event order, which is the order the deal added their quotes;
// rows the 2c77326 pipeline sent (no event), in send order (the row's close time and the quote's own time), since the
// import wrote them in approval order. A row of neither kind, a mix of the two, or unequal counts links none, so a
// quote never borrows another quote's pricing basis; it then has no basis and ages from its own time.
function sourceRows(ledger, quotes, observed) {
  const events = ledger.db.prepare("SELECT id, payload FROM events WHERE kind = 'deal.quote_observed' ORDER BY id").all().map((e) => ({ id: e.id, ...JSON.parse(e.payload ?? '{}') }));
  const linked = new Map(events.filter((e) => e.quoteId != null).map((e) => [e.outboxId, e.quoteId]));
  const order = new Map(events.filter((e) => e.quoteId == null).map((e) => [e.outboxId, e.id]));
  const out = new Map();
  for (const r of observed) if (linked.has(r.id)) out.set(linked.get(r.id), r);
  const imported = (r) => r.receipt?.pipeline === 'd605c5d';
  const time = (v) => Date.parse(v ?? '') || 0;
  const key = (threadId, amountKRW) => threadId + ':' + amountKRW;
  const rows = Map.groupBy(observed.filter((r) => !linked.has(r.id) && (order.has(r.id) || imported(r))), (r) => key(r.threadId, r.payload?.amountKRW));
  for (const [k, qs] of Map.groupBy(quotes.filter((q) => !out.has(q.id)), (q) => key(q.threadId, q.amountKRW))) {
    const rs = rows.get(k) ?? [];
    if (rs.length !== qs.length) continue;
    if (rs.every((r) => order.has(r.id))) {
      const sorted = [...rs].sort((a, b) => order.get(a.id) - order.get(b.id));
      [...qs].sort((a, b) => a.id - b.id).forEach((q, i) => out.set(q.id, sorted[i]));
    } else if (rs.every(imported)) {
      const sorted = [...rs].sort((a, b) => time(a.updatedAt) - time(b.updatedAt) || a.id - b.id);
      [...qs].sort((a, b) => time(a.at) - time(b.at) || a.id - b.id).forEach((q, i) => out.set(q.id, sorted[i]));
    }
  }
  return out;
}

// When a quote went out, which its age runs from. v0's drain moved its row to observed when it read the send
// back (updatedAt; the outbox allows no move out of observed, src/outbox/plan.mjs), while the deal records
// the quote at the time of the tick that applied quote_observed. A send of the 2c77326 pipeline keeps the
// quote's own time, since an import or the operator moved its row later (receipt.pipeline, as
// src/deal/sweep.mjs reads it).
const sentAt = (quote, row) => (row && row.receipt?.pipeline !== 'd605c5d' ? row.updatedAt : quote.at);

// What the chat list showed customers do with fsw quotes (src/loop/funnel.mjs), as of a cut: the quote ids a
// customer opened, those a poll saw still unopened past the platform's refund window (quote.unread), and those whose
// customer hired another pro (a later quote.hired_other_cancelled lifts it).
// The funnel's quote.hired_us is not read here: our own hire is the deal's accepted status (won), which accept()
// sets from the same row, so counting the event too would win the quote twice.
export function chatActs(ledger, cut) {
  const opened = new Set();
  const unread = new Set();
  const hiredOther = new Set();
  const rows = ledger.db.prepare("SELECT kind, payload, at FROM events WHERE kind IN ('quote.opened', 'quote.unread', 'quote.hired_other', 'quote.hired_other_cancelled') ORDER BY at, id").all();
  for (const e of rows) {
    const id = JSON.parse(e.payload ?? '{}').quoteId;
    if (id == null || Date.parse(e.at) > cut) continue;
    if (e.kind === 'quote.opened') opened.add(id);
    else if (e.kind === 'quote.unread') unread.add(id);
    else if (e.kind === 'quote.hired_other') hiredOther.add(id);
    else hiredOther.delete(id);
  }
  return { opened, unread, hiredOther };
}

// expireAfterDays Infinity turns the age rule off (an instance without priceLearning settings). A platform that
// refunds a quote its customer never opened (descriptor bidCost.unreadRefundHours, soomgo 48) has ended that
// quote whatever the age rule says, but only on evidence that it went unread: a poll that saw its chat still
// unopened past the window (quote.unread) expires it with cause unread. No opened signal is no such evidence, since
// the funnel never sees a chat past the list's first page, so a quote nobody observed stays open until the age rule.
// The cash history's unread refund (견적 보상, parseCashHistory) would be a second source; it names the customer and
// no quote, so it is not linked yet. A platform with no descriptor file (a test's synthetic board) has no window.
export function quoteResults(ledger, { asOf, expireAfterDays }) {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) throw new TypeError('quoteResults needs asOf');
  if (!(expireAfterDays > 0)) throw new RangeError('expireAfterDays must be positive, got ' + expireAfterDays);
  const cut = asOf.getTime();
  const observed = ledger.listOutbox({ kinds: ['quote'], statuses: ['observed'] });
  const decided = decidedThreads(ledger);
  const acts = chatActs(ledger, cut);
  const quotes = ledger.listQuotes();
  const sources = sourceRows(ledger, quotes, observed);
  const described = new Set(listDescriptors());
  const refundWindow = (platform) => (described.has(platform) ? loadDescriptor(platform).bidCost?.unreadRefundHours : undefined);
  const out = [];
  for (const q of quotes) {
    const src = sources.get(q.id) ?? null;
    const sent = sentAt(q, src);
    const at = Date.parse(sent);
    if (at > cut) continue;
    // A customer who hired another pro decided this quote: lost at once, never aged or superseded. Accepted stays
    // won whatever the chat showed before the hire.
    const lostToOther = q.status === 'sent' && acts.hiredOther.has(q.id);
    // A quote still sent on a thread whose deal moved on was passed over for another quote of that deal: it is
    // neither won nor lost, and it never ages into expired.
    const superseded = q.status === 'sent' && !lostToOther && decided.has(q.threadId);
    const pending = q.status === 'sent' && !lostToOther && !superseded;
    const refundHours = pending && !acts.opened.has(q.id) && acts.unread.has(q.id) ? refundWindow(q.platform) : undefined;
    const unread = refundHours != null && cut - at >= refundHours * HOUR_MS;
    const aged = pending && (unread || cut - at >= expireAfterDays * DAY_MS);
    const result = q.status === 'accepted' ? 'won' : q.status === 'declined' || lostToOther ? 'lost' : q.status === 'expired' || aged ? 'expired' : superseded ? 'superseded' : 'open';
    out.push({ source: 'quote', id: q.id, threadId: q.threadId, platform: q.platform, service: q.service ?? src?.payload?.service ?? null, at: sent, amountKRW: q.amountKRW, costKRW: q.costKRW ?? 0, result, aged, cause: lostToOther ? 'hired_other' : unread ? 'unread' : null, opened: acts.opened.has(q.id), index: priceIndex(q.amountKRW, src?.payload?.decision?.quote?.pricing) });
  }
  // A send the platform refused before the client saw it (the drain's STALE_NOT_SENT): no quote row exists.
  for (const r of ledger.listOutbox({ kinds: ['quote'], statuses: ['stale'] })) {
    if (!r.receipt?.refused || Date.parse(r.createdAt) > cut) continue;
    out.push({ source: 'outbox', id: r.id, threadId: r.threadId, platform: r.platform, service: r.payload?.service ?? null, at: r.createdAt, amountKRW: r.payload?.amountKRW ?? null, costKRW: 0, result: 'refused', aged: false, index: null, code: r.receipt.refused });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.source.localeCompare(b.source) || a.id - b.id);
}

// One platform's quotes sent within the window (days back from now) by what the customer did. Read from the
// same results the price table learns from, so the funnel and the price never count a quote two ways. noAnswer
// is every quote still open (opened or not); opensKnown says whether the platform's chat rows report opens at all.
export function quoteFunnel(ledger, { platform, now, days }) {
  const since = now.getTime() - days * DAY_MS;
  const rows = quoteResults(ledger, { asOf: now, expireAfterDays: Infinity }).filter((r) => r.source === 'quote' && r.platform === platform && Date.parse(r.at) >= since);
  // Only the funnel's own kinds: quote.sent, quote.budget_refused and quote.cost_observed share the prefix.
  const unlinked = new Set(ledger.db.prepare('SELECT ref, payload, at FROM events WHERE platform = ? AND kind IN (' + FUNNEL_EVENTS.map(() => '?').join(', ') + ')').all(platform, ...FUNNEL_EVENTS).filter((e) => Date.parse(e.at) >= since && Date.parse(e.at) <= now.getTime() && JSON.parse(e.payload ?? '{}').quoteId == null && JSON.parse(e.payload ?? '{}').unlinked).map((e) => e.ref));
  return {
    days, sent: rows.length, opened: rows.filter((r) => r.opened).length, hiredUs: rows.filter((r) => r.result === 'won').length,
    hiredOther: rows.filter((r) => r.cause === 'hired_other').length, noAnswer: rows.filter((r) => r.result === 'open').length,
    unlinked: unlinked.size, opensKnown: ledger.listThreads({ platform }).some((t) => t.meta?.funnel),
  };
}
