// 숨고 behind the surface interface (003). Page knowledge stays in src/platforms/soomgo; this file maps
// shapes only. A request has no chat yet, so its read is one inbound message built from its answers, the
// rule of src/pipeline/thread.mjs:86-90 at 2c77326.
import { AdapterRefusal } from '../platforms/kit.mjs';
import { REQUEST_FULL, openSoomgo } from '../platforms/soomgo/adapter.mjs';
import { authorizedSend, messageOf, readKind, receiptOf, unauthorized } from './shared.mjs';

const base = { platform: 'soomgo', notice: null, status: null, hired: null, otherProHired: null, quotable: null, expiresAt: null, quoteCostKRW: null, requestId: null, quote: null, quoteCount: null };

export const inboundOfChat = (c) => ({
  ...base, ref: String(c.id), kind: 'message', at: c.at ?? null, unread: c.unread === true, service: c.service ?? null, preview: c.preview ?? null,
  notice: c.notice ?? null, status: c.status ?? null, hired: c.hired ?? null, otherProHired: c.otherProHired ?? null, requestId: c.requestId == null ? null : String(c.requestId), customer: c.customer ?? null, quote: c.quote ?? null,
});

export const inboundOfRequest = (r) => ({
  ...base, ref: String(r.id), kind: 'request', at: r.at ?? null, unread: r.unread === true, service: r.service ?? null, preview: r.preview ?? null,
  quotable: r.quotable !== false, expiresAt: r.expiresAt ?? null, customer: r.customer ?? null, quoteCount: r.quoteCount ?? null,
});

export const threadOfChat = (t) => ({
  platform: 'soomgo', ref: String(t.id), kind: 'message', stage: 'pre_order', customer: t.customer ?? null, title: null, language: null, quoteCostKRW: null, budget: null,
  messages: t.messages.map(messageOf), notices: t.notices.map((n) => ({ kind: n.type ?? null, text: n.text, at: n.at ?? null })),
});

export const threadOfRequest = (d) => ({
  platform: 'soomgo', ref: String(d.id), kind: 'request', stage: 'pre_order', customer: null, title: d.service ?? null, language: null, quoteCostKRW: d.quoteCostKRW ?? null, budget: d.budget ?? null, quoteCount: d.quoteCount ?? null,
  messages: [{ direction: 'in', text: [d.service, ...(d.answers ?? []).map((x) => (x.q ? x.q + ': ' : '') + x.a)].filter(Boolean).join('\n'), at: null, externalId: 'request' }],
  notices: [],
});

export async function openSoomgoSurface({ session, sleep } = {}) {
  const a = await openSoomgo({ session, ...(sleep ? { sleep } : {}) });
  return {
    platform: 'soomgo',
    session: a.session,
    login: () => a.login(),
    // Chats first, then requests: one list page each, nothing opened.
    sense: async () => [...(await a.inbox()).map(inboundOfChat), ...(await a.requests()).map(inboundOfRequest)],
    read: async (ref, { willReply = false, kind } = {}) => (readKind(kind) === 'request' ? threadOfRequest(await a.readRequest(ref)) : threadOfChat(await a.readThread(ref, { willReply }))),
    send: async (ref, { text, files = [], authorized } = {}) => {
      const why = authorizedSend(authorized, { platform: 'soomgo', ref: String(ref), kinds: ['message', 'delivery'], text });
      return why ? unauthorized(why) : receiptOf(await a.send(ref, { text, files, gate: { ok: true } }));
    },
    // A request soomgo calls full took no quote and no cash, so it is thrown for the drain to mark the row
    // stale (its STALE_NOT_SENT list) instead of an unobserved press.
    quote: async (ref, { amountKRW, priceType = 'fixed', text, authorized, allowSpendCash = false, customer = null } = {}) => {
      const why = authorizedSend(authorized, { platform: 'soomgo', ref: String(ref), kinds: ['quote'], text });
      if (why) return unauthorized(why);
      const r = await a.quote(ref, { amountKRW, priceType, text, gate: { ok: true }, allowSpendCash, customer });
      if (r.code === REQUEST_FULL) throw new AdapterRefusal(r.code, r.reason);
      return receiptOf(r);
    },
    // A payment request is operator only (003): approved stays the flag, and the token proves the drain minted it
    // for an approved pay_request row of this thread.
    payRequest: async (ref, { amountKRW, approved = false, authorized } = {}) => {
      const why = approved === true ? authorizedSend(authorized, { platform: 'soomgo', ref: String(ref), kinds: ['pay_request'], text: '' }) : 'a pay request needs the operator approval';
      return why ? unauthorized(why) : receiptOf(await a.payRequest(ref, { amountKRW, approved }));
    },
    // soomgo has no order list: a hire is a chat row (Inbound.hired, from sense) and its 숨고페이 notices, so
    // orders gives the hired chat count without rows or counters, which raises no counter alert.
    orders: async () => ({ counts: null, total: (await a.orders()).length, gap: 'soomgo has no order list; hires are chat rows from sense', orders: null }),
    // 003 reviews?(): counts from /profile (리뷰수, 리뷰 평점); rows join once the review list is mapped (U6.6).
    // One page load: a signed-out account lands somewhere other than /profile, which is the sign-in check.
    reviews: async () => {
      const { profile: seller, url } = await a.profile();
      const path = new URL(url).pathname;
      if (path !== '/profile') return { counts: null, rows: null, gap: 'soomgo /profile opened ' + path + ', so the account is not signed in' };
      return { counts: { reviews: seller.reviews, rating: seller.rating }, rows: null, gap: 'review rows are not parsed yet' };
    },
    supply: async () => ({ platform: 'soomgo', listings: null, services: await a.services() }),
    // What the platform spends on its own beside fsw's quotes (smart quote campaigns, other charges).
    spend: (opts) => a.spend(opts),
    stop: () => a.stop(),
  };
}
