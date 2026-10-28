// Forged proofs (AGENTS.md honestCode, wp9 U9.2): a surface write without the drain's token, with a token for
// another row, kind or text, or with a signature nobody minted refuses before any page action; a row whose stored
// payload no longer matches its key is blocked before authorize runs; and every refusal leaves the ledger as it
// was, which each case checks by comparing a snapshot taken before and after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintAuthorization } from '../src/core/authz.mjs';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger, outboxKey } from '../src/core/ledger.mjs';
import { drain, plan, resolve, setStatus } from '../src/outbox/index.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { authorize } from '../src/policy/authorize.mjs';
import { openSurface } from '../src/surface/index.mjs';
import { scriptedSurface, tokenFor } from './helpers/surface.mjs';
import { tempDir } from './tmp.mjs';

const NOON = new Date('2026-10-20T12:00:00+09:00');
const TEXT = '요청하신 구성으로 진행 가능합니다. 원하시는 일정을 알려 주세요.';
const decision = (over = {}) => ({ intent: 'inquiry', service: 'landing_page_web', language: 'ko', reply: TEXT, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null, ...over });

function makeInstance() {
  const dir = tempDir('fsw-forged-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms.soomgo = { ...config.platforms.soomgo, mode: 'auto', maxQuotesPerDay: 5, maxCashPerDay: 1000 };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

function setup(platform = 'kmong') {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const descriptor = loadDescriptor(platform);
  const thread = (ref, kind = 'message') => ledger.upsertThread({ platform, externalId: ref, kind });
  const run = (surface) => drain(ledger, { platform, surface, authorize, ctx: { descriptor, instance, mode: 'auto', now: NOON, notify: async () => ({}) } });
  return { instance, ledger, descriptor, thread, run };
}

// Every table's row count, and each outbox row's status, receipt and operator answer.
const snapshot = (ledger) => ({ counts: ledger.counts(), outbox: ledger.listOutbox({}).map((r) => ({ id: r.id, status: r.status, receipt: r.receipt, operator: r.operator })) });
const approve = (ledger, row, id) => {
  setStatus(ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: id });
  return setStatus(ledger, row.id, { from: 'awaiting_operator', to: 'approved', operator: { resolvedAt: NOON.toISOString(), finalText: null, edited: false, resolutionReason: null } });
};

// A driver stand-in that logs every page action, so "no page action" is read from the log.
function spySession() {
  const log = [];
  const act = (name) => async (...a) => (log.push(name + ' ' + a[0]), a[0]);
  return { log, guard: { beforeMessage: () => log.push('message') }, navigate: act('navigate'), evaluate: act('evaluate'), click: act('click'), fill: act('fill'), typeKeys: act('type'), press: act('press'), setFiles: act('files'), stop: async () => {} };
}

test('a surface write without a valid token refuses before any page action and stores nothing', async () => {
  const ledger = openLedger(':memory:');
  ledger.upsertThread({ platform: 'soomgo', externalId: '1', kind: 'message' });
  const before = snapshot(ledger);
  const forgedMac = { ...tokenFor('soomgo', '1', 'message', { text: TEXT }), mac: '00'.repeat(32) };
  const cases = [
    ['missing proof', 'send', { text: TEXT, authorized: undefined }, 'missing authorization'],
    ['the bare verdict of 030', 'send', { text: TEXT, authorized: { verdict: 'send' } }, 'missing authorization'],
    ['foreign proof: a token for thread 2', 'send', { text: TEXT, authorized: tokenFor('soomgo', '2', 'message', { text: TEXT }) }, 'authorization belongs to another outbox row'],
    ['foreign proof: a token for another platform', 'send', { text: TEXT, authorized: tokenFor('kmong', '1', 'message', { text: TEXT }) }, 'authorization belongs to another outbox row'],
    ['wrong kind: a message token on quote', 'quote', { text: TEXT, amountKRW: 50000, allowSpendCash: true, authorized: tokenFor('soomgo', '1', 'message', { text: TEXT }) }, 'authorization belongs to another outbox row'],
    ['tampered text after authorization', 'send', { text: TEXT + '.', authorized: tokenFor('soomgo', '1', 'message', { text: TEXT }) }, 'the write differs from what was authorized'],
    ['forged signature', 'send', { text: TEXT, authorized: forgedMac }, 'authorization signature does not match'],
    ['pay request without a token', 'payRequest', { amountKRW: 50000, approved: true }, 'missing authorization'],
    ['pay request not approved', 'payRequest', { amountKRW: 50000, approved: false, authorized: tokenFor('soomgo', '1', 'pay_request', { amountKRW: 50000, approved: false }) }, 'a pay request needs the operator approval'],
  ];
  for (const [name, write, args, reason] of cases) {
    const session = spySession();
    const surface = await openSurface('soomgo', { session });
    assert.deepEqual(await surface[write]('1', args), { observed: false, reason: 'not authorized: ' + reason }, name);
    assert.deepEqual(session.log, [], name + ': no page action');
  }
  const kmong = spySession();
  const k = await openSurface('kmong', { session: kmong });
  assert.deepEqual(await k.send('1', { text: TEXT, authorized: { verdict: 'send' } }), { observed: false, reason: 'not authorized: missing authorization' });
  assert.deepEqual(await k.propose('project:7', { text: TEXT, amountKRW: 1000000, authorized: tokenFor('kmong', 'project:7', 'message', { text: TEXT }) }), { observed: false, reason: 'not authorized: authorization belongs to another outbox row' });
  assert.deepEqual(kmong.log, []);
  assert.deepEqual(snapshot(ledger), before);
});

test('the four surfaces with unmapped forms refuse a forged write for its authorization before the unmapped form', async () => {
  const shell = () => ({ calls: [], navigate: async () => { throw new Error('no page may load'); }, evaluate: async () => { throw new Error('no page may load'); }, stop: async () => {} });
  for (const platform of ['wishket', 'upwork', 'fiverr', 'freelancer']) {
    const session = shell();
    const s = await openSurface(platform, { session, reader: { close: async () => {} }, open: async () => { throw new Error('no reader may open'); }, fetchJson: async () => { throw new Error('no API call'); } });
    for (const write of ['send', 'quote', 'propose']) {
      for (const authorized of [undefined, { verdict: 'send' }, tokenFor(platform, '2', write === 'propose' ? 'proposal' : write === 'quote' ? 'quote' : 'message', { text: 'x' })]) {
        const r = await s[write]('1', { text: 'x', amountKRW: 1000, authorized });
        assert.equal(r.observed, false, platform + ' ' + write);
        assert.match(r.reason, /^not authorized: (missing authorization|authorization belongs to another outbox row)$/, platform + ' ' + write);
      }
    }
  }
});

for (const kind of ['message', 'quote', 'proposal', 'pay_request', 'delivery']) {
  test('a ' + kind + ' row whose stored payload changed after planning is blocked with no surface call', async () => {
    const s = setup('kmong');
    const t = s.thread('t-' + kind);
    const payload = { text: TEXT, amountKRW: kind === 'message' || kind === 'delivery' ? undefined : 300000, decision: decision(), ...(kind === 'delivery' ? { files: [], runAt: 'r1' } : {}), ...(kind === 'proposal' ? { proposal: { phases: [{ title: 'a' }] } } : {}) };
    const row = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind, payload });
    approve(s.ledger, row, '20261020-kmong-0000000' + ['message', 'quote', 'proposal', 'pay_request', 'delivery'].indexOf(kind));
    const field = kind === 'quote' ? '$.amountKRW' : '$.text';
    s.ledger.db.prepare('UPDATE outbox SET payload = json_set(payload, ?, ?) WHERE id = ?').run(field, kind === 'quote' ? 1 : 'other', row.id);
    const before = s.ledger.counts();
    const surface = scriptedSurface({ platform: 'kmong', methods: ['payRequest', 'propose'] });
    const out = await s.run(surface);
    assert.deepEqual(out.map((x) => [x.id, x.action, x.reason]), [[row.id, 'blocked', 'payload changed after planning']]);
    assert.equal(s.ledger.getOutbox(row.id).status, 'blocked');
    assert.equal(surface.calls.filter((c) => c.name !== 'read').length, 0);
    const after = s.ledger.counts();
    for (const table of ['messages', 'quotes', 'money_events', 'payments']) assert.equal(after[table], before[table], table);
  });
}

test('a verdict column rewritten to send does not let a text that breaks the gate out: drain judges the row again and asks the operator', async () => {
  const s = setup('kmong');
  const t = s.thread('t1');
  const row = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind: 'message', payload: { text: '연락처 010-1234-5678 로 문자 주세요', decision: decision() } });
  s.ledger.db.prepare('UPDATE outbox SET verdict = ? WHERE id = ?').run(JSON.stringify({ verdict: 'send', violations: [], warnings: [], reasons: [] }), row.id);
  const surface = scriptedSurface({ platform: 'kmong' });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => x.action), ['awaiting_operator']);
  assert.notEqual(s.ledger.getOutbox(row.id).verdict.verdict, 'send');
  assert.equal(surface.calls.length, 0);
  assert.equal(s.ledger.counts().messages, 0);
});

test('resolve refuses an unknown approval id and a row already sent, and changes nothing', () => {
  const s = setup('kmong');
  const t = s.thread('t1');
  const row = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind: 'message', payload: { text: TEXT, decision: decision() } });
  approve(s.ledger, row, '20261020-kmong-00000abc');
  setStatus(s.ledger, row.id, { from: 'approved', to: 'sending' });
  setStatus(s.ledger, row.id, { from: 'sending', to: 'observed', receipt: { observed: true } });
  const before = snapshot(s.ledger);
  assert.throws(() => resolve(s.ledger, '20261025-kmong-00000000', { approve: true }), { code: 'FSW_OUTBOX_NO_APPROVAL' });
  assert.throws(() => resolve(s.ledger, '20261020-kmong-00000abc', { approve: true }), { code: 'FSW_OUTBOX_RESOLVED' });
  assert.deepEqual(snapshot(s.ledger), before);
});

test('an operator edit that breaks the gate is stored, then judged by the next drain and blocked with no surface call', async () => {
  const s = setup('kmong');
  const t = s.thread('t1');
  const row = plan(s.ledger, { platform: 'kmong', threadId: t.id, kind: 'message', payload: { text: TEXT, decision: decision({ needsOperator: true, operatorReason: 'check' }) } });
  setStatus(s.ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId: '20261020-kmong-0000beef' });
  const done = resolve(s.ledger, '20261020-kmong-0000beef', { approve: true, editedText: '010-1234-5678 로 연락 주세요' });
  assert.deepEqual([done.status, done.operator.finalText], ['approved', '010-1234-5678 로 연락 주세요']);
  const surface = scriptedSurface({ platform: 'kmong' });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => x.action), ['blocked']);
  assert.equal(surface.calls.length, 0);
  assert.equal(s.ledger.counts().messages, 0);
});

test('authorize never answers send to a forged decision or a context it cannot judge', () => {
  const instance = makeInstance();
  const kmong = loadDescriptor('kmong');
  const item = (over = {}) => ({ platform: 'kmong', kind: 'message', text: TEXT, thread: { kind: 'message', stage: 'pre_order' }, attachments: [], ...over });
  const forged = authorize(item({ decision: decision({ intent: 'unsupported', needsOperator: false, confidence: 1 }) }), { descriptor: kmong, instance, mode: 'auto', now: NOON });
  assert.equal(forged.verdict, 'operator');
  assert.throws(() => authorize(item({ decision: decision() }), { instance, mode: 'auto', now: NOON }), TypeError);
  const soomgo = loadDescriptor('soomgo');
  const unknownCost = authorize({ platform: 'soomgo', kind: 'quote', text: TEXT, amountKRW: 300000, costKRW: null, serviceLabel: '웹 개발', thread: { kind: 'request', stage: 'pre_order' }, attachments: [], decision: decision({ intent: 'quote_request' }), gate: { verdict: 'send' } }, { descriptor: soomgo, instance, mode: 'auto', now: NOON });
  assert.notEqual(unknownCost.verdict, 'send');
});

test('controls: a planned row the drain authorizes sends with its token, and an imported approved row with an edit and files is not blocked', async () => {
  const s = setup('kmong');
  const row = plan(s.ledger, { platform: 'kmong', threadId: s.thread('t1').id, kind: 'message', payload: { text: TEXT, decision: decision() } });
  const t2 = s.thread('t2');
  const files = ['C:/old/jobs/j1/work/a.png'];
  const finalText = TEXT + ' 감사합니다.';
  const imported = s.ledger.addOutbox({
    key: outboxKey({ platform: 'kmong', threadRef: 't2', kind: 'message', text: finalText, amountKRW: null, files }),
    platform: 'kmong', threadId: t2.id, kind: 'message', status: 'approved', approvalId: '20261020-kmong-0000f00d',
    payload: { text: TEXT, amountKRW: null, files, threadRef: 't2', importedFrom: 'operator/approvals/20261020-kmong-0000f00d.json' },
    operator: { resolvedAt: NOON.toISOString(), finalText, edited: true, resolutionReason: null },
  });
  const surface = scriptedSurface({ platform: 'kmong' });
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[row.id, 'observed'], [imported.id, 'observed']]);
  const sends = surface.calls.filter((c) => c.name === 'send');
  assert.deepEqual(sends.map((c) => [c.ref, c.args.text, c.args.authorized.key]), [['t1', TEXT, row.key], ['t2', finalText, imported.key]]);
  assert.equal(Object.isFrozen(sends[0].args.authorized), true);
  const { authorized, ...sent } = sends[0].args;
  assert.equal(mintAuthorization(row, sent).mac, authorized.mac, 'the token signs exactly the arguments the surface received');
});

test('a token signs every argument the surface sends: another amount, file list or proposal term is refused before any page action', async () => {
  const quote = { amountKRW: 50000, priceType: 'fixed', text: TEXT, allowSpendCash: true, customer: '고객A' };
  const cases = [
    ['soomgo', 'quote', 'quote', quote, { ...quote, amountKRW: 9000000 }],
    ['soomgo', 'send', 'delivery', { text: TEXT, files: ['C:/send/0/a.png'] }, { text: TEXT, files: ['C:/send/0/a.png', 'C:/elsewhere/b.png'] }],
    ['soomgo', 'payRequest', 'pay_request', { amountKRW: 50000, approved: true }, { amountKRW: 5000000, approved: true }],
    ['kmong', 'propose', 'proposal', { text: TEXT, amountKRW: 1000000, phases: [{ title: 'a' }] }, { text: TEXT, amountKRW: 1000000, phases: [{ title: 'a' }, { title: 'b' }] }],
  ];
  for (const [platform, write, kind, signedArgs, sent] of cases) {
    const session = spySession();
    const surface = await openSurface(platform, { session });
    const ref = kind === 'proposal' ? 'project:7' : '1';
    const r = await surface[write](ref, { ...sent, authorized: tokenFor(platform, ref, kind, signedArgs) });
    assert.deepEqual(r, { observed: false, reason: 'not authorized: the write differs from what was authorized' }, platform + ' ' + write);
    assert.deepEqual(session.log, [], platform + ' ' + write + ': no page action');
  }
});

