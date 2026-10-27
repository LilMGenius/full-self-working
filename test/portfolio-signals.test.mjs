// Portfolio data the ordering reads (070 U7.8): fame read live from GitHub and npm for items the operator
// authored, quality from the rendered checks of an item's live page, README media for authored repositories, all
// read once per Seoul day; a silent source leaves the figure absent, never remembered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isContribution } from '../src/core/profile.mjs';
import { captureRepoMedia } from '../src/portfolio/media.mjs';
import { fameOf, githubLogin, qualityOf, readReach, readSignals, repoOf } from '../src/portfolio/signals.mjs';
import { itemsFromProfile, loadItems, syncPortfolio } from '../src/portfolio/store.mjs';
import { proofPlan } from '../src/listings/proofs.mjs';
import { openRenderer } from '../src/render/html2png.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { tempDir } from './tmp.mjs';

const LOGIN = 'maker';
const res = (status, body, link = null) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (h) => (h.toLowerCase() === 'link' ? link : null) } });

// A GitHub and npm stand-in: repos maps 'owner/name' to {stars, fork, owner, first}; a repo absent answers 404.
function stubFetch({ repos = {}, npm = {}, down = null } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (down) {
      if (down === 'throw') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      return res(down, { message: 'rate limit' });
    }
    let m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?]+)$/.exec(url);
    if (m) {
      const r = repos[m[1]];
      return r ? res(200, { stargazers_count: r.stars, fork: r.fork === true, owner: { login: r.owner ?? LOGIN } }) : res(404, {});
    }
    m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?]+)\/commits\?per_page=1(&page=(\d+))?$/.exec(url);
    if (m) {
      const r = repos[m[1]];
      if (!m[3]) return res(200, [{ author: { login: 'latest-person' } }], '<https://api.github.com/repos/' + m[1] + '/commits?per_page=1&page=40>; rel="last"');
      return res(200, [{ author: { login: r.first ?? LOGIN } }]);
    }
    m = /^https:\/\/api\.npmjs\.org\/downloads\/point\/last-month\/(.+)$/.exec(url);
    if (m) return npm[decodeURIComponent(m[1])] != null ? res(200, { downloads: npm[decodeURIComponent(m[1])] }) : res(404, {});
    throw new Error('unexpected url ' + url);
  };
  fn.calls = calls;
  return fn;
}
const item = (id, over = {}) => ({ id, source: 'background', url: 'https://github.com/' + LOGIN + '/' + id, media: [], contribution: false, ...over });

test('repoOf names a github.com repository and githubLogin reads the profile link', () => {
  assert.equal(repoOf('https://github.com/a/b.git'), 'a/b');
  assert.equal(repoOf('https://github.com/a/b/tree/main'), 'a/b');
  assert.equal(repoOf('https://example.com/a'), null);
  assert.equal(githubLogin({ person: { links: ['https://example.com', 'https://github.com/Maker/'] } }), 'maker');
  assert.equal(githubLogin({ person: { links: ['https://github.com/maker/repo'] } }), null);
});

test('itemsFromProfile marks a contribution role and carries the npm package, through the one isContribution rule', () => {
  const [own, theirs, flagged] = itemsFromProfile({ projects: [
    { name: 'Own Tool', role: 'Author', url: 'https://github.com/maker/own', package: 'own-tool' },
    { name: 'Their Lib', role: "Contributor to another maintainer's repository", url: 'https://github.com/other/lib' },
    { name: 'Flagged', contribution: true },
  ] });
  assert.deepEqual([own.contribution, own.package, theirs.contribution, theirs.package, flagged.contribution], [false, 'own-tool', true, null, true]);
  assert.deepEqual([isContribution({ role: 'Contributor' }), isContribution({ role: 'Author' })], [true, false]);
});

test('only an authored repository carries figures: a contribution, a fork, another owner and another first committer do not', async () => {
  const fetch = stubFetch({ repos: { 'maker/own': { stars: 12 }, 'maker/forked': { stars: 900, fork: true }, 'other/lib': { stars: 5000, owner: 'other' }, 'maker/adopted': { stars: 70, first: 'someone' } }, npm: { 'own-tool': 345 } });
  const reach = await readReach([
    item('own', { package: 'own-tool' }),
    item('forked'),
    item('lib', { url: 'https://github.com/other/lib' }),
    item('adopted'),
    item('theirs', { url: 'https://github.com/other/big', contribution: true }),
  ], { fetch, login: LOGIN });
  assert.deepEqual(reach.own, { authored: true, why: null, stars: 12, downloads: 345, errors: [] });
  assert.deepEqual([reach.forked.authored, reach.forked.why, reach.forked.stars], [false, 'a fork', null]);
  assert.deepEqual([reach.lib.why, reach.lib.stars], ['owned by other', null]);
  assert.deepEqual([reach.adopted.why, reach.adopted.stars], ['first commit by someone', null]);
  assert.deepEqual([reach.theirs.authored, reach.theirs.why], [false, "a contribution to another maintainer's repository"]);
  assert.equal(fetch.calls.some((u) => u.includes('other/big')), false, 'a contribution makes no request');
  assert.deepEqual(fameOf(reach), { own: 1, forked: null, lib: null, adopted: null, theirs: null });
});

test('a source that is down leaves the figure absent with its error, and no login means no figure', async () => {
  const limited = await readReach([item('own')], { fetch: stubFetch({ down: 403 }), login: LOGIN });
  assert.deepEqual([limited.own.stars, limited.own.authored, limited.own.why, limited.own.errors], [null, false, 'repository unread', ['github maker/own answered 403']]);
  const dropped = await readReach([item('own')], { fetch: stubFetch({ down: 'throw' }), login: LOGIN });
  assert.deepEqual(dropped.own.errors, ['github maker/own: ENOTFOUND']);
  const nobody = await readReach([item('own')], { fetch: stubFetch({ repos: { 'maker/own': { stars: 3 } } }), login: null });
  assert.deepEqual([nobody.own.stars, nobody.own.why], [null, 'no github.com link in profile.person.links']);
  assert.equal(fameOf({ ...limited }).own, null);
});

test('fame is each figure on a log scale against the largest of the day', () => {
  const r = (stars) => ({ authored: true, stars, downloads: null });
  assert.deepEqual(fameOf({ a: r(0), b: r(9), c: r(999), d: r(null) }), { a: 0, b: 0.333, c: 1, d: null });
  assert.deepEqual(fameOf({ a: r(0) }), { a: null });
});

test('quality is the share of viewports where the live page neither overflows nor breaks an image', { timeout: 180_000 }, async () => {
  const dir = tempDir('fsw-quality-');
  const page = join(dir, 'page.html');
  writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0} .w{width:340px;height:10px;background:#333}</style></head><body><div class="w"></div></body></html>');
  const renderer = await openRenderer();
  let q;
  try {
    q = await qualityOf([{ id: 'web', url: pathToFileURL(page).href }, { id: 'repo', url: 'https://github.com/maker/own' }, { id: 'none', url: null }], { renderer, dir });
  } finally {
    await renderer.close();
  }
  assert.deepEqual(Object.keys(q), ['web']);
  assert.equal(q.web.quality, 0.889);
  assert.equal(q.web.problems.length, 1);
  assert.match(q.web.problems[0], /@320x568: horizontal overflow 340 > 320/);
});

test('readSignals reads once per Seoul day into signals-<day>.json', async () => {
  const dir = tempDir('fsw-signals-');
  const instance = { dir, profile: { person: { links: ['https://github.com/maker'] } }, paths: { portfolio: join(dir, 'portfolio') } };
  const fetch = stubFetch({ repos: { 'maker/own': { stars: 4 } } });
  let opened = 0;
  const openRendererStub = async () => (opened++, { render: async () => { throw new Error('no web item to render'); }, close: async () => {} });
  const now = new Date('2026-10-27T03:00:00.000Z');
  const first = await readSignals(instance, [item('own')], { fetch, openRenderer: openRendererStub, now });
  const calls = fetch.calls.length;
  const second = await readSignals(instance, [item('own')], { fetch, openRenderer: openRendererStub, now: new Date('2026-10-27T14:00:00.000Z') });
  assert.deepEqual(second, first);
  assert.deepEqual([fetch.calls.length, opened], [calls, 1]);
  assert.deepEqual(readdirSync(instance.paths.portfolio), ['signals-20261027.json']);
  assert.deepEqual([first.day, first.reach.own.stars, first.reach.own.fame, first.quality], ['20261027', 4, 1, {}]);
});

test('a README capture is taken only for an authored repository without media, and an item with no url is missing', async () => {
  const calls = [];
  const renderer = { render: async (o) => (calls.push(o), o.probe ? { probe: { x: 10, y: 400, width: 900, height: 1600 } } : { width: 1800, height: 3200 }) };
  const reach = { own: { authored: true }, lib: { authored: false } };
  const out = await captureRepoMedia([
    item('own'),
    item('lib', { url: 'https://github.com/other/lib' }),
    item('shown', { media: [{ kind: 'image', src: 'media/shown.png', width: 10, height: 10 }] }),
    item('bare', { url: null }),
  ], { renderer, dir: tempDir('fsw-media-'), reach });
  assert.deepEqual(out.missing, ['bare']);
  assert.deepEqual(out.media, { own: [{ kind: 'readme', src: 'media/own-readme.png', width: 1800, height: 3200, alt: 'README of maker/own on GitHub' }] });
  assert.deepEqual(calls.map((c) => [c.url, Boolean(c.probe), c.clip ?? null]), [['https://github.com/maker/own', true, null], ['https://github.com/maker/own', false, { x: 10, y: 400, width: 900, height: 1600 }]]);
  const none = await captureRepoMedia([item('own')], { renderer: { render: async () => ({ probe: null }) }, dir: tempDir('fsw-media-'), reach });
  assert.deepEqual(none, { media: {}, missing: ['own'] });
});

test('a README capture stays out of gig images', () => {
  const readme = { ...item('own'), media: [{ kind: 'readme', src: 'media/own-readme.png', width: 1800, height: 3200, alt: 'README' }] };
  const shot = { ...item('web', { url: 'https://example.com' }), media: [{ src: 'media/web.png', width: 10, height: 10 }] };
  assert.deepEqual(proofPlan({ service: 'web', items: [readme, shot] }).gallery.map((g) => g.itemId), ['web']);
  assert.deepEqual(proofPlan({ service: 'web', items: [readme] }).gallery, []);
});

test('syncPortfolio stores the day signals and media, and a figure gone today replaces yesterday\'s', () => {
  const dir = tempDir('fsw-portfolio-sig-');
  const instance = { profile: { projects: [{ name: 'Own', url: 'https://github.com/maker/own' }, { name: 'Site', url: 'https://example.com/site' }] }, paths: { portfolio: join(dir, 'portfolio') } };
  const ledger = openLedger(':memory:');
  const day = (stars, fame) => ({ day: 'd', reach: { 'bg-own': { authored: true, why: null, stars, downloads: null, errors: stars == null ? ['github maker/own answered 403'] : [], fame } }, quality: { 'bg-site': { quality: 0.889, problems: [] } } });
  const media = { 'bg-own': [{ kind: 'readme', src: 'media/bg-own-readme.png', width: 1, height: 1, alt: 'README of maker/own on GitHub' }] };
  syncPortfolio(instance, ledger, { signals: day(120, 1), media });
  let own = loadItems(instance).find((i) => i.id === 'bg-own');
  assert.deepEqual([own.reach.stars, own.reach.fame, own.media[0].kind], [120, 1, 'readme']);
  assert.equal(loadItems(instance).find((i) => i.id === 'bg-site').quality, 0.889);
  syncPortfolio(instance, ledger, { signals: day(null, null) });
  own = loadItems(instance).find((i) => i.id === 'bg-own');
  assert.deepEqual([own.reach.stars, own.reach.fame, own.media[0].kind], [null, null, 'readme']);
  syncPortfolio(instance, ledger);
  assert.equal(loadItems(instance).find((i) => i.id === 'bg-own').reach.stars, null, 'a run without signals keeps what it had');
  assert.equal(existsSync(join(dir, 'portfolio', 'items.json')), true);
  ledger.close();
});

test('the portfolio job reads the day signals, captures README media for authored repositories and tells the operator about items with none', async () => {
  const { JOB_HANDLERS } = await import('../src/supervisor/run.mjs');
  const dir = tempDir('fsw-portfolio-job-');
  const instance = { dir, profile: { person: { links: ['https://github.com/maker'] }, projects: [
    { name: 'Own', role: 'Author', url: 'https://github.com/maker/own' },
    { name: 'Lib', role: 'Contributor', url: 'https://github.com/other/lib' },
    { name: 'Site', url: 'https://example.com/site', media: [{ kind: 'image', src: 'media/site.png', width: 10, height: 10 }] },
    { name: 'Bare' },
  ] }, paths: { portfolio: join(dir, 'portfolio') } };
  const renders = [];
  const renderer = { close: async () => {}, render: async (o) => {
    renders.push(o.url);
    if (o.url.startsWith('https://github.com/')) return o.clip ? { width: 1800, height: 2400 } : { probe: { x: 0, y: 300, width: 900, height: 1200 } };
    return { probe: { iw: o.width, sw: o.width, wide: [] }, brokenImages: [] };
  } };
  const notes = [];
  const r = await JOB_HANDLERS.portfolio({ instance, ledger: openLedger(':memory:'), fetch: stubFetch({ repos: { 'maker/own': { stars: 7 } } }), openRenderer: async () => renderer, notify: async (_i, n) => (notes.push(n), {}), now: new Date('2026-10-27T15:00:00.000Z') });
  assert.deepEqual(r, { status: 'ok', shown: 4, withFame: 1, missingMedia: 1 });
  assert.deepEqual(notes.map((n) => n.dedupeKey), ['portfolio-media:bg-bare']);
  const items = Object.fromEntries(loadItems(instance).map((i) => [i.id, i]));
  assert.deepEqual([items['bg-own'].reach.fame, items['bg-own'].media[0].kind, items['bg-lib'].contribution, items['bg-lib'].reach.authored, items['bg-lib'].media, items['bg-site'].quality], [1, 'readme', true, false, [], 1]);
  assert.equal(renders.filter((u) => u.includes('other/lib')).length, 0);
  assert.deepEqual(readdirSync(instance.paths.portfolio).filter((f) => f.startsWith('signals-')), ['signals-20261028.json']);
});
