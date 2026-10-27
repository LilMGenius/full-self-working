// 위시켓 behind the Surface interface (003). The project list and detail pages are public, so sense and read
// work signed out through the project reader's owned headless browser (src/platforms/wishket/projects.mjs),
// opened on the first read so a pass that only asks for login or reviews launches nothing. Applying needs the
// signed-in form, which is not mapped, so send, quote and propose throw APPLY_UNMAPPED before anything reaches
// a page; the drain reads that code as not sent (NOT_TYPED). Projects are requests: one Inbound per open 외주
// project, whose service label is the card's 위시켓 field, with no quote cost (applying is free, descriptor
// bidCost).
import { AdapterRefusal } from '../platforms/kit.mjs';
import { APPLY_UNMAPPED, openProjectReader } from '../platforms/wishket/projects.mjs';
import { readKind } from './shared.mjs';

export { APPLY_UNMAPPED };
// Every refusal a wishket write throws before it touches a page, for the drain's PROPOSAL_NOT_SENT.
export const NOT_TYPED = [APPLY_UNMAPPED];

const unmapped = (what) => {
  throw new AdapterRefusal(APPLY_UNMAPPED, 'the wishket ' + what + ' needs the signed-in apply form, which is not mapped from a recording; nothing was typed');
};

// A card shows only the date it was posted, so a project's list time is that Seoul day: it stays the same on
// every poll, and a project read once is not read again (triage needsWork).
const postedAt = (date) => (date ? date + 'T00:00:00+09:00' : null);

export const inboundOfProject = (p) => ({
  platform: 'wishket', ref: String(p.id), kind: 'request', at: postedAt(p.postedOn), unread: false, service: p.field, preview: p.title,
  notice: null, status: p.private ? 'private' : 'open', hired: null, quotable: !p.private, expiresAt: null, quoteCostKRW: 0, requestId: String(p.id), customer: null, quote: null,
});

export const threadOfProject = (p) => ({
  platform: 'wishket', ref: String(p.id), kind: 'request', stage: 'pre_order', customer: null, title: p.title, language: 'ko', quoteCostKRW: 0, budget: p.amountKRW,
  messages: [{ direction: 'in', text: p.description, at: postedAt(p.postedOn), externalId: 'request' }],
  notices: [],
});

export async function openWishketSurface({ reader = null, open = openProjectReader } = {}) {
  let r = reader;
  const opened = async () => (r ??= await open());
  return {
    platform: 'wishket',
    publicSense: true,
    // No signed-in marker is mapped, so the public board reads as signed out and the loop keeps it in observe.
    login: async () => ({ loggedIn: false, detail: 'signed-in markers unmapped; the public project list needs no login' }),
    sense: async ({ pages = 2, now = new Date() } = {}) => (await (await opened()).listProjects({ pages, now })).projects.filter((p) => p.projectType === 'task_based').map(inboundOfProject),
    read: async (ref, { kind, now = new Date() } = {}) => {
      readKind(kind, ['request']);
      return threadOfProject(await (await opened()).readProject(Number(ref), { now }));
    },
    send: async () => unmapped('message'),
    quote: async () => unmapped('quote, which an application replaces,'),
    propose: async () => unmapped('application'),
    stop: async () => r?.close(),
  };
}
