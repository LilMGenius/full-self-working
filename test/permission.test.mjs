import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { step } from '../src/loop/index.mjs';
import { permissionSignal } from '../src/loop/permission.mjs';
import { scriptedSurface } from './helpers/surface.mjs';
import { tempDir } from './tmp.mjs';

const DELIVERED = '2026-10-20T10:00:00+09:00';
const job = { id: 'kmong-k1', threadId: 7, platform: 'kmong', status: 'delivered', deliveredAt: DELIVERED };
const GRANT = '네, 포트폴리오에 올리셔도 됩니다.';
const msg = (direction, text, at) => ({ direction, text, at });
const thread = (messages) => ({ platform: 'kmong', messages });
const decision = (portfolioPermission, permissionQuote) => ({ intent: 'smalltalk', portfolioPermission, permissionQuote });

test('a grant whose quote is in an inbound message after the delivery becomes permission_granted with the quote', () => {
  const r = permissionSignal({ thread: thread([msg('out', '작업물 전달드립니다. 포트폴리오에 써도 될까요?', DELIVERED), msg('in', '감사합니다!  ' + GRANT, '2026-10-20T11:00:00+09:00')]), job, decision: decision('granted', GRANT), at: '2026-10-20T12:00:00+09:00' });
  assert.equal(r.reason, null);
  assert.deepEqual(r.signal, { type: 'permission_granted', platform: 'kmong', threadId: 7, jobId: 'kmong-k1', at: '2026-10-20T12:00:00+09:00', evidence: { quote: GRANT, source: 'brain' } });
});

test('a grant quoting my own outbound message, an inbound before the delivery, or nothing is not accepted', () => {
  const cases = [
    thread([msg('out', GRANT, '2026-10-20T11:00:00+09:00')]),
    thread([msg('in', GRANT, '2026-10-20T09:00:00+09:00')]),
    thread([msg('in', '감사합니다!', '2026-10-20T11:00:00+09:00')]),
  ];
  for (const t of cases) {
    const r = permissionSignal({ thread: t, job, decision: decision('granted', GRANT) });
    assert.equal(r.signal, null);
    assert.equal(r.reason, 'grant without a quote found in an inbound message after the delivery');
  }
  const thanksOnly = permissionSignal({ thread: thread([msg('in', '감사합니다!', '2026-10-20T11:00:00+09:00')]), job, decision: decision('granted', '감사합니다!'.slice(0, 1)) });
  assert.equal(thanksOnly.signal, null);
});

test('a refusal needs no quote and becomes permission_refused', () => {
  const r = permissionSignal({ thread: thread([]), job, decision: decision('refused', null), at: '2026-10-20T12:00:00+09:00' });
  assert.equal(r.signal.type, 'permission_refused');
  assert.deepEqual(r.signal.evidence, { quote: null, source: 'brain' });
});

test('no answer, or a job that is not delivered or closed, gives no signal and no reason', () => {
  assert.deepEqual(permissionSignal({ thread: thread([]), job, decision: decision(null, null) }), { signal: null, reason: null });
  assert.deepEqual(permissionSignal({ thread: thread([]), job: { ...job, status: 'in_progress' }, decision: decision('refused', null) }), { signal: null, reason: null });
  assert.deepEqual(permissionSignal({ thread: thread([]), job: null, decision: decision('refused', null) }), { signal: null, reason: null });
});

// The step: the brain's answer on a delivered thread reaches the deal, or is recorded as unverified.
function setup() {
  const dir = tempDir('fsw-permission-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms.kmong = { ...config.platforms.kmong, enabled: true, mode: 'auto' };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const instance = loadInstance({ dir });
  const ledger = openLedger(':memory:');
  const t = ledger.upsertThread({ platform: 'kmong', externalId: 'k1', kind: 'message' });
  ledger.upsertJob({ id: 'kmong-k1', threadId: t.id, platform: 'kmong', service: 'landing_page_web', status: 'delivered', deliveredAt: DELIVERED, meta: { portfolio: { permission: 'pending', askedAt: DELIVERED } } });
  const now = new Date('2026-10-20T12:00:00+09:00');
  const run = (inboundText, answer) => {
    const at = '2026-10-20T11:00:00+09:00';
    const surface = scriptedSurface({
      sense: [{ platform: 'kmong', ref: 'k1', kind: 'message', at, unread: true, service: null, preview: inboundText, notice: null, status: null, hired: null, quotable: null, expiresAt: null, quoteCostKRW: null, requestId: null, customer: null, quote: null }],
      threads: () => ({ ref: 'k1', kind: 'message', stage: 'post_order', messages: [msg('out', '작업물 전달드립니다. 포트폴리오에 써도 될까요?', DELIVERED), msg('in', inboundText, at)], notices: [] }),
    });
    const d = { intent: 'smalltalk', service: 'landing_page_web', language: 'ko', reply: null, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null, ...answer };
    return step('kmong', { instance, ledger, now, notify: async () => ({ written: true }), openSurface: async () => surface, priceTable: [], runCodex: async () => ({ data: d, durationMs: 1 }) });
  };
  const events = (kind) => ledger.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind).map((e) => JSON.parse(e.payload));
  return { ledger, run, events };
}

test('the step sends a quoted grant to the deal, which keeps the quote on the portfolio meta', async () => {
  const s = setup();
  await s.run(GRANT, { portfolioPermission: 'granted', permissionQuote: GRANT });
  const p = s.ledger.getJob('kmong-k1').meta.portfolio;
  assert.deepEqual([p.permission, p.quote, p.source], ['granted', GRANT, 'brain']);
  assert.equal(s.events('deal.permission_granted').length, 1);
});

test('the step records a grant the page text does not back as permission.unverified and leaves the job pending', async () => {
  const s = setup();
  await s.run('감사합니다!', { portfolioPermission: 'granted', permissionQuote: GRANT });
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'pending');
  assert.deepEqual(s.events('permission.unverified').map((e) => e.reason), ['grant without a quote found in an inbound message after the delivery']);
  assert.equal(s.events('deal.permission_granted').length, 0);
});
