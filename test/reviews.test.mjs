// The review count watch (060 U6.1): a rise on a platform's seller profile is an event and one operator
// alert naming the fsw deal verb, a parsed review row attaches to one delivered job or to none, the hourly
// pass reports a count it could not read and stops every session it opened, and each surface's reviews()
// reads its profile page as the sign-in check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPacingGuard } from '../src/browser/driver.mjs';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { matchReview, recordReviewCounts, recordReviews, reviewSignals } from '../src/loop/reviews.mjs';
import { openKmongSurface } from '../src/surface/kmong.mjs';
import { openSoomgoSurface } from '../src/surface/soomgo.mjs';
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

test('the hourly pass reports an unread count with its gap and a failed read, loads no login page, and stops every session', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const calls = [];
  const login = async () => (calls.push('login'), { loggedIn: true });
  const surfaces = {
    kmong: { login, reviews: async () => ({ counts: null, rows: null, gap: 'no nickname on the dashboard' }), stop: async () => calls.push('kmong stop') },
    soomgo: { login, reviews: async () => { throw Object.assign(new Error('page crashed'), { code: 'FSW_X' }); }, stop: async () => calls.push('soomgo stop') },
  };
  const out = await recordReviews({ instance, ledger, openSurface: async (p) => surfaces[p], notify: async () => ({ written: false }) });
  assert.deepEqual(out, [{ platform: 'kmong', status: 'unread', gap: 'no nickname on the dashboard' }, { platform: 'soomgo', status: 'failed', reason: 'FSW_X page crashed' }]);
  assert.deepEqual(calls, ['kmong stop', 'soomgo stop']);
  assert.equal(kinds(ledger, 'reviews.read').length, 0);
  const drifted = await recordReviews({ instance, ledger, openSurface: async () => ({ reviews: async () => ({ counts: { reviews: null, rating: null }, rows: null }), stop: async () => {} }) });
  assert.deepEqual(drifted.map((e) => [e.status, e.gap]), [['unread', 'the review count did not parse'], ['unread', 'the review count did not parse']]);
});

test('a stop that throws is kept on the entry and the pass goes on to the next platform', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const surfaces = {
    kmong: { reviews: async () => counted(1), stop: async () => { throw Object.assign(new Error('bsk gone'), { code: 'FSW_BSK' }); } },
    soomgo: { reviews: async () => counted(2), stop: async () => {} },
  };
  const out = await recordReviews({ instance, ledger, openSurface: async (p) => surfaces[p], notify: async () => ({ written: false }) });
  assert.deepEqual(out, [{ platform: 'kmong', status: 'ok', changed: false, signals: 0, stop: 'FSW_BSK bsk gone' }, { platform: 'soomgo', status: 'ok', changed: false, signals: 0 }]);
});

test('the review read counts toward the hourly read share and waits for the next hour once it is spent', async () => {
  const instance = makeInstance({ soomgo: { enabled: true } });
  const ledger = openLedger(':memory:');
  let clock = Date.parse('2026-10-27T10:00:00+09:00');
  const guard = createPacingGuard('soomgo', { maxActionsPerHour: 60, readActionsPerHour: 2 }, { now: () => clock, sleep: async () => {} });
  const surface = { session: { guard }, reviews: async () => (await guard.beforeLoad(), counted(3)), stop: async () => {} };
  const pass = () => recordReviews({ instance, ledger, openSurface: async () => surface, notify: async () => ({ written: false }) });
  assert.equal((await pass())[0].status, 'ok');
  assert.equal(guard.readRoom(), 1);
  await guard.reading(() => guard.beforeLoad());
  const deferred = await pass();
  assert.equal(deferred[0].status, 'deferred');
  assert.equal(guard.counts().actions, 2, 'a deferred pass loads nothing');
  clock += 3_600_000;
  assert.equal((await pass())[0].status, 'ok');
});

test('the hourly pass records the counts of a signed-in platform and skips a surface without reviews', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const calls = [];
  const surfaces = {
    kmong: { stop: async () => calls.push('kmong stop') },
    soomgo: { reviews: async () => counted(7, 5), stop: async () => calls.push('soomgo stop') },
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

test('the hourly job is partial when a count could not be read, and its entry carries the gap', async () => {
  const instance = makeInstance({ soomgo: { enabled: true } });
  const ledger = openLedger(':memory:');
  const openSurface = async () => ({ login: async () => ({ loggedIn: true }), supply: async () => ({ platform: 'soomgo', listings: null, services: [] }), reviews: async () => ({ counts: null, rows: null, gap: 'soomgo /profile opened /login' }), stop: async () => {} });
  const s = await runTick({ instance, ledger, now: new Date('2026-10-25T03:00:00Z'), state: { lastRuns: {} }, only: ['hourly'], openSurface, notify: async () => ({ written: false }), persist: false });
  assert.deepEqual([s.jobs[0].status, s.jobs[0].reviews], ['partial', [{ platform: 'soomgo', status: 'unread', gap: 'soomgo /profile opened /login' }]]);
});

// A driver session that answers the page extractors by name; the anonymous innerText read answers by path.
function fakeSession({ redirect = {}, text = {}, answers = {} } = {}) {
  let path = null;
  const log = [];
  return {
    log,
    loads: 0,
    async navigate(url) {
      const to = redirect[new URL(url).pathname] ?? url;
      path = new URL(to).pathname;
      log.push(path);
      return to;
    },
    async evaluate(fn, arg) {
      if (fn.name === '') return text[path] ?? '';
      if (!answers[fn.name]) throw new Error('no answer for ' + fn.name);
      return answers[fn.name](arg, path);
    },
    stop: async () => {},
  };
}
const SOOMGO_PROFILE = ['고수 프로필', '웹 개발 고수', '리뷰 평점', '4.9', '리뷰수', '7', '고용수', '12'].join('\n');

test('soomgo reviews() loads /profile once with no login read, and a sign-in redirect reads no counts', async () => {
  const s = fakeSession({ text: { '/profile': SOOMGO_PROFILE } });
  const surface = await openSoomgoSurface({ session: s, sleep: async () => {} });
  assert.deepEqual(await surface.reviews(), { counts: { reviews: 7, rating: 4.9 }, rows: null, gap: 'review rows are not parsed yet' });
  assert.deepEqual(s.log, ['/profile']);
  const out = fakeSession({ redirect: { '/profile': 'https://soomgo.com/login?next=/profile' } });
  const r = await (await openSoomgoSurface({ session: out, sleep: async () => {} })).reviews();
  assert.deepEqual(r, { counts: null, rows: null, gap: 'soomgo /profile opened /login, so the account is not signed in' });
});

test('kmong reviews() reads the public profile the dashboard names, and no counts when signed out or without a nickname', async () => {
  const signedIn = (profileHref) => () => ({ url: 'https://kmong.com/seller/dashboard', avatar: true, authSection: true, loginButton: false, sellerMode: true, profileHref });
  const nick = encodeURIComponent('셀러');
  const s = fakeSession({ answers: { pageLogin: signedIn('/@' + nick) }, text: { ['/@' + nick]: ['셀러', '4.8', '(12)', '총 작업 수', '30'].join('\n') } });
  const surface = await openKmongSurface({ session: s });
  assert.deepEqual(await surface.reviews(), { counts: { reviews: 12, rating: 4.8 }, rows: null, gap: 'review rows are not parsed yet' });
  assert.deepEqual(s.log, ['/seller/dashboard', '/@' + nick]);
  const noNick = fakeSession({ answers: { pageLogin: signedIn(null) } });
  assert.deepEqual(await (await openKmongSurface({ session: noNick })).reviews(), { counts: null, rows: null, gap: 'no nickname on the dashboard, so the public profile was not read' });
  const out = fakeSession({ answers: { pageLogin: () => ({ url: 'https://kmong.com/', avatar: false, authSection: false, loginButton: true, sellerMode: null, profileHref: null }) } });
  assert.deepEqual(await (await openKmongSurface({ session: out })).reviews(), { counts: null, rows: null, gap: 'kmong is not signed in, so the public profile was not read' });
});

test('the probe reads reviews as a read op and prints counts without words', async () => {
  const lines = [];
  const surface = { session: { loads: 1 }, reviews: async () => counted(2), stop: async () => {} };
  assert.equal(await probe(['kmong', 'reviews', '--now'], { open: async () => surface, log: (l) => lines.push(l) }), 0);
  const summary = JSON.parse(lines.at(-1));
  assert.deepEqual([summary.op, summary.ok, summary.result.counts.reviews, summary.result.gap], ['reviews', true, 2, '<30 chars>']);
});
