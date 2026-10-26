// close() has a ceiling: a browser that answers nothing and survives every kill still lets close return
// once its deadline (grace plus exit wait) is spent, with the waits it gave up on recorded. The real
// headless Chrome is started and its browser process suspended, so Browser.close gets no reply and the
// process never exits; the kill is injected as a no-op and the test ends the tree itself afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { DEFAULT_CHROME, openRenderer, releaseProfile } from '../src/render/html2png.mjs';
import { tempDir } from './tmp.mjs';

const GRACE_MS = 500;
const EXIT_WAIT_MS = 1500;
// A close past its deadline leaves the live browser's folder alone and returns. The slack covers timer
// lag and the warnings around the waits: under two concurrent full suites one close took 4,506 ms
// against grace, exit wait and retries of 3,000 ms. 6507383 never returned here, and running the second
// kill pass again costs 5 s more, so the slack still tells both apart.
const CEILING_MS = GRACE_MS + EXIT_WAIT_MS + 1000 + 3000;

// The browser process of a renderer: the one naming its profile without a --type= child flag.
function browserPid(profile) {
  const name = basename(profile);
  if (process.platform === 'win32') {
    const query = "(Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%" + name + "%'\" | Where-Object { $_.CommandLine -notmatch '--type=' }).ProcessId";
    return Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true }).toString().trim());
  }
  const line = execFileSync('ps', ['-eo', 'pid=,args=']).toString().split('\n').find((l) => l.includes(name) && !l.includes('--type='));
  return Number(line.trim().split(/\s+/)[0]);
}

function suspend(pid) {
  if (process.platform !== 'win32') return process.kill(pid, 'SIGSTOP');
  const script = "Add-Type -Name P -Namespace W -MemberDefinition '[DllImport(\"ntdll.dll\")] public static extern int NtSuspendProcess(IntPtr h);'; exit [W.P]::NtSuspendProcess((Get-Process -Id " + pid + ").Handle)";
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
}

// taskkill /T exits 128 or 255 when a child of the tree exits on its own while the tree is being ended
// (seen under two concurrent suites), so its status proves nothing; the caller awaits the browser's exit.
function endTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else process.kill(pid, 'SIGKILL');
}

// The budget covers the start, the suspension and the cleanup around close: under two concurrent full
// suites the whole test took 72 to 82 s while close itself stayed under 4.6 s.
test('close returns within its deadline when the browser never answers and survives every kill', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed', timeout: 180000 }, async () => {
  const root = tempDir('fsw-renderroot-');
  const warned = [];
  const removals = [];
  const leftovers = [];
  const renderer = await openRenderer({
    tempRoot: root,
    kill: async () => {},
    processes: async () => [],
    remove: (dir) => {
      removals.push(dir);
      rmSync(dir, { recursive: true, force: true });
    },
    onLeftover: (left) => leftovers.push(left),
    warn: (what, err) => warned.push(what + ': ' + err.message),
    closeGraceMs: GRACE_MS,
    exitWaitMs: EXIT_WAIT_MS,
  });
  const pid = browserPid(renderer.profile);
  assert.ok(pid > 0, 'the browser process of ' + renderer.profile + ' was found');
  let elapsed;
  let closed;
  try {
    suspend(pid);
    const t0 = Date.now();
    // A close that never returns is cut off here so the test can still clean up.
    closed = await Promise.race([renderer.close(), new Promise((r) => setTimeout(r, CEILING_MS * 4).unref())]);
    elapsed = Date.now() - t0;
  } finally {
    endTree(pid);
    await renderer.exited;
  }
  assert.ok(closed && elapsed < CEILING_MS, 'close took ' + elapsed + ' ms against a ' + CEILING_MS + ' ms ceiling' + (closed ? '' : ' and never returned'));
  assert.ok(warned.some((w) => /^closing browser pid \d+ of .*: the browser exit did not answer within \d+ ms$/.test(w)), warned.join(' | '));
  // The live browser's profile is left alone, and the leftover names the pid instead of a bare EPERM.
  assert.equal(closed.removed, false);
  assert.match(closed.error, /^browser pid \d+ did not exit within the close deadline/);
  assert.deepEqual(removals, [], 'close removed nothing while the browser was alive');
  assert.deepEqual(leftovers.map((l) => l.error), [closed.error]);
  assert.equal((await releaseProfile(renderer.profile)).removed, true);
  assert.equal(existsSync(renderer.profile), false);
});

