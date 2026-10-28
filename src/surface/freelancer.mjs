// Freelancer.com behind the surface interface (003). Its projects read through the public API with no login
// (publicSense), so the loop keeps sensing them in observe mode while the operator's session is signed out;
// the sign-in check, the bid gate and the reputation read run in his BrowserSkill session. No bid form is
// mapped yet, so every write refuses by name before anything is typed. Page knowledge stays in
// src/platforms/freelancer.
import { targetsFor } from '../economics/catalog.mjs';
import { AdapterRefusal } from '../platforms/kit.mjs';
import { BALANCE, FORM_UNMAPPED, NO_BIDS, STEPS, bidCostKRW, bidRefusal, readBidState } from '../platforms/freelancer/bid.mjs';
import { fetchApi, listProjects, readProject, readReputation, readSelf, signInWithGoogle } from '../platforms/freelancer/projects.mjs';
import { verifyAuthorization } from '../core/authz.mjs';
import { readKind, unauthorized } from './shared.mjs';

export { FORM_UNMAPPED };
// Every refusal propose throws before it types anything, so the drain returns the row instead of reading
// it as an unobserved send (as kmong's NOT_TYPED).
export const BID_NOT_TYPED = [BALANCE, STEPS, NO_BIDS, FORM_UNMAPPED];

const unmapped = (what) => {
  throw new AdapterRefusal(FORM_UNMAPPED, 'the freelancer ' + what + ' form is not mapped from a signed-in recording; nothing was typed');
};

// A project lists the many jobs (skills) its client tagged; the service label is the first catalog job
// among them, in catalog order, so triage maps it onto the catalog as it maps a soomgo category.
const labelOf = (jobs, names) => names.find((n) => jobs.includes(n)) ?? null;

// quoteCostKRW stays null on the list: what a bid costs is read in the signed-in session when the thread is
// read to reply.
export const inboundOfProject = (p, names) => ({
  platform: 'freelancer', ref: String(p.id), kind: 'request', at: p.submitDate, unread: false, service: labelOf(p.jobs, names), preview: p.title,
  notice: null, status: null, hired: null, quotable: p.open, expiresAt: p.closesAt, quoteCostKRW: null, requestId: null, customer: null, quote: null, quoteCount: p.bidCount,
});

// currency is the project's own (a bid states its amount in it); bid is the gate read when the thread is
// read to reply, null otherwise.
export const threadOfProject = (p, state = null) => ({
  platform: 'freelancer', ref: String(p.id), kind: 'request', stage: 'pre_order', customer: null, title: p.title, language: null, quoteCostKRW: state ? bidCostKRW(state) : null, budget: p.budget, currency: p.currency, quoteCount: p.bidCount,
  messages: [{ direction: 'in', text: [p.title, p.description].filter(Boolean).join('\n'), at: p.submitDate, externalId: 'request' }],
  notices: [],
  bid: state ? { bidsLeft: state.bidsLeft, refused: bidRefusal(state).code } : null,
});

export async function openFreelancerSurface({ session, fetchJson = fetchApi, targets = targetsFor('freelancer'), google } = {}) {
  const names = targets.map((t) => t.category);
  return {
    platform: 'freelancer',
    session,
    publicSense: true,
    login: () => readSelf(session),
    // The Google sign-in the supervisor uses when the session signed out; email is the operator's Google
    // account from the identity file, and a password or second-factor prompt stays his.
    signIn: ({ email }) => signInWithGoogle(session, { email, ...(google ? { google } : {}) }),
    sense: async () => (await listProjects({ targets, fetchJson })).projects.map((p) => inboundOfProject(p, names)),
    // A project has no conversation before a bid, so read takes kind request and refuses a message. Read to
    // reply, it also reads the bid gate (two page loads), which sets the bid's cost; an observe read loads
    // nothing in the session.
    read: async (ref, { kind, willReply = false } = {}) => {
      readKind(kind, ['request']);
      const p = await readProject(ref, { fetchJson });
      return threadOfProject(p, willReply ? await readBidState(session, p) : null);
    },
    send: async (ref, args = {}) => {
      const why = verifyAuthorization(args, { platform: 'freelancer', ref: String(ref), kinds: ['message', 'delivery'] });
      return why ? unauthorized(why) : unmapped('message');
    },
    quote: async (ref, args = {}) => {
      const why = verifyAuthorization(args, { platform: 'freelancer', ref: String(ref), kinds: ['quote'] });
      return why ? unauthorized(why) : unmapped('quote');
    },
    // Every bid is refused by name before anything is typed: the balance, the profile steps, the free bids,
    // then the unmapped form (src/platforms/freelancer/bid.mjs bidRefusal).
    propose: async (ref, args = {}) => {
      const why = verifyAuthorization(args, { platform: 'freelancer', ref: String(ref), kinds: ['proposal'] });
      if (why) return unauthorized(why);
      const r = bidRefusal(await readBidState(session, await readProject(ref, { fetchJson })));
      throw new AdapterRefusal(r.code, r.reason);
    },
    // The rehearsal of a bid: reads the gate and says what would refuse it. It types and presses nothing.
    dryRun: async (ref) => {
      const state = await readBidState(session, await readProject(ref, { fetchJson }));
      const r = bidRefusal(state);
      return { dryRun: true, typed: false, refused: r.code, reason: r.reason, bidsLeft: state.bidsLeft, steps: state.steps, unlock: state.unlock !== null, form: state.form, quoteCostKRW: bidCostKRW(state) };
    },
    // 003 reviews?(): the count and rating from the self API's reputation, and state, the seller state the
    // caller writes for the price table (platforms/freelancer-state.json).
    reviews: async () => {
      const rep = await readReputation(session);
      if (!rep) return { counts: null, rows: null, gap: 'the self API gave no review count' };
      return { counts: { reviews: rep.reviews, rating: rep.rating }, rows: null, gap: 'review rows are not parsed yet', state: { reviews: { count: rep.reviews }, account: { totalJobs: rep.completed } } };
    },
    stop: async () => session?.stop?.(),
  };
}
