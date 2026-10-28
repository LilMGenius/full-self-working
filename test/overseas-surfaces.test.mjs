import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { step } from '../src/loop/index.mjs';
import { hasSurface, openSurface } from '../src/surface/index.mjs';
import { BID_NOT_TYPED, FORM_UNMAPPED, openFreelancerSurface } from '../src/surface/freelancer.mjs';
import { scriptedSurface, tokenFor } from './helpers/surface.mjs';
import { readRecording, replaySession } from '../src/surface/recorder.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { outboundItem } from '../src/brain/respond.mjs';
import { authorize } from '../src/policy/authorize.mjs';
import { recordReviews } from '../src/loop/reviews.mjs';
import { writeSellerState } from '../src/economics/price-table.mjs';
import { probe } from '../scripts/probe.mjs';
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

test('freelancer send and quote refuse by name before anything reaches the session', async () => {
  const session = fakeSession(null);
  const s = await openFreelancerSurface({ session, fetchJson: fakeApi([]).fetchJson, targets: TARGETS });
  for (const [write, kind] of [['send', 'message'], ['quote', 'quote']]) await assert.rejects(s[write]('7', { text: 'x', amountKRW: 1000, authorized: tokenFor('freelancer', '7', kind, 'x') }), { code: FORM_UNMAPPED });
  assert.deepEqual(session.calls, []);
});

test('freelancer login reads the self API in the session: an account id is true, unauthenticated false, anything else null', async () => {
  const out = await openFreelancerSurface({ session: fakeSession({ json: { status: 'error', error_code: 'RestExceptionCodes.NOT_AUTHENTICATED' } }), targets: TARGETS });
  assert.equal((await out.login()).loggedIn, false);
  const other = fakeSession({ json: { status: 'success', result: { id: 1 } } });
  const s = await openFreelancerSurface({ session: other, targets: TARGETS });
  assert.equal((await s.login()).loggedIn, true);
  assert.deepEqual(other.calls[0], ['navigate', 'https://www.freelancer.com/api/users/0.1/self/']);
  for (const body of [{ title: 'Error 502', text: '<html>Bad gateway</html>' }, { json: { status: 'success', result: {} } }]) assert.equal((await (await openFreelancerSurface({ session: fakeSession(body), targets: TARGETS })).login()).loggedIn, null);
});

test('freelancer signIn presses the framed Google button on the login page, and a login page that redirects away presses nothing', async () => {
  const pressed = [];
  const google = async (_s, opts) => pressed.push(opts);
  const page = (loginLands, self) => ({ calls: [], navigate: async (url) => (url.endsWith('/login') ? loginLands : url), evaluate: async () => self, stop: async () => {} });
  const signedOut = await openFreelancerSurface({ session: page('https://www.freelancer.com/login', { json: { status: 'success', result: { id: 1 } } }), targets: TARGETS, google });
  assert.deepEqual(await signedOut.signIn({ email: 'operator@example.invalid' }), { signedIn: true, reason: 'the self API answered with the account id' });
  assert.deepEqual(pressed, [{ framed: true, email: 'operator@example.invalid' }]);
  const stillOut = await openFreelancerSurface({ session: page('https://www.freelancer.com/login', { json: { status: 'error', error_code: 'RestExceptionCodes.NOT_AUTHENTICATED' } }), targets: TARGETS, google });
  assert.equal((await stillOut.signIn({ email: 'operator@example.invalid' })).signedIn, false);
  // An HTML error page from the self API after the pick is no sign-in (wp8 review): nothing reads it as one.
  const errorPage = await openFreelancerSurface({ session: page('https://www.freelancer.com/login', { title: 'Error 502', text: '<html>Bad gateway</html>' }), targets: TARGETS, google });
  assert.equal((await errorPage.signIn({ email: 'operator@example.invalid' })).signedIn, false);
  const already = await openFreelancerSurface({ session: page('https://www.freelancer.com/dashboard', { json: { status: 'success', result: { id: 1 } } }), targets: TARGETS, google });
  assert.deepEqual(await already.signIn({ email: 'operator@example.invalid' }), { signedIn: true, alreadySignedIn: true });
  // A redirect away from /login proves nothing by itself: to an error page it is a failed sign-in (wp8 re-review).
  const elsewhere = await openFreelancerSurface({ session: page('https://www.freelancer.com/maintenance', { title: 'Service unavailable', text: 'Try again later' }), targets: TARGETS, google });
  const r = await elsewhere.signIn({ email: 'operator@example.invalid' });
  assert.equal(r.signedIn, false);
  assert.match(r.reason, /went to \/maintenance/);
  assert.equal(pressed.length, 3);
});

test('googleSignIn reads the opener page when the chooser tab closes under the engine after the pick', async () => {
  const { googleSignIn } = await import('../src/platforms/onboarding.mjs');
  const email = 'operator@example.invalid';
  let picked = false;
  const bsk = {
    observe: async ({ tabId }) => ({ text: tabId ? 'option "' + email + '" @e2' : 'button "Continue as Operator, ' + email + '. Opens in new tab" @e1' }),
    click: async (_ref, { tabId } = {}) => {
      if (!tabId) return;
      picked = true;
      throw new Error('No tab with id: 527361333.');
    },
    tabList: async () => ({ tabs: picked ? [] : [{ tab_id: 7, url: 'https://accounts.google.com/v3/signin/accountchooser', scope: 'agent' }] }),
    evaluate: async () => ({ value: JSON.stringify({ accounts: [email], password: false }) }),
  };
  const session = { session: bsk, evaluate: async () => (picked ? '/dashboard' : '/login') };
  assert.equal(await googleSignIn(session, { framed: true, email, wait: async () => {} }), '/dashboard');
  assert.equal(picked, true);
});

test('openSurface opens freelancer on the session it is given, as a publicSense surface', async () => {
  assert.equal(hasSurface('freelancer'), true);
  const s = await openSurface('freelancer', { session: fakeSession(null) });
  assert.deepEqual([s.platform, s.publicSense], ['freelancer', true]);
});

// 위시켓 (088 unit 1): the public board through the project reader, every write refused by name.
const wishketProject = (id, over = {}) => ({ id, title: '예약 웹 ' + id, description: '예약 웹을 만들고 싶습니다 ' + id, amountKRW: 12000000, projectType: 'task_based', private: false, field: '랜딩ㆍ소개 페이지', postedOn: '2026-10-21', ...over });
function fakeReader(projects) {
  const calls = [];
  return {
    calls,
    listProjects: async (opts) => (calls.push(['list', opts.pages]), { projects, total: projects.length, skipped: 0 }),
    readProject: async (id) => (calls.push(['read', id]), projects.find((p) => p.id === id)),
    close: async () => calls.push(['close']),
  };
}
const WISHKET_WRITES = { send: { text: '안녕하세요' }, quote: { amountKRW: 1000000, text: '견적' }, propose: { text: '제안', amountKRW: 1000000 } };
const WRITE_KIND = { send: 'message', quote: 'quote', propose: 'proposal' };

test('openSurface opens wishket with no BrowserSkill session and freelancer still on its session', async () => {
  assert.equal(hasSurface('wishket'), true);
  const w = await openSurface('wishket', { session: fakeSession(null) });
  assert.deepEqual([w.platform, w.publicSense, w.session, (await w.login()).loggedIn], ['wishket', true, undefined, false]);
  const given = fakeSession(null);
  const f = await openSurface('freelancer', { session: given });
  assert.equal(f.session, given, 'freelancer keeps the operator session its login, signIn, propose and reviews use');
});

test('wishket sense lists open 외주 projects as requests and read gives the description as one inbound message', async () => {
  const { openWishketSurface } = await import('../src/surface/wishket.mjs');
  const reader = fakeReader([wishketProject(1), wishketProject(2, { private: true }), wishketProject(3, { projectType: 'term_based' })]);
  const s = await openWishketSurface({ reader });
  const rows = await s.sense();
  assert.deepEqual(rows.map((r) => [r.ref, r.kind, r.service, r.quotable, r.quoteCostKRW, r.unread, r.at]), [['1', 'request', '랜딩ㆍ소개 페이지', true, 0, false, '2026-10-21T00:00:00+09:00'], ['2', 'request', '랜딩ㆍ소개 페이지', false, 0, false, '2026-10-21T00:00:00+09:00']]);
  const t = await s.read('1', { kind: 'request' });
  assert.deepEqual([t.platform, t.kind, t.title, t.budget, t.messages.map((m) => [m.direction, m.text, m.at])], ['wishket', 'request', '예약 웹 1', 12000000, [['in', '예약 웹을 만들고 싶습니다 1', '2026-10-21T00:00:00+09:00']]]);
  assert.match(t.messages[0].externalId, /^request:[0-9a-f]{12}$/);
  await assert.rejects(s.read('1', { kind: 'message' }), { code: 'FSW_READ_KIND' });
  await s.stop();
  assert.deepEqual(reader.calls, [['list', 2], ['read', 1], ['close']]);
});

test('a wishket card edited under the same posted day is read again, and an unedited one waits', async () => {
  const { inboundOfProject } = await import('../src/surface/wishket.mjs');
  const { needsWork } = await import('../src/triage/index.mjs');
  const before = inboundOfProject(wishketProject(1));
  const row = { lastInboundAt: before.at, meta: { settled: { at: before.at, rev: before.rev, by: 'observe', key: null } } };
  assert.equal(needsWork(before, row, null, 'observe'), false);
  for (const edit of [{ title: '예약 웹 수정' }, { amountKRW: 15000000 }, { field: '웹 개발' }]) {
    const after = inboundOfProject(wishketProject(1, edit));
    assert.equal(after.at, before.at);
    assert.equal(needsWork(after, row, null, 'observe'), true, 'edit ' + JSON.stringify(edit));
  }
});

test('a reread wishket project with an edited description stores the new body, and an unchanged one adds nothing', async () => {
  const { threadOfProject } = await import('../src/surface/wishket.mjs');
  const ledger = openLedger(':memory:');
  const t = ledger.upsertThread({ platform: 'wishket', externalId: '1', kind: 'request' });
  // The detail page carries no field, so the stored id cannot lean on the card.
  const detail = (over) => { const { field, ...p } = wishketProject(1, over); return p; };
  for (const p of [detail(), detail(), detail({ description: '예약 웹 범위가 바뀌었습니다' })]) {
    for (const m of threadOfProject(p).messages) ledger.addMessage({ threadId: t.id, direction: m.direction, body: m.text, externalId: m.externalId, at: m.at });
  }
  assert.deepEqual(ledger.db.prepare('SELECT body FROM messages WHERE thread_id = ? ORDER BY id').all(t.id).map((r) => r.body), ['예약 웹을 만들고 싶습니다 1', '예약 웹 범위가 바뀌었습니다']);
  ledger.close();
});

test('a wishket card parked, edited and read, then restored is read again in observe and auto mode', async () => {
  const { inboundOfProject } = await import('../src/surface/wishket.mjs');
  const { needsWork } = await import('../src/triage/index.mjs');
  const { withRecords } = await import('../src/loop/step.mjs');
  const a = inboundOfProject(wishketProject(1));
  const b = inboundOfProject(wishketProject(1, { title: '예약 웹 수정' }));
  for (const mode of ['observe', 'auto']) {
    let meta = withRecords({}, { skipped: { at: a.at, rev: a.rev, reason: 'catalog: x', key: null } });
    meta = withRecords(meta, { settled: { at: b.at, rev: b.rev, by: mode, key: null } });
    const row = { lastInboundAt: a.at, meta };
    assert.equal(needsWork(b, row, null, mode), false, mode + ': the read revision waits');
    assert.equal(needsWork(a, row, null, mode), true, mode + ': the restored card is read again');
  }
});

test('every wishket write throws APPLY_UNMAPPED before the project reader is opened, authorized or not', async () => {
  const { APPLY_UNMAPPED, NOT_TYPED, openWishketSurface } = await import('../src/surface/wishket.mjs');
  assert.equal(APPLY_UNMAPPED, 'FSW_WISHKET_APPLY_UNMAPPED');
  let opened = 0;
  const s = await openWishketSurface({ open: async () => ((opened += 1), fakeReader([])) });
  for (const [write, args] of Object.entries(WISHKET_WRITES)) await assert.rejects(s[write]('1', { ...args, authorized: tokenFor('wishket', '1', WRITE_KIND[write], args.text) }), { code: APPLY_UNMAPPED });
  assert.equal(opened, 0, 'no browser was launched for a refused write');
  assert.deepEqual(NOT_TYPED, [APPLY_UNMAPPED]);
  await s.stop();
});

// 088 unit 2: the sign-in probe and the upwork and fiverr shells, which sense nothing and refuse every write.
const probeSession = (landed, page = {}) => {
  const calls = [];
  return { calls, navigate: async (url) => (calls.push(['navigate', url]), landed), evaluate: async () => (calls.push(['evaluate']), { url: landed, title: '', text: '', ...page }), stop: async () => {} };
};
const SHELLS = [['upwork', 'FSW_UPWORK_UNMAPPED', 'https://www.upwork.com/ab/account-security/login?redir=%2Fnx%2Ffind-work%2F'], ['fiverr', 'FSW_FIVERR_UNMAPPED', 'https://www.fiverr.com/login?source=inbox']];

test('probeSignIn reads a redirect to the login route and a bot wall as signed out, and anything else as unknown', async () => {
  const { probeSignIn } = await import('../src/platforms/signin.mjs');
  const opts = { startUrl: 'https://example.invalid/inbox', loginRoute: /\/login/ };
  const out = probeSession('https://example.invalid/login?next=inbox');
  assert.deepEqual(await probeSignIn(out, opts), { loggedIn: false, detail: 'redirected to the login page https://example.invalid/login?next=inbox' });
  assert.deepEqual(out.calls[0], ['navigate', 'https://example.invalid/inbox']);
  assert.deepEqual(await probeSignIn(probeSession('https://example.invalid/inbox', { text: 'Press & Hold to confirm you are a human' }), opts), { loggedIn: false, detail: 'challenge: perimeterx' });
  assert.deepEqual(await probeSignIn(probeSession('https://example.invalid/inbox', { title: 'Just a moment...' }), opts), { loggedIn: false, detail: 'challenge: cloudflare' });
  const stayed = await probeSignIn(probeSession('https://example.invalid/inbox', { text: 'Inbox' }), opts);
  assert.equal(stayed.loggedIn, null, 'no signed-in marker is mapped, so staying on the page proves nothing');
});

test('upwork and fiverr open on the operator session, probe their login routes, sense nothing and refuse every read and write before any driver call', async () => {
  for (const [platform, code, loginPage] of SHELLS) {
    assert.equal(hasSurface(platform), true, platform);
    const session = probeSession(loginPage);
    const s = await openSurface(platform, { session });
    assert.deepEqual([s.platform, s.publicSense, s.session === session, typeof s.signIn], [platform, false, true, 'undefined'], platform);
    const login = await s.login();
    assert.equal(login.loggedIn, false, platform);
    assert.match(login.detail, /login page/);
    session.calls.length = 0;
    assert.deepEqual(await s.sense(), [], platform);
    await assert.rejects(s.read('1', { kind: 'request' }), { code });
    for (const [write, args] of Object.entries(WISHKET_WRITES)) await assert.rejects(s[write]('1', { ...args, authorized: tokenFor(platform, '1', WRITE_KIND[write], args.text) }), { code });
    assert.deepEqual(session.calls, [], platform + ': nothing reached the session after the login probe');
    const { NOT_TYPED } = await import('../src/surface/' + platform + '.mjs');
    assert.deepEqual(NOT_TYPED, [code]);
  }
  // The fiverr login route is the /login page itself, never a path that merely contains it.
  assert.equal((await (await openSurface('fiverr', { session: probeSession('https://www.fiverr.com/inbox', { text: 'Inbox' }) })).login()).loggedIn, null);
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

// Order 5: the bid gate of a signed-in session, replayed from a synthetic recording of the gated details
// page mapped 2026-10-27 (test/fixtures/surfaces/freelancer/bidform.jsonl): the balance banner, two open
// steps and 6 free bids.
const GATED = readRecording('test/fixtures/surfaces/freelancer/bidform.jsonl');
const gate = (edit = (g) => g, bids = 6) => GATED.map((e) => (e.name === 'pageBidGate' ? { ...e, answer: edit(e.answer) } : e.name === 'pageBody' ? { ...e, answer: { json: { ...e.answer.json, result: { ...e.answer.json.result, account_balances: { ...e.answer.json.result.account_balances, bids_remaining: bids } } } } } : e));
const replayed = async (entries) => {
  const session = replaySession(entries);
  return { session, surface: await openFreelancerSurface({ session, fetchJson: fakeApi([project(7)]).fetchJson, targets: TARGETS }) };
};
const SEND = tokenFor('freelancer', '7', 'proposal', 'x');

test('a freelancer bid is refused by name before anything is typed: balance, then steps, then free bids, then the unmapped form', async () => {
  const cases = [
    [gate(), 'FSW_FREELANCER_BALANCE', /minimum balance of \$20 USD/],
    [gate((g) => ({ ...g, unlock: null })), 'FSW_FREELANCER_STEPS', /Update your skills, Verify your email; nothing was typed/],
    [gate((g) => ({ ...g, unlock: null, steps: g.steps.map((s) => ({ ...s, done: true })) }), 0), 'FSW_FREELANCER_NO_BIDS', /no free bids are left this month \(6 a month\)/],
    [gate((g) => ({ ...g, unlock: null, steps: [] })), 'FSW_FREELANCER_FORM_UNMAPPED', /not mapped/],
  ];
  for (const [entries, code, reason] of cases) {
    const { session, surface } = await replayed(entries);
    await assert.rejects(surface.propose('7', { text: 'x', amountKRW: 100000, amount: 80, currency: 'USD', periodDays: 5, authorized: SEND }), (err) => err.code === code && reason.test(err.message));
    assert.ok(BID_NOT_TYPED.includes(code), code + ' is listed for the drain as not typed');
    assert.equal(session.remaining(), 0, code + ': the gate was read and nothing else was called');
  }
  const { session, surface } = await replayed(gate());
  assert.equal((await surface.propose('7', { text: 'x', authorized: { verdict: 'refuse' } })).observed, false);
  assert.equal(session.remaining(), GATED.length, 'an unauthorized bid loads nothing');
});

test('a freelancer dryRun reads the gate and names its refusal without typing or pressing', async () => {
  const { session, surface } = await replayed(gate());
  const r = await surface.dryRun('7');
  assert.deepEqual([r.dryRun, r.typed, r.refused, r.bidsLeft, r.unlock, r.form, r.quoteCostKRW], [true, false, 'FSW_FREELANCER_BALANCE', 6, true, false, 0]);
  assert.deepEqual(r.steps.filter((s) => !s.done).map((s) => s.name), ['Update your skills', 'Verify your email']);
  assert.equal(session.remaining(), 0);
});

test('a read to reply costs a free bid 0 KRW, which the default bid budget passes, and an unknown count is refused budget.bid', async () => {
  const instance = makeInstance();
  // The real descriptor keeps the bid form unmapped, which refuses first; a copy with it mapped isolates the bid budget.
  const real = loadDescriptor('freelancer');
  const descriptor = { ...real, forms: { ...real.forms, proposal: { mapped: true, mappedAt: '2026-10-27T00:00:00Z', recording: 'test/fixtures/surfaces/freelancer/bidform.jsonl', readBack: true } } };
  const verdictOf = async (entries, d = descriptor) => {
    const { surface } = await replayed(entries);
    const thread = { ...(await surface.read('7', { kind: 'request', willReply: true })), serviceLabel: 'Web Scraping' };
    const decision = { intent: 'quote_request', service: 'data_crawling', language: 'en', reply: 'I can build this scraper.', quote: { amountKRW: 300000, priceType: 'fixed', scope: 'one scraper', deliveryDays: 5, complexity: 'standard' }, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null };
    const item = outboundItem(thread, decision, decision.reply, { descriptor: d, fx: { date: '2026-10-20', source: 'synthetic', rates: { KRW: 1400, USD: 1 } } });
    return { thread, item, rules: authorize(item, { descriptor: d, instance, mode: 'auto', now: new Date('2026-10-20T12:00:00+09:00'), usage: { quotes: 0, cashKRW: 0, bidMonthKRW: 0, bidUnanswered: 0 } }).reasons.map((x) => x.rule) };
  };
  const free = await verdictOf(gate());
  assert.deepEqual([free.thread.quoteCostKRW, free.thread.currency, free.thread.bid.refused, free.item.kind, free.item.costKRW], [0, 'USD', 'FSW_FREELANCER_BALANCE', 'proposal', 0]);
  assert.equal(free.rules.includes('budget.bid'), false, free.rules.join(','));
  const none = await verdictOf(gate((g) => g, null));
  assert.equal(none.thread.quoteCostKRW, null);
  assert.equal(none.rules.includes('budget.bid'), true, none.rules.join(','));
  assert.deepEqual((await verdictOf(gate(), real)).rules, ['form.unmapped']);
  const observed = await (await openFreelancerSurface({ session: fakeSession(null), fetchJson: fakeApi([project(7)]).fetchJson, targets: TARGETS })).read('7', { kind: 'request' });
  assert.deepEqual([observed.quoteCostKRW, observed.bid], [null, null], 'an observe read loads nothing in the session');
});

test('freelancer reviews come from the self API reputation, and the hourly pass writes the seller state the price table reads', async () => {
  const rep = { json: { status: 'success', result: { id: 1, reputation: { entire_history: { reviews: 0, overall: 0, complete: 0 } } } } };
  const surface = await openFreelancerSurface({ session: fakeSession(rep), targets: TARGETS });
  const reviews = await surface.reviews();
  assert.deepEqual([reviews.counts, reviews.state], [{ reviews: 0, rating: 0 }, { reviews: { count: 0 }, account: { totalJobs: 0 } }]);
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const out = await recordReviews({ instance, ledger, now: new Date('2026-10-28T01:00:00Z'), openSurface: async () => surface, notify: async () => ({ written: false }) });
  assert.deepEqual(out.filter((e) => e.platform === 'freelancer').map((e) => e.status), ['ok']);
  const file = join(instance.paths.platforms, 'freelancer-state.json');
  const first = readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(first).reviews, { count: 0 });
  assert.equal(writeSellerState(instance.paths.platforms, 'freelancer', reviews.state, new Date('2026-10-29T00:00:00Z')).written, false);
  assert.equal(readFileSync(file, 'utf8'), first, 'an unchanged state is not rewritten');
});

test('the probe bidform op prints the refusal code of the gated page and the reviews op writes the seller state', async () => {
  const dir = makeInstance().dir;
  const prev = process.env.FSW_INSTANCE;
  process.env.FSW_INSTANCE = dir;
  try {
    const lines = [];
    const { surface } = await replayed(gate());
    assert.equal(await probe(['freelancer', 'bidform', '7', '--now'], { open: async () => surface, log: (l) => lines.push(l) }), 0);
    assert.equal(JSON.parse(lines.at(-1)).refused, 'FSW_FREELANCER_BALANCE');
    assert.equal(await probe(['kmong', 'bidform', '7', '--now'], { open: async () => surface, log: () => {} }), 2);
    const rep = await openFreelancerSurface({ session: fakeSession({ json: { status: 'success', result: { id: 1, reputation: { entire_history: { reviews: 2, overall: 4.5, complete: 3 } } } } }), targets: TARGETS });
    assert.equal(await probe(['freelancer', 'reviews', '--now'], { open: async () => Object.assign(rep, { session: { loads: 1 } }), log: () => {} }), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'platforms', 'freelancer-state.json'), 'utf8')).reviews, { count: 2 });
  } finally {
    if (prev === undefined) delete process.env.FSW_INSTANCE;
    else process.env.FSW_INSTANCE = prev;
  }
});
