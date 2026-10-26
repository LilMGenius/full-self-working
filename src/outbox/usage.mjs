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
