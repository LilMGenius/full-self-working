import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger } from '../src/core/ledger.mjs';

function withLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-ledger-'));
  const ledger = openLedger(join(dir, 'ledger.sqlite'));
  try {
    return fn(ledger, dir);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('upsertThread is idempotent on platform and externalId', () => withLedger((l) => {
  const a = l.upsertThread({ platform: 'kmong', externalId: 'T1', kind: 'message', customer: 'buyer', meta: { src: 'inbox' } });
  const b = l.upsertThread({ platform: 'kmong', externalId: 'T1', kind: 'message', status: 'replied' });
  assert.equal(a.id, b.id);
  assert.equal(b.status, 'replied');
  assert.equal(b.customer, 'buyer');
  assert.deepEqual(b.meta, { src: 'inbox' });
  const other = l.upsertThread({ platform: 'soomgo', externalId: 'T1', kind: 'request' });
  assert.notEqual(other.id, a.id);
  assert.equal(l.listThreads({ platform: 'kmong' }).length, 1);
  assert.equal(l.counts().threads, 2);
}));

test('addMessage is idempotent on thread, direction and externalId', () => withLedger((l) => {
  const t = l.upsertThread({ platform: 'kmong', externalId: 'T2', kind: 'message' });
  const m1 = l.addMessage({ threadId: t.id, direction: 'in', body: 'hello', externalId: 'm-1', attachments: ['a.png'] });
  const m2 = l.addMessage({ threadId: t.id, direction: 'in', body: 'hello again', externalId: 'm-1' });
  assert.equal(m1.inserted, true);
  assert.equal(m2.inserted, false);
  assert.equal(m2.id, m1.id);
  l.addMessage({ threadId: t.id, direction: 'out', body: 'reply', externalId: 'm-1' });
  l.addMessage({ threadId: t.id, direction: 'out', body: 'no id' });
  l.addMessage({ threadId: t.id, direction: 'out', body: 'no id' });
  const msgs = l.threadMessages(t.id);
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs[0].attachments, ['a.png']);
  assert.ok(l.getThread(t.id).lastInboundAt);
}));

test('jobs, quotes and payments round-trip and payments need evidence', () => withLedger((l) => {
  const t = l.upsertThread({ platform: 'soomgo', externalId: 'R1', kind: 'request' });
  const q = l.addQuote({ threadId: t.id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 300000, scope: { pages: 1 } });
  assert.equal(q.amountKRW, 300000);
  assert.equal(l.updateQuote(q.id, { status: 'accepted' }).status, 'accepted');
  const job = l.upsertJob({ id: 'job-1', threadId: t.id, platform: 'soomgo', priceKRW: 300000, status: 'ordered' });
  assert.equal(l.upsertJob({ id: 'job-1', status: 'in_progress' }).status, 'in_progress');
  assert.equal(job.priceKRW, 300000);
  assert.throws(() => l.addPayment({ jobId: 'job-1', kind: 'deposit', amountKRW: 150000 }));
  l.addPayment({ jobId: 'job-1', kind: 'deposit', amountKRW: 150000, evidence: 'soomgo pay confirmed' });
  assert.equal(l.jobPayments('job-1').length, 1);
  assert.equal(l.addReview({ jobId: 'job-1', rating: 5, liked: true }).liked, true);
  assert.deepEqual(l.addEvent({ kind: 'tick', payload: { ok: true } }).payload, { ok: true });
  assert.deepEqual(l.counts(), { threads: 1, messages: 0, quotes: 1, jobs: 1, payments: 1, reviews: 1, events: 1, money_events: 0 });
}));

test('reopening keeps the schema version and data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-ledger-'));
  try {
    const path = join(dir, 'ledger.sqlite');
    const a = openLedger(path);
    a.upsertThread({ platform: 'kmong', externalId: 'X', kind: 'order' });
    a.close();
    const b = openLedger(path);
    assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(b.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(b.counts().threads, 1);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a version 2 ledger takes project threads after the rebuild and keeps every row and reference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-ledger-'));
  try {
    const path = join(dir, 'ledger.sqlite');
    const a = openLedger(path);
    const t = a.upsertThread({ platform: 'kmong', externalId: 'T9', kind: 'message', meta: { a: 1 } });
    a.addMessage({ threadId: t.id, direction: 'in', body: 'hello', externalId: 'm1' });
    a.addQuote({ threadId: t.id, platform: 'kmong', amountKRW: 100000 });
    a.close();
    // Turn the file back into a version 2 ledger: the old threads table without the project kind.
    const raw = new DatabaseSync(path);
    // legacy_alter_table keeps the child tables pointing at the name threads while the table is swapped.
    raw.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON');
    const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'threads'").get().sql;
    raw.exec('ALTER TABLE threads RENAME TO threads_v3');
    raw.exec(sql.replace(",'project'", ''));
    raw.exec('INSERT INTO threads SELECT * FROM threads_v3; DROP TABLE threads_v3; PRAGMA user_version = 2');
    raw.close();
    const b = openLedger(path);
    assert.equal(b.db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(b.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.deepEqual(b.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(b.getThread(t.id).meta.a, 1);
    assert.equal(b.threadMessages(t.id).length, 1);
    assert.equal(b.listQuotes({ threadId: t.id }).length, 1);
    const p = b.upsertThread({ platform: 'kmong', externalId: 'project:1', kind: 'project' });
    assert.equal(p.kind, 'project');
    assert.throws(() => b.addMessage({ threadId: 9999, direction: 'in', body: 'orphan' }), /FOREIGN KEY/);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
