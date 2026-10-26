// What every surface returns, mapped from the 2c77326 adapter results (003 Surface): Receipt, the refusal a
// write gives without an authorize verdict of send, the read kinds, and the Thread message shape.
import { AdapterRefusal } from '../platforms/kit.mjs';

export const receiptOf = (r) => ({
  observed: r?.observed === true,
  ...(r?.externalId != null ? { externalId: String(r.externalId) } : {}),
  ...(typeof r?.text === 'string' ? { text: r.text } : {}),
  ...(typeof r?.cashSpentKRW === 'number' ? { cashSpentKRW: r.cashSpentKRW } : {}),
  ...(r?.observedSnippet ? { snippet: r.observedSnippet } : {}),
  ...(r?.reason ? { reason: r.reason } : {}),
});

// Every surface write (send, quote, payRequest, propose) goes to the page only with authorize()'s verdict
// send; the 2c77326 adapters keep refusing without gate.ok, which the surface sets only here, and payRequest
// also needs approved.
// Known gap: the token is the authorize() result itself and is bound to no outbox row or payload, so
// in-process code could build one by hand for any of these writes, payRequest included; wp9 closes it with
// src/core/authz.mjs, whose {key, digest, mac} over the row key and the text or amount the drain sends is
// checked here.
export const authorizedSend = (authorized) => authorized?.verdict === 'send';
export const unauthorized = () => ({ observed: false, reason: 'not authorized: a write needs the authorize() verdict send' });

// read's kind tells a soomgo request id from a chat id (003); a kind the platform does not have is refused
// before any page loads.
export function readKind(kind = 'message', kinds = ['message', 'request']) {
  if (!kinds.includes(kind)) throw new AdapterRefusal('FSW_READ_KIND', 'read kind ' + kind + ' is not one of ' + kinds.join(', '));
  return kind;
}

export const messageOf = ({ direction, text, at, externalId }) => ({ direction, text, at: at ?? null, externalId });
