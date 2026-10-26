// The lead supply report: what the hourly job writes per platform and what leads the 09:00 digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { plan, setStatus } from '../src/outbox/index.mjs';
import { latestSupply, parkedCounts, supplyLines, supplyReport, writeSupply } from '../src/supervisor/supply.mjs';
import { runTick } from '../src/supervisor/run.mjs';
import { writeDigest } from '../src/supervisor/digest.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-supply-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms = { kmong: { ...config.platforms.kmong, enabled: true }, soomgo: { ...config.platforms.soomgo, enabled: true } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}
const NOW = new Date('2026-10-25T03:00:00Z'); // 12:00 Seoul
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const quiet = async () => ({ written: false });
const surfaceWith = (services, over = {}) => async () => ({ login: async () => ({ loggedIn: true }), supply: async () => ({ platform: 'soomgo', listings: null, services }), stop: async () => {}, ...over });

test('parked counts distinct threads per reason over the last seven days', () => {
  const ledger = openLedger(':memory:');
  const park = (kind, ref, reason, at) => ledger.addEvent({ kind, platform: 'soomgo', ref, payload: { reason }, at });
  park('thread.operator', 'r1', 'catalog: 피아노 레슨', hoursAgo(1));
  park('thread.operator', 'r1', 'catalog: 피아노 레슨', hoursAgo(2));
  park('thread.skipped', 'r2', 'stale: 80h', hoursAgo(3));
  park('thread.skipped', 'r3', 'expired', hoursAgo(4));
  park('thread.system', 'c1', 'notice: unread quote', hoursAgo(5));
  park('thread.skipped', 'r9', 'stale: 90h', hoursAgo(24 * 8));
  ledger.addEvent({ kind: 'thread.operator', platform: 'kmong', ref: 'x', payload: { reason: 'catalog: x' }, at: hoursAgo(1) });
  assert.deepEqual(parkedCounts(ledger, 'soomgo', NOW), { outOfCatalog: 1, stale: 1, expired: 1, notice: 1 });
});

test('a report lists gigs by review state, offered services without items and the awaiting reply count', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const dir = join(instance.dir, 'listings');
  for (const [service, status, last] of [['logo_brand', '승인 전', null], ['landing_page_web', '판매중', 'selling']]) {
    mkdirSync(join(dir, service), { recursive: true });
    writeFileSync(join(dir, service, 'publish-20261025.json'), JSON.stringify({ service, gigId: service.length, status, submitted: true }));
    if (last) writeFileSync(join(dir, service, 'review.json'), JSON.stringify({ lastStatus: last }));
  }
  const waiting = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  ledger.addMessage({ threadId: waiting.id, direction: 'in', body: '문의', at: hoursAgo(2) });
  const old = ledger.upsertThread({ platform: 'soomgo', externalId: 'c2', kind: 'message' });
  ledger.addMessage({ threadId: old.id, direction: 'in', body: '문의', at: hoursAgo(100) });
  const answered = ledger.upsertThread({ platform: 'soomgo', externalId: 'c3', kind: 'message' });
  ledger.addMessage({ threadId: answered.id, direction: 'in', body: '문의', at: hoursAgo(3) });
  ledger.addMessage({ threadId: answered.id, direction: 'out', body: '답변', at: hoursAgo(2) });
  const row = plan(ledger, { platform: 'soomgo', threadId: waiting.id, kind: 'message', payload: { text: '답변 초안' } });
  setStatus(ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261025-soomgo-0000abcd' });
  const offered = [{ name: '웹 개발', itemsSet: false, ref: 'a' }, { name: '로고 디자인', itemsSet: true, ref: 'b' }, { name: '피아노 레슨', itemsSet: false, ref: 'c' }];
  const soomgo = await supplyReport('soomgo', { instance, ledger, now: NOW, openSurface: surfaceWith(offered) });
  assert.deepEqual([soomgo.status, soomgo.awaitingReply, soomgo.waiting.awaiting_operator], ['ok', 1, 1]);
  assert.deepEqual(soomgo.services, { offered: 3, withoutItems: ['웹 개발'] });
  const kmong = await supplyReport('kmong', { instance, ledger, now: NOW, openSurface: async () => ({ login: async () => ({ loggedIn: true }), stop: async () => {} }) });
  assert.deepEqual(kmong.listings, { published: 2, byStatus: { waiting: 1, selling: 1 } });
  assert.equal(kmong.services, null);
});

test('a platform whose supply has no services list reports no services line', async () => {
  const instance = makeInstance();
  const kmong = await supplyReport('kmong', { instance, ledger: openLedger(':memory:'), now: NOW, openSurface: async () => ({ login: async () => ({ loggedIn: true }), supply: async () => ({ platform: 'kmong', listings: [], services: null }), stop: async () => {} }) });
  assert.deepEqual([kmong.status, kmong.services], ['ok', null]);
  assert.doesNotMatch(supplyLines({ reports: [kmong] })[0], /request items/);
});

test('a failing read, a missing login and a missing pipeline setting each leave a partial report with the reason', async () => {
  const ledger = openLedger(':memory:');
  const instance = makeInstance();
  const broken = await supplyReport('soomgo', { instance, ledger, now: NOW, openSurface: surfaceWith([], { supply: async () => { throw new Error('tool RPC timed out'); } }) });
  assert.deepEqual([broken.status, broken.services], ['partial', null]);
  assert.match(broken.notes.join(), /tool RPC timed out/);
  const out = await supplyReport('soomgo', { instance, ledger, now: NOW, openSurface: surfaceWith([], { login: async () => ({ loggedIn: false }) }) });
  assert.match(out.notes.join(), /FSW_SUPPLY_LOGIN not logged in/);
  const bare = makeInstance((c) => ({ ...c, pipeline: undefined }));
  const noPipeline = await supplyReport('soomgo', { instance: bare, ledger, now: NOW, openSurface: surfaceWith([]) });
  assert.equal(noPipeline.awaitingReply, null);
  assert.match(noPipeline.notes.join(), /pipeline/);
});

test('the hourly job writes one supply file per Seoul hour, and latestSupply reads the newest', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const openSurface = surfaceWith([{ name: '웹 개발', itemsSet: false, ref: 'a' }]);
  const state = { lastRuns: {} };
  const tick = (iso) => runTick({ instance, ledger, now: new Date(iso), state, only: ['hourly'], openSurface, notify: quiet, persist: false });
  const first = await tick('2026-10-25T03:00:00Z');
  assert.match(first.jobs[0].supply.file, /supply-2026102512\.json$/);
  assert.equal(latestSupply(instance).file, 'supply-2026102512.json');
  await tick('2026-10-25T03:30:00Z');
  assert.equal(latestSupply(instance).file, 'supply-2026102512.json', 'the same hour runs once');
  await tick('2026-10-25T04:00:00Z');
  const latest = latestSupply(instance);
  assert.deepEqual([latest.file, latest.hour, latest.reports.map((r) => r.platform)], ['supply-2026102513.json', '2026102513', ['kmong', 'soomgo']]);
  assert.equal(ledger.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'supervisor.supply'").get().n, 2);
});

test('the digest leads with the lead supply section, and its notice opens with the same lines', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  ledger.addEvent({ kind: 'thread.operator', platform: 'soomgo', ref: 'r1', payload: { reason: 'catalog: 피아노 레슨' }, at: hoursAgo(1) });
  await writeSupply({ instance, ledger, now: NOW, openSurface: surfaceWith([{ name: '웹 개발', itemsSet: false, ref: 'a' }]) });
  const notes = [];
  const d = await writeDigest({ instance, ledger, now: new Date('2026-10-26T00:00:00Z'), notify: async (_i, n) => (notes.push(n), { written: true }) });
  const lines = readFileSync(d.file, 'utf8').split('\n');
  assert.equal(lines[2], '## Lead supply (supply-2026102512.json)');
  assert.match(lines[5], /^- soomgo: 0 awaiting reply; parked in 7 days: out of catalog 1; offered services without request items: 웹 개발$/);
  assert.equal(lines.indexOf('## Activity') > 5, true);
  assert.match(notes[0].body, /^kmong: .* \| soomgo: 0 awaiting reply/);
  assert.deepEqual(supplyLines(null), ['- none yet (the hourly job writes it)']);
});

test('approvals waiting in the digest counts outbox rows awaiting the operator', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const t = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  const a = plan(ledger, { platform: 'soomgo', threadId: t.id, kind: 'message', payload: { text: '하나' } });
  plan(ledger, { platform: 'soomgo', threadId: t.id, kind: 'message', payload: { text: '둘' } });
  setStatus(ledger, a.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261025-soomgo-0000abcd' });
  const d = await writeDigest({ instance, ledger, now: new Date('2026-10-26T00:00:00Z'), notify: quiet });
  assert.equal(d.numbers.approvalsWaiting, 1);
  assert.match(readFileSync(d.file, 'utf8'), /- approvals waiting now: 1/);
});
