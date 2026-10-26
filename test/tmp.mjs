// One temp-directory maker for tests: every directory it makes is removed when the test process exits,
// so a file-level fixture, a helper called from several tests and a test that throws all clean up alike.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];

process.on('exit', () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
