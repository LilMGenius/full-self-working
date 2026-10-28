// The supervisor's pid lock under <instance>/run (docs/DESIGN.md, Scheduling): one process per instance drains
// the outbox, so fsw run and fsw tick share it, and the read of whether its holder still lives.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const runDir = (instance) => join(instance.dir, 'run');
const lockFile = (instance) => join(runDir(instance), 'supervisor.pid');

// The process holding pid now: {image, startedAt} or null when none does. On Windows the image is the
// process name (node) and startedAt its start time as Windows reports it, '' when Windows will not say
// (another user's elevated process); elsewhere only process.kill(pid, 0) answers, so both are null.
// A powershell.exe read that fails (a missing or blocked shell, a timeout) gives no start time, and the
// image comes from tasklist, the 2c77326 rule; if that fails too the image is unknown (null), which
// pidAlive counts as live, so acquireLock answers already running rather than taking a lock a live
// supervisor may hold. exec is execFileSync, passed by tests.
export function processInfo(pid, exec = execFileSync) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return null;
  }
  if (process.platform !== 'win32') return { image: null, startedAt: null };
  const script = '$p = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue; if ($p) { $p.ProcessName + "|" + $(if ($p.StartTime) { $p.StartTime.ToUniversalTime().ToString("o") } else { "" }) }';
  let out;
  try {
    out = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return imageFromTasklist(pid, exec);
  }
  if (!out) return null;
  const [image, startedAt] = out.split('|');
  return { image, startedAt: startedAt || null };
}

function imageFromTasklist(pid, exec) {
  let out;
  try {
    out = exec('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  } catch {
    return { image: null, startedAt: null };
  }
  const m = /^"([^"]+)","(\d+)"/m.exec(String(out));
  return m && Number(m[2]) === pid ? { image: m[1], startedAt: null } : null;
}

// A lock holder is live while a node process holds its pid. Windows recycles pids quickly and this
// machine runs many node processes, so a lock that recorded its holder's start time is live only while
// the process on that pid has that start time; a lock without one (written by the 2c77326 code) keeps the
// node rule. A part the reader cannot tell (null) is not checked.
export function pidAlive(pid, startedAt = null, read = processInfo) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const info = read(pid);
  if (!info) return false;
  if (info.image != null && !/^node(\.exe)?$/i.test(info.image)) return false;
  return !startedAt || info.startedAt == null || info.startedAt === startedAt;
}

// The lock file is the pid on its first line, then the holder's start time when known. The 2c77326
// readLock parses the file with Number.parseInt, which still reads the pid from the first line.
const parseLock = (text) => {
  const [first, second] = String(text).split(/\r?\n/);
  const pid = Number.parseInt(first, 10);
  return { pid: Number.isInteger(pid) ? pid : null, startedAt: second?.trim() || null };
};

export function readLock(instance) {
  const file = lockFile(instance);
  if (!existsSync(file)) return null;
  return { file, ...parseLock(readFileSync(file, 'utf8')) };
}

const LOCK_FS = { openSync, writeFileSync, closeSync, readFileSync, renameSync, linkSync, unlinkSync };

const holderIn = (fs, file) => {
  try {
    return parseLock(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
};

// Takes the lock for pid, or reports who holds it. A lock whose pid is not alive is stale and taken over:
// the stale file is renamed to a name only this pid uses, so of two contenders that read the same dead pid
// only one moves that file. The one whose renamed file turns out to hold another pid (a contender already
// took the lock between the read and the rename) links it back, which fails rather than overwrite a newer
// lock, and tries again. Every lock is then created exclusively. fs is injectable so a test can interleave
// two contenders, and processInfo so a test needs no real process.
export function acquireLock(instance, { pid = process.pid, processInfo: read = processInfo, alive = (p, startedAt) => pidAlive(p, startedAt, read), fs = LOCK_FS } = {}) {
  const file = lockFile(instance);
  mkdirSync(runDir(instance), { recursive: true });
  const aside = file + '.' + pid + '.stale';
  const startedAt = read(pid)?.startedAt ?? null;
  let stale = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, pid + '\n' + (startedAt ? startedAt + '\n' : ''));
      fs.closeSync(fd);
      return { acquired: true, pid, tookOverFrom: stale };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const held = holderIn(fs, file);
    if (held === undefined) continue;
    if (held.pid === pid) return { acquired: true, pid, tookOverFrom: null };
    if (held.pid && alive(held.pid, held.startedAt)) return { acquired: false, heldBy: held.pid };
    try {
      fs.renameSync(file, aside);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    const moved = holderIn(fs, aside);
    if (moved?.pid === held.pid && moved.startedAt === held.startedAt) {
      fs.unlinkSync(aside);
      stale = held.pid;
      continue;
    }
    try {
      fs.linkSync(aside, file);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    fs.unlinkSync(aside);
  }
  return { acquired: false, heldBy: holderIn(fs, file)?.pid ?? null };
}

export function releaseLock(instance, pid = process.pid) {
  const held = readLock(instance);
  if (held?.pid === pid) unlinkSync(held.file);
}
