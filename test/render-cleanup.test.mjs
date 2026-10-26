// The render profile cleanup: a finished render is never failed by its temp folder, the browser tree is
// ended and awaited before the folder goes, and leftovers are removed on a later start. The remover, the
// process list and the killer are injected, so nothing here depends on how loaded the machine is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseProfile, sweepLeftovers } from '../src/render/html2png.mjs';
import { tempDir } from './tmp.mjs';

const PROFILE = 'C:/tmp/fsw-render-AbC123';
const eperm = () => Object.assign(new Error("EPERM, Permission denied: '" + PROFILE + "'"), { code: 'EPERM' });
const noWait = async () => {};

// A remover that fails while the log says a process still holds the folder, and a list that drains.
function scene(lists) {
  const log = [];
  let held = true;
  return {
    log,
    remove: () => {
      if (held) {
        log.push('remove:fail');
        throw eperm();
      }
      log.push('remove:ok');
    },
    processes: async () => {
      const list = lists.shift() ?? [];
      held = list.length > 0;
      log.push('list:' + list.map((p) => p.pid).join(','));
      return list;
    },
    kill: async (pid) => log.push('kill:' + pid),
  };
}
const child = (pid, type) => ({ pid, commandLine: 'chrome.exe --type=' + type + ' --user-data-dir=' + PROFILE });

test('a folder held after the browser exited is removed only once every process naming it is gone', async () => {
  const s = scene([[child(7, 'gpu-process'), child(8, 'crashpad-handler'), { pid: 9, commandLine: 'chrome.exe --user-data-dir=C:/tmp/fsw-render-Other1' }], [child(8, 'crashpad-handler')], []]);
  const r = await releaseProfile(PROFILE, { proc: { pid: 1, exitCode: 0, signalCode: null }, ...s, wait: noWait });
  assert.deepEqual(r, { removed: true, profile: PROFILE, ended: [7, 8] });
  // pid 9 holds another renderer's folder and is left alone.
  assert.deepEqual(s.log, ['remove:fail', 'list:7,8,9', 'kill:7', 'kill:8', 'list:8', 'list:', 'remove:ok']);
});

test('a browser that did not exit is ended with its whole tree before its folder is removed', async () => {
  const log = [];
  const proc = { pid: 42, exitCode: null, signalCode: null };
  const r = await releaseProfile(PROFILE, {
    proc,
    kill: async (pid) => {
      log.push('kill:' + pid);
      proc.exitCode = 1;
    },
    remove: () => log.push('remove:' + (proc.exitCode === null ? 'while alive' : 'after exit')),
    processes: async () => assert.fail('no process list is needed when the folder goes at once'),
    wait: noWait,
  });
  assert.equal(r.removed, true);
  assert.deepEqual(log, ['kill:42', 'remove:after exit']);
});

test('a folder that cannot be removed is returned with its cause instead of thrown', async () => {
  const always = () => {
    throw eperm();
  };
  const stuck = await releaseProfile(PROFILE, { remove: always, processes: async () => [child(7, 'utility')], kill: noWait, wait: noWait, treeWaitMs: 1000, pollMs: 250 });
  assert.equal(stuck.removed, false);
  assert.equal(stuck.profile, PROFILE);
  assert.match(stuck.error, /^EPERM .*; still held by pid 7$/);
  const blind = await releaseProfile(PROFILE, { remove: always, processes: async () => { throw new Error('powershell not found'); }, kill: noWait, wait: noWait });
  assert.equal(blind.removed, false);
  assert.match(blind.error, /^EPERM .*; powershell not found$/);
});


test('the tree wait ends at its deadline however slow the process list is', async () => {
  const always = () => {
    throw eperm();
  };
  const slow = (ms, list) => async ({ timeoutMs } = {}) => {
    calls.push(timeoutMs);
    // unref: a list left hanging past the deadline must not keep the test process alive.
    await new Promise((r) => setTimeout(r, ms).unref());
    return list;
  };
  let calls = [];
  // A list that answers in 300 ms and always names the folder: the old loop counted only the pauses, so it
  // ran about nine lists (some 4,900 ms) for a 2,000 ms wait.
  let t0 = Date.now();
  const held = await releaseProfile(PROFILE, { remove: always, processes: slow(300, [child(7, 'utility')]), kill: async () => {}, wait: (ms) => new Promise((r) => setTimeout(r, ms)), treeWaitMs: 2000, pollMs: 250 });
  const heldMs = Date.now() - t0;
  assert.equal(held.removed, false);
  assert.ok(heldMs < 2000 + 300 + 1600, 'the wait took ' + heldMs + ' ms for a 2,000 ms deadline');
  assert.ok(calls.every((ms) => ms > 0 && ms <= 2000), 'each list gets at most the time left: ' + calls.join(', '));
  // A list that never answers is cut off at the deadline and reported, and a kill that hangs does not hold it.
  calls = [];
  t0 = Date.now();
  const stuck = await releaseProfile(PROFILE, { remove: always, processes: slow(60_000, []), kill: () => new Promise(() => {}), wait: noWait, treeWaitMs: 500 });
  const stuckMs = Date.now() - t0;
  assert.ok(stuckMs < 1500, 'a list that never answers held the wait ' + stuckMs + ' ms');
  assert.match(stuck.error, /the process list did not answer within \d+ ms/);
  t0 = Date.now();
  const hung = await releaseProfile(PROFILE, { remove: always, processes: async () => [child(7, 'utility')], kill: () => new Promise(() => {}), wait: noWait, treeWaitMs: 500 });
  assert.ok(Date.now() - t0 < 1500, 'a kill that never returns held the wait ' + (Date.now() - t0) + ' ms');
  assert.match(hung.error, /still held by pid 7/);
});

test('the sweep removes old render folders no process names and keeps fresh, held and unrelated ones', async () => {
  const dir = tempDir('fsw-sweep-');
  const now = Date.now();
  const make = (name, ageMs) => {
    const p = join(dir, name);
    mkdirSync(p);
    writeFileSync(join(p, 'DIPS-wal'), 'x');
    utimesSync(p, (now - ageMs) / 1000, (now - ageMs) / 1000);
    return p;
  };
  const gone = make('fsw-render-gone01', 3_600_000);
  const held = make('fsw-render-held01', 3_600_000);
  const fresh = make('fsw-render-fresh1', 60_000);
  const other = make('chrome_scratch', 3_600_000);
  const lists = [];
  const processes = async () => (lists.push(1), [{ pid: 5, commandLine: 'chrome.exe --user-data-dir=' + held }]);
  const removed = [];
  const remove = (p) => removed.push(p);
  assert.deepEqual(await sweepLeftovers({ dir, processes, remove, now }), { removed: [gone], kept: [held], failed: [] });
  assert.deepEqual(removed, [gone]);
  const failing = await sweepLeftovers({ dir, processes, remove: () => { throw eperm(); }, now });
  assert.deepEqual(failing.failed, [{ profile: gone, removed: false, error: 'EPERM ' + eperm().message }]);
  const young = tempDir('fsw-sweep-');
  mkdirSync(join(young, 'fsw-render-young1'));
  assert.deepEqual(await sweepLeftovers({ dir: young, processes: async () => assert.fail('no candidate, no process list'), remove, now }), { removed: [], kept: [], failed: [] });
  assert.equal(lists.length, 2);
  assert.ok([fresh, other].every(existsSync));
});

