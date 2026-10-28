// The proof a surface needs before it writes to a page (003 Surface, wp9): minted by the outbox drain for one
// row after authorize said send (or the operator approved it), as {key, digest, mac} over the row's key and
// the exact text the drain sends (operator.finalText ?? payload.text). The key names the platform, thread and
// kind (outboxKey), so a token for one row cannot send to another thread or as another kind, and an edit after
// minting fails the digest. The secret lives only in this process, so tokens do not outlive the drain that
// minted them. The amount and the files are held by the drain's key recheck (rowKey in src/outbox/plan.mjs).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = randomBytes(32);
const digestOf = (text) => createHash('sha256').update(String(text ?? '')).digest('hex');
const sign = (key, digest) => createHmac('sha256', SECRET).update(key + '\0' + digest).digest('hex');

export function mintAuthorization(row, text) {
  const digest = digestOf(text);
  return Object.freeze({ key: row.key, digest, mac: sign(row.key, digest) });
}

// null when the token authorizes this text for a row of this platform, thread and one of these kinds;
// otherwise the reason it does not.
export function verifyAuthorization(token, { platform, ref, kinds, text }) {
  if (!token || typeof token.key !== 'string' || typeof token.digest !== 'string' || typeof token.mac !== 'string') return 'missing authorization';
  if (!kinds.some((kind) => token.key.startsWith(platform + ':' + ref + ':' + kind + ':'))) return 'authorization belongs to another outbox row';
  if (token.digest !== digestOf(text)) return 'text changed after authorization';
  const want = Buffer.from(sign(token.key, token.digest), 'hex');
  const got = Buffer.from(token.mac, 'hex');
  return want.length === got.length && timingSafeEqual(want, got) ? null : 'authorization signature does not match';
}
