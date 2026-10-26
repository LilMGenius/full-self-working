// scriptedSurface: a 003 Surface for tests. send, quote and (when methods names it) propose refuse through
// authorizedSend of src/surface/shared.mjs unless authorized.verdict is send, and payRequest throws unless
// approved is true (the refusal contract of the soomgo and kmong adapters). Every call is logged. receipts
// maps a method to a queue (or a function) of receipts; an Error in it is thrown. methods lists the
// optional methods the surface has (payRequest, propose, orders), so handles sees exactly those.
import { authorizedSend, unauthorized } from '../../src/surface/shared.mjs';

export function scriptedSurface({ login = { loggedIn: true }, sense = [], threads = {}, receipts = {}, methods = ['payRequest'], orders = null } = {}) {
  const calls = [];
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
      if (!authorizedSend(args.authorized)) return unauthorized();
      calls.push({ name: 'send', ref, args });
      return next('send', ref, args);
    },
    quote: async (ref, args) => {
      if (!authorizedSend(args.authorized)) return unauthorized();
      calls.push({ name: 'quote', ref, args });
      return next('quote', ref, args);
    },
    stop: async () => {},
  };
  if (methods.includes('payRequest')) {
    s.payRequest = async (ref, args) => {
      if (args.approved !== true) throw Object.assign(new Error('payRequest needs an approved operator item'), { code: 'FSW_PAY_REQUEST_REFUSED' });
      calls.push({ name: 'payRequest', ref, args });
      return next('payRequest', ref, args);
    };
  }
  if (methods.includes('propose')) {
    s.propose = async (ref, args) => {
      if (!authorizedSend(args.authorized)) return unauthorized();
      calls.push({ name: 'propose', ref, args });
      return next('propose', ref, args);
    };
  }
  if (methods.includes('orders')) s.orders = async () => (typeof orders === 'function' ? orders() : orders);
  return s;
}
