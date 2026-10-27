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

// Bids for one platform (authorize's bidBudgetCheck): the Seoul month's spend of the proposals that went out
// or may have (observed, an interrupted sending, an unobserved press the operator has not settled), at the
// cost the page reported or else the planned one, and how many of those proposals have had no inbound message
// on their thread since. The drain sets a proposal observed before it judges the next row, so a second
// proposal in the same drain already counts the first.
export function bidUsage(ledger, platform, now = new Date()) {
  const month = dayKey(now).slice(0, 6);
  const sent = ledger.listOutbox({ platform, statuses: ['observed', 'sending', 'unobserved'], kinds: ['proposal'] });
  const replied = (row) => ledger.threadMessages(row.threadId).some((m) => m.direction === 'in' && Date.parse(m.at) > Date.parse(row.updatedAt));
  return {
    bidMonthKRW: sent.filter((r) => dayKey(new Date(r.updatedAt)).slice(0, 6) === month).reduce((s, r) => s + (r.receipt?.cashSpentKRW ?? r.payload.costKRW ?? 0), 0),
    bidUnanswered: sent.filter((r) => !replied(r)).length,
  };
}
