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

// files: paths relative to dir, hashed by name and bytes.
export function hashTree(dir, files) {
  const h = createHash('sha256');
  for (const f of [...files].sort()) h.update(f + '\0' + digest(join(dir, f)) + '\n');
  return h.digest('hex');
}

// files: the delivery's own paths (payload.files), as the drain sends them.
export const filesHash = (files) => hashTree('', files);

// The delivery against its review: changed when a reviewed file is gone or its bytes differ from the reviewed hash
// (a review without its file list cannot be checked and counts as changed); unreviewed lists the delivery files the
// review never read, such as files an operator step added after the run.
export function reviewDrift(review, files) {
  if (!Array.isArray(review?.reviewed) || !review.work) return { changed: true, unreviewed: [...files] };
  const seen = new Set(review.reviewed.map((f) => resolve(review.work, f)));
  return { changed: hashTree(review.work, review.reviewed) !== review.hash, unreviewed: files.filter((f) => !seen.has(resolve(f))) };
}
