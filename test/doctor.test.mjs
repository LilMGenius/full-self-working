import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir } from '../src/core/instance.mjs';
import { checkChrome, checkInstance, checkNode, parseNodeRange, run, runChecks } from '../src/cli/doctor.mjs';

function instance({ filled = true, edit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-doctor-'));
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
  vercel: () => ({ ok: true, out: 'mina' }),
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
  const dir = instance({ edit: (c) => (c.site = { project: 'p', vercelTeam: 't', domain: null }) });
  const lines = [];
  assert.equal(await run([], { ...base({ dir }), log: (l) => lines.push(l) }), 0);
  const text = lines.join('\n');
  assert.match(text, /ok\s+login kmong\s+signed in as mina/);
  assert.match(text, /ok\s+login soomgo/);
  assert.match(text, /ok\s+vercel\s+signed in as mina/);
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

test('a signed-out platform and a failing schema call are FAIL; an unregistered task and signed-out vercel only warn', async () => {
  const dir = instance({ edit: (c) => (c.site = { project: 'p' }) });
  const probes = {
    codexCall: async () => { throw Object.assign(new Error('codex exec exited with 1'), { code: 'FSW_CODEX_EXIT', stderrTail: 'auth\nunauthorized' }); },
    openAdapter: async (id) => ({ login: async () => ({ loggedIn: id === 'soomgo' }), stop: async () => {} }),
    taskStatus: () => ({ supported: true, status: 0, out: 'task fsw-supervisor not registered' }),
    vercel: () => ({ ok: false, out: 'No existing credentials' }),
  };
  const checks = await runChecks(base({ dir, probes }));
  assert.match(by(checks, 'codex call').detail, /FSW_CODEX_EXIT.*unauthorized/);
  assert.equal(by(checks, 'login kmong').status, 'FAIL');
  assert.equal(by(checks, 'login soomgo').status, 'ok');
  assert.equal(by(checks, 'schedule').status, 'warn');
  assert.equal(by(checks, 'vercel').status, 'warn');
});

test('FSW_CODEX_PROXY=none skips the proxy check; a platform with no adapter is reported', async () => {
  const dir = instance({ edit: (c) => (c.platforms.fiverr = { enabled: true, mode: 'draft' }) });
  const checks = await runChecks({ ...base({ dir, probes: { openAdapter: async (id) => (id === 'fiverr' ? null : good.openAdapter()) } }), env: { FSW_CODEX_PROXY: 'none' } });
  assert.equal(by(checks, 'proxy').status, 'skip');
  assert.equal(by(checks, 'login fiverr').status, 'FAIL');
  assert.match(by(checks, 'login fiverr').detail, /no adapter/);
});
