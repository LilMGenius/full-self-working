// What keeps the supervisor's machine and browser usable around the clock (docs/DESIGN.md, Scheduling):
// a child PowerShell holding a Windows execution-state request so the machine does not idle into
// sleep, and a keeper for the BrowserSkill daemon the adapters drive Chrome through.
import { spawn, execFile } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dayKey } from '../core/clock.mjs';
import { ensureDir } from '../core/instance.mjs';
import { notifyOperator } from '../core/notify.mjs';

// SetThreadExecutionState(ES_CONTINUOUS 0x80000000 | ES_SYSTEM_REQUIRED 0x1) holds for as long as the
// calling thread lives; ES_DISPLAY_REQUIRED is left out so the display may still sleep. The child polls
// its parent every 5 seconds and exits when the parent is gone, so a hard-killed supervisor leaves no
// request behind for longer than one poll.
const HOLD_SCRIPT = [
  "$k = Add-Type -Name Power -Namespace Fsw -PassThru -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
  'if ($k::SetThreadExecutionState([uint32]2147483649) -eq 0) { [Console]::Out.WriteLine("refused"); exit 3 }',
  '[Console]::Out.WriteLine("held")',
  'while (Get-Process -Id ([int]$env:FSW_PARENT_PID) -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }',
].join('; ');

// Resolves once the child reports "held"; rejects when it refuses or exits first.
export function holdAwake({ timeoutMs = 30_000 } = {}) {
  if (process.platform !== 'win32') return Promise.reject(Object.assign(new Error('sleep prevention is built for Windows only'), { code: 'FSW_KEEPALIVE_PLATFORM' }));
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', HOLD_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, FSW_PARENT_PID: String(process.pid) },
  });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => fail(new Error('the execution-state child did not report within ' + timeoutMs + ' ms')), timeoutMs);
    const fail = (e) => {
      clearTimeout(timer);
      child.kill();
      reject(Object.assign(e, { code: e.code ?? 'FSW_KEEPALIVE', stderr: err.trim() }));
    };
    child.stderr.on('data', (d) => (err += d));
    child.on('error', fail);
    child.on('exit', (code) => fail(new Error('the execution-state child exited with ' + code + ' before holding')));
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('refused')) return fail(new Error('SetThreadExecutionState refused the request'));
      if (!out.includes('held')) return;
      clearTimeout(timer);
      child.removeAllListeners('exit');
      resolve({ pid: child.pid, child, stop: () => (child.exitCode === null ? child.kill() : false) });
    });
  });
}

export const BSK_BIN = process.env.FSW_BSK ?? join(homedir(), '.local', 'bin', 'bsk.exe');

// bsk status --json with auto start off. No daemon answering is a normal state and comes back as
// {daemon: false}; output that is not the status shape throws, since nothing can be read from it.
export function bskStatus({ bin = BSK_BIN, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['status', '--json'], { env: { ...process.env, BSK_AUTO_START: '0' }, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') return reject(Object.assign(new Error('bsk not found at ' + bin), { code: 'FSW_BSK_MISSING' }));
      let status = null;
      try {
        status = JSON.parse(stdout);
      } catch {
        status = null;
      }
      if (!error && status && Array.isArray(status.browsers)) {
        const connected = status.browsers.filter((b) => !b.unresponsive);
        return resolve({ daemon: true, pid: status.pid, version: status.daemon_version, browsers: connected.length, unresponsive: status.browsers.length - connected.length });
      }
      if (error) return resolve({ daemon: false, exitCode: error.code ?? null, detail: String(stderr || stdout).trim().slice(0, 300) });
      reject(Object.assign(new Error('bsk status printed no status object'), { code: 'FSW_BSK_STATUS' }));
    });
  });
}

// The keeper owns a foreground daemon child when it had to start one: this host's Job Object rules
// refuse a detached start, so the daemon lives as long as the supervisor. With canStart false (a
// one-shot tick) it only reports.
export function createBrowserKeeper({ instance, canStart = true, bin = BSK_BIN, status = bskStatus, notify = notifyOperator, settleMs = 5000 } = {}) {
  let daemon = null;
  const startDaemon = () => {
    const logFile = join(ensureDir(instance.paths.logs), 'bsk-daemon.log');
    const fd = openSync(logFile, 'a');
    try {
      daemon = spawn(bin, ['daemon', 'start', '--foreground'], { stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, BSK_AUTO_START: '0' } });
    } finally {
      closeSync(fd);
    }
    daemon.on('exit', () => (daemon = null));
    return daemon.pid;
  };
  return {
    get child() {
      return daemon;
    },
    async check(now = new Date()) {
      let s = await status({ bin });
      let started = null;
      if (!s.daemon) {
        if (!canStart) return { status: 'no daemon', ...s, started: null };
        started = startDaemon();
        await new Promise((r) => setTimeout(r, settleMs));
        s = await status({ bin });
        if (!s.daemon) return { status: 'daemon start failed', ...s, started };
      }
      if (s.browsers > 0) return { status: started ? 'daemon started' : 'daemon answering', ...s, started };
      const notified = await notify(instance, {
        kind: 'browser',
        title: 'BrowserSkill has no browser connected',
        body: 'Open Chrome with the BrowserSkill extension enabled; the platform pipelines wait for it.',
        dedupeKey: 'bsk-browser:' + dayKey(now),
      });
      return { status: 'no browser', ...s, started, notified: notified.written };
    },
    stop() {
      if (daemon && daemon.exitCode === null) daemon.kill();
    },
  };
}
