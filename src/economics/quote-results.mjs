// What became of every quote fsw sent, replayed from the ledger (docs/DESIGN.md, Economics): won, lost,
// expired, refused, superseded or still open, each with the price index it went out at when its pricing
// basis is known.
// Nothing here writes; the same ledger state and the same day give the same list, which the price table
// (price-learning.mjs) and the allocation (yield.mjs) both read, so neither counts a quote its own way.
export const QUOTE_RESULTS = ['won', 'lost', 'expired', 'refused', 'superseded', 'open'];
const DAY_MS = 86_400_000;

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

// amount / (complexity x the unlearned reference it was priced from): the guide average of a request quote
// or the row base before learning (basis.reference from this unit; older bases name it guideAvg or base).
// null without a basis.
export function priceIndex(amountKRW, pricing) {
  const ref = pricing?.reference ?? pricing?.guideAvg ?? pricing?.base;
  const cx = pricing?.complexity;
  return amountKRW > 0 && ref > 0 && cx > 0 ? amountKRW / (cx * ref) : null;
}

// The observed outbox row a quote came from: same thread and amount, the newest one. The quotes table keeps
// no outbox id, and an imported row's createdAt can follow its quote by milliseconds, so no time order is
// assumed.
function sourceRow(quote, observed) {
  return observed.filter((r) => r.threadId === quote.threadId && r.payload?.amountKRW === quote.amountKRW).at(-1) ?? null;
}

// When a quote went out, which its age runs from. v0's drain moved its row to observed when it read the send
// back (updatedAt; the outbox allows no move out of observed, src/outbox/plan.mjs), while the deal records
// the quote at the time of the tick that applied quote_observed. A send of the 2c77326 pipeline keeps the
// quote's own time, since an import or the operator moved its row later (receipt.pipeline, as
// src/deal/sweep.mjs reads it).
const sentAt = (quote, row) => (row && row.receipt?.pipeline !== 'd605c5d' ? row.updatedAt : quote.at);

// What the chat list showed customers do with fsw quotes (src/loop/funnel.mjs), as of a cut: the quote ids a
// customer opened, and those whose customer hired another pro (a later quote.hired_other_cancelled lifts it).
// The funnel's quote.hired_us is not read here: our own hire is the deal's accepted status (won), which accept()
// sets from the same row, so counting the event too would win the quote twice.
export function chatActs(ledger, cut) {
  const opened = new Set();
  const hiredOther = new Set();
  const rows = ledger.db.prepare("SELECT kind, payload, at FROM events WHERE kind IN ('quote.opened', 'quote.hired_other', 'quote.hired_other_cancelled') ORDER BY at, id").all();
  for (const e of rows) {
    const id = JSON.parse(e.payload ?? '{}').quoteId;
    if (id == null || Date.parse(e.at) > cut) continue;
    if (e.kind === 'quote.opened') opened.add(id);
    else if (e.kind === 'quote.hired_other') hiredOther.add(id);
    else hiredOther.delete(id);
  }
  return { opened, hiredOther };
}

// expireAfterDays Infinity reads statuses only (an instance without priceLearning settings).
export function quoteResults(ledger, { asOf, expireAfterDays }) {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) throw new TypeError('quoteResults needs asOf');
  if (!(expireAfterDays > 0)) throw new RangeError('expireAfterDays must be positive, got ' + expireAfterDays);
  const cut = asOf.getTime();
  const observed = ledger.listOutbox({ kinds: ['quote'], statuses: ['observed'] });
  const decided = decidedThreads(ledger);
  const acts = chatActs(ledger, cut);
  const out = [];
  for (const q of ledger.listQuotes()) {
    const src = sourceRow(q, observed);
    const sent = sentAt(q, src);
    const at = Date.parse(sent);
    if (at > cut) continue;
    // A customer who hired another pro decided this quote: lost at once, never aged or superseded. Accepted stays
    // won whatever the chat showed before the hire.
    const lostToOther = q.status === 'sent' && acts.hiredOther.has(q.id);
    // A quote still sent on a thread whose deal moved on was passed over for another quote of that deal: it is
    // neither won nor lost, and it never ages into expired.
    const superseded = q.status === 'sent' && !lostToOther && decided.has(q.threadId);
    const aged = q.status === 'sent' && !lostToOther && !superseded && cut - at >= expireAfterDays * DAY_MS;
    const result = q.status === 'accepted' ? 'won' : q.status === 'declined' || lostToOther ? 'lost' : q.status === 'expired' || aged ? 'expired' : superseded ? 'superseded' : 'open';
    out.push({ source: 'quote', id: q.id, threadId: q.threadId, platform: q.platform, service: q.service ?? src?.payload?.service ?? null, at: sent, amountKRW: q.amountKRW, costKRW: q.costKRW ?? 0, result, aged, cause: lostToOther ? 'hired_other' : null, opened: acts.opened.has(q.id), index: priceIndex(q.amountKRW, src?.payload?.decision?.quote?.pricing) });
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
  const unlinked = new Set(ledger.db.prepare("SELECT ref, payload, at FROM events WHERE platform = ? AND kind LIKE 'quote.%'").all(platform).filter((e) => Date.parse(e.at) >= since && Date.parse(e.at) <= now.getTime() && JSON.parse(e.payload ?? '{}').quoteId == null && JSON.parse(e.payload ?? '{}').unlinked).map((e) => e.ref));
  return {
    days, sent: rows.length, opened: rows.filter((r) => r.opened).length, hiredUs: rows.filter((r) => r.result === 'won').length,
    hiredOther: rows.filter((r) => r.cause === 'hired_other').length, noAnswer: rows.filter((r) => r.result === 'open').length,
    unlinked: unlinked.size, opensKnown: ledger.listThreads({ platform }).some((t) => t.meta?.funnel),
  };
}
