// bsk status --json, shared by the supervisor's browser keeper and fsw doctor (moved from
// src/supervisor/keepalive.mjs:54-76 at 2c77326, so doctor reads it without importing the supervisor).
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

