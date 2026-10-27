// Freelancer.com behind the surface interface (003). Its projects read through the public API with no login
// (publicSense), so the loop keeps sensing them in observe mode while the operator's session is signed out;
// the sign-in check runs in his BrowserSkill session. No bid form is mapped yet, so every write refuses by
// name before anything is typed. Page knowledge stays in src/platforms/freelancer.
import { targetsFor } from '../economics/catalog.mjs';
import { AdapterRefusal } from '../platforms/kit.mjs';
import { fetchApi, listProjects, readProject, readSelf } from '../platforms/freelancer/projects.mjs';
import { readKind } from './shared.mjs';

export const FORM_UNMAPPED = 'FSW_FREELANCER_FORM_UNMAPPED';

const unmapped = (what) => {
  throw new AdapterRefusal(FORM_UNMAPPED, 'the freelancer ' + what + ' form is not mapped from a signed-in recording; nothing was typed');
};

// A project lists the many jobs (skills) its client tagged; the service label is the first catalog job
// among them, in catalog order, so triage maps it onto the catalog as it maps a soomgo category.
const labelOf = (jobs, names) => names.find((n) => jobs.includes(n)) ?? null;

// quoteCostKRW stays null: what a bid costs is read from the bid form, which the list cannot see.
export const inboundOfProject = (p, names) => ({
  platform: 'freelancer', ref: String(p.id), kind: 'request', at: p.submitDate, unread: false, service: labelOf(p.jobs, names), preview: p.title,
  notice: null, status: null, hired: null, quotable: p.open, expiresAt: p.closesAt, quoteCostKRW: null, requestId: null, customer: null, quote: null, quoteCount: p.bidCount,
});

export const threadOfProject = (p) => ({
  platform: 'freelancer', ref: String(p.id), kind: 'request', stage: 'pre_order', customer: null, title: p.title, language: null, quoteCostKRW: null, budget: p.budget, quoteCount: p.bidCount,
  messages: [{ direction: 'in', text: [p.title, p.description].filter(Boolean).join('\n'), at: p.submitDate, externalId: 'request' }],
  notices: [],
});

export async function openFreelancerSurface({ session, fetchJson = fetchApi, targets = targetsFor('freelancer') } = {}) {
  const names = targets.map((t) => t.category);
  return {
    platform: 'freelancer',
    session,
    publicSense: true,
    login: () => readSelf(session),
    sense: async () => (await listProjects({ targets, fetchJson })).projects.map((p) => inboundOfProject(p, names)),
    // A project has no conversation before a bid, so read takes kind request and refuses a message.
    read: async (ref, { kind } = {}) => (readKind(kind, ['request']), threadOfProject(await readProject(ref, { fetchJson }))),
    send: async () => unmapped('message'),
    quote: async () => unmapped('quote'),
    propose: async () => unmapped('bid'),
    stop: async () => session?.stop?.(),
  };
}
