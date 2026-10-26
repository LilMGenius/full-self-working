// 크몽 behind the surface interface (003): the conversation half for the loop, the gig half as a listing
// surface for the listings job. Page knowledge stays in src/platforms/kmong; this file maps shapes only.
import { openKmongConversation } from '../platforms/kmong/conversation.mjs';
import { openKmongListing } from '../platforms/kmong/listing.mjs';
import { authorizedSend, messageOf, readKind, receiptOf, unauthorized } from './shared.mjs';

export const inboundOf = (r) => ({
  platform: 'kmong', ref: String(r.id), kind: 'message', at: r.at ?? null, unread: r.unread === true, service: null, preview: r.preview ?? null,
  notice: null, status: null, hired: null, quotable: null, expiresAt: null, quoteCostKRW: null, requestId: null, customer: r.customer ?? null, quote: null,
});

// The 문의 서비스 card of a thread opened from a gig names the gig; it is the thread's title.
export const threadOf = (t) => ({
  platform: 'kmong', ref: String(t.id), kind: 'message', stage: t.stage ?? 'pre_order', customer: t.customer ?? null,
  title: t.messages.find((m) => m.inquiry)?.inquiry.gigTitle ?? null, language: null, quoteCostKRW: null, budget: null,
  messages: t.messages.map(messageOf), notices: [],
});

export async function openKmongSurface({ session } = {}) {
  const a = await openKmongConversation({ session });
  return {
    platform: 'kmong',
    session: a.session,
    login: () => a.login(),
    sense: async () => (await a.inbox()).map(inboundOf),
    // kmong has conversations only, so read takes kind message and refuses a request.
    read: async (ref, { willReply = false, kind } = {}) => (readKind(kind, ['message']), threadOf(await a.readThread(ref, { willReply }))),
    send: async (ref, { text, files = [], authorized } = {}) => (authorizedSend(authorized) ? receiptOf(await a.send(ref, { text, files, gate: { ok: true } })) : unauthorized()),
    // kmong has no mapped quote form: a price goes out as a message the loop plans as kind message.
    quote: async () => ({ observed: false, reason: 'kmong has no mapped quote form; send the price as a message' }),
    orders: () => a.orders(),
    supply: async () => ({ platform: 'kmong', listings: (await openKmongListing({ session: a.session }).then((l) => l.listings())).gigs, services: null }),
    stop: () => a.stop(),
  };
}

export const openKmongListingSurface = ({ session } = {}) => openKmongListing({ session });
