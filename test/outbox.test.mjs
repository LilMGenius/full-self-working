import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { copyFileSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hashTree } from '../src/core/reviewed.mjs';
import { basename, join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger, outboxKey } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { authorize } from '../src/policy/authorize.mjs';
import { drain, plan, resolve, setStatus, settleSent, signalOf } from '../src/outbox/index.mjs';
import { NOT_SENT, PROPOSAL_NOT_SENT, handles, keepCost } from '../src/outbox/drain.mjs';
import { TRANSITIONS } from '../src/outbox/plan.mjs';
import { bidUsage, quotaUsage } from '../src/outbox/usage.mjs';
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
// gate: the value gate's send verdict the loop stamps on a paid request quote it plans (src/loop/step.mjs).
const quotePayload = (over = {}) => ({ text: TEXT, amountKRW: 300000, priceType: 'fixed', costKRW: 600, serviceLabel: '웹 개발', service: 'landing_page_web', priceRow: ROW, customer: null, thread: { kind: 'request', stage: 'pre_order', lastInboundText: '웹 개발 견적 부탁드립니다', recentOutbound: [] }, decision: decision({ intent: 'quote_request' }), gate: { verdict: 'send', evKRW: 82000, p: 1 / 3, at: NOON.toISOString() }, ...over });

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
// A passed review as src/work/review.mjs records it, for a delivery with no reviewed file of its own.
const passedReview = () => {
  const work = tempDir('fsw-outbox-reviewed-');
  return { verdict: 'pass', findings: [], reviewed: [], work, hash: hashTree(work, []) };
};

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
  // The next Seoul day pays 500 then 400; 300 more would pass 1000, so the third waits for another day. At 22:00 the
  // day's pace allows 916 of the 1000, so only the cap holds the third.
  const next = new Date('2026-10-21T22:00:00+09:00');
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
  const del = plan(d.ledger, { platform: 'soomgo', threadId: dt.id, kind: 'delivery', payload: { text: '전달드립니다', files: [], runAt: 'r1', review: passedReview() } });
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
  const waiting = (ref, id, review, files = ['C:/jobs/j1/work/copy/a.md']) => {
    const row = plan(s.ledger, { platform: 'soomgo', threadId: s.thread(ref).id, kind: 'delivery', payload: { text: '전달드립니다', files, runAt: '2026-10-20T10:00:00Z', ...(review ? { review } : {}) } });
    setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: id, reason: 'delivery' });
    return row;
  };
  const failed = waiting('d1', '20261020-soomgo-0000d001', { verdict: 'fail', findings: [{ severity: 'blocker', file: null, detail: 'x' }] });
  const none = waiting('d2', '20261020-soomgo-0000d002', null);
  // The passed review read the one file the delivery holds.
  const work = tempDir('fsw-outbox-reviewed-');
  mkdirSync(join(work, 'copy'), { recursive: true });
  writeFileSync(join(work, 'copy', 'a.md'), '# 빵집\n');
  const passed = waiting('d3', '20261020-soomgo-0000d003', { verdict: 'pass', findings: [], reviewed: ['copy/a.md'], work, hash: hashTree(work, ['copy/a.md']) }, [join(work, 'copy', 'a.md')]);
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

// Complete mediation for a reviewed delivery: resolve itself refuses a changed one without a reason, and the drain
// sends only the bytes the operator approved.
// added: names of files an operator step wrote beside the work after the review, which the review never read.
function reviewedDelivery(s, ref, approvalId, added = []) {
  const work = join(tempDir('fsw-outbox-work-'), 'work');
  mkdirSync(join(work, 'copy'), { recursive: true });
  const file = join(work, 'copy', 'a.md');
  writeFileSync(file, '# 빵집\n');
  const extra = added.map((name) => join(work, '..', 'handoff', name));
  if (extra.length) mkdirSync(join(work, '..', 'handoff'), { recursive: true });
  for (const f of extra) writeFileSync(f, 'bytes of ' + f);
  const review = { verdict: 'pass', findings: [], reviewed: ['copy/a.md'], work, hash: hashTree(work, ['copy/a.md']) };
  const row = plan(s.ledger, { platform: 'soomgo', threadId: s.thread(ref).id, kind: 'delivery', payload: { text: '전달드립니다', files: [file, ...extra], runAt: '2026-10-20T10:00:00Z', review } });
  setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId, reason: 'delivery' });
  return { row, file, added: extra };
}

test('resolve refuses a passed delivery whose reviewed files changed unless a reason is given', () => {
  const s = setup('soomgo');
  const { row, file } = reviewedDelivery(s, 'd1', '20261020-soomgo-0000e001');
  writeFileSync(file, '# 바뀐 빵집\n');
  for (const reason of [undefined, ' ']) assert.throws(() => resolve(s.ledger, '20261020-soomgo-0000e001', { approve: true, reason }), { code: 'FSW_REVIEW_CHANGED', message: /changed since its review; approving it needs --reason/ });
  assert.deepEqual([s.ledger.getOutbox(row.id).status, s.ledger.getOutbox(row.id).operator ?? null], ['awaiting_operator', null]);
  const done = resolve(s.ledger, '20261020-soomgo-0000e001', { approve: true, reason: 'I changed the title' });
  assert.equal(done.status, 'approved');
  assert.match(done.operator.filesHash, /^[0-9a-f]{64}$/);
});

// A file the review never read (handoff.xlsx added after the run) is covered by the approval stamp and sent, so it
// needs the operator's stated reason as a changed file does, and the refusal names it.
test('resolve refuses a passed delivery holding a file its review never read unless a reason is given', () => {
  const s = setup('soomgo');
  const { row, added } = reviewedDelivery(s, 'd1', '20261020-soomgo-0000e004', ['handoff.xlsx']);
  for (const reason of [undefined, '', ' ']) assert.throws(() => resolve(s.ledger, '20261020-soomgo-0000e004', { approve: true, reason }), (err) => err.code === 'FSW_REVIEW_UNREVIEWED' && err.message.includes('holds files its review never read: ' + added[0]) && /approving it needs --reason/.test(err.message));
  assert.deepEqual([s.ledger.getOutbox(row.id).status, s.ledger.getOutbox(row.id).operator ?? null], ['awaiting_operator', null]);
  const done = resolve(s.ledger, '20261020-soomgo-0000e004', { approve: true, reason: 'I wrote the handoff sheet myself' });
  assert.deepEqual([done.status, done.operator.resolutionReason], ['approved', 'I wrote the handoff sheet myself']);
});

test('the drain blocks a delivery whose files changed after its approval and tells the operator once', async () => {
  const s = setup('soomgo');
  const kept = reviewedDelivery(s, 'd1', '20261020-soomgo-0000e002');
  const changed = reviewedDelivery(s, 'd2', '20261020-soomgo-0000e003');
  resolve(s.ledger, '20261020-soomgo-0000e002', { approve: true });
  resolve(s.ledger, '20261020-soomgo-0000e003', { approve: true });
  writeFileSync(changed.file, '# 승인 뒤에 바뀐 빵집\n');
  const surface = scriptedSurface();
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action]).sort(), [[kept.row.id, 'observed'], [changed.row.id, 'blocked']].sort());
  const blocked = s.ledger.getOutbox(changed.row.id);
  assert.deepEqual([blocked.status, /changed since the operator approved it/.test(blocked.reason)], ['blocked', true]);
  assert.deepEqual(surface.calls.filter((c) => c.name === 'send').map((c) => c.ref), ['d1']);
  assert.deepEqual(s.notes.filter((n) => /changed since/.test(n.body)).map((n) => n.dedupeKey), ['outbox-blocked:' + changed.row.id]);
  await s.run(surface);
  assert.equal(s.notes.filter((n) => /changed since/.test(n.body)).length, 1);
});

// The drain uploads copies taken before the claim: a file rewritten while the surface works (soomgo sets the file
// input only after it opens the chat and types) still goes out as the bytes the operator approved, and the copies are
// removed once the send settles, whether the surface returned or threw.
test('an approved delivery uploads the approved bytes even when its file changes during the send', async () => {
  const s = setup('soomgo');
  const sent = reviewedDelivery(s, 'd1', '20261020-soomgo-0000e005');
  const crashed = reviewedDelivery(s, 'd2', '20261020-soomgo-0000e006');
  resolve(s.ledger, '20261020-soomgo-0000e005', { approve: true });
  resolve(s.ledger, '20261020-soomgo-0000e006', { approve: true });
  const uploaded = [];
  const send = (ref, args) => {
    const original = ref === 'd1' ? sent.file : crashed.file;
    writeFileSync(original, '# 업로드 직전에 바뀐 빵집\n');
    for (const f of args.files) uploaded.push({ ref, name: basename(f), bytes: readFileSync(f, 'utf8'), path: f, original });
    return ref === 'd1' ? { observed: true } : new Error('the page crashed during the upload');
  };
  const out = await s.run(scriptedSurface({ receipts: { send } }));
  assert.deepEqual(out.map((x) => [x.id, x.action]).sort(), [[sent.row.id, 'observed'], [crashed.row.id, 'unobserved']].sort());
  assert.deepEqual(uploaded.map((u) => [u.ref, u.name, u.bytes]).sort(), [['d1', 'a.md', '# 빵집\n'], ['d2', 'a.md', '# 빵집\n']]);
  for (const u of uploaded) {
    assert.notEqual(u.path, u.original);
    assert.equal(existsSync(u.path), false, 'the frozen copy of ' + u.ref + ' is removed once the send settles');
  }
});

// A send folder Windows will not let go (EBUSY after rmSync's own retries) is recorded and left for a later drain: the
// removal never takes the place of the send's result or stops the rows after it.
test('a send folder that cannot be removed leaves the receipt observed, the next row drained and the folder to a later drain', async () => {
  const s = setup('soomgo');
  const first = reviewedDelivery(s, 'd1', '20261020-soomgo-0000e007');
  const second = reviewedDelivery(s, 'd2', '20261020-soomgo-0000e008');
  resolve(s.ledger, '20261020-soomgo-0000e007', { approve: true });
  resolve(s.ledger, '20261020-soomgo-0000e008', { approve: true });
  const realRm = fs.rmSync;
  fs.rmSync = (path, opts) => {
    if (basename(String(path)).startsWith('fsw-send-')) throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir ' + path), { code: 'EBUSY' });
    return realRm(path, opts);
  };
  syncBuiltinESMExports();
  let out;
  try {
    out = await s.run(scriptedSurface());
  } finally {
    fs.rmSync = realRm;
    syncBuiltinESMExports();
  }
  assert.deepEqual(out.map((x) => [x.id, x.action]).sort(), [[first.row.id, 'observed'], [second.row.id, 'observed']].sort());
  for (const { row } of [first, second]) assert.equal(s.ledger.getOutbox(row.id).status, 'observed');
  const left = s.ledger.db.prepare("SELECT payload FROM events WHERE kind = 'send.cleanup_failed'").all().map((e) => JSON.parse(e.payload));
  assert.deepEqual(left.map((e) => [e.outboxId, e.code]).sort(), [[first.row.id, 'EBUSY'], [second.row.id, 'EBUSY']].sort());
  for (const e of left) assert.ok(existsSync(e.dir), 'the event names the folder left behind: ' + e.dir);
  // An hour on, the next drain removes them.
  const old = new Date(Date.now() - 2 * 3_600_000);
  for (const e of left) utimesSync(e.dir, old, old);
  await s.run(scriptedSurface());
  for (const e of left) assert.equal(existsSync(e.dir), false, e.dir + ' is swept');
});

// wp8: proposals that spend bids (freelancer, upwork) go out inside platforms.<id>.bidBudget, counted from the
// outbox rows the drain itself sets observed, so two proposals in one drain never both pass on one count.
const mappedFreelancer = () => {
  const d = structuredClone(loadDescriptor('freelancer'));
  d.forms.proposal = { mapped: true, mappedAt: '2026-10-28T00:00:00Z', recording: 'test fixture', readBack: true };
  return d;
};
const EN = 'I can build this with the layout you described. Let me know the schedule you have in mind.';
// A bid as the loop plans it: priced by code from a viable price row and stated in dollars at the day's rate
// (U8.11), so only the bid budget decides it.
const bidPayload = (costKRW, i) => ({ text: EN + ' ' + i, amountKRW: 400000, currency: 'USD', amount: 286, fx: RATE('2026-10-19'), costKRW, priceRow: { ...ROW, platform: 'freelancer' }, thread: { kind: 'request', stage: 'pre_order', lastInboundText: 'Need a landing page', recentOutbound: [] }, decision: decision({ intent: 'quote_request', language: 'en', reply: EN, quote: { amountKRW: 400000, scope: ['landing page'], deliveryDays: 7, priceType: 'fixed', complexity: 1 } }) });
// A freelancer drain with the proposal form mapped and the day's rate of 2026-10-19 unless a case says otherwise.
const bidSetup = (bidBudget) => {
  const s = setup('freelancer', (c) => ({ ...c, platforms: { ...c.platforms, freelancer: { ...c.platforms.freelancer, enabled: true, mode: 'auto', bidBudget } } }));
  return { ...s, run: (surface, over = {}) => s.run(surface, { descriptor: mappedFreelancer(), loadFx: dayRate, ...over }) };
};

test('two priced proposals with room for one: the first goes out and the second is blocked by budget.bid', async () => {
  const s = bidSetup({ monthlyKRW: 3000, stopAfterUnanswered: 20 });
  const rows = ['p1', 'p2'].map((ref, i) => plan(s.ledger, { platform: 'freelancer', threadId: s.thread(ref, 'request').id, kind: 'proposal', payload: bidPayload(2000, i) }));
  const surface = scriptedSurface({ methods: ['propose'] });
  const out = await s.run(surface, { descriptor: mappedFreelancer() });
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[rows[0].id, 'observed'], [rows[1].id, 'blocked']]);
  assert.equal(surface.count('propose'), 1);
  assert.match(s.ledger.getOutbox(rows[1].id).reason, /^budget\.bid .*the month's bid budget is spent \(2000 \+ 2000 over 3000 KRW\)/);
  assert.deepEqual(bidUsage(s.ledger, 'freelancer', NOON), { bidMonthKRW: 2000, bidUnanswered: 1, unknownCost: [] });
});

test('one more unanswered proposal than the limit allows stops the next bid, and a reply frees its place', async () => {
  const s = bidSetup({ monthlyKRW: 100000, stopAfterUnanswered: 1 });
  const threads = ['p1', 'p2'].map((ref) => s.thread(ref, 'request'));
  const rows = threads.map((t, i) => plan(s.ledger, { platform: 'freelancer', threadId: t.id, kind: 'proposal', payload: bidPayload(0, i) }));
  const surface = scriptedSurface({ methods: ['propose'] });
  const out = await s.run(surface, { descriptor: mappedFreelancer() });
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[rows[0].id, 'observed'], [rows[1].id, 'blocked']]);
  assert.match(s.ledger.getOutbox(rows[1].id).reason, /1 sent proposals have no reply; bids stop at 1/);
  const sentAt = Date.parse(s.ledger.getOutbox(rows[0].id).updatedAt);
  s.ledger.addMessage({ threadId: threads[0].id, direction: 'in', body: 'Thanks, can we talk?', externalId: 'r1', at: new Date(sentAt + 60_000).toISOString() });
  assert.deepEqual(bidUsage(s.ledger, 'freelancer', NOON), { bidMonthKRW: 0, bidUnanswered: 0, unknownCost: [] });
});
// U8.11 of wp8: a converted proposal carries its rate; the drain sends its amount and currency, sends nothing on
// a rate older than the day's, and reads an interrupted one back from the board's own proposal list.
const RATE = (date) => ({ currency: 'USD', krwPerUnit: 1400, date, source: 'https://api.frankfurter.dev/v1/latest?base=USD' });
const dayRate = async () => ({ day: '20261020', source: 'https://api.frankfurter.dev/v1/latest?base=USD', date: '2026-10-19', base: 'USD', rates: { USD: 1, KRW: 1400 } });
const usdPayload = (fxDate, i = 0) => ({ ...bidPayload(0, i), amountKRW: 480000, amount: 343, currency: 'USD', deliveryDays: 7, fx: RATE(fxDate) });

test('a proposal priced at an older rate than the day goes stale with no surface call; one at the day rate sends amount, currency and period', async () => {
  const s = bidSetup({ monthlyKRW: 0, stopAfterUnanswered: 20 });
  const old = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p1', 'request').id, kind: 'proposal', payload: usdPayload('2026-10-16', 0) });
  const current = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p2', 'request').id, kind: 'proposal', payload: usdPayload('2026-10-19', 1) });
  const surface = scriptedSurface({ methods: ['propose'] });
  const out = await s.run(surface, { descriptor: mappedFreelancer(), loadFx: dayRate });
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[old.id, 'stale'], [current.id, 'observed']]);
  assert.match(s.ledger.getOutbox(old.id).reason, /343 USD at the rate of 2026-10-16, older than the rate of 2026-10-19/);
  const calls = surface.calls.filter((c) => c.name === 'propose');
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].ref, calls[0].args.amount, calls[0].args.currency, calls[0].args.amountKRW, calls[0].args.periodDays, calls[0].args.authorized.verdict], ['p2', 343, 'USD', 480000, 7, 'send']);
});

test('a rate the day cannot read holds the converted proposal, and a KRW proposal gets amount in KRW', async () => {
  const s = bidSetup({ monthlyKRW: 0, stopAfterUnanswered: 20 });
  const row = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p1', 'request').id, kind: 'proposal', payload: usdPayload('2026-10-19') });
  const down = async () => Promise.reject(Object.assign(new Error('HTTP 503'), { code: 'FSW_FX_UNAVAILABLE' }));
  const surface = scriptedSurface({ methods: ['propose'] });
  const out = await s.run(surface, { descriptor: mappedFreelancer(), loadFx: down });
  assert.deepEqual([out[0].action, s.ledger.getOutbox(row.id).status, surface.count('propose')], ['held', 'planned', 0]);
  const k = setup();
  const prop = plan(k.ledger, { platform: 'kmong', threadId: k.thread('p1').id, kind: 'proposal', payload: { text: '요청하신 범위로 제안드립니다. 일정은 협의 가능합니다.', amountKRW: 1000000 } });
  setStatus(k.ledger, prop.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-kmong-0000beef' });
  resolve(k.ledger, '20261020-kmong-0000beef', { approve: true });
  const spy = scriptedSurface({ methods: ['propose'] });
  await k.run(spy, { loadFx: async () => assert.fail('a KRW proposal reads no rate') });
  const call = spy.calls.find((c) => c.name === 'propose');
  assert.deepEqual([call.args.amount, call.args.currency, call.args.periodDays], [1000000, 'KRW', null]);
});

test('an interrupted proposal is observed through the surface proposal list, and one it does not list goes to unobserved', async () => {
  const s = bidSetup({ monthlyKRW: 0, stopAfterUnanswered: 20 });
  const seen = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p1', 'request').id, kind: 'proposal', payload: usdPayload('2026-10-19', 0) });
  const missing = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p2', 'request').id, kind: 'proposal', payload: usdPayload('2026-10-19', 1) });
  for (const row of [seen, missing]) setStatus(s.ledger, row.id, { from: 'planned', to: 'sending' });
  const surface = scriptedSurface({ methods: ['propose'] });
  const asked = [];
  surface.proposalSent = async (ref, opts) => (asked.push([ref, typeof opts.since]), ref === 'p1' ? { observed: true, externalId: 'bid-77' } : { observed: false, reason: 'no bid on project p2 in the bid list' });
  const out = await s.run(surface, { descriptor: mappedFreelancer(), loadFx: dayRate });
  assert.deepEqual(asked, [['p1', 'string'], ['p2', 'string']]);
  assert.deepEqual(out.map((x) => [x.id, x.action, x.reconciled ?? null]), [[seen.id, 'observed', true], [missing.id, 'unobserved', null]]);
  assert.equal(s.ledger.getOutbox(seen.id).receipt.externalId, 'bid-77');
  assert.equal(s.ledger.getOutbox(missing.id).reason, 'no bid on project p2 in the bid list');
  assert.deepEqual([surface.count('propose'), surface.count('read')], [0, 0]);
});

// A bid's earlier spend is the receipt's recorded cost before the planned one; an unknown cost is never 0
// (the C review of wp8, finding 1).
const earlierBid = (s, ref, payloadCost, receipt, approvalId = '20261020-freelancer-0000aaa1') => {
  const t = s.thread(ref, 'request');
  return s.ledger.addOutbox({ key: 'earlier-' + ref, platform: 'freelancer', threadId: t.id, kind: 'proposal', status: 'unobserved', approvalId, payload: { ...bidPayload(payloadCost, ref), costKRW: payloadCost }, receipt, updatedAt: NOON.toISOString() });
};

test('an earlier bid counts the cost its receipt recorded over the planned one, so a bid past the month limit is blocked', async () => {
  const s = bidSetup({ monthlyKRW: 3000, stopAfterUnanswered: 20 });
  earlierBid(s, 'old', 1000, { observed: false, costKRW: 2500 });
  const row = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p1', 'request').id, kind: 'proposal', payload: bidPayload(2000, 1) });
  assert.deepEqual(bidUsage(s.ledger, 'freelancer', NOON), { bidMonthKRW: 2500, bidUnanswered: 1, unknownCost: [] });
  const surface = scriptedSurface({ methods: ['propose'] });
  const out = await s.run(surface, { descriptor: mappedFreelancer() });
  assert.deepEqual([out.map((x) => x.action), surface.count('propose')], [['blocked'], 0]);
  assert.match(s.ledger.getOutbox(row.id).reason, /\(2500 \+ 2000 over 3000 KRW\)/);
});

test('an earlier bid with no known cost blocks the next bid by name until the operator settles it with --cost', async () => {
  const s = bidSetup({ monthlyKRW: 3000, stopAfterUnanswered: 20 });
  const old = earlierBid(s, 'old', null, { observed: false });
  earlierBid(s, 'odd', -5, { observed: false }, '20261020-freelancer-0000aaa2');
  const usage = bidUsage(s.ledger, 'freelancer', NOON);
  assert.deepEqual([usage.bidMonthKRW, usage.unknownCost], [null, ['20261020-freelancer-0000aaa1', '20261020-freelancer-0000aaa2']]);
  const row = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p1', 'request').id, kind: 'proposal', payload: bidPayload(0, 1) });
  const surface = scriptedSurface({ methods: ['propose'] });
  await s.run(surface, { descriptor: mappedFreelancer() });
  assert.equal(surface.count('propose'), 0);
  assert.match(s.ledger.getOutbox(row.id).reason, new RegExp("bid spend is unknown: no cost is recorded for " + old.approvalId));
  // The operator's --cost lands on a proposal receipt as the bids it spent.
  const { receipt } = settleSent(s.ledger, old.approvalId, { costKRW: 1200, now: NOON });
  assert.equal(receipt.cashSpentKRW, 1200);
  assert.deepEqual(bidUsage(s.ledger, 'freelancer', NOON).unknownCost, ['20261020-freelancer-0000aaa2']);
});

// The terms propose receives are the ones authorize judged (the C review of wp8, findings 2 and 3).
test('a dollar proposal with no rate is blocked by price.terms with no rate read and nothing sent', async () => {
  const s = bidSetup({ monthlyKRW: 0, stopAfterUnanswered: 20 });
  const row = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p1', 'request').id, kind: 'proposal', payload: { ...bidPayload(0, 0), fx: undefined } });
  let reads = 0;
  const surface = scriptedSurface({ methods: ['propose'] });
  const out = await s.run(surface, { loadFx: async () => (reads++, Promise.reject(new Error('unavailable'))) });
  assert.deepEqual([out.map((x) => x.action), surface.count('propose'), reads], [['blocked'], 0, 0]);
  assert.match(s.ledger.getOutbox(row.id).reason, /^price\.terms the proposal in USD carries no dated USD rate/);
});

test('a dollar amount that disagrees with its KRW price is blocked, and the one that agrees is what propose receives', async () => {
  const s = bidSetup({ monthlyKRW: 0, stopAfterUnanswered: 20 });
  const wrong = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p1', 'request').id, kind: 'proposal', payload: { ...bidPayload(0, 0), amount: 1 } });
  const right = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p2', 'request').id, kind: 'proposal', payload: bidPayload(0, 1) });
  const surface = scriptedSurface({ methods: ['propose'] });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[wrong.id, 'blocked'], [right.id, 'observed']]);
  assert.match(s.ledger.getOutbox(wrong.id).reason, /states 1 USD where 400000 KRW at 1400 KRW per USD \(2026-10-19\) is 286/);
  const call = surface.calls.find((c) => c.name === 'propose');
  assert.deepEqual([call.ref, call.args.amount, call.args.currency], ['p2', 286, 'USD']);
});
// The C re-review of wp8, finding 1: settling a send without --cost keeps the cost its receipt recorded.
test('fsw approve --sent without --cost keeps the recorded bid cost, so the next bid past the month limit is blocked', async () => {
  const s = bidSetup({ monthlyKRW: 3000, stopAfterUnanswered: 20 });
  const old = earlierBid(s, 'old', 1000, { observed: false, cashSpentKRW: 2500 });
  assert.equal(settleSent(s.ledger, old.approvalId, { now: NOON }).receipt.cashSpentKRW, 2500);
  assert.equal(bidUsage(s.ledger, 'freelancer', NOON).bidMonthKRW, 2500);
  const row = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p1', 'request').id, kind: 'proposal', payload: bidPayload(2000, 1) });
  const surface = scriptedSurface({ methods: ['propose'] });
  await s.run(surface);
  assert.deepEqual([s.ledger.getOutbox(row.id).status, surface.count('propose')], ['blocked', 0]);
  // A press the surface recorded is kept the same way, and --cost still sets the cost.
  const pressed = earlierBid(s, 'pressed', 1000, { observed: false, costKRW: 1800 }, '20261020-freelancer-0000aaa3');
  assert.equal(settleSent(s.ledger, pressed.approvalId, { now: NOON }).receipt.cashSpentKRW, 1800);
  const told = earlierBid(s, 'told', 1000, { observed: false, cashSpentKRW: 2500 }, '20261020-freelancer-0000aaa4');
  assert.equal(settleSent(s.ledger, told.approvalId, { costKRW: 700, now: NOON }).receipt.cashSpentKRW, 700);
});
// The C re-review of wp8, finding 2: a read-back without a cost keeps the cost the earlier receipt recorded.
test('a read-back that observes no cost keeps the recorded bid cost, so the next bid past the month limit is blocked', async () => {
  const s = bidSetup({ monthlyKRW: 3000, stopAfterUnanswered: 20 });
  const old = s.ledger.addOutbox({ key: 'old', platform: 'freelancer', threadId: s.thread('old', 'request').id, kind: 'proposal', status: 'sending', payload: { ...bidPayload(1000, 'old'), threadRef: 'old' }, receipt: { observed: false, costKRW: 2500 }, updatedAt: NOON.toISOString() });
  const row = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p1', 'request').id, kind: 'proposal', payload: bidPayload(2000, 1) });
  const surface = scriptedSurface({ methods: ['propose'] });
  surface.proposalSent = async () => ({ observed: false, reason: 'not visible yet' });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[old.id, 'unobserved'], [row.id, 'blocked']]);
  assert.deepEqual([s.ledger.getOutbox(old.id).receipt.costKRW, s.ledger.getOutbox(old.id).receipt.reason], [2500, 'not visible yet']);
  assert.equal(surface.count('propose'), 0);
  // A read-back that observes the send without a cost keeps it too, and one that observes a cost sets it.
  assert.deepEqual(keepCost({ costKRW: 2500, pressed: true }, { observed: true, externalId: 'b1' }), { observed: true, externalId: 'b1', costKRW: 2500, pressed: true });
  assert.deepEqual(keepCost({ costKRW: 2500 }, { observed: true, cashSpentKRW: 1900 }), { observed: true, cashSpentKRW: 1900 });
  assert.deepEqual(keepCost(null, { observed: false }), { observed: false });
});
// The C re-review of wp8, finding 3: every refusal a surface raises before typing returns the row unsent and
// adds no bid, read from the lists the surfaces export.
test('a freelancer refusal raised before typing returns the proposal unsent and counts as no bid', async () => {
  const { BID_NOT_TYPED } = await import('../src/surface/freelancer.mjs');
  const { NOT_TYPED } = await import('../src/surface/kmong.mjs');
  for (const code of [...BID_NOT_TYPED, ...NOT_TYPED]) assert.ok(PROPOSAL_NOT_SENT.includes(code), code);
  for (const code of BID_NOT_TYPED) {
    const s = bidSetup({ monthlyKRW: 3000, stopAfterUnanswered: 20 });
    const row = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('p1', 'request').id, kind: 'proposal', payload: bidPayload(0, 0) });
    const surface = scriptedSurface({ methods: ['propose'], receipts: { propose: [Object.assign(new Error('refused before typing'), { code })] } });
    const out = await s.run(surface);
    assert.deepEqual([out.map((x) => [x.action, x.code]), s.ledger.getOutbox(row.id).status], [[['deferred', code]], 'planned'], code);
    assert.deepEqual(bidUsage(s.ledger, 'freelancer', NOON), { bidMonthKRW: 0, bidUnanswered: 0, unknownCost: [] }, code);
  }
});

test('the freelancer surface refusing a bid at its profile steps leaves the row planned, through the recorded bid page', async () => {
  const { openFreelancerSurface } = await import('../src/surface/freelancer.mjs');
  const { readRecording, replaySession } = await import('../src/surface/recorder.mjs');
  const entries = readRecording('test/fixtures/surfaces/freelancer/bidform.jsonl').map((e) => (e.name === 'pageBidGate' ? { ...e, answer: { ...e.answer, unlock: null } } : e));
  const session = replaySession(entries);
  const project = { id: 7, type: 'fixed', title: 'Landing page', description: 'Need a page', budget: { minimum: 250, maximum: 750 }, currency: { code: 'USD' }, seo_url: 'python/project-7', status: 'active', frontend_project_status: 'open' };
  const surface = await openFreelancerSurface({ session, fetchJson: async () => project });
  const s = bidSetup({ monthlyKRW: 3000, stopAfterUnanswered: 20 });
  const row = plan(s.ledger, { platform: 'freelancer', threadId: s.thread('7', 'request').id, kind: 'proposal', payload: bidPayload(0, 0) });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.action, x.code]), [['deferred', 'FSW_FREELANCER_STEPS']]);
  assert.equal(s.ledger.getOutbox(row.id).status, 'planned');
  assert.equal(bidUsage(s.ledger, 'freelancer', NOON).bidUnanswered, 0);
});

// 088 unit 1: a wishket application refused for its unmapped apply form returns unsent and spends nothing. The
// descriptor copy maps the form and the operator approved the row, so authorize lets it reach the real surface,
// which refuses it by name.
test('a wishket application the surface refuses for its unmapped form returns to approved and counts no spend', async () => {
  const { APPLY_UNMAPPED, openWishketSurface } = await import('../src/surface/wishket.mjs');
  assert.ok(PROPOSAL_NOT_SENT.includes(APPLY_UNMAPPED));
  const s = setup('wishket', (c) => ({ ...c, platforms: { ...c.platforms, wishket: { ...c.platforms.wishket, enabled: true, mode: 'auto' } } }));
  const descriptor = structuredClone(s.descriptor);
  descriptor.forms.proposal = { mapped: true, mappedAt: '2026-10-28T00:00:00Z', recording: 'test fixture', readBack: true };
  const row = plan(s.ledger, { platform: 'wishket', threadId: s.thread('700001', 'request').id, kind: 'proposal', payload: { text: TEXT, amountKRW: 1500000, thread: { kind: 'request', stage: 'pre_order', lastInboundText: '예약 웹 구축', recentOutbound: [] }, decision: decision({ intent: 'quote_request' }) } });
  setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-wishket-00000001' });
  resolve(s.ledger, '20261020-wishket-00000001', { approve: true });
  let opened = 0;
  const surface = await openWishketSurface({ open: async () => ((opened += 1), { close: async () => {} }) });
  const out = await s.run(surface, { descriptor });
  assert.deepEqual(out.map((x) => [x.action, x.code]), [['deferred', APPLY_UNMAPPED]]);
  assert.equal(s.ledger.getOutbox(row.id).status, 'approved');
  assert.equal(opened, 0);
  assert.deepEqual([quotaUsage(s.ledger, 'wishket', NOON), bidUsage(s.ledger, 'wishket', NOON)], [{ quotes: 0, cashKRW: 0 }, { bidMonthKRW: 0, bidUnanswered: 0, unknownCost: [] }]);
  assert.deepEqual(events(s.ledger, 'send.unobserved'), []);
});
