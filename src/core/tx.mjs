// One SQLite transaction around a synchronous body. BEGIN IMMEDIATE takes the write lock up front, so a
// job child and the supervisor writing the same ledger wait on busy_timeout (src/core/ledger.mjs)
// instead of failing a lock upgrade halfway. A nested call joins the outer transaction.
const depth = new WeakMap();

export function transaction(ledger, fn) {
  const db = ledger.db;
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try {
      return fn();
    } finally {
      depth.set(db, d);
    }
  }
  db.exec('BEGIN IMMEDIATE');
  depth.set(db, 1);
  try {
    const out = fn();
    if (out && typeof out.then === 'function') throw new TypeError('a transaction body must be synchronous');
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth.set(db, 0);
  }
}
