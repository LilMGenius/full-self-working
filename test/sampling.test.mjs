// Synthetic samplers only: the per-platform page parsers are covered by test/market.test.mjs (wp2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { latestSummary, summarizeDay } from '../src/economics/market.mjs';
import { targetsFor } from '../src/economics/catalog.mjs';
import { CARRY_DAYS, categoriesPerRun, marketCadence, marketEngine, marketPlatforms as platformsOn, sampleMarket } from '../src/economics/sampling.mjs';
import { validateDescriptor } from '../src/platforms/registry.mjs';
import { archiveSession, captureOf } from '../src/browser/archive.mjs';
import { tempDir } from './tmp.mjs';

const instanceAt = (platforms) => ({ config: { platforms }, paths: { market: join(tempDir('fsw-sampling-'), 'market') } });
const both = { kmong: { enabled: true, mode: 'auto' }, soomgo: { enabled: true, mode: 'auto' } };

// A sampler whose answer per category comes from answer(platform, category, pass): a price, an Error, or
// {challenge}. Every call is logged as [platform, categories].
function fakeSamplers(answer, { engines = {} } = {}) {
  const calls = [];
  const make = (platform) => async () => ({
    ...(engines[platform] ? { engines: engines[platform] } : {}),
    sample: async (session, targets, { now }) => {
      calls.push([platform, targets.map((t) => t.category)]);
      const pass = calls.filter(([p]) => p === platform).length;
      const rows = [];
      const errors = [];
      for (const t of targets) {
        const a = answer(platform, t.category, pass);
        if (typeof a === 'number') rows.push({ platform, category: t.category, priceKRW: a, reviews: 1, observedAt: now().toISOString() });
        else if (a?.challenge) errors.push({ category: t.category, message: a.challenge + ' bot challenge', challenge: a.challenge });
        else if (a?.final) errors.push({ category: t.category, message: a.final, final: true });
        else errors.push({ category: t.category, message: String(a?.message ?? a) });
      }
      return { rows, errors };
    },
  });
  return { calls, samplers: { kmong: make('kmong'), soomgo: make('soomgo'), freelancer: make('freelancer'), fiverr: make('fiverr') } };
}
const withPage = async (platform, fn) => fn({});
const marketPlatforms = (config, cadence) => platformsOn(config, cadence, fakeSamplers(() => 0).samplers);

test('a day summary turns listing samples into quantiles and passes price-guide figures through', () => {
  const at = '2026-10-24T15:05:00.000Z';
  const rows = [10000, 20000, 30000, 40000, 50000].map((priceKRW, i) => ({ platform: 'kmong', category: '로고 디자인', priceKRW, reviews: i, observedAt: at }));
  rows.push({ platform: 'soomgo', category: '로고 디자인', url: 'https://soomgo.com/prices/x', guide: { avgKRW: 100000, minKRW: 50000, maxKRW: 300000, unit: '건', quoteRequests: 117808, activePros: 57509 }, observedAt: at });
  const [listing, guide] = summarizeDay(rows);
  assert.deepEqual([listing.platform, listing.n, listing.p25, listing.median, listing.p75], ['kmong', 5, 20000, 30000, 40000]);
  assert.deepEqual(guide, { platform: 'soomgo', category: '로고 디자인', n: 117808, minKRW: 50000, p25: null, median: null, p75: null, maxKRW: 300000, avgKRW: 100000, unit: '건', activePros: 57509, url: 'https://soomgo.com/prices/x', observedAt: at });
});

test('a failed category is retried once, a second failure is reported by name, and an unchanged rerun writes nothing', async () => {
  const instance = instanceAt({ ...both, upwork: { enabled: false } });
  const [slow] = targetsFor('kmong');
  const [down] = targetsFor('soomgo');
  const { samplers } = fakeSamplers((p, c, pass) => (p === 'kmong' && c === slow.category && pass === 1 ? new Error('timeout') : p === 'soomgo' && c === down.category ? new Error('no guide') : 10000));
  const ctx = { samplers, withPage, now: () => new Date('2026-10-24T15:00:00Z') };
  const first = await sampleMarket(instance, ctx);
  assert.equal(first.exitCode, 1);
  assert.deepEqual(first.errors.map(({ platform, category }) => [platform, category]), [['soomgo', down.category]]);
  const { day, entries } = latestSummary(instance);
  assert.equal(day, '20261025');
  assert.equal(entries.filter((e) => e.platform === 'kmong').length, targetsFor('kmong').length);
  assert.equal(entries.filter((e) => e.platform === 'soomgo').length, targetsFor('soomgo').length - 1);
  assert.equal((await sampleMarket(instance, ctx)).written, false);
});

test('a named run replaces only the pairs it read and keeps the rest of the day', async () => {
  const instance = instanceAt(both);
  const [broken] = targetsFor('kmong');
  let price = 10000;
  let failing = null;
  const { samplers } = fakeSamplers((p, c) => (c === failing && p === 'kmong' ? new Error('empty page') : price));
  const ctx = { samplers, withPage, now: () => new Date('2026-10-25T03:00:00Z') };
  await sampleMarket(instance, ctx);
  price = 20000;
  failing = broken.category;
  const named = await sampleMarket(instance, { ...ctx, platforms: ['kmong'] });
  assert.deepEqual(named.errors.map(({ platform, category }) => [platform, category]), [['kmong', broken.category]]);
  const kmong = latestSummary(instance).entries.filter((e) => e.platform === 'kmong');
  assert.equal(kmong.length, targetsFor('kmong').length);
  assert.equal(kmong.find((e) => e.category === broken.category).median, 10000);
  assert.ok(kmong.filter((e) => e.category !== broken.category).every((e) => e.median === 20000));
  assert.equal(latestSummary(instance).entries.filter((e) => e.platform === 'soomgo').length, targetsFor('soomgo').length);
  const samples = readFileSync(named.samplesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(samples.filter((r) => r.platform === 'soomgo').length, targetsFor('soomgo').length);
});

test('a new day that cannot read a platform keeps its recent samples with their old dates, and drops them after CARRY_DAYS', async () => {
  const instance = instanceAt(both);
  let soomgoDown = false;
  const { samplers } = fakeSamplers((p) => (p === 'soomgo' && soomgoDown ? new Error('down') : 10000));
  const on = (iso) => ({ samplers, withPage, now: () => new Date(iso) });
  await sampleMarket(instance, on('2026-10-24T15:00:00Z'));
  soomgoDown = true;
  await sampleMarket(instance, on('2026-10-25T15:00:00Z'));
  let summary = latestSummary(instance);
  assert.equal(summary.day, '20261026');
  const soomgo = summary.entries.filter((e) => e.platform === 'soomgo');
  assert.equal(soomgo.length, targetsFor('soomgo').length);
  assert.ok(soomgo.every((e) => e.observedAt === '2026-10-24T15:00:00.000Z'));
  assert.equal(CARRY_DAYS, 7);
  await sampleMarket(instance, on('2026-11-02T15:00:00Z'));
  summary = latestSummary(instance);
  assert.equal(summary.day, '20261103');
  assert.equal(summary.entries.filter((e) => e.platform === 'soomgo').length, 0);
});

test('a bot challenge ends the platform for the run and is never retried', async () => {
  const instance = instanceAt(both);
  const { samplers, calls } = fakeSamplers((p) => (p === 'soomgo' ? { challenge: 'cloudflare' } : 10000));
  const result = await sampleMarket(instance, { samplers, withPage, now: () => new Date('2026-10-25T03:00:00Z') });
  assert.equal(calls.filter(([p]) => p === 'soomgo').length, 1);
  assert.equal(result.errors.length, targetsFor('soomgo').length);
  assert.ok(result.errors.every((e) => e.platform === 'soomgo' && e.challenge === 'cloudflare'));
});

test('without exchange rates a non-KRW platform fails by name, loads no page, and the rest is still written', async () => {
  const instance = instanceAt({ kmong: { enabled: true, mode: 'auto' }, freelancer: { enabled: false } });
  const { samplers, calls } = fakeSamplers(() => 10000);
  const loadFx = async () => { throw Object.assign(new Error('offline'), { code: 'FSW_FX_UNAVAILABLE' }); };
  const result = await sampleMarket(instance, { samplers, withPage, loadFx, now: () => new Date('2026-10-25T03:00:00Z') });
  assert.equal(calls.filter(([p]) => p === 'freelancer').length, 0);
  assert.equal(result.errors.length, targetsFor('freelancer').length);
  assert.ok(result.errors.every((e) => e.platform === 'freelancer' && /^fx unavailable/.test(e.message)));
  assert.equal(result.written, true);
});

test('a run with no sampler for any asked platform, or one that reads no row, fails by name', async () => {
  const instance = instanceAt(both);
  const { samplers } = fakeSamplers(() => new Error('down'));
  await assert.rejects(sampleMarket(instance, { samplers, withPage, platforms: ['upwork'] }), { code: 'FSW_MARKET_NO_SAMPLER' });
  await assert.rejects(sampleMarket(instance, { samplers, withPage }), { code: 'FSW_MARKET_EMPTY' });
  await assert.rejects(sampleMarket(instance, { samplers }), TypeError);
});

test('a platform\'s market engine is the operator\'s setting, else its descriptor\'s, else owned, and an unknown one fails by name', () => {
  assert.equal(marketEngine('fiverr', {}), 'attached');
  assert.equal(marketEngine('fiverr', { market: { engines: { fiverr: null } } }), 'attached');
  assert.equal(marketEngine('fiverr', { market: { engines: { fiverr: 'archive' } } }), 'archive');
  assert.equal(marketEngine('kmong', { market: { engines: { fiverr: 'archive' } } }), 'owned');
  assert.equal(marketEngine('kmong', { market: { engines: { kmong: 'attached' } } }), 'attached');
  assert.throws(() => marketEngine('fiverr', { market: { engines: { fiverr: 'proxy' } } }), (err) => err.code === 'FSW_MARKET_ENGINE_UNKNOWN' && /"proxy" for fiverr/.test(err.message));
  const fiverrDescriptor = JSON.parse(readFileSync(new URL('../src/platforms/descriptors/fiverr.json', import.meta.url), 'utf8'));
  assert.throws(() => validateDescriptor({ ...fiverrDescriptor, market: { engine: 'stealth' } }), /market\.engine/);
});

test('fiverr samples one search an hour by default, and the operator can move any platform between the daily and hourly slots', () => {
  const platforms = { kmong: { enabled: true }, soomgo: { enabled: true }, upwork: { enabled: false }, fiverr: { enabled: false } };
  assert.equal(marketCadence('fiverr', {}), 'hour');
  assert.equal(marketCadence('kmong', {}), 'day');
  assert.equal(categoriesPerRun('fiverr', {}), 1);
  assert.deepEqual(marketPlatforms({ platforms }, 'day'), ['kmong', 'soomgo']);
  assert.deepEqual(marketPlatforms({ platforms }, 'hour'), ['fiverr']);
  const moved = { platforms, market: { cadence: { fiverr: 'day', soomgo: 'hour' } } };
  assert.deepEqual(marketPlatforms(moved, 'day'), ['kmong', 'fiverr']);
  assert.deepEqual(marketPlatforms(moved, 'hour'), ['soomgo']);
  assert.throws(() => marketCadence('fiverr', { market: { cadence: { fiverr: 'minute' } } }), (err) => err.code === 'FSW_MARKET_CADENCE_UNKNOWN');
  const fiverrDescriptor = JSON.parse(readFileSync(new URL('../src/platforms/descriptors/fiverr.json', import.meta.url), 'utf8'));
  assert.throws(() => validateDescriptor({ ...fiverrDescriptor, market: { ...fiverrDescriptor.market, cadence: 'week' } }), /market\.cadence/);
});

test('a run opens each platform through its engine, refuses an engine its sampler does not list, and tags rows and errors with it', async () => {
  const instance = instanceAt(both);
  instance.config.market = { engines: { kmong: 'archive', soomgo: 'attached' } };
  const opened = [];
  const { samplers, calls } = fakeSamplers((p, c) => (c === targetsFor('soomgo')[0].category ? new Error('down') : 10000), { engines: { soomgo: ['owned', 'attached'] } });
  const result = await sampleMarket(instance, { samplers, withPage: async (platform, fn, { engine }) => { opened.push(platform + ':' + engine); return fn({}); }, now: () => new Date('2026-10-25T03:00:00Z') });
  assert.deepEqual([...new Set(opened)], ['soomgo:attached']);
  assert.equal(calls.filter(([p]) => p === 'kmong').length, 0);
  const kmong = result.errors.filter((e) => e.platform === 'kmong');
  assert.equal(kmong.length, targetsFor('kmong').length);
  assert.ok(kmong.every((e) => /kmong sampler cannot read through the archive engine/.test(e.message)));
  assert.deepEqual(result.errors.filter((e) => e.platform === 'soomgo').map((e) => e.engine), ['attached']);
  const samples = readFileSync(result.samplesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(samples.length > 0 && samples.every((r) => r.platform === 'soomgo' && r.engine === 'attached'));
});

test('a final error is not retried, and a bounded run reads never-read and stalest categories first', async () => {
  const instance = instanceAt({ soomgo: { enabled: true, mode: 'auto' } });
  const all = targetsFor('soomgo').map((t) => t.category);
  instance.config.market = { categoriesPerRun: { soomgo: 2 } };
  const { samplers, calls } = fakeSamplers((p, c) => (c === all[1] ? { final: 'no archive snapshot' } : 10000));
  const on = (iso) => ({ samplers, withPage, now: () => new Date(iso) });
  const first = await sampleMarket(instance, on('2026-10-24T03:00:00Z'));
  assert.deepEqual(calls, [['soomgo', all.slice(0, 2)]]);
  assert.ok(first.errors.length === 1 && first.errors[0].final && first.errors[0].category === all[1]);
  calls.length = 0;
  await sampleMarket(instance, on('2026-10-25T03:00:00Z'));
  assert.deepEqual(calls, [['soomgo', [all[1], all[2]]]]);
});

test('an archive capture is dated by its address, and a missing or stale capture is final', async () => {
  assert.equal(captureOf('https://web.archive.org/web/20260128032306id_/https://x.test/a'), '2026-01-28T03:23:06.000Z');
  assert.equal(captureOf('https://web.archive.org/web/29991231id_/x'), null);
  const page = (href) => ({ navigate: async () => {}, evaluate: async () => href });
  const now = () => new Date('2026-10-25T03:00:00Z');
  const open = (href) => archiveSession(page(href), { now, maxAgeDays: CARRY_DAYS });
  const fresh = open('https://web.archive.org/web/20261020120000id_/https://x.test/a');
  await fresh.navigate('https://x.test/a');
  assert.deepEqual(fresh.capture(), { capturedAt: '2026-10-20T12:00:00.000Z', snapshot: 'https://web.archive.org/web/20261020120000id_/https://x.test/a' });
  await assert.rejects(open('https://web.archive.org/web/29991231id_/https://x.test/a').navigate('https://x.test/a'), (err) => err.final === true && /no archive snapshot/.test(err.message));
  await assert.rejects(open('https://web.archive.org/web/20170301095312id_/https://x.test/a').navigate('https://x.test/a'), (err) => err.final === true && /older than 7 days/.test(err.message));
});
