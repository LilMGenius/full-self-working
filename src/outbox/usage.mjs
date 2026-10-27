// Quotes and cash for one platform on the Seoul day of now (src/pipeline/thread.mjs:56-61 at 2c77326),
// plus quotes whose send was interrupted: their cash may be spent, so they count until settled. A quote
// the surface pressed but could not confirm (receipt.pressed, 7b9524e) counts on the day it was pressed
// until the operator settles it with fsw approve <id> --sent, when the quote row the deal writes takes over.
import { dayKey } from '../core/clock.mjs';

export function quotaUsage(ledger, platform, now = new Date()) {
  const today = dayKey(now);
  const quotes = ledger.listQuotes({ platform }).filter((q) => dayKey(new Date(q.at)) === today);
  const inFlight = ledger.listOutbox({ platform, statuses: ['sending'], kinds: ['quote'] });
  const pressed = ledger.listOutbox({ platform, statuses: ['unobserved'], kinds: ['quote'] }).filter((r) => r.receipt?.pressed === true && dayKey(new Date(r.receipt.pressedAt ?? r.updatedAt)) === today);
  return {
    quotes: quotes.length + inFlight.length + pressed.length,
    cashKRW: quotes.reduce((s, q) => s + (q.costKRW ?? 0), 0) + inFlight.reduce((s, r) => s + (r.payload.costKRW ?? 0), 0) + pressed.reduce((s, r) => s + (r.receipt.costKRW ?? r.payload.costKRW ?? 0), 0),
  };
}

const knownKRW = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// What one proposal spent: the charge recorded on its receipt (the page's, or the operator's --cost), then the
// press the surface recorded, then the planned cost. The first of them present decides, and one that is not a
// finite amount of 0 or more is unknown (null), never 0.
export function bidCostOf(row) {
  const cost = [row.receipt?.cashSpentKRW, row.receipt?.costKRW, row.payload?.costKRW].find((v) => v != null);
  return knownKRW(cost) ? cost : null;
}

// Bids for one platform (authorize's bidBudgetCheck): the Seoul month's spend of the proposals that went out
// or may have (observed, an interrupted sending, an unobserved press the operator has not settled), and how
// many of those proposals have had no inbound message on their thread since. A proposal of the month whose
// cost is unknown leaves the spend uncounted (bidMonthKRW null) and is named in unknownCost, so the budget
// refuses until the operator settles it. The drain sets a proposal observed before it judges the next row, so
// a second proposal in the same drain already counts the first.
export function bidUsage(ledger, platform, now = new Date()) {
  const month = dayKey(now).slice(0, 6);
  const sent = ledger.listOutbox({ platform, statuses: ['observed', 'sending', 'unobserved'], kinds: ['proposal'] });
  const replied = (row) => ledger.threadMessages(row.threadId).some((m) => m.direction === 'in' && Date.parse(m.at) > Date.parse(row.updatedAt));
  const ofMonth = sent.filter((r) => dayKey(new Date(r.updatedAt)).slice(0, 6) === month);
  const unknownCost = ofMonth.filter((r) => bidCostOf(r) === null).map((r) => r.approvalId ?? 'outbox ' + r.id);
  return {
    bidMonthKRW: unknownCost.length ? null : ofMonth.reduce((s, r) => s + bidCostOf(r), 0),
    bidUnanswered: sent.filter((r) => !replied(r)).length,
    unknownCost,
  };
}
