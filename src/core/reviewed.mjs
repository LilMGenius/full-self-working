// The bytes a delivery's review read and its approval covered. src/work/review.mjs hashes the reviewed files,
// src/outbox/resolve.mjs refuses a passed delivery whose reviewed files changed (unless the operator states a
// reason) and stamps the hash of the files it approves, and src/outbox/drain.mjs sends only those bytes. It lives in
// core because both the work and the outbox modules read it, and core is the one module every other may import
// (scripts/check-imports.mjs, docs/DESIGN.md).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// A missing file hashes as missing, so a deleted file reads as a change rather than an error.
const digest = (file) => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'missing');

// pairs: [name, path the bytes are read from], hashed by name and bytes in name order.
function hashPairs(pairs) {
  const h = createHash('sha256');
  for (const [name, path] of [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) h.update(name + '\0' + digest(path) + '\n');
  return h.digest('hex');
}

// files: paths relative to dir, hashed by name and bytes.
export const hashTree = (dir, files) => hashPairs(files.map((f) => [f, join(dir, f)]));

// files: the delivery's own paths (payload.files), as the approval stamps them.
export const filesHash = (files) => hashTree('', files);

// The same hash over copies of the delivery's files: copies[i] holds the bytes of files[i] (the drain's frozen send
// folder), so it equals filesHash(files) exactly when the copies hold the bytes the files held.
export const copiesHash = (files, copies) => hashPairs(files.map((f, i) => [f, copies[i]]));

// The delivery against its review: changed when a reviewed file is gone or its bytes differ from the reviewed hash
// (a review without its file list cannot be checked and counts as changed); unreviewed lists the delivery files the
// review never read, such as files an operator step added after the run.
export function reviewDrift(review, files) {
  if (!Array.isArray(review?.reviewed) || !review.work) return { changed: true, unreviewed: [...files] };
  const seen = new Set(review.reviewed.map((f) => resolve(review.work, f)));
  return { changed: hashTree(review.work, review.reviewed) !== review.hash, unreviewed: files.filter((f) => !seen.has(resolve(f))) };
}
