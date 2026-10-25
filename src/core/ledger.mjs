// SQLite ledger on node:sqlite. Tables follow docs/DESIGN.md (Ledger); helpers take and return
// camelCase objects, JSON columns are stored as text and parsed on read. `ledger.db` is the raw handle.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { ensureDir } from './instance.mjs';

const MIGRATIONS = [
  `
  CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    external_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message','request','order')),
    customer TEXT,
    service TEXT,
    status TEXT,
    language TEXT,
    last_inbound_at TEXT,
    last_outbound_at TEXT,
    created_at TEXT NOT NULL,
    meta TEXT,
    UNIQUE (platform, external_id)
  );
  CREATE INDEX threads_platform_status ON threads(platform, status);
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    thread_id INTEGER NOT NULL REFERENCES threads(id),
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    body TEXT,
    attachments TEXT,
    external_id TEXT,
    at TEXT NOT NULL,
    gate TEXT,
    UNIQUE (thread_id, direction, external_id)
  );
  CREATE INDEX messages_thread ON messages(thread_id);
  CREATE TABLE quotes (
    id INTEGER PRIMARY KEY,
    thread_id INTEGER REFERENCES threads(id),
    platform TEXT NOT NULL,
    service TEXT,
    amount_krw INTEGER,
    deposit_krw INTEGER,
    balance_krw INTEGER,
    scope TEXT,
    delivery_days INTEGER,
    cost_krw INTEGER,
    status TEXT NOT NULL CHECK (status IN ('sent','accepted','declined','expired')),
    at TEXT NOT NULL
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    thread_id INTEGER REFERENCES threads(id),
    platform TEXT,
    service TEXT,
    title TEXT,
    price_krw INTEGER,
    status TEXT NOT NULL CHECK (status IN ('lead','quoted','ordered','in_progress','delivered','revision','closed','lost')),
    agent_minutes REAL DEFAULT 0,
    human_minutes REAL DEFAULT 0,
    cost_krw INTEGER DEFAULT 0,
    started_at TEXT,
    delivered_at TEXT,
    closed_at TEXT,
    meta TEXT
  );
  CREATE INDEX jobs_status ON jobs(status);
  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    kind TEXT NOT NULL CHECK (kind IN ('deposit','balance','full','milestone')),
    amount_krw INTEGER NOT NULL,
    channel TEXT,
    received_at TEXT NOT NULL,
    evidence TEXT NOT NULL
  );
  CREATE INDEX payments_job ON payments(job_id);
  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY,
    job_id TEXT REFERENCES jobs(id),
    platform TEXT,
    rating REAL,
    text TEXT,
    liked INTEGER,
    at TEXT NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    platform TEXT,
    ref TEXT,
    payload TEXT
  );
  `,
  // Every money signal read from a platform (a hire, a payment notice, a confirmation), once per key, with
  // the payment row it wrote or matched; src/orders/money.mjs owns the keys.
  `
  CREATE TABLE money_events (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL,
    thread_id INTEGER REFERENCES threads(id),
    job_id TEXT REFERENCES jobs(id),
    event TEXT NOT NULL,
    amount_krw INTEGER,
    at TEXT,
    applied INTEGER NOT NULL,
    note TEXT,
    payment_id INTEGER REFERENCES payments(id),
    evidence TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX money_events_job ON money_events(job_id);
  `,
];

export const TABLES = ['threads', 'messages', 'quotes', 'jobs', 'payments', 'reviews', 'events', 'money_events'];
const JSON_COLUMNS = new Set(['meta', 'attachments', 'gate', 'scope', 'payload']);
const BOOL_COLUMNS = new Set(['liked', 'applied']);

const camel = (s) => s.replace(/_krw$/, 'KRW').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snake = (s) => s.replace(/KRW$/, 'Krw').replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const now = () => new Date().toISOString();

function decode(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (JSON_COLUMNS.has(k)) out[camel(k)] = v == null ? null : JSON.parse(v);
    else if (BOOL_COLUMNS.has(k)) out[camel(k)] = v == null ? null : Boolean(v);
    else out[camel(k)] = v;
  }
  return out;
}

function encode(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const col = snake(k);
    if (JSON_COLUMNS.has(col)) out[col] = v == null ? null : JSON.stringify(v);
    else if (BOOL_COLUMNS.has(col)) out[col] = v == null ? null : v ? 1 : 0;
    else out[col] = v;
  }
  return out;
}

export function openLedger(path) {
  if (path !== ':memory:') ensureDir(dirname(path));
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const insert = (table, obj) => {
    const row = encode(obj);
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => ':' + c).join(', ')})`;
    return db.prepare(sql).run(row);
  };
  const update = (table, id, patch) => {
    const row = encode(patch);
    delete row.id;
    const cols = Object.keys(row);
    if (cols.length) db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`).run({ ...row, id });
  };
  const get = (table, id) => decode(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
  const where = (filters) => {
    const row = encode(filters);
    const cols = Object.keys(row);
    return { sql: cols.length ? ' WHERE ' + cols.map((c) => `${c} = :${c}`).join(' AND ') : '', row };
  };
  const list = (table, filters = {}, order = 'id') => {
    const w = where(filters);
    return db.prepare(`SELECT * FROM ${table}${w.sql} ORDER BY ${order}`).all(w.row).map(decode);
  };

  function upsertThread({ platform, externalId, kind, customer, service, status, language, meta }) {
    if (!platform || externalId == null || !kind) throw new TypeError('upsertThread needs platform, externalId and kind');
    const row = encode({ customer, service, status, language, meta });
    const existing = db.prepare('SELECT id FROM threads WHERE platform = ? AND external_id = ?').get(platform, String(externalId));
    if (existing) {
      const cols = Object.keys(row);
      if (cols.length) db.prepare(`UPDATE threads SET ${cols.map((c) => `${c} = :${c}`).join(', ')} WHERE id = :id`).run({ ...row, id: existing.id });
      return get('threads', existing.id);
    }
    const r = insert('threads', { platform, externalId: String(externalId), kind, customer, service, status: status ?? 'new', language, meta, createdAt: now() });
    return get('threads', Number(r.lastInsertRowid));
  }

  function addMessage({ threadId, direction, body, attachments, externalId, at, gate }) {
    if (!threadId || !['in', 'out'].includes(direction)) throw new TypeError('addMessage needs threadId and direction in|out');
    const ext = externalId == null ? null : String(externalId);
    if (ext != null) {
      const found = db.prepare('SELECT * FROM messages WHERE thread_id = ? AND direction = ? AND external_id = ?').get(threadId, direction, ext);
      if (found) return { ...decode(found), inserted: false };
    }
    const when = at ?? now();
    const r = insert('messages', { threadId, direction, body, attachments: attachments ?? [], externalId: ext, at: when, gate });
    db.prepare(`UPDATE threads SET ${direction === 'in' ? 'last_inbound_at' : 'last_outbound_at'} = ? WHERE id = ?`).run(when, threadId);
    return { ...get('messages', Number(r.lastInsertRowid)), inserted: true };
  }

  function addQuote({ threadId, platform, service, amountKRW, depositKRW, balanceKRW, scope, deliveryDays, costKRW, status = 'sent', at }) {
    const r = insert('quotes', { threadId, platform, service, amountKRW, depositKRW, balanceKRW, scope, deliveryDays, costKRW, status, at: at ?? now() });
    return get('quotes', Number(r.lastInsertRowid));
  }

  function updateQuote(id, patch) {
    update('quotes', id, patch);
    return get('quotes', id);
  }

  function upsertJob(job) {
    const id = job.id ?? randomUUID();
    if (get('jobs', id)) update('jobs', id, job);
    else insert('jobs', { status: 'lead', ...job, id });
    return get('jobs', id);
  }

  function addPayment({ jobId, kind, amountKRW, channel, receivedAt, evidence }) {
    if (!evidence) throw new TypeError('a payment is written only from evidence');
    const r = insert('payments', { jobId, kind, amountKRW, channel, receivedAt: receivedAt ?? now(), evidence: typeof evidence === 'string' ? evidence : JSON.stringify(evidence) });
    return get('payments', Number(r.lastInsertRowid));
  }

  function addReview({ jobId, platform, rating, text, liked, at }) {
    const r = insert('reviews', { jobId, platform, rating, text, liked, at: at ?? now() });
    return get('reviews', Number(r.lastInsertRowid));
  }

  function addEvent({ at, kind, platform, ref, payload }) {
    const r = insert('events', { at: at ?? now(), kind, platform, ref: ref == null ? null : String(ref), payload });
    return get('events', Number(r.lastInsertRowid));
  }

  // Returns {inserted: false, ...row} when the key was recorded before, so a signal read twice acts once.
  function addMoneyEvent({ key, platform, threadId, jobId, event, amountKRW, at, applied, note, paymentId, evidence }) {
    if (!key || !platform || !event || !evidence) throw new TypeError('addMoneyEvent needs key, platform, event and evidence');
    const found = db.prepare('SELECT * FROM money_events WHERE key = ?').get(key);
    if (found) return { ...decode(found), inserted: false };
    const r = insert('money_events', { key, platform, threadId, jobId, event, amountKRW, at, applied: Boolean(applied), note, paymentId, evidence: typeof evidence === 'string' ? evidence : JSON.stringify(evidence), recordedAt: now() });
    return { ...get('money_events', Number(r.lastInsertRowid)), inserted: true };
  }

  function counts() {
    return Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
  }

  return {
    db,
    path,
    upsertThread,
    getThread: (id) => get('threads', id),
    listThreads: ({ platform, status } = {}) => list('threads', { platform, status }),
    addMessage,
    threadMessages: (threadId) => list('messages', { threadId }, 'at, id'),
    addQuote,
    updateQuote,
    getQuote: (id) => get('quotes', id),
    listQuotes: ({ threadId, platform, status } = {}) => list('quotes', { threadId, platform, status }),
    upsertJob,
    getJob: (id) => get('jobs', id),
    listJobs: ({ platform, status, service } = {}) => list('jobs', { platform, status, service }),
    addPayment,
    jobPayments: (jobId) => list('payments', { jobId }),
    addReview,
    jobReviews: (jobId) => list('reviews', { jobId }),
    addEvent,
    addMoneyEvent,
    getMoneyEvent: (key) => decode(db.prepare('SELECT * FROM money_events WHERE key = ?').get(key)),
    listMoneyEvents: ({ platform, threadId, jobId, event } = {}) => list('money_events', { platform, threadId, jobId, event }, 'at, id'),
    counts,
    close: () => db.close(),
  };
}
