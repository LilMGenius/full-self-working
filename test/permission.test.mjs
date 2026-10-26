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
    ['Yes, use it once it is live.', 'grant with a condition, for the operator to scope'],
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
  // A scope word anywhere in the granting message still holds it.
  const scoped = single({ thread: thread([msg('in', '네 올리셔도 됩니다. 회사 이름은 빼주세요.', at)]), job, decision: decision('granted', '네 올리셔도 됩니다.') });
  assert.equal(scoped.reason, 'grant with a condition, for the operator to scope');
});

test('a sign-off with 다음에, 이후, 후에 or once again is no condition on a plain yes', () => {
  const at = '2026-10-20T11:00:00+09:00';
  const cases = [
    ['네 올리셔도 됩니다. 다음에도 잘 부탁드려요.', '네 올리셔도 됩니다.'],
    ['포트폴리오에 쓰셔도 됩니다. 이후로도 잘 부탁드립니다.', '포트폴리오에 쓰셔도 됩니다.'],
    ['확인 후에 연락드릴게요. 포트폴리오는 올리셔도 돼요.', '포트폴리오는 올리셔도 돼요.'],
    ['Sure, go ahead. Thanks once again!', 'Sure, go ahead.'],
  ];
  for (const [text, quote] of cases) {
    for (const q of [quote, text]) {
      const r = single({ thread: thread([msg('in', text, at)]), job, decision: decision('granted', q) });
      assert.deepEqual([r.signal?.type, r.reason], ['permission_granted', null], text + ' / ' + q);
    }
  }
  // A later sign-off does not hold it either; a later message that times the posting does.
  const later = single({ thread: thread([msg('in', GRANT, at), msg('in', '다음에도 잘 부탁드려요.', '2026-10-20T11:30:00+09:00')]), job, decision: decision('granted', GRANT) });
  assert.equal(later.signal?.type, 'permission_granted');
  const timed = single({ thread: thread([msg('in', GRANT, at), msg('in', '아, 정식 오픈 후에 올려 주세요.', '2026-10-20T11:30:00+09:00')]), job, decision: decision('granted', GRANT) });
  assert.equal(timed.reason, 'grant with a condition, for the operator to scope');
});

test('a timing or condition word in any sentence around the yes holds it, except the named sign-offs', () => {
  const t = (h) => '2026-10-20T' + h + ':00+09:00';
  const held = [
    [['네 좋아요. 다만 오픈은 다음 달이라 그 이후에 부탁드려요.'], '네 좋아요.'],
    [['네 좋아요. 런칭 후에 해 주세요.'], '네 좋아요.'],
    [['Sure, go ahead. But please wait until after the launch.'], 'Sure, go ahead.'],
    [['Yes. Only if the launch is done.'], 'Yes.'],
    [['네 좋아요. 다만 오픈 이후에 부탁드려요.'], '네 좋아요. 다만 오픈 이후에 부탁드려요.'],
    [['네 좋아요.', '다만 오픈 이후에 부탁드려요.'], '네 좋아요.'],
    [['네 좋아요\n오픈 이후에 부탁드려요'], '네 좋아요'],
    [['네 좋아요. 오픈하고 나서 부탁드려요'], '네 좋아요.'],
    [['네 좋아요. 다음 달까지는 기다려 주세요'], '네 좋아요.'],
    [['Sure. Please wait until we launch'], 'Sure.'],
    [['오픈 이후에 부탁드려요.', '네 좋아요.'], '네 좋아요.'],
  ];
  for (const [texts, quote] of held) {
    const r = single({ thread: thread(texts.map((x, k) => msg('in', x, t('11:0' + k)))), job, decision: decision('granted', quote) });
    assert.deepEqual([r.signal, r.reason], [null, 'grant with a condition, for the operator to scope'], texts.join(' | ') + ' / ' + quote);
  }
});

test('a thank-you line after a plain yes is no condition', () => {
  const lines = ['지금까지 감사했습니다.', '끝까지 신경 써 주셔서 감사합니다.', '기다려 주셔서 감사합니다.', '결과물 보고 나서 너무 좋았어요.', 'Good afternoon!', "Can't wait to see it live.", '다음에 또 맡길게요.', '감사합니다 기다려 주셔서요!'];
  for (const line of lines) {
    for (const texts of [[GRANT + ' ' + line], [GRANT, line]]) {
      const r = single({ thread: thread(texts.map((x, k) => msg('in', x, '2026-10-20T11:0' + k + ':00+09:00'))), job, decision: decision('granted', GRANT) });
      assert.deepEqual([r.signal?.type, r.reason], ['permission_granted', null], texts.join(' | '));
    }
  }
});

test('a sign-off is exempt only as a whole phrase; a condition about posting holds the grant around the yes and as the yes', () => {
  const at = (k) => '2026-10-20T11:0' + k + ':00+09:00';
  const conditions = [
    '수정본 보고 나서 올려 주세요.',
    '다음에 또 연락드릴 때 올려 주세요.',
    '지금까지 작업한 첫 페이지만 보여 주세요.',
    "Can't wait, so post it when it launches.",
    '기다려 주셔서 감사해요. 공개는 잠시 보류해 주세요.',
    '제가 최종본 보고 나서 말씀드릴게요.',
    '오픈하면 올려 주세요.',
    '수정이 끝나면 올려 주세요.',
    '오픈할 때 같이 올려 주세요.',
    'Yes, post it when the site is live.',
  ];
  for (const line of conditions) {
    for (const texts of [[GRANT + ' ' + line], [GRANT, line]]) {
      const r = single({ thread: thread(texts.map((x, k) => msg('in', x, at(k)))), job, decision: decision('granted', GRANT) });
      assert.equal(r.signal, null, texts.join(' | '));
      assert.ok(r.reason, texts.join(' | '));
    }
    // As the quoted answer itself (the last sentence when the line has two).
    const quote = line.split(/(?<=\.)\s+/).at(-1);
    const asQuote = single({ thread: thread([msg('in', line, at(0))]), job, decision: decision('granted', quote) });
    assert.equal(asQuote.signal, null, 'quoted: ' + quote);
  }
  // A clean yes about posting beside a plain yes still grants.
  const both = single({ thread: thread([msg('in', '네 좋아요. 포트폴리오에 올리셔도 돼요.', at(0))]), job, decision: decision('granted', '네 좋아요.') });
  assert.equal(both.signal?.type, 'permission_granted');
});

test('an edit request anywhere since the delivery holds the grant, before the yes and two messages back too', () => {
  const at = (k) => '2026-10-20T11:0' + k + ':00+09:00';
  const requests = [
    '메인 이미지는 다른 걸로 바꿔서 올려 주세요.',
    '회사명 노출 없이 부탁드려요.',
    '로고는 지워 주세요.',
    '얼굴은 흐리게 처리해 주세요.',
    '업체명은 가명으로 바꿔 주세요.',
    '포트폴리오에는 2차 수정본으로 올려 주세요.',
    'Please use the second version.',
    'Just swap our logo for a placeholder first.',
    'Sure, as a case study with our name removed.',
    '오픈 이후에 올려 주세요.',
  ];
  for (const line of requests) {
    for (const texts of [[GRANT, line], [line, GRANT], [line, '정산 확인했습니다.', GRANT]]) {
      const r = single({ thread: thread(texts.map((x, k) => msg('in', x, at(k)))), job, decision: decision('granted', GRANT) });
      assert.equal(r.signal, null, texts.join(' | '));
      assert.ok(r.reason, texts.join(' | '));
    }
  }
  // A plain note between the request and the yes does not reset it, and without the request the yes grants.
  const plain = single({ thread: thread([msg('in', '정산 확인했습니다.', at(0)), msg('in', GRANT, at(1))]), job, decision: decision('granted', GRANT) });
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
    return step('kmong', { instance, ledger, now, spawnJob: () => ({ pid: 1, log: 'runner.log' }), openSurface: async () => surface, priceTable: [], runCodex: async () => ({ data: d, durationMs: 1 }) });
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

test('the backstop holds a yes beside a preference, a restriction or an imperative even when the model says granted', () => {
  // The model's own conditional never grants, even beside a clean yes: it is recorded as a condition.
  const c = single({ thread: thread([msg('in', GRANT, '2026-10-20T11:00:00+09:00')]), job, decision: decision('conditional', GRANT) });
  assert.deepEqual([c.signal?.type, c.reason], ['permission_conditional', 'the client set a condition on showing the work, for the operator to scope']);
  const at = (k) => '2026-10-20T11:0' + k + ':00+09:00';
  for (const line of ['포트폴리오엔 2번 시안이 나을 것 같아요.', '로고는 빼는 게 좋겠어요.', 'Use the second version.', "I'd prefer the dark theme version."]) {
    for (const texts of [[GRANT + ' ' + line], [GRANT, line], [line, GRANT]]) {
      const r = single({ thread: thread(texts.map((x, k) => msg('in', x, at(k)))), job, decision: decision('granted', GRANT) });
      assert.equal(r.signal, null, texts.join(' | '));
    }
  }
  const only = single({ thread: thread([msg('in', 'Yes, on your portfolio site only.', at(0))]), job, decision: decision('granted', 'Yes, on your portfolio site only.') });
  assert.equal(only.signal, null);
});

test('logistics after a plain yes is neutral, and a change request before the latest delivery no longer holds', async () => {
  const at = (k) => '2026-10-20T11:0' + k + ':00+09:00';
  for (const line of ['세금계산서 발행 가능할까요?', '원본 파일도 받을 수 있을까요?', 'Could you send the invoice and the source files?', '입금은 내일 해 드릴게요.']) {
    const r = single({ thread: thread([msg('in', GRANT, at(0)), msg('in', line, at(1))]), job, decision: decision('granted', GRANT) });
    assert.equal(r.signal?.type, 'permission_granted', line);
  }
  // Logistics that also speaks about showing the work is read like any other sentence.
  const shown = single({ thread: thread([msg('in', GRANT, at(0)), msg('in', '정산 끝나면 올려 주세요.', at(1))]), job, decision: decision('granted', GRANT) });
  assert.equal(shown.signal, null);
  const s = setup();
  // No reply is planned, so no item waits on the operator and the next message is decided.
  await s.run('메인 이미지는 다른 걸로 바꿔서 올려 주세요.', { intent: 'revision', reply: null }, 11);
  assert.equal(s.ledger.getJob('kmong-k1').status, 'revision');
  s.deal({ type: 'run_started', at: '2026-10-20T12:00:00+09:00', evidence: {} });
  s.deal({ type: 'delivery_observed', at: '2026-10-20T12:20:00+09:00', evidence: {} });
  await s.run(GRANT, { portfolioPermission: 'granted', permissionQuote: GRANT }, 13);
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'granted');
});

test('a model conditional on a thread is held and tells the operator once, naming it as conditional', async () => {
  const s = setup();
  const keys = () => [...s.requests().matchAll(/^- dedupe: (portfolio-answer-check:.+)$/gm)].map((m) => m[1]);
  const answer = { portfolioPermission: 'conditional', permissionQuote: '네, 로고만 빼고 올려 주세요.' };
  await s.run('네, 로고만 빼고 올려 주세요.', answer, 11);
  await s.run('네, 로고만 빼고 올려 주세요. 감사합니다.', answer, 13);
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'conditional');
  assert.deepEqual(keys(), ['portfolio-answer-check:kmong-k1:conditional']);
  assert.match(s.requests(), /read the client as conditional/);
  assert.equal(s.events('permission.unverified').length, 2);
});

test('a model conditional is recorded on the job; a later model grant of the earlier yes stays conditional and only the operator lifts it', async () => {
  const s = setup();
  const keys = () => [...s.requests().matchAll(/^- dedupe: (portfolio-answer-check:.+)$/gm)].map((m) => m[1]);
  const COND = '대표님 확인이 먼저 필요해요.';
  await s.run('네 좋아요. ' + COND, { portfolioPermission: 'conditional', permissionQuote: COND }, 11);
  const p = s.ledger.getJob('kmong-k1').meta.portfolio;
  assert.deepEqual([p.permission, p.quote, p.quoteAt, p.source], ['conditional', COND, '2026-10-20T11:00:00+09:00', 'brain']);
  await s.run('감사합니다!', { portfolioPermission: 'granted', permissionQuote: '네 좋아요.' }, 13);
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'conditional');
  assert.deepEqual(keys(), ['portfolio-answer-check:kmong-k1:conditional', 'portfolio-answer-check:kmong-k1:granted']);
  // The deal refuses the same grant by any path, with a fresh quote time too.
  s.deal({ type: 'permission_granted', at: '2026-10-20T13:40:00+09:00', evidence: { quote: '감사합니다!', quoteAt: '2026-10-20T13:00:00+09:00', source: 'brain' } });
  assert.equal(s.events('deal.refused').at(-1).reason, 'only the operator lifts a portfolio condition');
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'conditional');
  s.deal({ type: 'permission_granted', at: '2026-10-20T14:00:00+09:00', evidence: { source: 'operator' } });
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'granted');
});

test('a condition never replaces a denial, and the operator can deny a conditional job', () => {
  const s = setup();
  s.deal({ type: 'permission_conditional', at: '2026-10-20T12:00:00+09:00', evidence: { quote: 'x', source: 'brain' } });
  s.deal({ type: 'permission_refused', at: '2026-10-20T12:10:00+09:00', evidence: { source: 'operator' } });
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'denied');
  s.deal({ type: 'permission_conditional', at: '2026-10-20T12:20:00+09:00', evidence: { quote: 'x', source: 'brain' } });
  assert.equal(s.ledger.getJob('kmong-k1').meta.portfolio.permission, 'denied');
  assert.equal(s.events('deal.refused').at(-1).reason, 'a portfolio denial stands over a later condition');
});
