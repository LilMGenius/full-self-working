// The frontier reference set (070 U7.2): probe frontier reads the top cards of each published kmong
// gig's category inside the probe window and saves their cover images under the instance, with no seller
// name kept. The surface and the image fetch are stubs, so no browser and no network run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCard } from '../src/platforms/kmong/market.mjs';
import { captureFrontier, frontierTargets, probe } from '../scripts/probe.mjs';
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

// A surface whose frontier returns three cards per target, each with a seller and a cover URL; the rank
// named by noCover shows no cover.
function surface(calls, { noCover = null } = {}) {
  return {
    session: { loads: 0 },
    frontier: async (targets, opts) => {
      calls.push({ categories: targets.map((t) => t.category), services: targets.flatMap((t) => t.services ?? [t.service]), ...opts });
      const rows = targets.flatMap((t) => [1, 2, 3].map((rank) => ({ platform: 'kmong', category: t.category, url: 'https://kmong.com/gig/' + rank, rank, title: '제목 ' + rank, seller: '판매자이름' + rank, rating: 4.9, reviews: 10 * rank, img: rank === noCover ? null : 'https://cdn.test/' + t.services[0] + '/' + rank + '.webp' })));
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
  assert.ok(index.every((e) => e.file && !e.error));
  const summary = JSON.parse(lines.at(-1)).result;
  assert.equal(summary.saved, 6);
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


// An instance whose published gigs are given; logo_brand and a second service share one kmong category.
function instanceWith(services) {
  const dir = tempDir('fsw-frontier-');
  services.forEach((service, i) => {
    mkdirSync(join(dir, 'listings', service), { recursive: true });
    writeFileSync(join(dir, 'listings', service, 'publish-20261027.json'), JSON.stringify({ service, gigId: i + 1, submitted: true }));
  });
  return dir;
}

test('only an image body is saved: a block page, a data: placeholder and a failed fetch are errors on their entry', async (t) => {
  const dir = instanceWith(['logo_brand']);
  useInstance(t, dir);
  const covers = { 1: 'https://cdn.test/1.webp', 2: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 3: 'https://cdn.test/3.webp' };
  const s = {
    session: { loads: 0 },
    frontier: async (targets) => ({ rows: [1, 2, 3].map((rank) => ({ category: targets[0].category, url: 'https://kmong.com/gig/' + rank, rank, rating: 5, reviews: rank, img: covers[rank] })), errors: [] }),
    stop: async () => {},
  };
  const fetched = [];
  const fetchImage = async (url) => {
    fetched.push(url);
    return url.endsWith('3.webp') ? new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }) : image(url);
  };
  const lines = [];
  assert.equal(await probe(['kmong', 'frontier', '--now'], { open: async () => s, log: (l) => lines.push(l), fetchImage }), 0);
  assert.ok(!fetched.some((u) => u.startsWith('data:')), 'a data: placeholder is never fetched');
  const day = readdirSync(join(dir, 'qa', 'frontier'))[0];
  const folder = join(dir, 'qa', 'frontier', day);
  const index = JSON.parse(readFileSync(join(folder, 'frontier.json'), 'utf8'));
  assert.deepEqual(index.map((e) => [e.rank, e.file, e.error]), [
    [1, 'logo_brand-1.jpg', null],
    [2, null, 'the card showed only a placeholder, no cover image'],
    [3, null, 'cover image answered text/html, not an image'],
  ]);
  assert.deepEqual(readdirSync(folder).sort(), ['frontier.json', 'logo_brand-1.jpg']);
  const summary = JSON.parse(lines.at(-1)).result;
  assert.equal(summary.saved, 1);
  assert.equal(summary.missing, 2);
});

test('a rank left without a file is read again by a later run the same day', async (t) => {
  const dir = instanceWith(['logo_brand']);
  useInstance(t, dir);
  let fail = true;
  const fetchImage = async (url) => (fail && url.endsWith('/2.webp') ? new Response('', { status: 503 }) : image(url));
  const calls = [];
  const clock = () => new Date('2026-10-27T10:02:00+09:00');
  const open = async () => surface(calls, { noCover: 3 });
  assert.equal(await probe(['kmong', 'frontier', '--now'], { now: clock, open, log: () => {}, fetchImage }), 0);
  fail = false;
  assert.equal(await probe(['kmong', 'frontier', '--now'], { now: clock, open, log: () => {}, fetchImage }), 0);
  assert.equal(calls.length, 2, 'the second run read the category again');
  const index = JSON.parse(readFileSync(join(dir, 'qa', 'frontier', '20261027', 'frontier.json'), 'utf8'));
  assert.deepEqual(index.map((e) => [e.rank, Boolean(e.file)]), [[1, true], [2, true], [3, false]]);
});

test('two published services in one kmong category each get entries pointing at one read of it', async (t) => {
  const list = { logo_brand: { kmongCategory: '로고 디자인', kmongCategoryId: 101 }, logo_extra: { kmongCategory: '로고 디자인', kmongCategoryId: 101 } };
  const dir = instanceWith(Object.keys(list));
  useInstance(t, dir);
  assert.deepEqual(frontierTargets(dir, list).map((x) => x.services), [['logo_brand', 'logo_extra']]);
  const calls = [];
  const s = surface(calls, { noCover: 3 });
  const day = '20261027';
  const r = await captureFrontier(s, { dir, day, fetchImage: image, list });
  assert.equal(calls.length, 1);
  assert.equal(r.saved, 2);
  const index = JSON.parse(readFileSync(join(dir, 'qa', 'frontier', day, 'frontier.json'), 'utf8'));
  for (const service of Object.keys(list)) assert.deepEqual(index.filter((e) => e.service === service).map((e) => e.file), ['logo_brand-1.jpg', 'logo_brand-2.jpg', null], service);
  assert.equal((await captureFrontier(s, { dir, day, fetchImage: image, list })).skipped, 0, 'rank 3 has no cover, so the category is read again');
});
