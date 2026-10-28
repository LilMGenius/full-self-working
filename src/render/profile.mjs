// The render profile of src/render/html2png.mjs: its DevToolsActivePort, the processes still naming it, ending a
// process tree, the release of the folder and the sweep of folders earlier renderers left behind, with the error
// type and the waits the renderer shares.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export const PROFILE_PREFIX = 'fsw-render-';
// Ending a process tree is a local system call; one that has not answered by then is reported, not awaited.
export const KILL_TIMEOUT_MS = 10000;
// How long a release waits for the processes still naming a profile to go.
export const TREE_WAIT_MS = 20000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const exited = (proc) => proc.exitCode !== null || proc.signalCode !== null;
export const describe = (err) => (err?.code ? err.code + ' ' : '') + (err?.message ?? String(err));
export const removeDir = (dir) => rmSync(dir, { recursive: true, force: true });

// A wait that timed out or a kill that failed during cleanup does not fail the caller, but it is recorded:
// a browser tree that outlives it is a leak, and this warning is where the log shows it began.
export const reportWait = (what, err) => process.emitWarning(what + ': ' + describe(err), { code: 'FSW_RENDER_WAIT' });

// Settles with promise, or rejects once ms pass, so a call that ignores its own timeout cannot outlive a
// deadline either.
export function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RenderError('FSW_RENDER_TIMEOUT', what + ' did not answer within ' + ms + ' ms')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export class RenderError extends Error {
  // detail.cause becomes the standard error cause; every other detail field is copied onto the error.
  constructor(code, message, { cause, ...detail } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    Object.assign(this, detail);
  }
}

// Chrome writes the chosen port and the browser target path to DevToolsActivePort once it listens. Until then the
// file is absent (ENOENT), or Windows reports it busy while Chrome writes it (EBUSY, EPERM): each is "not ready
// yet" and the poll goes on until the deadline; any other read error fails the start with its cause.
const NOT_READY = ['ENOENT', 'EBUSY', 'EPERM'];

export async function readActivePort(profile, proc, timeoutMs, { read = (file) => readFileSync(file, 'utf8') } = {}) {
  const file = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new RenderError('FSW_RENDER_CHROME_EXIT', 'Chrome exited before DevTools came up (exit ' + proc.exitCode + ')');
    let text = null;
    try {
      text = read(file);
      lastError = null;
    } catch (err) {
      if (!NOT_READY.includes(err.code)) throw err;
      lastError = err;
    }
    const [port, path] = String(text ?? '').split(/\r?\n/);
    if (port && path) return { port: Number(port), path };
    await sleep(50);
  }
  // The last read error, when the file was still busy or gone, is the cause: a persistent EPERM says why.
  throw new RenderError('FSW_RENDER_TIMEOUT', 'Chrome did not open DevTools within ' + timeoutMs + ' ms' + (lastError ? ' (last read: ' + lastError.code + ')' : ''), lastError ? { cause: lastError } : {});
}

// Every process that names a Chrome profile folder on its command line, as {pid, commandLine}. Each
// process of a Chrome tree carries the browser's --user-data-dir (read 2026-10-27: the browser,
// crashpad-handler, gpu-process, utility and renderer children), so a folder still names its tree after
// the browser itself exited. Windows has no process list with command lines short of CIM, which costs
// one to three seconds a call, so it runs only when a removal has already failed or leftovers exist, and
// timeoutMs ends the listing process when the caller's time is up.
export function profileProcesses({ timeoutMs = 60000 } = {}) {
  return new Promise((ok, reject) => {
    const done = (parse) => (err, stdout) => {
      if (err) return reject(new RenderError('FSW_RENDER_PROCESSES', 'cannot list processes: ' + err.message));
      try {
        ok(parse(String(stdout)));
      } catch (e) {
        reject(new RenderError('FSW_RENDER_PROCESSES', 'cannot read the process list: ' + e.message));
      }
    };
    const opts = { windowsHide: true, timeout: Math.max(1, Math.round(timeoutMs)), maxBuffer: 32 * 1024 * 1024 };
    if (process.platform === 'win32') {
      const query = "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%--user-data-dir=%'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], opts, done((out) => {
        const text = out.trim();
        return (text ? [].concat(JSON.parse(text)) : []).map((r) => ({ pid: r.ProcessId, commandLine: r.CommandLine ?? '' }));
      }));
    } else {
      execFile('ps', ['-eo', 'pid=,args='], opts, done((out) => out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), commandLine: m[2] }))));
    }
  });
}

// Ends a process and every process it started. taskkill /T finds the children through the parent pid, so
// it reaches the tree only while the browser is alive. A taskkill that runs past timeoutMs is ended.
export function killTree(pid, { timeoutMs = KILL_TIMEOUT_MS } = {}) {
  return new Promise((ok) => {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: Math.max(1, Math.round(timeoutMs)) }, () => ok());
    else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        // ESRCH: the process is already gone. Anything else (EPERM) leaves it running; the error is
        // returned, and the caller's next process list still names the process.
        if (err.code !== 'ESRCH') return ok({ error: err });
      }
      ok();
    }
  });
}

// Removes a renderer's profile once nothing holds it, and returns {removed, profile, error, ended}; it never
// throws, since a leftover temp folder must not fail a render that finished. A browser that has not exited
// is ended with its whole tree. When the removal still fails, a process of the tree outlived the browser
// (crashpad-handler, gpu-process, a utility with an open database journal; 2026-10-26 left GrShaderCache,
// GPUPersistentCache, DIPS-wal and first_party_sets.db-journal), so the processes naming the folder are
// ended and awaited before the folder is removed again. treeWaitMs is a deadline on the clock: every
// process list and kill inside it gets only the time left, so a slow list cannot stretch the wait.
export async function releaseProfile(profile, { proc = null, processes = profileProcesses, kill = killTree, remove = removeDir, wait = sleep, warn = reportWait, exitWaitMs = 5000, treeWaitMs = TREE_WAIT_MS, pollMs = 250 } = {}) {
  if (proc && !exited(proc)) {
    await within(kill(proc.pid, { timeoutMs: KILL_TIMEOUT_MS }), KILL_TIMEOUT_MS, 'taskkill').catch((err) => warn('ending browser pid ' + proc.pid + ' of ' + profile, err));
    const exitBy = Date.now() + exitWaitMs;
    while (!exited(proc) && Date.now() < exitBy) await wait(50);
  }
  let error = null;
  const attempt = () => {
    try {
      remove(profile);
      return true;
    } catch (err) {
      error = err;
      return false;
    }
  };
  if (attempt()) return { removed: true, profile, ended: [] };
  const name = basename(profile);
  const ended = new Set();
  let held = [];
  let listing = null;
  const deadline = Date.now() + treeWaitMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      held = (await within(processes({ timeoutMs: left }), left, 'the process list')).filter((p) => p.commandLine.includes(name));
    } catch (err) {
      listing = err;
      break;
    }
    if (!held.length) break;
    const fresh = held.filter((p) => !ended.has(p.pid));
    for (const p of fresh) ended.add(p.pid);
    const killLeft = deadline - Date.now();
    if (killLeft <= 0) break;
    await within(Promise.all(fresh.map((p) => kill(p.pid, { timeoutMs: Math.min(KILL_TIMEOUT_MS, killLeft) }))), killLeft, 'taskkill').catch((err) => warn('ending pid ' + fresh.map((p) => p.pid).join(', ') + ' holding ' + profile, err));
    const pause = Math.min(pollMs, deadline - Date.now());
    if (pause > 0) await wait(pause);
  }
  if (!held.length) {
    // A handle can close a moment after its process is gone (an indexer or a scanner reading the folder).
    for (let i = 0; i < 3; i++) {
      if (attempt()) return { removed: true, profile, ended: [...ended] };
      if (i < 2) await wait(500);
    }
  }
  const why = [describe(error)];
  if (held.length) why.push('still held by pid ' + held.map((p) => p.pid).join(', '));
  if (listing) why.push(describe(listing));
  return { removed: false, profile, error: why.join('; '), ended: [...ended] };
}

// Profiles earlier renderers left behind (a removal that failed, a process killed mid-render): every
// fsw-render folder in dir older than minAgeMs that no running process names is removed. The age guard
// leaves alone a folder another process has just made and not yet handed to its Chrome. Returns
// {removed, kept, failed: [{profile, error}]}; the process list is read only when there is a candidate.
export async function sweepLeftovers({ dir = tmpdir(), processes = profileProcesses, remove = removeDir, minAgeMs = 10 * 60_000, now = Date.now() } = {}) {
  const out = { removed: [], kept: [], failed: [] };
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(PROFILE_PREFIX))
    .map((d) => d.name)
    .filter((name) => {
      try {
        return now - statSync(join(dir, name)).mtimeMs >= minAgeMs;
      } catch (err) {
        // A folder another start removed between the listing and the stat is gone; any other error is reported.
        if (err.code !== 'ENOENT') out.failed.push({ profile: join(dir, name), removed: false, error: describe(err) });
        return false;
      }
    });
  if (!candidates.length) return out;
  const lines = (await processes()).map((p) => p.commandLine);
  for (const name of candidates) {
    const profile = join(dir, name);
    if (lines.some((l) => l.includes(name))) out.kept.push(profile);
    else {
      try {
        remove(profile);
        out.removed.push(profile);
      } catch (err) {
        out.failed.push({ profile, removed: false, error: describe(err) });
      }
    }
  }
  return out;
}

export const reportLeftover = ({ profile, error }) =>
  process.emitWarning('render profile ' + profile + ' could not be removed (' + error + '); the next renderer start removes it once no process holds it', { code: 'FSW_RENDER_LEFTOVER' });
