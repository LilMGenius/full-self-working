// The quote funnel from the chat list (U7.Q): soomgo's chat rows say whether the customer opened our quote and
// whether they hired us or another pro (src/platforms/soomgo/parse.mjs parseChats), on the list every poll
// already loads. recordFunnel keeps a change-only record of those acts: the last state seen sits on the chat
// thread's meta.funnel, and a quote.* event is written only when a fact changes, so a repeat poll writes nothing
// (AGENTS.md changeOnlyWhatChanged). It never writes quotes.status or a job: the deal owns those, and our own
// hire reaches it through the row's status as before (src/deal/signals.mjs). Its event kinds are FUNNEL_EVENTS in
// src/economics/quote-results.mjs, which reads them.
import { transaction } from '../core/tx.mjs';

// other_provider_hire_status values the code reads as a hire of another pro: the word soomgo's hire_status uses
// for a hire. Every value recorded so far is null (test/fixtures/surfaces/soomgo/shapes.json), so this list
// grows only from a recorded page.
export const OTHER_HIRED = ['hired'];
// The hire_status words for a hire that ended (src/deal/signals.mjs): a hire of another pro that ended.
export const ENDED_HIRE = ['customer_cancelled', 'rejected'];

// Any other non-null value is unknown: recorded with unknown: true, told to the operator once per value, and
// counted as nothing until a recorded page says what it means.
const stateOf = (ib) => {
  const other = ib.otherProHired ?? null;
  return { opened: ib.quote?.opened === true, hiredUs: ib.status === 'hired', hiredOther: OTHER_HIRED.includes(other), otherStatus: other, otherUnknown: other != null && !OTHER_HIRED.includes(other) && !ENDED_HIRE.includes(other) };
};

// The fsw quote a chat row stands for: the newest quote on the request thread the row names (soomgo quotes on
// the request, the link the deal's quotesOf follows in src/deal/advance.mjs), else one on the chat thread.
function linkOf(ledger, requests, ib, row) {
  const req = ib.requestId ? requests.get(String(ib.requestId)) ?? null : null;
  const quote = [...(req ? ledger.listQuotes({ threadId: req.id }) : []), ...ledger.listQuotes({ threadId: row.id })].sort((a, b) => a.id - b.id).at(-1) ?? null;
  const unlinked = quote ? null : !ib.requestId ? 'the row names no request' : !req ? 'request ' + ib.requestId + ' is not in the ledger' : 'no fsw quote on request ' + ib.requestId;
  return { quoteId: quote?.id ?? null, requestThreadId: req?.id ?? null, unlinked, quoteAt: quote?.at ?? null };
}

// inbound: the step's sense rows; rows: their thread rows by ref. Only a chat row whose quote carries an opened
// field is read (soomgo chats); a request row or another platform's row is left alone. Returns {written,
// effects}: effects are the operator notices for other-pro statuses no earlier poll recorded.
// refundHours (descriptor bidCost.unreadRefundHours, soomgo 48): a row that still shows our quote unopened once that
// long has passed since the quote was recorded is the platform's own word that the customer never read it, so it is
// written once as quote.unread, the evidence src/economics/quote-results.mjs expires an unread quote on. A quote whose
// chat no poll saw (one past the first list page) gets no such event and stays open.
export function recordFunnel(ledger, { platform, inbound, rows, now, refundHours = null }) {
  const requests = new Map(ledger.listThreads({ platform }).filter((t) => t.kind === 'request').map((t) => [t.externalId, t]));
  const knownOther = new Set(ledger.db.prepare("SELECT payload FROM events WHERE kind = 'quote.other_status' AND platform = ?").all(platform).map((e) => JSON.parse(e.payload).otherStatus));
  const effects = [];
  let written = 0;
  for (const ib of inbound) {
    if (ib.kind !== 'message' || !ib.quote || !('opened' in ib.quote)) continue;
    const row = rows.get(String(ib.ref));
    const link = linkOf(ledger, requests, ib, row);
    // The state belongs to the quote it was seen for: a newer fsw quote on the request starts the record over, so
    // its open and a hire of another pro are written against it (as first sight, since they may predate this poll).
    const kept = row.meta?.funnel ?? null;
    const prev = kept && kept.quoteId === link.quoteId ? kept : null;
    const next = stateOf(ib);
    next.unread = Number.isInteger(refundHours) && link.quoteId != null && ib.quote.opened === false && now.getTime() - Date.parse(link.quoteAt) >= refundHours * 3_600_000;
    const changes = [];
    if (next.opened && !prev?.opened) changes.push('quote.opened');
    if (next.unread && !prev?.unread) changes.push('quote.unread');
    if (next.hiredUs && !prev?.hiredUs) changes.push('quote.hired_us');
    if (next.hiredOther && !prev?.hiredOther) changes.push('quote.hired_other');
    if (!next.hiredOther && prev?.hiredOther) changes.push('quote.hired_other_cancelled');
    if (next.otherUnknown && next.otherStatus !== (prev?.otherStatus ?? null)) changes.push('quote.other_status');
    if (prev && !changes.length && prev.otherStatus === next.otherStatus) continue;
    const { otherUnknown, unread, ...rest } = next;
    // unread stays on the record once seen, and only then, so a record written before it keeps its shape.
    const state = { ...rest, ...(unread || prev?.unread ? { unread: true } : {}) };
    transaction(ledger, () => {
      const { quoteAt, ...linked } = link;
      for (const kind of changes) ledger.addEvent({ kind, platform, ref: String(ib.ref), at: now.toISOString(), payload: { ...linked, firstSeen: prev === null, otherStatus: next.otherStatus, ...(kind === 'quote.other_status' ? { unknown: true } : {}), rowQuote: { priceKRW: ib.quote.priceKRW ?? null, unit: ib.quote.unit ?? null } } });
      ledger.upsertThread({ platform, externalId: String(ib.ref), kind: 'message', meta: { ...(ledger.getThread(row.id).meta ?? {}), funnel: { ...state, quoteId: link.quoteId, seenAt: prev?.seenAt ?? now.toISOString() } } });
    });
    if (changes.includes('quote.other_status') && !knownOther.has(next.otherStatus)) {
      knownOther.add(next.otherStatus);
      effects.push({ type: 'notify', note: { kind: 'operator', title: platform + ' chat list shows an unknown other-pro hire status: ' + next.otherStatus, body: 'Chat ' + ib.ref + ' carries other_provider_hire_status "' + next.otherStatus + '", which fsw does not read as a hire of another pro, so it counts as nothing. Open the chat on ' + platform + ' and say what it means; the code names a hire of another pro in src/loop/funnel.mjs OTHER_HIRED.', dedupeKey: platform + '-other-pro-status:' + next.otherStatus } });
    }
    written += changes.length;
  }
  return { written, effects };
}
