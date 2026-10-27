// 크몽 behind the surface interface (003): the conversation half for the loop, the gig half as a listing
// surface for the listings job. Page knowledge stays in src/platforms/kmong; this file maps shapes only.
import { loadInstance } from '../core/instance.mjs';
import { AdapterRefusal } from '../platforms/kit.mjs';
import { openKmongConversation } from '../platforms/kmong/conversation.mjs';
import { openKmongListing } from '../platforms/kmong/listing.mjs';
import { sample } from '../platforms/kmong/market.mjs';
import { openProjectReader, openProjectSeller } from '../platforms/kmong/projects.mjs';
import { authorizedSend, messageOf, readKind, receiptOf, unauthorized } from './shared.mjs';

// Refusals seller.propose returns before it types anything: the day's quota is spent, or 제안하기 opened
// the enterprise profile registration in place of the form. They are thrown so the drain returns the row
// (its NOT_SENT list) instead of reading them as an unobserved send.
export const NOT_TYPED = ['FSW_KMONG_QUOTA_SPENT', 'FSW_KMONG_ENTERPRISE_PROFILE'];
// A project that closed or passed its deadline before the send: nothing is typed, and the drain marks the
// row stale (its STALE_NOT_SENT list) instead of asking the operator to settle a send that never started.
export const PROJECT_CLOSED = 'FSW_KMONG_PROJECT_CLOSED';

// The form asks 세금계산서 발행 여부; the answer is the instance's business.taxInvoice, read at send time.
const taxInvoiceOf = (business) => business()?.taxInvoice ?? null;

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

export async function openKmongSurface({ session, openReader = openProjectReader, openSeller = openProjectSeller, business = () => loadInstance().business } = {}) {
  const a = await openKmongConversation({ session });
  return {
    platform: 'kmong',
    session: a.session,
    login: () => a.login(),
    // The email sign-in the supervisor uses when kmong signed out (36400c4); the values go only into the form.
    signIn: (login) => a.signIn(login),
    sense: async () => (await a.inbox()).map(inboundOf),
    // kmong has conversations only, so read takes kind message and refuses a request.
    read: async (ref, { willReply = false, kind } = {}) => (readKind(kind, ['message']), threadOf(await a.readThread(ref, { willReply }))),
    send: async (ref, { text, files = [], authorized } = {}) => (authorizedSend(authorized) ? receiptOf(await a.send(ref, { text, files, gate: { ok: true } })) : unauthorized()),
    // kmong has no mapped quote form: a price goes out as a message the loop plans as kind message.
    quote: async () => ({ observed: false, reason: 'kmong has no mapped quote form; send the price as a message' }),
    orders: () => a.orders(),
    // 003 reviews?(): counts from the public profile; rows join once pageReviewRows is mapped (U6.6). The
    // dashboard read that finds the nickname is also the sign-in check, so the review pass needs no login()
    // of its own. The page's profile is named seller, since scripts/check-example.mjs reads profile.x as
    // an instance key.
    reviews: async () => {
      const { login, profile: seller } = await a.profile();
      if (!login.loggedIn) return { counts: null, rows: null, gap: 'kmong is not signed in, so the public profile was not read' };
      if (!seller) return { counts: null, rows: null, gap: 'no nickname on the dashboard, so the public profile was not read' };
      return { counts: { reviews: seller.reviews, rating: seller.rating }, rows: null, gap: 'review rows are not parsed yet' };
    },
    supply: async () => ({ platform: 'kmong', listings: (await openKmongListing({ session: a.session }).then((l) => l.listings())).gigs, services: null }),
    // The frontier reference set (AGENTS.md frontierTargets): the top cards of each target's category page,
    // one page load per target, with their cover image URLs. Rows keep no seller name past this read.
    frontier: (targets, { perCategory = 3 } = {}) => sample(a.session, targets, { limit: perCategory }),
    // An enterprise proposal (003 propose; ref is the project thread's externalId, project:<id>). The
    // project is read first for its title, which the read-back on /seller/proposals matches, and its
    // status; then the projects page module fills the form, reads every field back, submits and looks for
    // the proposal on /seller/proposals. The seller shares this surface's session, which stop() ends.
    // Known gap (003 Surface): authorized is checked by verdict only until wp9's src/core/authz.mjs.
    propose: async (ref, { text, amountKRW, phases = [], authorized } = {}) => {
      if (!authorizedSend(authorized)) return unauthorized();
      const id = Number(String(ref).replace(/^project:/, ''));
      const reader = await openReader();
      let project;
      try {
        project = await reader.readProject(id);
      } finally {
        await reader.close();
      }
      if (project.status !== 'APPROVAL' || (Number.isInteger(project.deadlineDays) && project.deadlineDays < 0)) throw new AdapterRefusal(PROJECT_CLOSED, 'project ' + id + ' is ' + project.status + '; nothing was typed');
      const seller = await openSeller({ session: a.session });
      const res = await seller.propose(project, { text, totalKRW: amountKRW, phases }, { gate: { ok: true }, taxInvoice: taxInvoiceOf(business) });
      if (!res.submitted && NOT_TYPED.includes(res.code)) throw new AdapterRefusal(res.code, res.reason);
      return receiptOf({ ...res, observedSnippet: res.label ?? null });
    },
    stop: () => a.stop(),
  };
}

export const openKmongListingSurface = ({ session } = {}) => openKmongListing({ session });

// Fills the proposal form and reads it back without submitting (dryRun), behind the caller's gate result,
// so the operator can rehearse a proposal; nothing reaches the platform and no outbox row is written.
export async function proposalDryRun(project, proposal, { gate, openSeller = openProjectSeller, business = () => loadInstance().business } = {}) {
  const seller = await openSeller();
  try {
    return await seller.propose(project, proposal, { gate, dryRun: true, taxInvoice: taxInvoiceOf(business) });
  } finally {
    await seller.stop();
  }
}
