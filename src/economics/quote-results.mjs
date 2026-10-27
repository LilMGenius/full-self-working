// What became of every quote fsw sent, replayed from the ledger (docs/DESIGN.md, Economics): won, lost,
// expired, refused or still open, each with the price index it went out at when its pricing basis is known.
// Nothing here writes; the same ledger and the same day give the same list, which the price table
// (price-learning.mjs) and the allocation (yield.mjs) both read, so neither counts a quote its own way.
export const QUOTE_RESULTS = ['won', 'lost', 'expired', 'refused', 'open'];
const DAY_MS = 86_400_000;

// 00:00 Seoul of a dayKey (YYYYMMDD, src/core/clock.mjs): the instant a day's table and allocation are
// computed as of, so a rerun later that day sees the same cases.
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

// expireAfterDays Infinity reads statuses only (an instance without priceLearning settings).
export function quoteResults(ledger, { asOf, expireAfterDays }) {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) throw new TypeError('quoteResults needs asOf');
  if (!(expireAfterDays > 0)) throw new RangeError('expireAfterDays must be positive, got ' + expireAfterDays);
  const cut = asOf.getTime();
  const observed = ledger.listOutbox({ kinds: ['quote'], statuses: ['observed'] });
  const out = [];
  for (const q of ledger.listQuotes()) {
    const src = sourceRow(q, observed);
    const sent = sentAt(q, src);
    const at = Date.parse(sent);
    if (at > cut) continue;
    const aged = q.status === 'sent' && cut - at >= expireAfterDays * DAY_MS;
    const result = q.status === 'accepted' ? 'won' : q.status === 'declined' ? 'lost' : q.status === 'expired' || aged ? 'expired' : 'open';
    out.push({ source: 'quote', id: q.id, threadId: q.threadId, platform: q.platform, service: q.service ?? src?.payload?.service ?? null, at: sent, amountKRW: q.amountKRW, costKRW: q.costKRW ?? 0, result, aged, index: priceIndex(q.amountKRW, src?.payload?.decision?.quote?.pricing) });
  }
  // A send the platform refused before the client saw it (the drain's STALE_NOT_SENT): no quote row exists.
  for (const r of ledger.listOutbox({ kinds: ['quote'], statuses: ['stale'] })) {
    if (!r.receipt?.refused || Date.parse(r.createdAt) > cut) continue;
    out.push({ source: 'outbox', id: r.id, threadId: r.threadId, platform: r.platform, service: r.payload?.service ?? null, at: r.createdAt, amountKRW: r.payload?.amountKRW ?? null, costKRW: 0, result: 'refused', aged: false, index: null, code: r.receipt.refused });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.source.localeCompare(b.source) || a.id - b.id);
}
