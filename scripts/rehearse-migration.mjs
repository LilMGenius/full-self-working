#!/usr/bin/env node
// node scripts/rehearse-migration.mjs --ledger <ledger.sqlite> --approvals <operator/approvals> --old <old src/core/ledger.mjs> --out <dir>
// Proves the v4 migration on a copy of a live ledger before any v0 code opens the live file: a
// consistent copy through VACUUM INTO on a read-only connection, the v4 migration with every older row
// kept, the approval import run twice with the same rows, and the old openLedger opening the v4 copy.
// The live ledger and the approval files are only read. Prints a JSON summary; exit 0 when every check
// holds, 1 naming the first that does not, 2 on a usage error.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openLedger } from '../src/core/ledger.mjs';
import { importApprovals } from '../src/core/approvals-import.mjs';

const OLD_TABLES = ['threads', 'messages', 'quotes', 'jobs', 'payments', 'reviews', 'events', 'money_events'];
const countsOf = (db) => Object.fromEntries(OLD_TABLES.map((t) => [t, db.prepare('SELECT count(*) AS n FROM ' + t).get().n]));

export async function rehearse({ ledger, approvals, old, out }) {
  mkdirSync(out, { recursive: true });
  const copy = join(out, 'ledger.sqlite');
  if (existsSync(copy)) throw new Error(copy + ' exists; give an empty --out');
  const live = new DatabaseSync(resolve(ledger), { readOnly: true });
  live.exec('PRAGMA busy_timeout = 5000');
  live.exec("VACUUM INTO '" + copy.replace(/'/g, "''") + "'");
  live.close();
  const raw = new DatabaseSync(copy);
  const before = { version: raw.prepare('PRAGMA user_version').get().user_version, counts: countsOf(raw) };
  raw.close();
  const failures = [];
  const v0 = openLedger(copy);
  const version = v0.db.prepare('PRAGMA user_version').get().user_version;
  if (version !== 4) failures.push('v0 openLedger left user_version ' + version);
  if (JSON.stringify(countsOf(v0.db)) !== JSON.stringify(before.counts)) failures.push('the v4 migration changed an older table');
  const first = importApprovals(v0, approvals);
  const second = importApprovals(v0, approvals);
  const outbox = v0.counts().outbox;
  if (second.imported !== 0 || outbox !== first.imported) failures.push('the second import added rows (' + second.imported + ') or the outbox holds ' + outbox + ' rows for ' + first.imported + ' imported');
  v0.close();
  const { openLedger: openOld } = await import(pathToFileURL(resolve(old)).href);
  const o = openOld(copy);
  const oldVersion = o.db.prepare('PRAGMA user_version').get().user_version;
  if (oldVersion !== 4) failures.push('the old openLedger moved user_version to ' + oldVersion);
  o.addEvent({ kind: 'rehearsal.old_write', payload: { at: new Date().toISOString() } });
  o.close();
  return { copy, before, after: { version }, import: { first, second }, outbox, oldOpen: { version: oldVersion }, failures };
}

if (import.meta.url === 'file:///' + process.argv[1]?.replace(/\\/g, '/')) {
  let args;
  try {
    args = parseArgs({ options: { ledger: { type: 'string' }, approvals: { type: 'string' }, old: { type: 'string' }, out: { type: 'string' } } }).values;
    if (!args.ledger || !args.approvals || !args.old || !args.out) throw new Error('--ledger, --approvals, --old and --out are required');
  } catch (err) {
    console.error('rehearse-migration: ' + err.message);
    process.exit(2);
  }
  const summary = await rehearse(args);
  console.log(JSON.stringify(summary, null, 1));
  process.exit(summary.failures.length ? 1 : 0);
}
