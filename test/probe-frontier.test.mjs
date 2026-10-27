// The frontier reference set (070 U7.2): probe frontier reads the top cards of each published kmong
// gig's category inside the probe window and saves their cover images under the instance, with no seller
// name kept. The surface and the image fetch are stubs, so no browser and no network run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCard } from '../src/platforms/kmong/market.mjs';
import { probe } from '../scripts/probe.mjs';
import { tempDir } from './tmp.mjs';

// A throwaway instance with two published gigs, in two kmong categories, and a live tick at 10:00 Seoul.
function instance() {
  const dir = tempDir('fsw-frontier-');
  for (const [service, gigId] of [['logo_brand', 1], ['thumbnail_banner', 2]]) {
    mkdirSync(join(dir, 'listings', service), { recursive: true });
    writeFileSync(join(dir, 'listings', service, 'publish-20261027.json'), JSON.stringify({ service, gigId, submitted: true }));
  }
  mkdirSync(join(dir, 'run'));
  writeFileSync(join(dir, 'run', 'state.json'), JSON.stringify({ lastTick: { at: '2026-10-27T01:00:40.000Z' } }));
  return dir;
}

// A surface whose frontier returns three cards per target, each with a seller and a cover URL.
function surface(calls) {
  return {
    session: { loads: 0 },
    frontier: async (targets, opts) => {
      calls.push({ categories: targets.map((t) => t.category), services: targets.map((t) => t.service), ...opts });
      const rows = targets.flatMap((t) => [1, 2, 3].map((rank) => ({ platform: 'kmong', category: t.category, url: 'https://kmong.com/gig/' + rank, rank, title: '제목 ' + rank, seller: '판매자이름' + rank, rating: 4.9, reviews: 10 * rank, img: rank === 3 ? null : 'https://cdn.test/' + t.service + '/' + rank + '.webp' })));
      return { rows, errors: [] };
    },
    stop: async () => {},
  };
}
const image = async (url) => new Response(Buffer.from('bytes of ' + url), { headers: { 'content-type': 'image/jpeg' } });

// Points instanceDir at dir for one test and puts the previous value back after it.
function useInstance(t, dir) {
  const before = process.env.FSW_INSTANCE;
  process.env.FSW_INSTANCE = dir;
  t.after(() => {
    if (before === undefined) delete process.env.FSW_INSTANCE;
    else process.env.FSW_INSTANCE = before;
  });
}

test('a kmong card keeps its cover image URL', () => {
  assert.equal(parseCard({ href: '/gig/1', text: '로고\n60,000원~\n판매자', img: 'https://cdn.test/a.jpg' }).img, 'https://cdn.test/a.jpg');
});

test('frontier is a kmong op; another platform is a usage error', async () => {
  assert.equal(await probe(['soomgo', 'frontier', '--now'], { open: async () => assert.fail('opened'), log: () => {} }), 2);
});

test('frontier waits for the probe window, reads the published categories and saves covers without seller names', async (t) => {
  const dir = instance();
  useInstance(t, dir);
  // 10:04:30 is inside the last minute before the 10:05 mark, so the probe waits; the supervisor records
  // its 10:05 tick while it sleeps, which opens the window.
  let clock = new Date('2026-10-27T10:04:30+09:00');
  const sleep = async (ms) => {
    clock = new Date(clock.getTime() + ms);
    writeFileSync(join(dir, 'run', 'state.json'), JSON.stringify({ lastTick: { at: new Date(clock.getTime() + 10_000).toISOString() } }));
  };
  const lines = [];
  const calls = [];
  const code = await probe(['kmong', 'frontier'], { now: () => clock, sleep, open: async () => surface(calls), log: (l) => lines.push(l), fetchImage: image });
  assert.equal(code, 0, lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('probe window: ')), 'it waited for the window');
  assert.deepEqual(calls.map((c) => c.services[0]).sort(), ['logo_brand', 'thumbnail_banner']);
  assert.ok(calls.every((c) => c.categories.length === 1 && c.perCategory === 3));
  const folder = join(dir, 'qa', 'frontier', '20261027');
  const index = JSON.parse(readFileSync(join(folder, 'frontier.json'), 'utf8'));
  assert.equal(index.length, 6);
  assert.deepEqual(Object.keys(index[0]).sort(), ['category', 'error', 'file', 'rank', 'rating', 'reviews', 'service', 'url']);
  assert.doesNotMatch(readFileSync(join(folder, 'frontier.json'), 'utf8'), /판매자이름/);
  assert.ok(existsSync(join(folder, 'logo_brand-1.jpg')));
  assert.equal(readFileSync(join(folder, 'logo_brand-2.jpg'), 'utf8'), 'bytes of https://cdn.test/logo_brand/2.webp');
  assert.deepEqual(index.filter((e) => !e.file).map((e) => e.error), ['the card showed no cover image', 'the card showed no cover image']);
  const summary = JSON.parse(lines.at(-1)).result;
  assert.equal(summary.saved, 4);
  assert.equal(summary.stoppedByWindow, false);
  // A second run the same day reads nothing that is already filled.
  calls.length = 0;
  assert.equal(await probe(['kmong', 'frontier', '--now'], { now: () => clock, open: async () => surface(calls), log: () => {}, fetchImage: image }), 0);
  assert.deepEqual(calls, []);
});

test('a window that closes mid-run ends the op, and the next run fills only what is missing', async (t) => {
  const dir = instance();
  useInstance(t, dir);
  let clock = new Date('2026-10-27T10:03:50+09:00');
  const calls = [];
  const s = surface(calls);
  const frontier = s.frontier;
  // The first category load takes the clock past 10:04, a minute before the next mark.
  s.frontier = async (...a) => ((clock = new Date('2026-10-27T10:04:10+09:00')), frontier(...a));
  const lines = [];
  assert.equal(await probe(['kmong', 'frontier'], { now: () => clock, sleep: async () => assert.fail('the window was open'), open: async () => s, log: (l) => lines.push(l), fetchImage: image }), 0);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(lines.at(-1)).result.stoppedByWindow, true);
  const first = calls[0].services[0];
  calls.length = 0;
  assert.equal(await probe(['kmong', 'frontier', '--now'], { now: () => clock, open: async () => surface(calls), log: () => {}, fetchImage: image }), 0);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].services[0], first);
});

