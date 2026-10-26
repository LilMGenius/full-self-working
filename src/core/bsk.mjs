// bsk status --json, shared by the supervisor's browser keeper and fsw doctor (moved from
// src/supervisor/keepalive.mjs:54-76 at 2c77326, so doctor reads it without importing the supervisor).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const BSK_BIN = process.env.FSW_BSK ?? join(homedir(), '.local', 'bin', 'bsk.exe');
export const BSK_HOME = join(homedir(), '.bsk');

const PIPE_DIR = '\\\\.\\pipe\\';

// Whether a daemon serves the socket ~/.bsk/daemon.json names: the daemon writes that record when it
// starts and serves its IPC on a named pipe (a socket file off Windows) only while it lives, so a stale
// record of a dead daemon, or a reused pid, has no pipe behind it. Listing the pipes costs under a
// millisecond where bsk status --json took 5 s on an idle daemon (2026-10-27).
// It answers {listening, pid, sock} or {listening: false, note}: a pipe listing that throws runs inside
// bsk status's callback, where an uncaught error would end the supervisor, so it reads as unknown with
// its cause in note, and the keeper starts a daemon as it did before this check existed.
export function bskListening({ home = BSK_HOME, listPipes = () => readdirSync(PIPE_DIR) } = {}) {
  let record;
  try {
    record = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8'));
  } catch (err) {
    // A missing record is the normal state with no daemon; one that does not parse is named, though
    // both start a daemon as before.
    if (err.code === 'ENOENT') return { listening: false, note: null };
    return { listening: false, note: join(home, 'daemon.json') + ' could not be read (' + (err.code ? err.code + ' ' : '') + err.message + '), so whether a daemon lives is unknown and a daemon is started as before' };
  }
  const sock = typeof record.sock_path === 'string' ? record.sock_path : null;
  if (!sock) return { listening: false, note: null };
  let listening;
  try {
    listening = sock.startsWith(PIPE_DIR) ? listPipes().includes(sock.slice(PIPE_DIR.length)) : existsSync(sock);
  } catch (err) {
    return { listening: false, note: 'the daemon pipe could not be listed (' + (err.code ? err.code + ' ' : '') + err.message + '), so whether a daemon lives is unknown and a daemon is started as before' };
  }
  return listening ? { listening: true, pid: record.pid ?? null, sock: basename(sock) } : { listening: false, note: null };
}

// bsk status --json with auto start off. No daemon answering is a normal state and comes back as
// {daemon: false}; output that is not the status shape throws, since nothing can be read from it.
// A read that gets no status while the daemon's pipe is listening is a busy daemon, {daemon: false,
// busy: true}: under load the read timed out at 2026-10-26T17:20Z, the keeper took it for a missing
// daemon and started a second one, which lost the bsk lock and exited.
export function bskStatus({ bin = BSK_BIN, timeoutMs = 20_000, home = BSK_HOME, listPipes } = {}) {
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
      if (error) {
        const timedOut = error.killed === true;
        const detail = timedOut ? 'bsk status did not answer within ' + timeoutMs + ' ms' : String(stderr || stdout).trim().slice(0, 300);
        const live = bskListening({ home, ...(listPipes ? { listPipes } : {}) });
        if (live.listening) return resolve({ daemon: false, busy: true, pid: live.pid, timedOut, exitCode: error.code ?? null, detail: 'daemon pid ' + live.pid + ' is listening on ' + live.sock + ' but ' + (timedOut ? detail : 'bsk status failed: ' + detail) });
        return resolve({ daemon: false, timedOut, exitCode: error.code ?? null, detail: live.note ? detail + '; ' + live.note : detail, ...(live.note ? { liveness: live.note } : {}) });
      }
      reject(Object.assign(new Error('bsk status printed no status object'), { code: 'FSW_BSK_STATUS' }));
    });
  });
}

