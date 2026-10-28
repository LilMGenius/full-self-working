// The send folders of src/outbox/drain.mjs: frozen copies of a delivery's files, their removal and the sweep of
// folders an earlier removal left behind.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copiesHash } from '../core/reviewed.mjs';
import { baseName } from './plan.mjs';

// A delivery uploads copies of its files taken once, before the claim: the surface reads them only later (soomgo
// sets the file input after it opens the chat and types), so uploading the original paths would send whatever they
// hold by then, and the approved hash would have been checked against other bytes. Each copy sits in its own
// numbered folder under its own name, as the platform shows it; a file gone before the copy has none, which hashes
// as missing. The caller removes the folder once the send settles.
const SEND_PREFIX = 'fsw-send-';
export function freeze(files) {
  const dir = mkdtempSync(join(tmpdir(), SEND_PREFIX));
  try {
    const copies = files.map((f, i) => {
      const to = join(dir, String(i), baseName(f));
      mkdirSync(join(dir, String(i)));
      try {
        copyFileSync(f, to);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return to;
    });
    return { dir, copies, hash: copiesHash(files, copies) };
  } catch (err) {
    const left = removeSendDir(dir);
    if (left) err.message += '; the send folder ' + dir + ' stays for a later drain to remove (' + (left.code ?? left.message) + ')';
    throw err;
  }
}

// Removes a send folder, retrying one Windows still reports busy (EBUSY, EPERM while a scanner or an upload holds a
// copy), and returns the error that outlasted the retries, or null: the caller records it, so a failed removal never
// takes the place of a send's result.
export function removeSendDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return null;
  } catch (err) {
    return err;
  }
}

// Send folders a removal left behind (the event send.cleanup_failed names each): a drain removes those older than an
// hour, which no upload takes, judged by the machine's clock that stamped them. One that still resists is a result
// line of every drain until it goes.
const SEND_LEFTOVER_MS = 60 * 60_000;
export function sweepSendLeftovers(out) {
  const root = tmpdir();
  for (const name of readdirSync(root)) {
    if (!name.startsWith(SEND_PREFIX)) continue;
    const dir = join(root, name);
    let age;
    try {
      age = Date.now() - statSync(dir).mtimeMs;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (age < SEND_LEFTOVER_MS) continue;
    const left = removeSendDir(dir);
    if (left) out.push({ id: null, kind: 'delivery', action: 'leftover', reason: 'the send folder ' + dir + ' could not be removed: ' + (left.code ?? left.message) });
  }
}
