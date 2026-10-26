// The surface module's entry: one interface over every platform this build can work (003 Surface), the
// listing surface for the gig writer, and the market samplers sampling (src/economics/sampling.mjs) is
// handed. A session can be the operator's Chrome (the default), a recording wrapped around it, or a replay.
import { openSession } from '../browser/driver.mjs';
import { AdapterRefusal } from '../platforms/kit.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { recordSession, replaySession } from './recorder.mjs';

const OPENERS = {
  kmong: async () => (await import('./kmong.mjs')).openKmongSurface,
  soomgo: async () => (await import('./soomgo.mjs')).openSoomgoSurface,
};
const LISTING_OPENERS = {
  kmong: async () => (await import('./kmong.mjs')).openKmongListingSurface,
};

// Market samplers by platform. fiverr reads through the engine its descriptor or config names (attached
// by default, since the owned browser met PerimeterX; 003 Decisions of 20:30); upwork has none, since its
// public job search needs a login.
export const SAMPLERS = {
  kmong: () => import('../platforms/kmong/market.mjs'),
  soomgo: () => import('../platforms/soomgo/market.mjs'),
  freelancer: () => import('../platforms/freelancer/market.mjs'),
  wishket: () => import('../platforms/wishket/market.mjs'),
  fiverr: () => import('../platforms/fiverr/market.mjs'),
};

export const hasSurface = (platform) => platform in OPENERS;

async function sessionFor(platform, { session, record, replay, name = platform } = {}) {
  let s = replay ? replaySession(replay) : session ?? (await openSession(name, { platform, pacing: loadDescriptor(platform).pacing }));
  if (record) s = recordSession(s, record);
  return s;
}

// opts: {session} to reuse a driver session, {replay: file or lines} to answer from a recording, and
// {record: file} to write every call of this session to a recording.
export async function openSurface(platform, opts = {}) {
  if (!OPENERS[platform]) throw new AdapterRefusal('FSW_NO_SURFACE', 'no surface for ' + platform + ' in this build');
  return (await OPENERS[platform]())({ session: await sessionFor(platform, opts) });
}

export async function openListingSurface(platform, opts = {}) {
  if (!LISTING_OPENERS[platform]) throw new AdapterRefusal('FSW_NO_SURFACE', 'no listing surface for ' + platform + ' in this build');
  return (await LISTING_OPENERS[platform]())({ session: await sessionFor(platform, { name: platform + '-listing', ...opts }) });
}
