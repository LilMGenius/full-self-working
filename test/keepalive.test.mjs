import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { bskStatus } from '../src/core/bsk.mjs';
import { createBrowserKeeper } from '../src/supervisor/keepalive.mjs';
import { tempDir } from './tmp.mjs';

test('bsk status reports a missing binary by code, for the keeper and fsw doctor alike', async () => {
  await assert.rejects(bskStatus({ bin: join(tempDir('fsw-bsk-'), 'bsk.exe') }), { code: 'FSW_BSK_MISSING' });
});

test('the keeper notice names chromeName(config): Chrome, or Chrome with the configured profile', async () => {
  for (const [profile, want] of [[null, /^Open Chrome with/], ['X', /^Open Chrome \(profile X\) with/]]) {
    const notes = [];
    const instance = { config: { browser: { chromeProfile: profile } }, paths: { logs: tempDir('fsw-keeper-') } };
    const keeper = createBrowserKeeper({ instance, canStart: false, status: async () => ({ daemon: true, browsers: 0 }), notify: async (_i, n) => (notes.push(n), { written: true }) });
    const r = await keeper.check(new Date('2026-10-26T01:00:00Z'));
    assert.equal(r.status, 'no browser');
    assert.match(notes[0].body, want);
  }
});

test('stop ends the daemon the keeper started even after a second start lost the bsk lock and exited', async () => {
  // A bsk status read that times out under load reads as no daemon, so the keeper starts a second one,
  // which finds the lock held and exits (2026-10-26T17:20:48Z); stop must still end the first.
  const work = tempDir('fsw-keeper-daemon-');
  writeFileSync(join(work, 'daemon.js'), "const fs = require('node:fs');\ntry { fs.closeSync(fs.openSync('daemon.lock', 'wx')); } catch { process.exit(1); }\nsetInterval(() => {}, 1000);\n");
  const cwd = process.cwd();
  process.chdir(work);
  let first = null;
  try {
    let reads = 0;
    const status = async () => ((reads += 1), reads === 1 || reads === 3 ? { daemon: false } : { daemon: true, browsers: 1 });
    const keeper = createBrowserKeeper({ instance: { config: {}, paths: { logs: work } }, bin: process.execPath, status, settleMs: 1000 });
    assert.equal((await keeper.check()).status, 'daemon started');
    first = keeper.child;
    await keeper.check();
    assert.equal(first.exitCode, null, 'the first daemon still runs after the second start exited');
    const ended = once(first, 'exit');
    keeper.stop();
    await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('the first daemon is still running after stop')), 5000).unref())]);
  } finally {
    process.chdir(cwd);
    if (first && first.exitCode === null && first.signalCode === null) first.kill();
  }
});

// A bsk stand-in run as node <file>: 'status' never answers, 'daemon' records its pid and runs until
// killed. A real named pipe stands for the live daemon's IPC, with a daemon.json naming it.
async function busyDaemon(t, { listening, listPipes }) {
  const work = tempDir('fsw-keeper-busy-');
  writeFileSync(join(work, 'status'), 'setInterval(() => {}, 1000);\n');
  writeFileSync(join(work, 'daemon'), "require('node:fs').appendFileSync('pids', process.pid + '\\n');\nsetInterval(() => {}, 1000);\n");
  const sock = '\\\\.\\pipe\\fsw-test-bsk-' + process.pid + '-' + Date.now();
  writeFileSync(join(work, 'daemon.json'), JSON.stringify({ pid: 4242, sock_path: sock }));
  if (listening) {
    const server = createServer();
    await new Promise((resolve) => server.listen(sock, resolve));
    t.after(() => server.close());
  }
  const cwd = process.cwd();
  process.chdir(work);
  t.after(() => {
    process.chdir(cwd);
    const pids = existsSync(join(work, 'pids')) ? readFileSync(join(work, 'pids'), 'utf8').split(/\s+/).filter(Boolean).map(Number) : [];
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {}
    }
  });
  const status = (o) => bskStatus({ ...o, bin: process.execPath, timeoutMs: 1000, home: work, ...(listPipes ? { listPipes } : {}) });
  const keeper = createBrowserKeeper({ instance: { config: {}, paths: { logs: work } }, bin: process.execPath, status, notify: async () => ({ written: false }), settleMs: 200 });
  return { work, keeper };
}

test('a status read that times out while the daemon pipe listens keeps that daemon and starts no second one', async (t) => {
  const { work, keeper } = await busyDaemon(t, { listening: true });
  const r = await keeper.check();
  assert.equal(existsSync(join(work, 'pids')), false, 'no second daemon was started');
  assert.equal(keeper.child, null);
  assert.equal(r.status, 'daemon busy');
  assert.equal(r.pid, 4242);
  assert.match(r.detail, /did not answer within 1000 ms/);
});

test('a status read that times out with a stale daemon.json and no pipe still starts a daemon', async (t) => {
  const { work, keeper } = await busyDaemon(t, { listening: false });
  const r = await keeper.check();
  assert.equal(r.status, 'daemon start failed');
  assert.match(r.detail, /did not answer within 1000 ms/, 'the timeout is reported as a timeout');
  assert.equal(readFileSync(join(work, 'pids'), 'utf8').trim().split(/\s+/).length, 1);
});

test('a pipe listing that throws after a status timeout reads as unknown, starts a daemon as before and says why', async (t) => {
  const listPipes = () => {
    throw Object.assign(new Error('pipe listing refused'), { code: 'EPERM' });
  };
  const { work, keeper } = await busyDaemon(t, { listening: false, listPipes });
  const r = await keeper.check();
  assert.equal(readFileSync(join(work, 'pids'), 'utf8').trim().split(/\s+/).length, 1, 'a daemon was started as before');
  assert.equal(r.status, 'daemon start failed');
  assert.match(r.liveness, /could not be listed \(EPERM pipe listing refused\).*unknown/);
  assert.match(r.detail, /did not answer within 1000 ms; the daemon pipe could not be listed/);
});

test('a corrupt daemon.json after a status timeout is named in the result, and a daemon starts as before', async (t) => {
  const { work, keeper } = await busyDaemon(t, { listening: false });
  writeFileSync(join(work, 'daemon.json'), '{"pid": 4242, "sock_pa');
  const r = await keeper.check();
  assert.equal(readFileSync(join(work, 'pids'), 'utf8').trim().split(/\s+/).length, 1, 'a daemon was started as before');
  assert.match(r.liveness, /daemon\.json could not be read \(.*JSON.*\)/);
  assert.match(r.detail, /did not answer within 1000 ms; .*daemon\.json could not be read/);
});

test('a daemon that cannot be spawned is reported with its cause and does not end the supervisor', async () => {
  const work = tempDir('fsw-keeper-spawn-');
  const keeper = createBrowserKeeper({ instance: { config: {}, paths: { logs: work } }, bin: join(work, 'no-such-bsk.exe'), status: async () => ({ daemon: false }), notify: async () => ({ written: false }), settleMs: 200 });
  const r = await keeper.check();
  assert.equal(r.status, 'daemon start failed');
  assert.equal(r.code, 'ENOENT');
  assert.match(r.detail, /bsk daemon start failed: .*ENOENT/);
  assert.equal(keeper.child, null);
  keeper.stop();
});

