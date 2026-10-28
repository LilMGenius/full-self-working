// scriptedSurface: a 003 Surface for tests. send, quote and (when methods names it) propose refuse through
// verifyAuthorization of src/core/authz.mjs unless the drain's token covers the thread, kind and arguments, and
// payRequest refuses the same way and throws unless approved is true (the refusal contract of the adapters).
// A scripted surface stands in for whichever platform drains it, so the token is checked against that platform
// unless the platform option names one. Every call is logged. receipts
// maps a method to a queue (or a function) of receipts; an Error in it is thrown. methods lists the
// optional methods the surface has (payRequest, propose, orders), so handles sees exactly those.
import { mintAuthorization, verifyAuthorization } from '../../src/core/authz.mjs';
import { outboxKey } from '../../src/core/ledger.mjs';
import { unauthorized } from '../../src/surface/shared.mjs';

// The token the drain would mint for a row of this platform, thread and kind that hands the surface these
// arguments, and the arguments with that token, for tests that call a surface write directly (src/core/authz.mjs).
export const tokenFor = (platform, ref, kind, args = {}) => mintAuthorization({ key: outboxKey({ platform, threadRef: String(ref), kind, text: args.text }) }, args);
export const signed = (platform, ref, kind, args = {}) => ({ ...args, authorized: tokenFor(platform, ref, kind, args) });

export function scriptedSurface({ platform = null, login = { loggedIn: true }, sense = [], threads = {}, receipts = {}, methods = ['payRequest'], orders = null } = {}) {
  const calls = [];
  const why = (ref, kinds, args) => verifyAuthorization(args, { platform: platform ?? String(args.authorized?.key ?? '').split(':')[0], ref: String(ref), kinds });
  const next = (method, ...args) => {
    const q = receipts[method];
    const r = typeof q === 'function' ? q(...args) : Array.isArray(q) && q.length ? q.shift() : { observed: true };
    if (r instanceof Error) throw r;
    return r;
  };
  const count = (name) => calls.filter((c) => c.name === name).length;
  const s = {
    platform: 'test',
    calls,
    count,
    login: async () => login,
    sense: async () => (typeof sense === 'function' ? sense() : sense),
    read: async (ref, opts = {}) => {
      calls.push({ name: 'read', ref, opts });
      const t = typeof threads === 'function' ? threads(ref, opts) : threads[ref];
      if (t instanceof Error) throw t;
      return t ?? { ref, messages: [], notices: [] };
    },
    send: async (ref, args) => {
      const refused = why(ref, ['message', 'delivery'], args);
      if (refused) return unauthorized(refused);
      calls.push({ name: 'send', ref, args });
      return next('send', ref, args);
    },
    quote: async (ref, args) => {
      const refused = why(ref, ['quote'], args);
      if (refused) return unauthorized(refused);
      calls.push({ name: 'quote', ref, args });
      return next('quote', ref, args);
    },
    stop: async () => {},
  };
  if (methods.includes('payRequest')) {
    s.payRequest = async (ref, args) => {
      const refused = why(ref, ['pay_request'], args);
      if (refused) return unauthorized(refused);
      if (args.approved !== true) throw Object.assign(new Error('payRequest needs an approved operator item'), { code: 'FSW_PAY_REQUEST_REFUSED' });
      calls.push({ name: 'payRequest', ref, args });
      return next('payRequest', ref, args);
    };
  }
  if (methods.includes('propose')) {
    s.propose = async (ref, args) => {
      const refused = why(ref, ['proposal'], args);
      if (refused) return unauthorized(refused);
      calls.push({ name: 'propose', ref, args });
      return next('propose', ref, args);
    };
  }
  if (methods.includes('orders')) s.orders = async () => (typeof orders === 'function' ? orders() : orders);
  return s;
}
