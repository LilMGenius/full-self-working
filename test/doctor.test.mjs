import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir } from '../src/core/instance.mjs';
import { checkChrome, checkInstance, checkNode, failed, parseNodeRange, run, runChecks, surfaceProbe } from '../src/cli/doctor.mjs';
import { tempDir } from './tmp.mjs';

function instance({ filled = true, edit } = {}) {
  const dir = tempDir('fsw-doctor-');
  for (const f of readdirSync(exampleDir)) copyFileSync(join(exampleDir, f), join(dir, f));
  if (filled) {
    const p = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
    p.person = { nameEn: 'Mina Test', links: [] };
    p.roles = [];
    p.projects = [];
    p.serviceFit = {};
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(p));
    const b = JSON.parse(readFileSync(join(dir, 'business.json'), 'utf8'));
    Object.assign(b, { bizRegNo: '111-11-11111', email: 'me@mina.invalid', payout: { bank: 'b', account: '111-111-111111', holder: 'h' } });
    writeFileSync(join(dir, 'business.json'), JSON.stringify(b));
  }
  if (edit) {
    const c = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    edit(c);
    writeFileSync(join(dir, 'config.json'), JSON.stringify(c));
  }
  return dir;
}

const good = {
  codexVersion: () => ({ ok: true, detail: 'codex-cli 9.9.9' }),
  codexCall: async () => ({ ok: true, durationMs: 4000 }),
  proxy: async () => ({ status: 200 }),
  bsk: async () => ({ daemon: true, version: '1.0', browsers: 1 }),
  taskStatus: () => ({ supported: true, status: 0, out: 'state     Running\nlock      pid 12 alive=True\n' }),
  openAdapter: async () => ({ login: async () => ({ loggedIn: true, nickname: 'mina' }), stop: async () => {} }),
};
const base = (over = {}) => ({ instanceDir: over.dir, node: { version: '26.0.0', engines: '>=24' }, exists: () => true, env: {}, probes: { ...good, ...(over.probes ?? {}) } });
const by = (checks, name) => checks.find((c) => c.name === name);

test('node: a version below package.json engines fails, and an unreadable range fails by name', () => {
  assert.equal(checkNode({ version: '24.1.0', engines: '>=24' }).status, 'ok');
  assert.equal(checkNode({ version: '22.9.0', engines: '>=24' }).status, 'FAIL');
  assert.equal(checkNode({ version: '24.0.0', engines: '^24' }).status, 'FAIL');
  assert.deepEqual(parseNodeRange('>=24.2'), { major: 24, minor: 2 });
});

test('chrome: found or FAIL with the way to fix it', () => {
  assert.equal(checkChrome(() => true).status, 'ok');
  assert.match(checkChrome(() => false).hint, /FSW_CHROME/);
});

test('instance: the unmodified example fails on profile and business, a filled one passes', () => {
  const example = checkInstance(instance({ filled: false })).out;
  assert.equal(by(example, 'profile').status, 'FAIL');
  assert.equal(by(example, 'business').status, 'FAIL');
  const filled = checkInstance(instance()).out;
  assert.deepEqual(filled.map((c) => c.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  const uncapped = checkInstance(instance({ edit: (c) => delete c.platforms.soomgo.maxCashPerDay })).out;
  assert.equal(by(uncapped, 'cash caps').status, 'warn');
  assert.match(by(uncapped, 'cash caps').detail, /soomgo/);
});

test('instance: a missing instance, a missing pipeline setting and an unknown platform fail by name', () => {
  assert.match(checkInstance(join(tmpdir(), 'fsw-no-such-instance')).out[0].detail, /lacks/);
  const noPipeline = checkInstance(instance({ edit: (c) => delete c.pipeline })).out;
  assert.match(by(noPipeline, 'config').detail, /replyWindowHours/);
  const unknown = checkInstance(instance({ edit: (c) => (c.platforms.nowhere = { enabled: true, mode: 'auto' }) })).out;
  assert.match(by(unknown, 'config').detail, /nowhere has no descriptor/);
});

test('a healthy machine passes every check and exits 0', async () => {
  const dir = instance();
  const lines = [];
  assert.equal(await run([], { ...base({ dir }), log: (l) => lines.push(l) }), 0);
  const text = lines.join('\n');
  assert.match(text, /ok\s+login kmong\s+signed in as mina/);
  assert.match(text, /ok\s+login soomgo/);
  assert.match(text, /every required check passed/);
});

test('each broken requirement is a FAIL line with a hint, and the exit code is 1', async () => {
  const dir = instance();
  const probes = {
    codexVersion: () => ({ ok: false, detail: 'spawn codex ENOENT' }),
    proxy: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); },
    bsk: async () => ({ daemon: false, detail: 'no daemon' }),
  };
  const checks = await runChecks(base({ dir, probes }));
  assert.equal(by(checks, 'codex cli').status, 'FAIL');
  assert.match(by(checks, 'proxy').detail, /ECONNREFUSED/);
  assert.equal(by(checks, 'codex call').status, 'skip');
  assert.equal(by(checks, 'browserskill').status, 'FAIL');
  assert.equal(by(checks, 'login kmong').status, 'skip');
  const lines = [];
  assert.equal(await run([], { ...base({ dir, probes }), log: (l) => lines.push(l) }), 1);
  assert.match(lines.join('\n'), /FAIL\s+codex cli.*->.*codex login/);
});

test('a signed-out platform and a failing schema call are FAIL; an unregistered task only warns', async () => {
  const dir = instance();
  const probes = {
    codexCall: async () => { throw Object.assign(new Error('codex exec exited with 1'), { code: 'FSW_CODEX_EXIT', stderrTail: 'auth\nunauthorized' }); },
    openAdapter: async (id) => ({ login: async () => ({ loggedIn: id === 'soomgo' }), stop: async () => {} }),
    taskStatus: () => ({ supported: true, status: 0, out: 'task fsw-supervisor not registered' }),
  };
  const checks = await runChecks(base({ dir, probes }));
  assert.match(by(checks, 'codex call').detail, /FSW_CODEX_EXIT.*unauthorized/);
  assert.equal(by(checks, 'login kmong').status, 'FAIL');
  assert.equal(by(checks, 'login soomgo').status, 'ok');
  assert.equal(by(checks, 'schedule').status, 'warn');
});

// fsw deploys no operator site (docs/DESIGN.md, Decisions); a config written before that still holds the
// retired site group, which loads and checks like any other key the schema no longer names.
test('a config that still holds the retired site group passes the instance checks, and doctor has no site check', async () => {
  const dir = instance({ edit: (c) => (c.site = { domain: null, vercelTeam: null, project: null }) });
  assert.deepEqual(checkInstance(dir).out.map((c) => c.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
  const checks = await runChecks(base({ dir }));
  assert.deepEqual(checks.filter((c) => /vercel|site/.test(c.name)), []);
  assert.deepEqual(failed(checks), []);
});

test('FSW_CODEX_PROXY=none skips the proxy check; a platform with no adapter is reported', async () => {
  const dir = instance({ edit: (c) => (c.platforms.fiverr = { enabled: true, mode: 'draft' }) });
  const checks = await runChecks({ ...base({ dir, probes: { openAdapter: async (id) => (id === 'fiverr' ? null : good.openAdapter()) } }), env: { FSW_CODEX_PROXY: 'none' } });
  assert.equal(by(checks, 'proxy').status, 'skip');
  assert.equal(by(checks, 'login fiverr').status, 'FAIL');
  assert.match(by(checks, 'login fiverr').detail, /no adapter/);
});

test('an offered soomgo catalog service with no request items set warns by name; services outside the catalog are not named', async () => {
  const dir = instance();
  let rows = [{ name: '웹 개발', itemsSet: false }, { name: '피아노 레슨', itemsSet: false }, { name: '프로그래밍/코딩 레슨', itemsSet: true }];
  const probes = { openAdapter: async (id) => ({ login: async () => ({ loggedIn: true }), services: id === 'soomgo' ? async () => rows : undefined, stop: async () => {} }) };
  let checks = await runChecks(base({ dir, probes }));
  assert.equal(by(checks, 'items soomgo').status, 'warn');
  assert.match(by(checks, 'items soomgo').detail, /^웹 개발: no request items set/);
  assert.equal(by(checks, 'items kmong'), undefined);
  rows = rows.map((r) => (r.name === '웹 개발' ? { ...r, itemsSet: true } : r));
  checks = await runChecks(base({ dir, probes }));
  assert.equal(by(checks, 'items soomgo').status, 'ok');
});

test('the platform probe reads the login and the offered services from the surface supply', async () => {
  assert.equal(await surfaceProbe('fiverr', { has: () => false, open: async () => assert.fail('no surface, no session') }), null);
  const rows = [{ name: '웹 개발', itemsSet: false, ref: 'a' }];
  const p = await surfaceProbe('soomgo', { has: () => true, open: async () => ({ login: async () => ({ loggedIn: true }), supply: async () => ({ platform: 'soomgo', listings: null, services: rows }), stop: async () => {} }) });
  assert.deepEqual([(await p.login()).loggedIn, await p.services()], [true, rows]);
  const k = await surfaceProbe('kmong', { has: () => true, open: async () => ({ login: async () => ({ loggedIn: true }), supply: async () => ({ platform: 'kmong', listings: [], services: null }), stop: async () => {} }) });
  assert.deepEqual(await k.services(), []);
});

test('an offered lesson service without items is not named while the instance answers no lessons there', async () => {
  const rows = [{ name: '프로그래밍/코딩 레슨', itemsSet: false }];
  const probes = { openAdapter: async (id) => ({ login: async () => ({ loggedIn: true }), services: id === 'soomgo' ? async () => rows : undefined, stop: async () => {} }) };
  assert.equal(by(await runChecks(base({ dir: instance(), probes })), 'items soomgo').status, 'ok');
  const answering = instance({ edit: (c) => (c.platforms.soomgo.services = ['lesson_tutoring']) });
  assert.match(by(await runChecks(base({ dir: answering, probes })), 'items soomgo').detail, /^프로그래밍\/코딩 레슨: no request items set/);
});
test('one choice warning names each choice the operator has not made', async () => {
  const dir = instance();
  const checks = await runChecks(base({ dir }));
  const choices = checks.filter((c) => c.name.startsWith('choice '));
  assert.ok(choices.some((c) => c.name === 'choice platforms.soomgo.bidBudget' && c.status === 'warn' && c.hint === 'set it with fsw settings set platforms.soomgo.bidBudget <value>'));
  const set = instance({ edit: (c) => { for (const p of Object.values(c.platforms)) Object.assign(p, { maxCashPerDay: p.maxCashPerDay ?? 0, services: p.services ?? null, bidBudget: { monthlyKRW: 0, stopAfterUnanswered: 20 } }); } });
  assert.deepEqual((await runChecks(base({ dir: set }))).filter((c) => c.name.startsWith('choice ')), []);
});