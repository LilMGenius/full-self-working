// The review count watch (060 U6.1): a rise on a platform's seller profile is an event and one operator
// alert naming the fsw deal verb, a parsed review row attaches to one delivered job or to none, and the
// hourly pass reads only signed-in platforms and stops every session it opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { matchReview, recordReviewCounts, recordReviews, reviewSignals } from '../src/loop/reviews.mjs';
import { runTick } from '../src/supervisor/run.mjs';
import { probe } from '../scripts/probe.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance(platforms = { kmong: { enabled: true }, soomgo: { enabled: true } }) {
  const dir = tempDir('fsw-reviews-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms = Object.fromEntries(Object.entries(platforms).map(([id, over]) => [id, { ...config.platforms[id], ...over }]));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}
const kinds = (ledger, kind) => ledger.db.prepare('SELECT payload FROM events WHERE kind = ? ORDER BY id').all(kind).map((e) => JSON.parse(e.payload));
const counted = (n, rating = 4.9) => ({ counts: { reviews: n, rating }, rows: null, gap: 'review rows are not parsed yet' });

test('the first read records the counts and alerts nobody', async () => {
  const ledger = openLedger(':memory:');
  const notes = [];
  const r = await recordReviewCounts({ ledger, instance: {}, platform: 'kmong', reviews: counted(3), notify: async (_i, n) => notes.push(n) });
  assert.deepEqual(r, { changed: false, rise: null });
  assert.deepEqual(kinds(ledger, 'reviews.read').map((p) => p.counts.reviews), [3]);
  assert.deepEqual([kinds(ledger, 'reviews.changed').length, notes.length], [0, 0]);
});

test('a rise alerts once with the new count in its dedupe key and names the fsw deal review verb', async () => {
  const ledger = openLedger(':memory:');
  const notes = [];
  const call = (n) => recordReviewCounts({ ledger, instance: {}, platform: 'kmong', reviews: counted(n), notify: async (_i, note) => notes.push(note) });
  await call(3);
  assert.deepEqual(await call(4), { changed: true, rise: { from: 3, to: 4, rating: 4.9 } });
  assert.deepEqual(await call(4), { changed: false, rise: null });
  assert.equal(kinds(ledger, 'reviews.changed').length, 1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].dedupeKey, 'reviews:kmong:4');
  assert.match(notes[0].body, /fsw deal <jobId> review --rating <1-5>/);
});

test('an unreadable or falling count writes no change event', async () => {
  const ledger = openLedger(':memory:');
  const notes = [];
  const call = (reviews) => recordReviewCounts({ ledger, instance: {}, platform: 'soomgo', reviews, notify: async (_i, n) => notes.push(n) });
  await call(counted(5));
  assert.deepEqual(await call({ counts: { reviews: null, rating: null }, rows: null }), { changed: false, rise: null });
  assert.deepEqual(await call({ counts: null, rows: null, gap: 'no nickname' }), { changed: false, rise: null });
  assert.equal(kinds(ledger, 'reviews.read').length, 1, 'an unreadable count is not a read');
  assert.deepEqual(await call(counted(4)), { changed: false, rise: null });
  assert.deepEqual([kinds(ledger, 'reviews.changed').length, notes.length], [0, 0]);
});

test('a review row attaches to the newest delivered job of its author, and to none on a tie or no author match', () => {
  const threads = { 1: { customer: '김고객' }, 2: { customer: '김고객' }, 3: { customer: '박고객' }, 4: { customer: '김고객' } };
  const job = (id, threadId, status, deliveredAt, platform = 'kmong') => ({ id, threadId, status, deliveredAt, platform });
  const jobs = [job('a', 1, 'closed', '2026-10-01T00:00:00Z'), job('b', 2, 'delivered', '2026-10-10T00:00:00Z'), job('c', 3, 'delivered', '2026-10-12T00:00:00Z'), job('d', 4, 'in_progress', null), job('e', 4, 'delivered', '2026-10-20T00:00:00Z', 'soomgo')];
  const threadOf = (id) => threads[id];
  const row = (author) => ({ platform: 'kmong', key: 'kmong:review:' + author, author, rating: 5, text: '좋아요', at: '2026-10-21T00:00:00Z' });
  assert.equal(matchReview(row('김고객'), jobs, threadOf).id, 'b');
  assert.equal(matchReview(row('이고객'), jobs, threadOf), null);
  const tie = [job('x', 1, 'delivered', '2026-10-10T00:00:00Z'), job('y', 2, 'closed', '2026-10-10T00:00:00Z')];
  assert.equal(matchReview(row('김고객'), tie, threadOf), null);
  const s = reviewSignals([row('김고객'), row('이고객')], { jobs, threadOf });
  assert.deepEqual(s.unmatched, ['kmong:review:이고객']);
  assert.deepEqual([s.signals.length, s.signals[0].jobId, s.signals[0].evidence.key, s.signals[0].evidence.source], [1, 'b', 'kmong:review:김고객', 'review-row']);
});

test('the hourly pass skips a signed-out platform, reports a failed one, and stops every session it opened', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const calls = [];
  const surfaces = {
    kmong: { login: async () => ({ loggedIn: false }), reviews: async () => (calls.push('kmong reviews'), counted(1)), stop: async () => calls.push('kmong stop') },
    soomgo: { login: async () => ({ loggedIn: true }), reviews: async () => { throw Object.assign(new Error('page crashed'), { code: 'FSW_X' }); }, stop: async () => calls.push('soomgo stop') },
  };
  const out = await recordReviews({ instance, ledger, openSurface: async (p) => surfaces[p], notify: async () => ({ written: false }) });
  assert.deepEqual(out, [{ platform: 'kmong', status: 'skipped', reason: 'not logged in' }, { platform: 'soomgo', status: 'failed', reason: 'FSW_X page crashed' }]);
  assert.deepEqual(calls, ['kmong stop', 'soomgo stop']);
});

test('the hourly pass records the counts of a signed-in platform and skips a surface without reviews', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const calls = [];
  const surfaces = {
    kmong: { login: async () => ({ loggedIn: true }), stop: async () => calls.push('kmong stop') },
    soomgo: { login: async () => ({ loggedIn: true }), reviews: async () => counted(7, 5), stop: async () => calls.push('soomgo stop') },
  };
  const out = await recordReviews({ instance, ledger, openSurface: async (p) => surfaces[p], notify: async () => ({ written: false }) });
  assert.deepEqual(out, [{ platform: 'soomgo', status: 'ok', changed: false, signals: 0 }]);
  assert.deepEqual(calls, ['kmong stop', 'soomgo stop']);
  assert.deepEqual(kinds(ledger, 'reviews.read')[0].counts, { reviews: 7, rating: 5 });
});

test('the hourly job runs the review pass and reports it beside the supply report', async () => {
  const instance = makeInstance({ soomgo: { enabled: true } });
  const ledger = openLedger(':memory:');
  const openSurface = async () => ({ login: async () => ({ loggedIn: true }), supply: async () => ({ platform: 'soomgo', listings: null, services: [] }), reviews: async () => counted(2), stop: async () => {} });
  const s = await runTick({ instance, ledger, now: new Date('2026-10-25T03:00:00Z'), state: { lastRuns: {} }, only: ['hourly'], openSurface, notify: async () => ({ written: false }), persist: false });
  assert.deepEqual(s.jobs[0].reviews, [{ platform: 'soomgo', status: 'ok', changed: false, signals: 0 }]);
  assert.equal(kinds(ledger, 'reviews.read').length, 1);
});

test('the probe reads reviews as a read op and prints counts without words', async () => {
  const lines = [];
  const surface = { session: { loads: 1 }, reviews: async () => counted(2), stop: async () => {} };
  assert.equal(await probe(['kmong', 'reviews', '--now'], { open: async () => surface, log: (l) => lines.push(l) }), 0);
  const summary = JSON.parse(lines.at(-1));
  assert.deepEqual([summary.op, summary.ok, summary.result.counts.reviews, summary.result.gap], ['reviews', true, 2, '<30 chars>']);
});
