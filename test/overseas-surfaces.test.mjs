import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { step } from '../src/loop/index.mjs';
import { hasSurface, openSurface } from '../src/surface/index.mjs';
import { FORM_UNMAPPED, openFreelancerSurface } from '../src/surface/freelancer.mjs';
import { scriptedSurface } from './helpers/surface.mjs';
import { tempDir } from './tmp.mjs';

// Synthetic answers of the public projects API, in its shape (status success, result).
const SUBMIT = Date.parse('2026-10-20T00:00:00Z') / 1000;
const project = (id, over = {}) => ({
  id, type: 'fixed', status: 'active', frontend_project_status: 'open', title: ' Project ' + id + ' ', preview_description: 'Short ' + id, description: 'Full description ' + id,
  currency: { code: 'USD' }, budget: { minimum: 100, maximum: 300 }, jobs: [{ id: 1, name: 'Data Entry' }, { id: 95, name: 'Web Scraping' }], time_submitted: SUBMIT, bidperiod: 7,
  bid_stats: { bid_count: 12 }, seo_url: 'python/project-' + id, ...over,
});
function fakeApi(projects) {
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    if (url.includes('/jobs/?')) return [{ id: 95, name: 'Web Scraping' }, { id: 1035, name: 'Excel VBA' }];
    if (url.includes('/projects/active/?')) return { projects, total_count: projects.length };
    const id = Number(/\/projects\/(\d+)\//.exec(url)?.[1]);
    const p = projects.find((x) => x.id === id);
    if (!p) throw new Error('no project ' + id);
    return p;
  };
  return { fetchJson, urls };
}
const TARGETS = [{ category: 'Web Scraping' }, { category: 'Excel VBA' }, { category: 'Not A Job' }];

function fakeSession(body) {
  const calls = [];
  return { calls, navigate: async (url) => (calls.push(['navigate', url]), url), evaluate: async () => (calls.push(['evaluate']), body), stop: async () => calls.push(['stop']) };
}

test('freelancer sense reads the public projects API into request rows, one jobs read and one projects read', async () => {
  const api = fakeApi([project(1), project(2, { type: 'hourly' }), project(3, { budget: { minimum: 0, maximum: 0 } }), project(4, { frontend_project_status: 'closed', jobs: [{ id: 1035, name: 'Excel VBA' }] })]);
  const s = await openFreelancerSurface({ session: fakeSession(null), fetchJson: api.fetchJson, targets: TARGETS });
  const rows = await s.sense();
  assert.equal(api.urls.length, 2);
  assert.match(api.urls[1], /jobs\[\]=95&jobs\[\]=1035&project_types\[\]=fixed/);
  assert.deepEqual(rows.map((r) => [r.ref, r.kind, r.service, r.quotable, r.quoteCount, r.quoteCostKRW, r.unread]), [['1', 'request', 'Web Scraping', true, 12, null, false], ['4', 'request', 'Excel VBA', false, 12, null, false]]);
  assert.equal(rows[0].at, '2026-10-20T00:00:00.000Z');
  assert.equal(rows[0].expiresAt, '2026-10-27T00:00:00.000Z');
  assert.equal(rows[0].preview, 'Project 1');
});

test('freelancer read gives one inbound message from the full description and refuses a message kind', async () => {
  const api = fakeApi([project(7)]);
  const s = await openFreelancerSurface({ session: fakeSession(null), fetchJson: api.fetchJson, targets: TARGETS });
  const t = await s.read('7', { kind: 'request' });
  assert.deepEqual([t.platform, t.ref, t.kind, t.title, t.quoteCostKRW, t.budget], ['freelancer', '7', 'request', 'Project 7', null, { min: 100, max: 300, currency: 'USD' }]);
  assert.deepEqual(t.messages, [{ direction: 'in', text: 'Project 7\nFull description 7', at: '2026-10-20T00:00:00.000Z', externalId: 'request' }]);
  await assert.rejects(s.read('7', { kind: 'message' }), { code: 'FSW_READ_KIND' });
});

test('every freelancer write refuses by name before anything reaches the session', async () => {
  const session = fakeSession(null);
  const s = await openFreelancerSurface({ session, fetchJson: fakeApi([]).fetchJson, targets: TARGETS });
  const authorized = { verdict: 'send' };
  for (const write of ['send', 'quote', 'propose']) await assert.rejects(s[write]('7', { text: 'x', amountKRW: 1000, authorized }), { code: FORM_UNMAPPED });
  assert.deepEqual(session.calls, []);
});

test('freelancer login reads the self API in the session: unauthenticated is false, anything else null until mapped', async () => {
  const out = await openFreelancerSurface({ session: fakeSession({ json: { status: 'error', error_code: 'RestExceptionCodes.NOT_AUTHENTICATED' } }), targets: TARGETS });
  assert.equal((await out.login()).loggedIn, false);
  const other = fakeSession({ json: { status: 'success', result: { id: 1 } } });
  const s = await openFreelancerSurface({ session: other, targets: TARGETS });
  assert.equal((await s.login()).loggedIn, null);
  assert.deepEqual(other.calls[0], ['navigate', 'https://www.freelancer.com/api/users/0.1/self/']);
});

test('openSurface opens freelancer on the session it is given, as a publicSense surface', async () => {
  assert.equal(hasSurface('freelancer'), true);
  const s = await openSurface('freelancer', { session: fakeSession(null) });
  assert.deepEqual([s.platform, s.publicSense], ['freelancer', true]);
});

function makeInstance() {
  const dir = tempDir('fsw-overseas-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms.freelancer = { ...config.platforms.freelancer, enabled: true, mode: 'auto' };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

test('the step keeps a signed-out publicSense surface sensing in observe mode, with no login notice', async () => {
  const instance = makeInstance();
  const NOON = new Date('2026-10-20T12:00:00+09:00');
  const row = { platform: 'freelancer', ref: '1', kind: 'request', at: '2026-10-20T02:00:00.000Z', unread: false, service: 'Web Scraping', preview: 'Project 1', quotable: true, expiresAt: null, quoteCostKRW: null };
  const run = async (surface) => {
    const notes = [];
    const r = await step('freelancer', { instance, ledger: openLedger(':memory:'), now: NOON, notify: async (_i, n) => (notes.push(n), { written: true }), openSurface: async () => surface });
    return { r, notes };
  };
  const open = Object.assign(scriptedSurface({ login: { loggedIn: false }, sense: [row] }), { publicSense: true });
  const kept = await run(open);
  assert.deepEqual([kept.r.status, kept.r.mode, kept.r.inbound, kept.r.threads.observed, kept.notes.length], ['ok', 'observe', 1, 1, 0]);
  assert.deepEqual(open.calls.filter((c) => c.name !== 'read'), []);
  const closed = await run(scriptedSurface({ login: { loggedIn: false }, sense: [row] }));
  assert.deepEqual([closed.r.status, closed.r.inbound, closed.notes.length], ['failed', 0, 1]);
});
