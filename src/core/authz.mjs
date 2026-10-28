// The proof a surface needs before it writes to a page (003 Surface, wp9): minted by the outbox drain for one
// row after authorize said send (or the operator approved it), as {key, digest, mac} over the row's key and every
// argument the drain hands the surface write (the text, the amount, the files, the proposal terms). The key names
// the platform, thread and kind (outboxKey), so a token for one row cannot send to another thread or as another
// kind, and any argument changed after minting fails the digest. Each token carries a nonce its first successful
// check consumes, so one approval presses a page once. The secret and the consumed nonces live only in this process
// (docs/DESIGN.md Decisions): a token from another process fails the signature, so nothing has to outlive it.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = randomBytes(32);
const consumed = new Set();
// Arguments as one string independent of key order; undefined fields are left out, as JSON leaves them.
const canonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
};
const digestOf = (args) => createHash('sha256').update(canonical(args)).digest('hex');
const sign = (key, nonce, digest) => createHmac('sha256', SECRET).update(key + '\0' + nonce + '\0' + digest).digest('hex');

// args: exactly what the surface write will receive besides the token.
export function mintAuthorization(row, args) {
  const digest = digestOf(args);
  const nonce = randomBytes(16).toString('hex');
  return Object.freeze({ key: row.key, nonce, digest, mac: sign(row.key, nonce, digest) });
}

// args: the surface write's arguments as received, its token in args.authorized. null when the token authorizes
// exactly these arguments for a row of this platform, thread and one of these kinds and was never used before, which
// the same synchronous call records; otherwise the reason it does not.
export function verifyAuthorization(args, { platform, ref, kinds }) {
  const { authorized: token, ...sent } = args ?? {};
  if (!token || typeof token.key !== 'string' || typeof token.nonce !== 'string' || typeof token.digest !== 'string' || typeof token.mac !== 'string') return 'missing authorization';
  if (!kinds.some((kind) => token.key.startsWith(platform + ':' + ref + ':' + kind + ':'))) return 'authorization belongs to another outbox row';
  if (token.digest !== digestOf(sent)) return 'the write differs from what was authorized';
  const want = Buffer.from(sign(token.key, token.nonce, token.digest), 'hex');
  const got = Buffer.from(token.mac, 'hex');
  if (!(want.length === got.length && timingSafeEqual(want, got))) return 'authorization signature does not match';
  if (consumed.has(token.nonce)) return 'authorization already used';
  consumed.add(token.nonce);
  return null;
}
