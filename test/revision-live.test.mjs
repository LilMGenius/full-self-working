// A delivered kmong thread replayed through the loop step: the client's change requests reach the deal as
// revision_requested, the included round reopens the job and starts a run, a further round goes to the
// operator, and the same request read again acts once. The thread has the shape surface.read returns
// (src/surface/kmong.mjs); the text is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { advance } from '../src/deal/index.mjs';
import { readCases } from '../src/learning/outcomes.mjs';
import { step } from '../src/loop/index.mjs';
import { scriptedSurface } from './helpers/surface.mjs';
import { tempDir } from './tmp.mjs';

const DELIVERED = '2026-10-20T09:00:00+09:00';
const CHANGE_1 = '메뉴 사진을 더 크게 바꿔 주세요.';
const CHANGE_2 = '글꼴도 고딕으로 바꿔 주실 수 있나요?';

function setup() {
  const dir = tempDir('fsw-revision-live-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms.kmong = { ...config.platforms.kmong, enabled: true, mode: 'auto' };
  // Replies after an order go out on their own only while the operator watches orders (authorize).
  config.orders = { ...config.orders, watched: true };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const instance = loadInstance({ dir });
  const ledger = openLedger(':memory:');
  const t = ledger.upsertThread({ platform: 'kmong', externalId: 'k1', kind: 'message' });
  ledger.upsertJob({ id: 'kmong-k1', threadId: t.id, platform: 'kmong', service: 'landing_page_web', status: 'delivered', deliveredAt: DELIVERED, meta: { scope: ['한 페이지'] } });
  const messages = [{ direction: 'out', text: '작업물 전달드립니다. 확인 부탁드립니다.', at: DELIVERED, externalId: 'm0' }];
  const notes = [];
  const spawned = [];
  const prompts = [];
  const sent = [];
  // Each tick the client has written one more message, so the list time moves and triage opens the thread.
  const tick = async (text, hour) => {
    const at = '2026-10-20T' + hour + ':00:00+09:00';
    messages.push({ direction: 'in', text, at, externalId: 'm' + messages.length });
    const surface = scriptedSurface({
      sense: [{ platform: 'kmong', ref: 'k1', kind: 'message', at, unread: true, service: null, preview: text, notice: null, status: null, hired: null, quotable: null, expiresAt: null, quoteCostKRW: null, requestId: null, customer: null, quote: null }],
      threads: () => ({ ref: 'k1', kind: 'message', stage: 'post_order', customer: null, title: null, language: 'ko', messages: [...messages], notices: [] }),
    });
    const runCodex = async ({ prompt }) => {
      prompts.push(prompt);
      // The reply restates what changes, as the prompt asks, so each tick's reply is its own outbox item.
      return { data: { intent: 'revision', service: 'landing_page_web', language: 'ko', reply: hour + '시에 요청하신 "' + text + '" 내용을 확인했습니다.', quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null, portfolioPermission: null, permissionQuote: null }, durationMs: 1 };
    };
    const now = new Date('2026-10-20T' + hour + ':05:00+09:00');
    const result = await step('kmong', { instance, ledger, now, notify: async (_i, n) => (notes.push(n), { written: true }), openSurface: async () => surface, priceTable: [], runCodex, spawnJob: (_i, id) => (spawned.push(id), { pid: 1, log: 'runner.log' }) });
    // The reply the drain sent shows on the page as my outbound message on the next read.
    for (const c of surface.calls.filter((c) => c.name === 'send')) messages.push({ direction: 'out', text: c.args.text, at: now.toISOString(), externalId: 'm' + messages.length });
    sent.push(surface.count('send'));
    return result;
  };
  // The run the included round started delivers again (the work module's signals, outside the step).
  const redeliver = (hour) => {
    const ctx = { instance, descriptor: loadDescriptor('kmong'), now: new Date('2026-10-20T' + hour + ':00:00+09:00') };
    advance(ledger, { type: 'run_started', platform: 'kmong', jobId: 'kmong-k1', at: '2026-10-20T' + hour + ':00:00+09:00', evidence: {} }, ctx);
    advance(ledger, { type: 'delivery_observed', platform: 'kmong', jobId: 'kmong-k1', at: '2026-10-20T' + hour + ':30:00+09:00', evidence: {} }, ctx);
  };
  const events = (kind) => ledger.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind).map((e) => JSON.parse(e.payload));
  return { instance, ledger, notes, spawned, prompts, sent, tick, redeliver, events };
}

test('a change request on delivered work reopens the job once, an extra round goes to the operator, and a repeat acts once', async () => {
  const s = setup();
  const job = () => s.ledger.getJob('kmong-k1');

  await s.tick(CHANGE_1, '10');
  assert.equal(job().status, 'revision');
  assert.deepEqual(s.spawned, ['kmong-k1']);
  assert.deepEqual(job().meta.revisions.map((r) => [r.text, r.round, r.extra]), [[CHANGE_1, 1, false]]);
  assert.deepEqual(readCases(s.instance).filter((c) => c.kind === 'revision_request').map((c) => [c.jobId, c.text]), [['kmong-k1', CHANGE_1]]);
  assert.match(s.prompts[0], /A request to change delivered work is intent "revision"/);
  assert.match(s.prompts[0], /Only one revision round is included; do not promise a further round as free\./);

  s.redeliver('11');
  assert.equal(job().status, 'delivered');

  const before = s.notes.length;
  await s.tick(CHANGE_2, '12');
  assert.equal(job().status, 'delivered');
  assert.deepEqual(s.spawned, ['kmong-k1']);
  assert.deepEqual(job().meta.revisions.map((r) => [r.text, r.extra]), [[CHANGE_1, false], [CHANGE_2, true]]);
  assert.deepEqual(s.notes.slice(before).map((n) => n.dedupeKey).filter((k) => k.startsWith('revision-extra:')), ['revision-extra:kmong-k1:1']);

  // The client sends the same request again: the deal records a duplicate and nothing else changes.
  const notesBefore = s.notes.length;
  await s.tick(CHANGE_2, '13');
  assert.equal(job().status, 'delivered');
  assert.equal(job().meta.revisions.length, 2);
  assert.deepEqual(s.events('deal.revision_duplicate').map((e) => e.text), [CHANGE_2]);
  assert.deepEqual(s.notes.slice(notesBefore).filter((n) => n.dedupeKey.startsWith('revision-extra:')), []);
  assert.deepEqual(s.spawned, ['kmong-k1']);
  // Each tick answered the client in the chat.
  assert.deepEqual(s.sent, [1, 1, 1]);
});
