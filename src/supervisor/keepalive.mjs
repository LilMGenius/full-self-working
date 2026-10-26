// What keeps the supervisor's machine and browser usable around the clock (docs/DESIGN.md, Scheduling):
// a child PowerShell holding a Windows execution-state request so the machine does not idle into
// sleep, and a keeper for the BrowserSkill daemon the adapters drive Chrome through.
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { BSK_BIN, bskStatus } from '../core/bsk.mjs';
import { dayKey } from '../core/clock.mjs';
import { ensureDir } from '../core/instance.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { chromeName } from '../core/settings.mjs';

export { BSK_BIN, bskStatus };

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
      // stop() also lets go of the child's pipes and handle, so a child that outlives its kill does not
      // hold the supervisor's event loop open after it returned.
      resolve({
        pid: child.pid,
        child,
        stop: () => {
          const killed = child.exitCode === null ? child.kill() : false;
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          return killed;
        },
      });
    });
  });
}

// The keeper owns a foreground daemon child when it had to start one: this host's Job Object rules
// refuse a detached start, so the daemon lives as long as the supervisor. With canStart false (a
// one-shot tick) it only reports.
// It keeps every child it started until that child exits, since a status read that times out under load
// starts a second daemon that loses the bsk lock and exits at once; when the keeper held only the newest
// child, that exit dropped the live daemon, stop() ended nothing and the daemon's handle kept the
// supervisor alive after it said it was exiting for a restart (2026-10-26, pid 26920). Each supervisor
// ends its daemons on the way out and the next one starts its own, as every handover did before.
export function createBrowserKeeper({ instance, canStart = true, bin = BSK_BIN, status = bskStatus, notify = notifyOperator, settleMs = 5000 } = {}) {
  const daemons = new Set();
  const startDaemon = () => {
    const logFile = join(ensureDir(instance.paths.logs), 'bsk-daemon.log');
    const fd = openSync(logFile, 'a');
    let child;
    try {
      child = spawn(bin, ['daemon', 'start', '--foreground'], { stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, BSK_AUTO_START: '0' } });
    } finally {
      closeSync(fd);
    }
    daemons.add(child);
    child.on('exit', () => daemons.delete(child));
    return child.pid;
  };
  return {
    get child() {
      return [...daemons].at(-1) ?? null;
    },
    async check(now = new Date()) {
      let s = await status({ bin });
      let started = null;
      // A busy daemon is kept and reported: a second start against it only loses the bsk lock.
      if (!s.daemon && s.busy) return { status: 'daemon busy', ...s, started: null };
      if (!s.daemon) {
        if (!canStart) return { status: 'no daemon', ...s, started: null };
        started = startDaemon();
        await new Promise((r) => setTimeout(r, settleMs));
        s = await status({ bin });
        if (!s.daemon) return { status: s.busy ? 'daemon busy' : 'daemon start failed', ...s, started };
      }
      if (s.browsers > 0) return { status: started ? 'daemon started' : 'daemon answering', ...s, started };
      const notified = await notify(instance, {
        kind: 'browser',
        title: 'BrowserSkill has no browser connected',
        body: 'Open ' + chromeName(instance.config) + ' with the BrowserSkill extension enabled; the platform pipelines wait for it.',
        dedupeKey: 'bsk-browser:' + dayKey(now),
      });
      return { status: 'no browser', ...s, started, notified: notified.written };
    },
    stop() {
      for (const child of daemons) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        child.unref();
      }
    },
  };
}
