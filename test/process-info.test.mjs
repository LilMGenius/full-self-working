// processInfo in src/supervisor/lock.mjs when powershell.exe cannot be read: the 2c77326 tasklist rule
// decides, with no start time, and acquireLock answers instead of throwing. exec is a recording stand-in;
// the pid is this test's own process, which process.kill(pid, 0) finds alive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireLock, pidAlive, processInfo } from '../src/supervisor/lock.mjs';
import { tempDir } from './tmp.mjs';

const pid = process.pid;
const failing = () => {
  throw new Error('spawnSync powershell.exe ETIMEDOUT');
};
const exec = (tasklist) => (file, args) => (file === 'powershell.exe' ? failing() : tasklist(args));
const csv = (image, p = pid) => '"' + image + '","' + p + '","Console","1","50,000 K"\r\n';

test('a failed powershell read falls back to tasklist: node.exe is node, another image is not, and nothing answering is unknown', { skip: process.platform !== 'win32' }, () => {
  assert.deepEqual(processInfo(pid, exec(() => csv('node.exe'))), { image: 'node.exe', startedAt: null });
  assert.deepEqual(processInfo(pid, exec(() => csv('chrome.exe'))), { image: 'chrome.exe', startedAt: null });
  assert.equal(processInfo(pid, exec(() => 'INFO: No tasks are running which match the specified criteria.\r\n')), null);
  assert.deepEqual(processInfo(pid, exec(failing)), { image: null, startedAt: null });
});

test('pidAlive and acquireLock answer through a failed powershell read instead of throwing', { skip: process.platform !== 'win32' }, () => {
  const read = (p) => processInfo(p, exec(() => csv('node.exe', p)));
  assert.equal(pidAlive(pid, '2026-10-26T00:00:00.000Z', read), true);
  assert.equal(pidAlive(pid, null, (p) => processInfo(p, exec(() => csv('chrome.exe', p)))), false);
  const instance = { dir: tempDir('fsw-procinfo-') };
  assert.deepEqual(acquireLock(instance, { pid, processInfo: read }), { acquired: true, pid, tookOverFrom: null });
  assert.deepEqual(acquireLock(instance, { pid: pid + 1, processInfo: read }), { acquired: false, heldBy: pid });
});
