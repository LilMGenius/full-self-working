import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger, outboxKey } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { authorize } from '../src/policy/authorize.mjs';
import { drain, plan, resolve, setStatus, settleSent, signalOf } from '../src/outbox/index.mjs';
import { NOT_SENT, handles } from '../src/outbox/drain.mjs';
import { TRANSITIONS } from '../src/outbox/plan.mjs';
import { quotaUsage } from '../src/outbox/usage.mjs';
import { scriptedSurface } from './helpers/surface.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-outbox-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms.soomgo = { ...config.platforms.soomgo, mode: 'auto', maxQuotesPerDay: 5, maxCashPerDay: 1000 };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}
const ID_RE = /^[0-9]{8}-[a-z0-9_]+-[0-9a-f]{8}$/;
const NOON = new Date('2026-10-20T12:00:00+09:00');
const TEXT = '요청하신 구성으로 진행 가능합니다. 원하시는 일정을 알려 주세요.';
const decision = (over = {}) => ({ intent: 'inquiry', service: 'landing_page_web', language: 'ko', reply: TEXT, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null, ...over });
const msgPayload = (over = {}) => ({ text: TEXT, thread: { kind: 'message', stage: 'pre_order', lastInboundText: '랜딩 페이지 가능한가요?', recentOutbound: [] }, decision: decision(), ...over });
const ROW = { platform: 'soomgo', service: 'landing_page_web', baseKRW: 300000, floorKRW: 100000, ceilingKRW: 1000000, costFloorKRW: 50000, viable: true };
const quotePayload = (over = {}) => ({ text: TEXT, amountKRW: 300000, priceType: 'fixed', costKRW: 600, serviceLabel: '웹 개발', service: 'landing_page_web', priceRow: ROW, customer: null, thread: { kind: 'request', stage: 'pre_order', lastInboundText: '웹 개발 견적 부탁드립니다', recentOutbound: [] }, decision: decision({ intent: 'quote_request' }), ...over });

function setup(platform = 'kmong', edit) {
  const instance = makeInstance(edit);
  const ledger = openLedger(':memory:');
  const notes = [];
  const descriptor = loadDescriptor(platform);
  const thread = (ref, kind = 'message') => ledger.upsertThread({ platform, externalId: ref, kind });
  const run = (surface, over = {}) => drain(ledger, { platform, surface, authorize, ctx: { descriptor, instance, mode: 'auto', now: NOON, notify: async (_i, n) => (notes.push(n), {}), ...over } });
  return { instance, ledger, notes, descriptor, thread, run, platform };
}
const events = (ledger, kind) => ledger.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
const outMessages = (ledger, threadId) => ledger.threadMessages(threadId).filter((m) => m.direction === 'out');

test('plan twice with the same item returns one row; a deposit and a balance of equal amount make two rows', () => {
  const s = setup('soomgo');
  const t = s.thread('c1');
  const a = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'message', payload: msgPayload() });
  const b = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'message', payload: msgPayload() });
  assert.deepEqual([a.inserted, b.inserted, a.id === b.id], [true, false, true]);
  const dep = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'pay_request', payload: { text: '숨고 payment request: 150000 KRW, Deposit', amountKRW: 150000 } });
  const bal = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'pay_request', payload: { text: '숨고 payment request: 150000 KRW, Balance', amountKRW: 150000 } });
  assert.notEqual(dep.id, bal.id);
  assert.equal(events(s.ledger, 'outbox.status').length, 3);
  assert.throws(() => plan(s.ledger, { platform: 'soomgo', threadId: 999, kind: 'message', payload: msgPayload() }), { code: 'FSW_OUTBOX_THREAD' });
});

test('a delivery with the same file names and a new runAt is a new row, keyed through the ledger outboxKey', () => {
  const s = setup('soomgo');
  const t = s.thread('c1');
  const files = ['C:/jobs/j1/site/index.html', 'C:/jobs/j1/site/HOSTING.md'];
  const first = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'delivery', payload: { text: '전달드립니다', files, runAt: '2026-10-20T10:00:00Z' } });
  const again = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'delivery', payload: { text: '전달드립니다', files, runAt: '2026-10-21T10:00:00Z' } });
  assert.notEqual(first.id, again.id);
  assert.equal(first.key, outboxKey({ platform: 'soomgo', threadRef: 'c1', kind: 'delivery', text: '전달드립니다', amountKRW: undefined, files: ['HOSTING.md', 'index.html', 'run:2026-10-20T10:00:00Z'] }));
  assert.equal(first.payload.threadRef, 'c1');
});

test('setStatus moves only along TRANSITIONS and returns null with no event once the row moved', () => {
  const s = setup();
  const row = plan(s.ledger, { platform: 'kmong', threadId: s.thread('t1').id, kind: 'message', payload: msgPayload() });
  assert.throws(() => setStatus(s.ledger, row.id, { from: 'planned', to: 'observed' }), { code: 'FSW_OUTBOX_STATE' });
  assert.deepEqual(TRANSITIONS.observed, []);
  assert.equal(setStatus(s.ledger, row.id, { from: 'planned', to: 'sending' }).status, 'sending');
  const before = events(s.ledger, 'outbox.status').length;
  assert.equal(setStatus(s.ledger, row.id, { from: 'planned', to: 'stale' }), null);
  assert.equal(events(s.ledger, 'outbox.status').length, before);
  assert.throws(() => setStatus(s.ledger, row.id, { from: 'observed', to: 'sending' }), { code: 'FSW_OUTBOX_STATE' });
  assert.equal(s.ledger.getOutbox(row.id).status, 'sending');
});

test('drain records the outbound message only on an observed receipt; an unobserved one gets an approval id and a notice', async () => {
  const s = setup();
  const t = s.thread('t1');
  const row = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind: 'message', payload: msgPayload() });
  const seen = await s.run(scriptedSurface({ receipts: { send: [{ observed: true, externalId: 'm9' }] } }));
  assert.deepEqual(seen.map((x) => x.action), ['observed']);
  assert.equal(s.ledger.getOutbox(row.id).status, 'observed');
  assert.deepEqual(outMessages(s.ledger, t.id).map((m) => m.body), [TEXT]);
  const t2 = s.thread('t2');
  const row2 = plan(s.ledger, { platform: 'kmong', threadId: t2.id, kind: 'message', payload: msgPayload() });
  const missed = await s.run(scriptedSurface({ receipts: { send: [{ observed: false, reason: 'the sent text was not observed in the thread' }] } }));
  assert.deepEqual(missed.map((x) => x.action), ['unobserved']);
  const after = s.ledger.getOutbox(row2.id);
  assert.equal(after.status, 'unobserved');
  assert.match(after.approvalId, ID_RE);
  assert.equal(outMessages(s.ledger, t2.id).length, 0);
  assert.equal(events(s.ledger, 'send.unobserved').at(-1).payload.reason, 'the sent text was not observed in the thread');
  assert.match(s.notes.at(-1).body, new RegExp('fsw approve ' + after.approvalId + ' --sent'));
  assert.match(s.notes.at(-1).body, new RegExp('fsw approve ' + after.approvalId + ' --reject'));
});

test('a pressed quote keeps its press, counts against that day only, and holds the next quote over the cap', async () => {
  const s = setup('soomgo');
  const r1 = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r1', 'request').id, kind: 'quote', payload: quotePayload() });
  await s.run(scriptedSurface({ receipts: { quote: [{ observed: false, pressed: true, costKRW: 600, reason: 'no 견적 발송 charge after the press' }] } }));
  const row = s.ledger.getOutbox(r1.id);
  assert.deepEqual([row.status, row.receipt.pressed, row.receipt.pressedAt], ['unobserved', true, NOON.toISOString()]);
  assert.deepEqual(quotaUsage(s.ledger, 'soomgo', NOON), { quotes: 1, cashKRW: 600 });
  assert.deepEqual(quotaUsage(s.ledger, 'soomgo', new Date('2026-10-21T12:00:00+09:00')), { quotes: 0, cashKRW: 0 });
  const r2 = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r2', 'request').id, kind: 'quote', payload: quotePayload() });
  const surface = scriptedSurface();
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.action, x.reason]), [['held', 'cash quote refused: daily cash budget spent (600 + 600 over 1000)']]);
  assert.equal(s.ledger.getOutbox(r2.id).status, 'planned');
  assert.equal(surface.count('quote'), 0);
});

test('settleSent closes an unobserved pressed quote once, and refuses any other row', async () => {
  const s = setup('soomgo');
  const t = s.thread('r1', 'request');
  const r1 = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'quote', payload: quotePayload() });
  await s.run(scriptedSurface({ receipts: { quote: [{ observed: false, pressed: true, costKRW: 600, reason: 'unconfirmed' }] } }));
  const id = s.ledger.getOutbox(r1.id).approvalId;
  const { row, receipt } = settleSent(s.ledger, id, { now: NOON });
  assert.deepEqual([row.status, receipt.confirmedBy, receipt.cashSpentKRW], ['observed', 'operator', 600]);
  assert.equal(outMessages(s.ledger, t.id).length, 1);
  const sig = signalOf(row, receipt, NOON);
  assert.deepEqual([sig.type, sig.evidence.cashSpentKRW, sig.amountKRW], ['quote_observed', 600, 300000]);
  assert.deepEqual(quotaUsage(s.ledger, 'soomgo', NOON), { quotes: 0, cashKRW: 0 });
  assert.throws(() => settleSent(s.ledger, id, { now: NOON }), { code: 'FSW_OUTBOX_RESOLVED' });
  const r2 = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('c9').id, kind: 'message', payload: msgPayload() });
  await s.run(scriptedSurface(), { mode: 'draft' });
  const waiting = s.ledger.getOutbox(r2.id);
  assert.equal(waiting.status, 'awaiting_operator');
  assert.throws(() => settleSent(s.ledger, waiting.approvalId, { now: NOON }), { code: 'FSW_OUTBOX_RESOLVED' });
  assert.equal(s.ledger.getOutbox(r2.id).status, 'awaiting_operator');
  assert.throws(() => settleSent(s.ledger, waiting.approvalId, { costKRW: 9.5 }), RangeError);
  const r3 = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r3', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 100 }) });
  await s.run(scriptedSurface({ receipts: { quote: [{ observed: false, reason: 'unconfirmed' }] } }));
  const rejected = resolve(s.ledger, s.ledger.getOutbox(r3.id).approvalId, { approve: false, reason: 'not sent' });
  assert.equal(rejected.status, 'rejected');
});

test('draft mode screens a planned row to awaiting_operator with an approval id and calls no surface', async () => {
  const s = setup();
  const row = plan(s.ledger, { platform: 'kmong', threadId: s.thread('t1').id, kind: 'message', payload: msgPayload() });
  const surface = scriptedSurface();
  const out = await s.run(surface, { mode: 'draft' });
  assert.equal(out[0].action, 'awaiting_operator');
  assert.match(out[0].approvalId, ID_RE);
  assert.equal(s.ledger.getOutbox(row.id).reason, 'draft mode');
  assert.equal(surface.calls.length, 0);
  assert.equal(s.notes[0].kind, 'approval');
  assert.match(s.notes[0].body, /resolve: fsw approve /);
});

test('an edited approval sends the edited text exactly once and a re-plan of the draft returns the same row', async () => {
  const s = setup();
  const t = s.thread('t1');
  const row = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind: 'message', payload: msgPayload() });
  await s.run(scriptedSurface(), { mode: 'draft' });
  const id = s.ledger.getOutbox(row.id).approvalId;
  const edit = '말씀하신 구성으로 일정 맞춰 진행하겠습니다. 시작 날짜를 알려 주세요.';
  const done = resolve(s.ledger, id, { approve: true, editedText: edit });
  assert.deepEqual([done.status, done.operator.edited, done.operator.finalText], ['approved', true, edit]);
  const surface = scriptedSurface();
  await s.run(surface, { mode: 'draft' });
  await s.run(surface, { mode: 'draft' });
  assert.deepEqual(surface.calls.filter((c) => c.name === 'send').map((c) => c.args.text), [edit]);
  assert.deepEqual(outMessages(s.ledger, t.id).map((m) => m.body), [edit]);
  const again = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind: 'message', payload: msgPayload() });
  assert.deepEqual([again.id, again.inserted], [row.id, false]);
  assert.throws(() => resolve(s.ledger, id, { approve: true }), { code: 'FSW_OUTBOX_RESOLVED' });
  assert.throws(() => resolve(s.ledger, '20261020-kmong-00000000', { approve: true }), { code: 'FSW_OUTBOX_NO_APPROVAL' });
  assert.throws(() => resolve(s.ledger, 'nope', { approve: true }), RangeError);
});

test('an approved text the gate now blocks is refused with its verdict and never reaches the surface', async () => {
  const s = setup();
  const row = plan(s.ledger, { platform: 'kmong', threadId: s.thread('t1').id, kind: 'message', payload: msgPayload() });
  await s.run(scriptedSurface(), { mode: 'draft' });
  resolve(s.ledger, s.ledger.getOutbox(row.id).approvalId, { approve: true, editedText: '편하게 010-1234-5678 로 전화 주세요.' });
  const surface = scriptedSurface();
  const out = await s.run(surface);
  assert.equal(out[0].action, 'blocked');
  const after = s.ledger.getOutbox(row.id);
  assert.deepEqual([after.status, after.verdict.verdict], ['blocked', 'refuse']);
  assert.equal(surface.calls.length, 0);
});

test('reconcile: a sending row found on the page is observed, one not found or a quote is unobserved, and nothing is resent', async () => {
  const s = setup();
  const t1 = s.thread('t1');
  const found = plan(s.ledger, { platform: 'kmong', threadId: t1.id, kind: 'message', payload: msgPayload() });
  setStatus(s.ledger, found.id, { from: 'planned', to: 'sending' });
  const t2 = s.thread('t2');
  const lost = plan(s.ledger, { platform: 'kmong', threadId: t2.id, kind: 'message', payload: msgPayload() });
  setStatus(s.ledger, lost.id, { from: 'planned', to: 'sending' });
  const surface = scriptedSurface({ threads: { t1: { messages: [{ direction: 'out', text: TEXT, externalId: 'x1' }], notices: [] }, t2: { messages: [], notices: [] } } });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[found.id, 'observed'], [lost.id, 'unobserved']]);
  assert.equal(s.ledger.getOutbox(found.id).receipt.reconciled, true);
  assert.equal(outMessages(s.ledger, t1.id).length, 1);
  assert.equal(surface.count('send'), 0);
  assert.equal(s.notes.at(-1).dedupeKey, 'outbox-unobserved:' + lost.id);
  const q = setup('soomgo');
  const qr = plan(q.ledger, { platform: 'soomgo', threadId: q.thread('r1', 'request').id, kind: 'quote', payload: quotePayload() });
  setStatus(q.ledger, qr.id, { from: 'planned', to: 'sending' });
  const qs = scriptedSurface();
  await q.run(qs);
  assert.deepEqual([q.ledger.getOutbox(qr.id).status, q.ledger.getOutbox(qr.id).reason], ['unobserved', 'the interrupted quote is not on the page']);
  assert.deepEqual([qs.count('quote'), qs.count('read')], [0, 0]);
});

test('reconcile a pay request from its notice, and a read-back that throws leaves the row sending', async () => {
  const s = setup('soomgo');
  const t = s.thread('c1');
  const row = plan(s.ledger, { platform: 'soomgo', threadId: t.id, kind: 'pay_request', payload: { text: 'r', amountKRW: 150000 } });
  setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-soomgo-0000aaaa' });
  resolve(s.ledger, '20261020-soomgo-0000aaaa', { approve: true });
  setStatus(s.ledger, row.id, { from: 'approved', to: 'sending' });
  const notice = '숨고페이\n고객에게 거래를 요청했어요\n서비스 금액: 150,000원';
  const at = new Date(Date.now() + 1000).toISOString();
  const surface = scriptedSurface({ threads: { c1: { messages: [], notices: [{ kind: 'SP_ST_002', text: notice, at }] } } });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => x.action), ['observed']);
  assert.equal(surface.count('payRequest'), 0);
  const t2 = s.thread('c2');
  const r2 = plan(s.ledger, { platform: 'soomgo', threadId: t2.id, kind: 'message', payload: msgPayload() });
  setStatus(s.ledger, r2.id, { from: 'planned', to: 'sending' });
  const broken = scriptedSurface({ threads: { c2: new Error('page did not load') } });
  const res = await s.run(broken);
  assert.equal(res[0].action, 'reconcile_failed');
  assert.equal(s.ledger.getOutbox(r2.id).status, 'sending');
});

test('an interrupted proposal goes to unobserved without a read call', async () => {
  const s = setup();
  const row = plan(s.ledger, { platform: 'kmong', threadId: s.thread('p1').id, kind: 'proposal', payload: { text: '제안드립니다', amountKRW: 1000000 } });
  setStatus(s.ledger, row.id, { from: 'planned', to: 'sending' });
  const surface = scriptedSurface({ methods: ['propose'] });
  await s.run(surface);
  assert.equal(s.ledger.getOutbox(row.id).status, 'unobserved');
  assert.equal(surface.count('read'), 0);
});

test('pacing returns the row to its status, writes send.deferred and stops the drain', async () => {
  const s = setup();
  const a = plan(s.ledger, { platform: 'kmong', threadId: s.thread('t1').id, kind: 'message', payload: msgPayload() });
  const b = plan(s.ledger, { platform: 'kmong', threadId: s.thread('t2').id, kind: 'message', payload: msgPayload() });
  const surface = scriptedSurface({ receipts: { send: [Object.assign(new Error('pacing limit'), { code: 'FSW_PACING_LIMIT' })] } });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.action, x.code]), [['deferred', 'FSW_PACING_LIMIT']]);
  assert.deepEqual([s.ledger.getOutbox(a.id).status, s.ledger.getOutbox(b.id).status], ['planned', 'planned']);
  assert.equal(events(s.ledger, 'send.deferred').length, 1);
  assert.ok(NOT_SENT.includes('FSW_PACING_LIMIT'));
});

test('a missing kmong enterprise profile returns the approved proposal, writes send.deferred and stops the drain', async () => {
  const s = setup();
  const rows = ['p1', 'p2'].map((ref, i) => {
    const row = plan(s.ledger, { platform: 'kmong', threadId: s.thread(ref).id, kind: 'proposal', payload: { text: '요청하신 범위로 제안드립니다. 일정은 협의 가능합니다. ' + i, amountKRW: 1000000 } });
    setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-kmong-0000000' + i });
    resolve(s.ledger, '20261020-kmong-0000000' + i, { approve: true });
    return row;
  });
  const surface = scriptedSurface({ methods: ['propose'], receipts: { propose: [Object.assign(new Error('the enterprise profile is not registered'), { code: 'FSW_KMONG_ENTERPRISE_PROFILE' })] } });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.action, x.code]), [['deferred', 'FSW_KMONG_ENTERPRISE_PROFILE']]);
  assert.deepEqual(rows.map((r) => s.ledger.getOutbox(r.id).status), ['approved', 'approved']);
  assert.deepEqual(events(s.ledger, 'send.deferred').map((e) => e.payload.code), ['FSW_KMONG_ENTERPRISE_PROFILE']);
  assert.equal(events(s.ledger, 'send.unobserved').length, 0);
});

test('a refused kmong proposal skips the newer proposals but a newer customer reply still goes out', async () => {
  const s = setup();
  const proposals = ['p1', 'p2'].map((ref, i) => {
    const row = plan(s.ledger, { platform: 'kmong', threadId: s.thread(ref).id, kind: 'proposal', payload: { text: '요청하신 범위로 제안드립니다. 일정은 협의 가능합니다. ' + i, amountKRW: 1000000 } });
    setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-kmong-1000000' + i });
    resolve(s.ledger, '20261020-kmong-1000000' + i, { approve: true });
    return row;
  });
  const t = s.thread('t1');
  const msg = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind: 'message', payload: msgPayload() });
  const surface = scriptedSurface({ methods: ['propose'], receipts: { propose: [Object.assign(new Error('the enterprise profile is not registered'), { code: 'FSW_KMONG_ENTERPRISE_PROFILE' })] } });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[proposals[0].id, 'deferred'], [msg.id, 'observed']]);
  assert.deepEqual([surface.count('propose'), surface.count('send')], [1, 1]);
  assert.deepEqual(proposals.map((r) => s.ledger.getOutbox(r.id).status), ['approved', 'approved']);
  assert.equal(s.ledger.getOutbox(msg.id).status, 'observed');
  assert.equal(outMessages(s.ledger, t.id).length, 1);
  assert.deepEqual(events(s.ledger, 'send.deferred').map((e) => [e.payload.outboxId, e.payload.code]), [[proposals[0].id, 'FSW_KMONG_ENTERPRISE_PROFILE']]);
});

test('a row another drain moved before the claim is skipped as moved with no surface call', async () => {
  const s = setup();
  const row = plan(s.ledger, { platform: 'kmong', threadId: s.thread('t1').id, kind: 'message', payload: msgPayload() });
  const surface = scriptedSurface();
  const before = events(s.ledger, 'outbox.status').length;
  const out = await s.run(surface, { hold: (r) => (s.ledger.updateOutbox(r.id, { status: 'sending' }, { from: 'planned' }), null) });
  assert.deepEqual(out.map((x) => x.action), ['moved']);
  assert.equal(surface.count('send'), 0);
  assert.equal(events(s.ledger, 'outbox.status').length, before);
});

test('a surface without payRequest or propose leaves those rows alone; one with propose sends an approved proposal', async () => {
  const s = setup();
  const t = s.thread('t1');
  const pay = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind: 'pay_request', payload: { text: 'p', amountKRW: 100000 } });
  const prop = plan(s.ledger, { platform: 'kmong', threadId: s.thread('p1').id, kind: 'proposal', payload: { text: '요청하신 범위로 제안드립니다. 일정은 협의 가능합니다.', amountKRW: 1000000, proposal: { phases: [{ title: 'a' }] } } });
  setStatus(s.ledger, prop.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-kmong-0000abcd' });
  resolve(s.ledger, '20261020-kmong-0000abcd', { approve: true });
  const bare = scriptedSurface({ methods: [] });
  assert.deepEqual([handles(bare, 'pay_request'), handles(bare, 'proposal'), handles(bare, 'message')], [false, false, true]);
  assert.deepEqual(await s.run(bare), []);
  assert.deepEqual([s.ledger.getOutbox(pay.id).status, s.ledger.getOutbox(prop.id).status], ['planned', 'approved']);
  const withPropose = scriptedSurface({ methods: ['propose'] });
  const out = await s.run(withPropose);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[prop.id, 'observed']]);
  const call = withPropose.calls.find((c) => c.name === 'propose');
  assert.deepEqual([call.args.amountKRW, call.args.phases.length, call.args.authorized.verdict], [1000000, 1, 'send']);
});

test('a soomgo quote goes to the surface with its customer, and a row without one passes null', async () => {
  const s = setup('soomgo', (c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, maxCashPerDay: 5000 } } }));
  const a = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r1', 'request').id, kind: 'quote', payload: quotePayload({ customer: '고객C' }) });
  const b = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r2', 'request').id, kind: 'quote', payload: quotePayload({ customer: undefined }) });
  const surface = scriptedSurface({ receipts: { quote: [{ observed: true, cashSpentKRW: 600 }, { observed: false, reason: 'no charge for 고객D' }] } });
  await s.run(surface);
  assert.deepEqual(surface.calls.filter((c) => c.name === 'quote').map((c) => [c.args.customer, c.args.allowSpendCash]), [['고객C', true], [null, true]]);
  assert.equal(s.ledger.getOutbox(a.id).status, 'observed');
  assert.equal(events(s.ledger, 'send.unobserved').at(-1).payload.reason, 'no charge for 고객D');
  assert.equal(s.ledger.getOutbox(b.id).status, 'unobserved');
});

test('quotes deferred by the daily caps ask nobody, then go out oldest first within the cap on a later day', async () => {
  const s = setup('soomgo');
  const today = new Date('2026-10-20T12:00:00+09:00');
  s.ledger.addQuote({ threadId: s.thread('old', 'request').id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 900, status: 'sent', at: today.toISOString() });
  const rows = ['r1', 'r2', 'r3'].map((ref, i) => plan(s.ledger, { platform: 'soomgo', threadId: s.thread(ref, 'request').id, kind: 'quote', payload: quotePayload({ costKRW: [500, 400, 300][i], text: TEXT + ' ' + ref }) }));
  const first = scriptedSurface();
  const held = await s.run(first, { now: today });
  assert.deepEqual(held.map((x) => x.action), ['held', 'held', 'held']);
  assert.deepEqual(rows.map((r) => s.ledger.getOutbox(r.id).status), ['planned', 'planned', 'planned']);
  assert.equal(s.notes.length, 0);
  assert.equal(first.count('quote'), 0);
  // The next Seoul day pays 500 then 400; 300 more would pass 1000, so the third waits for another day.
  const next = new Date('2026-10-21T09:00:00+09:00');
  const surface = scriptedSurface({ receipts: { quote: [{ observed: true, cashSpentKRW: 500 }, { observed: true, cashSpentKRW: 400 }] } });
  const out = await s.run(surface, { now: next });
  assert.deepEqual(out.map((x) => x.action), ['observed', 'observed', 'held']);
  assert.deepEqual(surface.calls.filter((c) => c.name === 'quote').map((c) => c.args.text), [TEXT + ' r1', TEXT + ' r2']);
  assert.equal(s.ledger.getOutbox(rows[2].id).status, 'planned');
  assert.equal(s.notes.length, 0);
});

test('the oldest deferred quote the day cannot pay holds every newer cash quote, and an approved one waiting tells the operator once', async () => {
  const s = setup('soomgo');
  s.ledger.addQuote({ threadId: s.thread('old', 'request').id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 500, status: 'sent', at: NOON.toISOString() });
  const big = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r1', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 600, text: TEXT + ' big' }) });
  const small = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r2', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 300, text: TEXT + ' small' }) });
  const surface = scriptedSurface();
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[big.id, 'held'], [small.id, 'held']]);
  assert.equal(surface.count('quote'), 0);
  setStatus(s.ledger, big.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-soomgo-0000beef' });
  resolve(s.ledger, '20261020-soomgo-0000beef', { approve: true });
  await s.run(surface);
  await s.run(surface);
  assert.deepEqual(s.notes.map((n) => n.dedupeKey), ['outbox-held:' + big.id + ':20261020', 'outbox-held:' + big.id + ':20261020']);
  assert.equal(surface.count('quote'), 0);
});

test('a deferred quote whose service the instance stopped answering is left for the operator', async () => {
  const s = setup('soomgo');
  // The day's cash is spent, so the quote is deferred while its service is still answered.
  s.ledger.addQuote({ threadId: s.thread('old', 'request').id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, costKRW: 900, status: 'sent', at: NOON.toISOString() });
  const row = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r1', 'request').id, kind: 'quote', payload: quotePayload() });
  const first = await s.run(scriptedSurface());
  assert.deepEqual([first[0].action, s.ledger.getOutbox(row.id).status, s.notes.length], ['held', 'planned', 0]);
  // The operator turns the service off; on the next day's budget the deferred quote goes to the operator.
  s.instance.config.platforms.soomgo.services = ['web_app_dev'];
  const surface = scriptedSurface();
  const out = await s.run(surface, { now: new Date('2026-10-21T09:00:00+09:00') });
  assert.equal(out[0].action, 'awaiting_operator');
  assert.match(out[0].reason, /landing_page_web is no longer answered on soomgo/);
  assert.equal(surface.count('quote'), 0);
});

test('an approved cash quote of unknown cost goes back to the operator without holding newer quotes, and can be rejected', async () => {
  const s = setup('soomgo');
  const unknown = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r1', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: null, text: TEXT + ' unknown' }) });
  const first = await s.run(scriptedSurface());
  assert.equal(first[0].action, 'awaiting_operator');
  assert.match(first[0].reason, /the quote cost was not read from the page/);
  resolve(s.ledger, s.ledger.getOutbox(unknown.id).approvalId, { approve: true });
  const known = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r2', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 300, text: TEXT + ' known' }) });
  const surface = scriptedSurface({ receipts: { quote: [{ observed: true, cashSpentKRW: 300 }] } });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[unknown.id, 'operator'], [known.id, 'observed']]);
  assert.deepEqual(surface.calls.filter((c) => c.name === 'quote').map((c) => c.args.text), [TEXT + ' known']);
  assert.equal(s.ledger.getOutbox(unknown.id).status, 'approved');
  assert.ok(s.notes.some((n) => n.dedupeKey === 'outbox-unpayable:' + unknown.id));
  assert.equal(resolve(s.ledger, s.ledger.getOutbox(unknown.id).approvalId, { approve: false, reason: 'cost unknown' }).status, 'rejected');
});

test('a cash quote left in sending stays counted against the cap once reconciled, and so does one whose surface threw', async () => {
  const s = setup('soomgo');
  const left = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r1', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 600, text: TEXT + ' left' }) });
  setStatus(s.ledger, left.id, { from: 'planned', to: 'sending' });
  // The claim happened on the test's day: the press is dated by it.
  s.ledger.updateOutbox(left.id, { updatedAt: NOON.toISOString() });
  const next = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r2', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 600, text: TEXT + ' next' }) });
  const surface = scriptedSurface();
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[left.id, 'unobserved'], [next.id, 'held']]);
  const row = s.ledger.getOutbox(left.id);
  assert.deepEqual([row.receipt.pressed, row.receipt.costKRW], [true, 600]);
  assert.deepEqual(quotaUsage(s.ledger, 'soomgo', NOON), { quotes: 1, cashKRW: 600 });
  assert.equal(surface.count('quote'), 0);
  const t = setup('soomgo');
  const thrown = plan(t.ledger, { platform: 'soomgo', threadId: t.thread('r3', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 600 }) });
  await t.run(scriptedSurface({ receipts: { quote: [new Error('the page closed after the click')] } }));
  assert.deepEqual([t.ledger.getOutbox(thrown.id).status, t.ledger.getOutbox(thrown.id).receipt.pressed], ['unobserved', true]);
  assert.deepEqual(quotaUsage(t.ledger, 'soomgo', NOON), { quotes: 1, cashKRW: 600 });
});


test('read-back after an interrupted send ignores an older bubble with the same text, and an undated delivery stays unobserved', async () => {
  const s = setup();
  const t = s.thread('t1');
  const row = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind: 'message', payload: msgPayload() });
  setStatus(s.ledger, row.id, { from: 'planned', to: 'sending' });
  s.ledger.updateOutbox(row.id, { updatedAt: NOON.toISOString() });
  const old = new Date(NOON.getTime() - 3 * 3_600_000).toISOString();
  const surface = scriptedSurface({ threads: { t1: { messages: [{ direction: 'out', text: TEXT, at: old, externalId: 'old' }], notices: [] } } });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => x.action), ['unobserved']);
  assert.equal(outMessages(s.ledger, t.id).length, 0);
  const d = setup('soomgo');
  const dt = d.thread('c1');
  const del = plan(d.ledger, { platform: 'soomgo', threadId: dt.id, kind: 'delivery', payload: { text: '전달드립니다', files: [], runAt: 'r1', review: { verdict: 'pass', findings: [] } } });
  setStatus(d.ledger, del.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-soomgo-0000dd01' });
  resolve(d.ledger, '20261020-soomgo-0000dd01', { approve: true });
  setStatus(d.ledger, del.id, { from: 'approved', to: 'sending' });
  await d.run(scriptedSurface({ threads: { c1: { messages: [{ direction: 'out', text: '전달드립니다', at: null, externalId: 'x' }], notices: [] } } }));
  assert.equal(d.ledger.getOutbox(del.id).status, 'unobserved');
  const fresh = setup();
  const ft = fresh.thread('t2');
  const fr = plan(fresh.ledger, { platform: 'kmong', threadId: ft.id, kind: 'message', payload: msgPayload() });
  setStatus(fresh.ledger, fr.id, { from: 'planned', to: 'sending' });
  fresh.ledger.updateOutbox(fr.id, { updatedAt: NOON.toISOString() });
  await fresh.run(scriptedSurface({ threads: { t2: { messages: [{ direction: 'out', text: TEXT, at: new Date(NOON.getTime() + 30_000).toISOString(), externalId: 'new' }], notices: [] } } }));
  assert.equal(fresh.ledger.getOutbox(fr.id).status, 'observed');
});


// A driver session behind the real soomgo adapter whose quote form fills, presses and then finds no charge
// in 충전/사용 내역, so the adapter returns {observed: false, pressed: true, costKRW}.
function pressedSoomgoSession({ cost = 990, sendDisabled = false } = {}) {
  const form = { priceValue: '', textValue: '' };
  const detail = () => ({ url: 'https://soomgo.com/requests/received/r1?from=request_list', service: '웹 개발', pairs: [], customerText: '', form: { priceInput: true, priceValue: form.priceValue, priceTypes: ['총 비용', '시간 당'], selectedPriceType: '총 비용', textarea: true, textValue: form.textValue, textMaxChars: 1000, fileInput: true, saveTemplateChecked: false, sendLabel: cost.toLocaleString('en') + ' 캐시로 견적 보내기', sendDisabled } });
  const answers = { pageRequestDetail: detail, pageText: () => '충전/사용 내역' };
  return {
    loads: 0,
    guard: { beforeLoad: async () => {}, beforeAction: () => {}, beforeMessage: () => {} },
    navigate: async (url) => url,
    evaluate: async (fn) => answers[fn.name](),
    typeKeys: async (_t, v) => { form.priceValue = v ? Number(v).toLocaleString('en') : '0'; },
    fill: async (_t, v) => { form.textValue = v; },
    click: async () => {},
    stop: async () => {},
  };
}

test('a pressed quote counts at the cost the page showed, and one refused before the press counts nothing', { timeout: 60_000 }, async () => {
  const { openSurface } = await import('../src/surface/index.mjs');
  const s = setup('soomgo');
  const priced = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r1', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 990, text: TEXT + ' priced' }) });
  await s.run(await openSurface('soomgo', { session: pressedSoomgoSession({ cost: 700 }) }));
  assert.deepEqual([s.ledger.getOutbox(priced.id).receipt.costKRW, quotaUsage(s.ledger, 'soomgo', NOON)], [700, { quotes: 1, cashKRW: 700 }]);
  const t = setup('soomgo');
  const refused = plan(t.ledger, { platform: 'soomgo', threadId: t.thread('r2', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 990, text: TEXT + ' refused' }) });
  await t.run(await openSurface('soomgo', { session: pressedSoomgoSession({ sendDisabled: true }) }));
  assert.deepEqual([t.ledger.getOutbox(refused.id).receipt.pressed, quotaUsage(t.ledger, 'soomgo', NOON)], [false, { quotes: 0, cashKRW: 0 }]);
});

test('a quote the real soomgo surface pressed without a found charge stays counted against the cap', { timeout: 60_000 }, async () => {
  const { openSurface } = await import('../src/surface/index.mjs');
  const s = setup('soomgo');
  const first = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r1', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 990, text: TEXT + ' first' }) });
  const surface = await openSurface('soomgo', { session: pressedSoomgoSession() });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => x.action), ['unobserved']);
  const row = s.ledger.getOutbox(first.id);
  assert.deepEqual([row.receipt.pressed, row.receipt.costKRW], [true, 990]);
  assert.match(row.reason, /the quote charge was not observed/);
  assert.deepEqual(quotaUsage(s.ledger, 'soomgo', NOON), { quotes: 1, cashKRW: 990 });
  const second = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r2', 'request').id, kind: 'quote', payload: quotePayload({ costKRW: 990, text: TEXT + ' second' }) });
  const again = await s.run(surface);
  assert.deepEqual(again.map((x) => [x.id, x.action]), [[second.id, 'held']]);
});

test('a proposal for a project that closed goes stale with its reason and asks the operator nothing', async () => {
  const s = setup();
  const row = plan(s.ledger, { platform: 'kmong', threadId: s.thread('project:7').id, kind: 'proposal', payload: { text: '요청하신 범위로 제안드립니다. 일정은 협의 가능합니다.', amountKRW: 1000000 } });
  setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-kmong-2000000a' });
  resolve(s.ledger, '20261020-kmong-2000000a', { approve: true });
  const t = s.thread('t1');
  const msg = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind: 'message', payload: msgPayload() });
  const surface = scriptedSurface({ methods: ['propose'], receipts: { propose: [Object.assign(new Error('project 7 is CLOSED; nothing was typed'), { code: 'FSW_KMONG_PROJECT_CLOSED' })] } });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[row.id, 'stale'], [msg.id, 'observed']]);
  const after = s.ledger.getOutbox(row.id);
  assert.deepEqual([after.status, after.reason, after.approvalId], ['stale', 'project 7 is CLOSED; nothing was typed', '20261020-kmong-2000000a']);
  assert.equal(events(s.ledger, 'send.unobserved').length, 0);
  assert.deepEqual(s.notes, []);
});


test('a soomgo quote the platform refused as full goes stale, counts no press and asks the operator nothing', async () => {
  const s = setup('soomgo');
  const row = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('r1', 'request').id, kind: 'quote', payload: quotePayload() });
  const surface = scriptedSurface({ receipts: { quote: [Object.assign(new Error('soomgo took no quote: 이미 10개 이상 견적을 받은 요청입니다.'), { code: 'FSW_SOOMGO_REQUEST_FULL' })] } });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action, x.code]), [[row.id, 'stale', 'FSW_SOOMGO_REQUEST_FULL']]);
  const after = s.ledger.getOutbox(row.id);
  assert.deepEqual([after.status, after.reason], ['stale', 'soomgo took no quote: 이미 10개 이상 견적을 받은 요청입니다.']);
  // The refusal code stays on the row, where src/economics/quote-results.mjs reads a refused quote.
  assert.deepEqual(after.receipt, { refused: 'FSW_SOOMGO_REQUEST_FULL', at: NOON.toISOString() });
  assert.deepEqual(quotaUsage(s.ledger, 'soomgo', NOON), { quotes: 0, cashKRW: 0 });
  assert.equal(events(s.ledger, 'send.unobserved').length, 0);
  assert.deepEqual(s.notes, []);
});

// U7.7: a delivery is approved only after a passed review, or with the operator's stated reason.
test('resolve refuses a delivery without a passed review unless a reason is given, and stores nothing when it refuses', () => {
  const s = setup('soomgo');
  const waiting = (ref, id, review) => {
    const row = plan(s.ledger, { platform: 'soomgo', threadId: s.thread(ref).id, kind: 'delivery', payload: { text: '전달드립니다', files: ['C:/jobs/j1/work/copy/a.md'], runAt: '2026-10-20T10:00:00Z', ...(review ? { review } : {}) } });
    setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: id, reason: 'delivery' });
    return row;
  };
  const failed = waiting('d1', '20261020-soomgo-0000d001', { verdict: 'fail', findings: [{ severity: 'blocker', file: null, detail: 'x' }] });
  const none = waiting('d2', '20261020-soomgo-0000d002', null);
  const passed = waiting('d3', '20261020-soomgo-0000d003', { verdict: 'pass', findings: [] });
  for (const reason of [undefined, '', '   ']) assert.throws(() => resolve(s.ledger, '20261020-soomgo-0000d001', { approve: true, reason }), { code: 'FSW_REVIEW_NOT_PASSED', message: /has review fail; approving it needs --reason/ });
  assert.throws(() => resolve(s.ledger, '20261020-soomgo-0000d002', { approve: true }), { code: 'FSW_REVIEW_NOT_PASSED', message: /has review error/ });
  for (const r of [failed, none]) assert.deepEqual([s.ledger.getOutbox(r.id).status, s.ledger.getOutbox(r.id).operator ?? null], ['awaiting_operator', null]);
  const over = resolve(s.ledger, '20261020-soomgo-0000d001', { approve: true, reason: 'checked both variants by hand' });
  assert.deepEqual([over.status, over.operator.resolutionReason], ['approved', 'checked both variants by hand']);
  assert.equal(resolve(s.ledger, '20261020-soomgo-0000d003', { approve: true }).status, 'approved');
  assert.equal(resolve(s.ledger, '20261020-soomgo-0000d002', { approve: false }).status, 'rejected');
  assert.equal(s.ledger.getOutbox(passed.id).status, 'approved');
  const message = plan(s.ledger, { platform: 'soomgo', threadId: s.thread('m1').id, kind: 'message', payload: msgPayload() });
  setStatus(s.ledger, message.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-soomgo-0000d004', reason: 'draft mode' });
  assert.equal(resolve(s.ledger, '20261020-soomgo-0000d004', { approve: true }).status, 'approved');
});
