import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { advance } from '../src/deal/index.mjs';
import { step } from '../src/loop/index.mjs';
import { permissionSignal } from '../src/loop/permission.mjs';
import { scriptedSurface } from './helpers/surface.mjs';
import { tempDir } from './tmp.mjs';

const DELIVERED = '2026-10-20T10:00:00+09:00';
const job = { id: 'kmong-k1', threadId: 7, platform: 'kmong', status: 'delivered', deliveredAt: DELIVERED };
const GRANT = '네, 포트폴리오에 올리셔도 됩니다.';
const msg = (direction, text, at) => ({ direction, text, at });
const thread = (messages) => ({ platform: 'kmong', messages });
// One job on the thread: the result as one signal or none.
const single = ({ job: j, ...rest }) => {
  const r = permissionSignal({ ...rest, jobs: j ? [j] : [] });
  assert.ok(r.signals.length <= 1);
  return { signal: r.signals[0] ?? null, reason: r.reason };
};
const decision = (portfolioPermission, permissionQuote) => ({ intent: 'smalltalk', portfolioPermission, permissionQuote });

test('a grant whose quote is in an inbound message after the delivery becomes permission_granted with the quote', () => {
  const r = single({ thread: thread([msg('out', '작업물 전달드립니다. 포트폴리오에 써도 될까요?', DELIVERED), msg('in', '감사합니다!  ' + GRANT, '2026-10-20T11:00:00+09:00')]), job, decision: decision('granted', GRANT), at: '2026-10-20T12:00:00+09:00' });
  assert.equal(r.reason, null);
  assert.deepEqual(r.signal, { type: 'permission_granted', platform: 'kmong', threadId: 7, jobId: 'kmong-k1', at: '2026-10-20T12:00:00+09:00', evidence: { quote: GRANT, quoteAt: '2026-10-20T11:00:00+09:00', source: 'brain' } });
  // The model may drop the closing mark; the sentence is the same.
  const bare = single({ thread: thread([msg('in', GRANT, '2026-10-20T11:00:00+09:00')]), job, decision: decision('granted', GRANT.slice(0, -1)) });
  assert.equal(bare.signal?.type, 'permission_granted');
});

test('a grant quoting my own outbound message, an inbound before the delivery, or nothing is not accepted', () => {
  const cases = [
    thread([msg('out', GRANT, '2026-10-20T11:00:00+09:00')]),
    thread([msg('in', GRANT, '2026-10-20T09:00:00+09:00')]),
    thread([msg('in', '감사합니다!', '2026-10-20T11:00:00+09:00')]),
  ];
  for (const t of cases) {
    const r = single({ thread: t, job, decision: decision('granted', GRANT) });
    assert.equal(r.signal, null);
    assert.equal(r.reason, 'grant whose quote is not a whole sentence of an inbound message after the delivery');
  }
  const thanksOnly = single({ thread: thread([msg('in', '감사합니다!', '2026-10-20T11:00:00+09:00')]), job, decision: decision('granted', '감사합니다!'.slice(0, 1)) });
  assert.equal(thanksOnly.signal, null);
});

test('a fragment of a refusal, or a whole sentence from a message that says no, is never a grant', () => {
  const at = '2026-10-20T11:00:00+09:00';
  const cases = [
    ['포트폴리오에 올리시는 건 안 됩니다.', '포트폴리오에 올리시는', 'grant whose quote is not a whole sentence of an inbound message after the delivery'],
    ['포트폴리오에 올리시는 건 안 됩니다.', '포트폴리오에 올리시는 건 안 됩니다.', 'grant quoted from a message that says no, or followed by one'],
    ['네, 받았습니다. 포트폴리오는 안 됩니다.', '네,', 'grant whose quote is not a whole sentence of an inbound message after the delivery'],
    ['네, 받았습니다. 포트폴리오는 안 됩니다.', '네, 받았습니다.', 'grant quoted from a message that says no, or followed by one'],
    ['Sure, but please do not post it publicly.', 'Sure, but please do not post it publicly.', 'grant quoted from a message that says no, or followed by one'],
  ];
  for (const [text, quote, reason] of cases) {
    const r = single({ thread: thread([msg('in', text, at)]), job, decision: decision('granted', quote) });
    assert.deepEqual([r.signal, r.reason], [null, reason], text + ' / ' + quote);
  }
  // A yes followed by a later no is not a grant either.
  const later = single({ thread: thread([msg('in', GRANT, at), msg('in', '아, 생각해 보니 포트폴리오는 올리지 말아 주세요.', '2026-10-20T11:30:00+09:00')]), job, decision: decision('granted', GRANT) });
  assert.equal(later.signal, null);
  // A greeting that starts with 안 is not a no.
  const hello = single({ thread: thread([msg('in', '안녕하세요. ' + GRANT, at)]), job, decision: decision('granted', GRANT) });
  assert.equal(hello.signal?.type, 'permission_granted');
});

test('a private ask, a question, an echo of my question or a conditional yes is never a grant', () => {
  const at = '2026-10-20T11:00:00+09:00';
  const ASK = '작업물을 포트폴리오에 소개해도 괜찮을까요?';
  const cases = [
    ['Please keep it private.', 'grant quoted from a message that says no, or followed by one'],
    ['외부 공개는 자제 부탁드려요.', 'grant quoted from a message that says no, or followed by one'],
    ['포트폴리오에 올려도 되나요?', 'grant quoted from a question'],
    [ASK, 'grant quoting a sentence of my own message'],
    ['회사명 빼고 올리시면 돼요.', 'grant with a condition, for the operator to scope'],
    ['Sure, except the dashboard screenshots.', 'grant with a condition, for the operator to scope'],
    ['회사 이름은 빼주세요.', 'grant with a condition, for the operator to scope'],
    ['로고는 가려 주세요.', 'grant with a condition, for the operator to scope'],
    ['정식 오픈 후에 올려 주세요.', 'grant with a condition, for the operator to scope'],
    ['Sure, once the site launches.', 'grant with a condition, for the operator to scope'],
    ['혹시 어디에 올리시는 건가요', 'grant quoted from a question'],
    ['어떤 화면을 쓰실 건지요', 'grant quoted from a question'],
    ['그럼 언제 올리시나요', 'grant quoted from a question'],
  ];
  for (const [text, reason] of cases) {
    const r = single({ thread: thread([msg('out', ASK, DELIVERED), msg('in', text, at)]), job, decision: decision('granted', text) });
    assert.deepEqual([r.signal, r.reason], [null, reason], text);
  }
  // The echo is caught without its question mark too.
  const echo = single({ thread: thread([msg('out', ASK, DELIVERED), msg('in', ASK.slice(0, -1), at)]), job, decision: decision('granted', ASK.slice(0, -1)) });
  assert.equal(echo.reason, 'grant quoting a sentence of my own message');
  // A plain yes after my question is still a grant.
  const yes = single({ thread: thread([msg('out', ASK, DELIVERED), msg('in', GRANT, at)]), job, decision: decision('granted', GRANT) });
  assert.equal(yes.signal?.type, 'permission_granted');
  const plain = single({ thread: thread([msg('out', ASK, DELIVERED), msg('in', '네 올리셔도 됩니다.', at)]), job, decision: decision('granted', '네 올리셔도 됩니다.') });
  assert.equal(plain.signal?.type, 'permission_granted');
});

test('a refusal needs no quote and becomes permission_refused', () => {
  const r = single({ thread: thread([]), job, decision: decision('refused', null), at: '2026-10-20T12:00:00+09:00' });
  assert.equal(r.signal.type, 'permission_refused');
  assert.deepEqual(r.signal.evidence, { quote: null, source: 'brain' });
});

test('a refusal keeps the client sentence when the page holds it, and the deal stores it', () => {
  const NO = '포트폴리오에는 올리지 말아 주세요.';
  const r = single({ thread: thread([msg('in', '글꼴 바꿔 주세요. ' + NO, '2026-10-20T11:00:00+09:00')]), job, decision: decision('refused', NO) });
  assert.deepEqual(r.signal.evidence, { quote: NO, quoteAt: '2026-10-20T11:00:00+09:00', source: 'brain' });
  const invented = single({ thread: thread([msg('in', '글꼴 바꿔 주세요.', '2026-10-20T11:00:00+09:00')]), job, decision: decision('refused', NO) });
  assert.deepEqual([invented.signal.type, invented.signal.evidence.quote], ['permission_refused', null]);
  const s = setup();
  const { threadId, ...signal } = r.signal;
  s.deal({ ...signal, at: '2026-10-20T12:00:00+09:00' });
  const p = s.ledger.getJob('kmong-k1').meta.portfolio;
  assert.deepEqual([p.permission, p.quote, p.quoteAt], ['denied', NO, '2026-10-20T11:00:00+09:00']);
});

test('a refusal reaches every job of the thread that was ever delivered, the older ones included', () => {
  const old = { ...job, id: 'kmong-k1-a', status: 'closed' };
  const rerun = { ...job, id: 'kmong-k1-b', status: 'revision' };
  const fresh = { ...job, id: 'kmong-k1-c', status: 'ordered', deliveredAt: null };
  const r = permissionSignal({ thread: thread([]), jobs: [old, rerun, fresh], decision: decision('refused', null) });
  assert.deepEqual(r.signals.map((s) => [s.type, s.jobId]), [['permission_refused', 'kmong-k1-a'], ['permission_refused', 'kmong-k1-b']]);
  assert.equal(r.reason, null);
});

test('no answer gives nothing; a grant waits for delivered work; a refusal before any delivery is named, after one it holds', () => {
  assert.deepEqual(single({ thread: thread([]), job, decision: decision(null, null) }), { signal: null, reason: null });
  assert.deepEqual(single({ thread: thread([msg('in', GRANT, '2026-10-20T11:00:00+09:00')]), job: { ...job, status: 'revision' }, decision: decision('granted', GRANT) }), { signal: null, reason: null });
  const never = 'refusal on a thread whose job was never delivered';
  assert.deepEqual(single({ thread: thread([]), job: { ...job, status: 'in_progress', deliveredAt: null }, decision: decision('refused', null) }), { signal: null, reason: never });
  assert.deepEqual(single({ thread: thread([]), job: null, decision: decision('refused', null) }), { signal: null, reason: never });
  for (const status of ['revision', 'in_progress']) assert.equal(single({ thread: thread([]), job: { ...job, status }, decision: decision('refused', null) }).signal.type, 'permission_refused');
});

test('a brain grant never replaces a denial, needs nothing over a grant, and quotes only messages after the last answer', () => {
  const yes = thread([msg('in', GRANT, '2026-10-20T11:00:00+09:00')]);
  const denied = { ...job, meta: { portfolio: { permission: 'denied', answeredAt: '2026-10-20T13:00:00+09:00', source: 'operator' } } };
  assert.deepEqual(single({ thread: yes, job: denied, decision: decision('granted', GRANT) }), { signal: null, reason: 'the client refused before; only the operator lifts it with fsw deal kmong-k1 permission granted' });
  const granted = { ...job, meta: { portfolio: { permission: 'granted', answeredAt: '2026-10-20T12:00:00+09:00' } } };
  assert.deepEqual(single({ thread: yes, job: granted, decision: decision('granted', GRANT) }), { signal: null, reason: null });
  const answered = { ...job, meta: { portfolio: { permission: 'pending', answeredAt: '2026-10-20T12:00:00+09:00' } } };
  assert.equal(single({ thread: yes, job: answered, decision: decision('granted', GRANT) }).signal, null);
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
  const messages = [msg('out', '작업물 전달드립니다. 포트폴리오에 써도 될까요?', DELIVERED)];
  // One tick: the client wrote inboundText at hour:00 and the step reads the thread at hour:30.
  const run = (inboundText, answer, hour = 11) => {
    const at = '2026-10-20T' + hour + ':00:00+09:00';
    const now = new Date('2026-10-20T' + hour + ':30:00+09:00');
    messages.push(msg('in', inboundText, at));
    const surface = scriptedSurface({
      sense: [{ platform: 'kmong', ref: 'k1', kind: 'message', at, unread: true, service: null, preview: inboundText, notice: null, status: null, hired: null, quotable: null, expiresAt: null, quoteCostKRW: null, requestId: null, customer: null, quote: null }],
      threads: () => ({ ref: 'k1', kind: 'message', stage: 'post_order', messages: [...messages], notices: [] }),
    });
    const d = { intent: 'smalltalk', service: 'landing_page_web', language: 'ko', reply: null, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null, ...answer };
    // The real notifier writes operator/requests.md in the temp instance (toast and webhook off).
    return step('kmong', { instance, ledger, now, openSurface: async () => surface, priceTable: [], runCodex: async () => ({ data: d, durationMs: 1 }) });
  };
  const events = (kind) => ledger.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind).map((e) => JSON.parse(e.payload));
  const deal = (signal) => advance(ledger, { platform: 'kmong', jobId: 'kmong-k1', ...signal }, { instance, descriptor: loadDescriptor('kmong'), now: new Date(signal.at) });
  const requests = () => (existsSync(join(instance.paths.operator, 'requests.md')) ? readFileSync(join(instance.paths.operator, 'requests.md'), 'utf8') : '');
  return { instance, ledger, run, events, deal, requests };
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
  assert.deepEqual(s.events('permission.unverified').map((e) => e.reason), ['grant whose quote is not a whole sentence of an inbound message after the delivery']);
  assert.equal(s.events('deal.permission_granted').length, 0);
});

test('after the operator records a denial, a later thanks never lets the brain grant again from the old sentence', async () => {
  const s = setup();
  await s.run(GRANT, { portfolioPermission: 'granted', permissionQuote: GRANT }, 11);
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'granted');
  s.deal({ type: 'permission_refused', at: '2026-10-20T12:00:00+09:00', evidence: { source: 'operator' } });
  await s.run('감사합니다!', { portfolioPermission: 'granted', permissionQuote: GRANT }, 13);
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'denied');
  assert.deepEqual(s.events('permission.unverified').map((e) => e.reason), ['the client refused before; only the operator lifts it with fsw deal kmong-k1 permission granted']);
  // The deal refuses the same grant if it arrives by another path, with or without a fresh quote time.
  for (const quoteAt of ['2026-10-20T11:00:00+09:00', '2026-10-20T13:00:00+09:00']) s.deal({ type: 'permission_granted', at: '2026-10-20T13:40:00+09:00', evidence: { quote: GRANT, quoteAt, source: 'brain' } });
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'denied');
  assert.deepEqual(s.events('deal.refused').map((e) => e.reason), ['only the operator lifts a portfolio denial', 'only the operator lifts a portfolio denial']);
  s.deal({ type: 'permission_granted', at: '2026-10-20T14:00:00+09:00', evidence: { source: 'operator' } });
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'granted');
});

test('the deal refuses a grant that is not the operator and carries no client sentence from after the delivery and the last answer', () => {
  const s = setup();
  const reason = 'a grant needs the client sentence from after the delivery and the last answer';
  for (const evidence of [{}, { source: 'brain', quote: GRANT }, { source: 'brain', quote: GRANT, quoteAt: '2026-10-20T09:00:00+09:00' }, { source: 'brain', quote: null, quoteAt: '2026-10-20T11:00:00+09:00' }]) {
    s.deal({ type: 'permission_granted', at: '2026-10-20T12:00:00+09:00', evidence });
  }
  assert.deepEqual(s.events('deal.refused').map((e) => e.reason), [reason, reason, reason, reason]);
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'pending');
});

test('a refusal sent with a change request ends denied, and the redelivery keeps it', async () => {
  const s = setup();
  await s.run(GRANT, { portfolioPermission: 'granted', permissionQuote: GRANT }, 11);
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'granted');
  await s.run('글꼴 바꿔 주세요. 포트폴리오에는 올리지 말아 주세요.', { intent: 'revision', reply: '글꼴을 바꿔 다시 보내 드리겠습니다.', portfolioPermission: 'refused', permissionQuote: '포트폴리오에는 올리지 말아 주세요.' }, 13);
  const job = s.ledger.getJob('kmong-k1');
  assert.deepEqual([job.status, job.meta.portfolio.permission, job.meta.revisions.length], ['revision', 'denied', 1]);
  s.deal({ type: 'run_started', at: '2026-10-20T14:00:00+09:00', evidence: {} });
  s.deal({ type: 'delivery_observed', at: '2026-10-20T15:00:00+09:00', evidence: {} });
  assert.deepEqual([s.ledger.getJob('kmong-k1').status, s.ledger.getJob('kmong-k1').meta.portfolio.permission], ['delivered', 'denied']);
});

test('the operator denial holds on a job reopened for a revision, and a refusal that cannot apply is an event', async () => {
  const s = setup();
  s.ledger.upsertJob({ id: 'kmong-k1', status: 'revision' });
  s.deal({ type: 'permission_refused', at: '2026-10-20T12:00:00+09:00', evidence: { source: 'operator' } });
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'denied');
  s.ledger.upsertJob({ id: 'kmong-k1', status: 'in_progress', deliveredAt: null, meta: {} });
  await s.run('포트폴리오에는 올리지 말아 주세요.', { portfolioPermission: 'refused', permissionQuote: null }, 13);
  assert.deepEqual(s.events('permission.refusal_unapplied').map((e) => e.reason), ['refusal on a thread whose job was never delivered']);
});

test('a model grant without the client sentence keeps the thread reply and is recorded as permission.unverified', async () => {
  const s = setup();
  const r = await s.run(GRANT, { portfolioPermission: 'granted', permissionQuote: null, reply: '확인 감사합니다. 남은 일정도 안내드리겠습니다.' });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(s.ledger.listOutbox({ platform: 'kmong' }).map((o) => o.payload.text), ['확인 감사합니다. 남은 일정도 안내드리겠습니다.']);
  assert.deepEqual(s.events('permission.unverified').map((e) => e.reason), ['the model answered granted without the client sentence']);
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'pending');
});

test('a refusal about earlier work takes it down when the thread has opened a newer order since', async () => {
  const s = setup();
  await s.run(GRANT, { portfolioPermission: 'granted', permissionQuote: GRANT }, 11);
  const a = s.ledger.getJob('kmong-k1');
  assert.equal(a.meta.portfolio.permission, 'granted');
  s.ledger.upsertJob({ id: a.id, status: 'closed', closedAt: '2026-10-20T12:00:00+09:00' });
  s.ledger.upsertJob({ id: 'kmong-k1-2', threadId: a.threadId, platform: 'kmong', service: 'landing_page_web', status: 'ordered' });
  await s.run('예전 작업물은 포트폴리오에서 내려 주세요.', { portfolioPermission: 'refused', permissionQuote: '예전 작업물은 포트폴리오에서 내려 주세요.' }, 13);
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'denied');
  assert.equal(s.ledger.getJob('kmong-k1-2').meta?.portfolio, undefined);
  assert.deepEqual(s.events('permission.refusal_unapplied'), []);
});

test('an answer that is not applied tells the operator once per job and answer, naming the fsw deal verb', async () => {
  const s = setup();
  const keys = () => [...s.requests().matchAll(/^- dedupe: (portfolio-answer-check:.+)$/gm)].map((m) => m[1]);
  await s.run('감사합니다!', { portfolioPermission: 'granted', permissionQuote: GRANT }, 11);
  await s.run('정말 감사합니다!', { portfolioPermission: 'granted', permissionQuote: GRANT }, 13);
  assert.deepEqual(keys(), ['portfolio-answer-check:kmong-k1:granted']);
  assert.match(s.requests(), /fsw deal kmong-k1 permission granted \(or denied\)/);
  assert.equal(s.events('permission.unverified').length, 2);
  // A refusal with nothing delivered on the thread is its own notice.
  s.ledger.upsertJob({ id: 'kmong-k1', status: 'in_progress', deliveredAt: null, meta: {} });
  await s.run('포트폴리오에는 올리지 말아 주세요.', { portfolioPermission: 'refused', permissionQuote: null }, 15);
  assert.deepEqual(keys(), ['portfolio-answer-check:kmong-k1:granted', 'portfolio-answer-check:kmong:k1:refused']);
  assert.match(s.requests(), /No job on this thread was delivered/);
});
