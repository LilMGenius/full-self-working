#!/usr/bin/env node
// node scripts/approvals-writeback.mjs --instance <instance> [--apply | --check | --reconcile]
// Before main moves back to the 2c77326 line (003 "Verifier and recovery scripts"; 050 2.5 and the
// rollback, A2): the old code sends every operator/approvals/<id>.json whose status is approved (the
// pipeline's flushApprovals and the projects job at a8ae31c), and v0 decides those items in the outbox.
// This writes each imported row's outcome back into its file, so nothing v0 sent or settled goes out
// again, and lists the rows v0 created that the old code cannot see. A file already in a final status
// (the old code sent or closed it) is never rewritten. Every file is read and every write planned before
// any file is written: an unreadable file or a row with no file status stops the run with exit 1 and
// nothing written, since a partial write-back leaves the old code files it would send again. Dry run by
// default; --apply writes each file atomically and prints its sha256 before and after. --check writes
// nothing and exits 1 while an
// imported row and its file disagree (050 2.1, before a forward move); --reconcile first runs
// importApprovals, whose reconcile moves an open row under a final file (010 2.5), then checks the same
// way. A ledger below version 4 has no outbox yet: every mode prints so and exits 0.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FINAL_FILE, STATUS_OF, importApprovals } from '../src/core/approvals-import.mjs';
import { openLedger } from '../src/core/ledger.mjs';

// The status the importer reads a file as: an open file the old code could not observe is unobserved.
const fileStatus = (record) => (record.status === 'open' && record.unobserved === true ? 'unobserved' : record.status);

// Pure: the status and fields the old file takes for an outbox row; null leaves the file as it is.
export function fileOutcome(row) {
  const at = row.updatedAt;
  const finalText = row.operator?.finalText ?? row.payload?.text ?? null;
  switch (row.status) {
    case 'planned':
    case 'awaiting_operator':
      // Still open under v0 (a quote deferred by the day's cash caps is planned): the file stays open.
      return { status: 'open' };
    case 'approved':
      return { status: 'approved', resolvedAt: row.operator?.resolvedAt ?? at, finalText, edited: row.operator?.edited === true };
    case 'sending':
      // A send interrupted under v0 may have gone out; the old code must not send it blind.
      return { status: 'unobserved', closedAt: at, detail: 'interrupted under v0; check the thread' };
    case 'observed':
      return { status: 'sent', closedAt: at, finalText };
    case 'unobserved':
    case 'blocked':
      // A quote pressed but not confirmed keeps its press, which the old quotaUsage counts (7b9524e).
      return { status: row.status, closedAt: at, detail: row.reason ?? null, ...(row.receipt?.pressed ? { pressed: { at: row.receipt.pressedAt ?? at, costKRW: row.receipt.costKRW ?? null } } : {}) };
    case 'rejected':
      return row.operator?.resolvedAt ? { status: 'rejected', resolvedAt: row.operator.resolvedAt } : { status: 'dropped', closedAt: at, detail: row.reason ?? null };
    case 'stale':
      return { status: row.kind === 'proposal' ? 'expired' : 'dropped', closedAt: at, detail: row.reason ?? null };
    default:
      return null;
  }
}

// Pure: why an imported row and its file disagree, or null. They agree when the file holds what the
// write-back writes for the row, or the row holds what the import maps the file's status to.
export function disagreement(row, record) {
  if (fileOutcome(row)?.status === record.status) return null;
  if (STATUS_OF[fileStatus(record)] === row.status) return null;
  return 'row ' + row.id + ' is ' + row.status + ', its file is ' + record.status;
}

// Pure: the file's next content for a row, or null when the file stays as it is: it already agrees with
// the row, or it is final (the old code sent or closed it, and a rewrite could only reopen it).
export function nextRecord(row, record) {
  if (FINAL_FILE.includes(fileStatus(record))) return null;
  if (STATUS_OF[fileStatus(record)] === row.status) return null;
  const out = fileOutcome(row);
  if (!out || Object.entries(out).every(([k, v]) => JSON.stringify(record[k] ?? null) === JSON.stringify(v))) return null;
  return { ...record, ...out };
}

const sha = (text) => createHash('sha256').update(text).digest('hex');
const OPEN_V0 = ['planned', 'awaiting_operator', 'approved', 'sending'];

// Every *.json file of the approvals directory, parsed: {records: Map id -> {file, text, record}, unreadable}.
export function readApprovals(dir) {
  const records = new Map();
  const unreadable = [];
  if (!existsSync(dir)) return { records, unreadable };
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const file = join(dir, name);
    try {
      const text = readFileSync(file, 'utf8');
      records.set(name.slice(0, -5), { file, text, record: JSON.parse(text) });
    } catch (err) {
      unreadable.push(name + ': unreadable: ' + err.message);
    }
  }
  return { records, unreadable };
}

// Pure: every write the outbox rows ask of the files read, and every reason not to write any of them.
// writes: [{id, file, before, next}]; problems: unreadable files and rows with no file status; notes: lines.
export function planWriteback(rows, { records, unreadable }) {
  const writes = [];
  const problems = [...unreadable];
  const notes = [];
  for (const row of rows) {
    if (!row.approvalId || !row.payload?.importedFrom) {
      if (OPEN_V0.includes(row.status)) notes.push('v0-only row ' + row.id + ' ' + row.platform + ' ' + row.kind + ' is ' + row.status + ': the old code cannot see it; the operator settles it on the platform');
      continue;
    }
    const found = records.get(row.approvalId);
    if (!found) {
      if (!unreadable.some((u) => u.startsWith(row.approvalId + '.json:'))) notes.push('row ' + row.id + ': ' + row.approvalId + '.json is gone');
      continue;
    }
    if (!FINAL_FILE.includes(fileStatus(found.record)) && !fileOutcome(row)) {
      problems.push(row.approvalId + '.json: row ' + row.id + ' is ' + row.status + ', which has no approval file status');
      continue;
    }
    const next = nextRecord(row, found.record);
    if (next) writes.push({ id: row.approvalId, file: found.file, before: found.text, from: found.record.status, next });
  }
  return { writes, problems, notes };
}

// mode: 'dry' | 'apply' | 'check' | 'reconcile'. Returns {lines, exit}.
export function writeback(instance, mode = 'dry') {
  const lines = [];
  const file0 = join(instance, 'ledger.sqlite');
  const probe = new DatabaseSync(file0, { readOnly: true });
  const version = probe.prepare('PRAGMA user_version').get().user_version;
  probe.close();
  if (version < 4) return { lines: ['approvals-writeback: ledger at version ' + version + ', no outbox yet; nothing imported'], exit: 0 };
  const dir = join(instance, 'operator', 'approvals');
  const ledger = openLedger(file0);
  let rows;
  try {
    if (mode === 'reconcile') lines.push('approvals import ' + JSON.stringify(importApprovals(ledger, dir)));
    rows = ledger.listOutbox({});
  } finally {
    ledger.close();
  }
  const checking = mode === 'check' || mode === 'reconcile';
  const read = readApprovals(dir);
  if (checking) {
    const findings = [...read.unreadable];
    for (const row of rows) {
      if (!row.approvalId || !row.payload?.importedFrom) continue;
      const found = read.records.get(row.approvalId);
      const why = found ? disagreement(row, found.record) : null;
      if (why) findings.push(row.approvalId + ': ' + why);
    }
    lines.push(...findings, 'approvals-writeback --' + mode + ': ' + rows.length + ' outbox rows, ' + findings.length + ' disagreement(s)');
    return { lines, exit: findings.length ? 1 : 0 };
  }
  const { writes, problems, notes } = planWriteback(rows, read);
  lines.push(...notes);
  if (problems.length) {
    lines.push(...problems, 'approvals-writeback: ' + problems.length + ' problem(s); nothing written, so the old code must not start over these files');
    return { lines, exit: 1 };
  }
  for (const w of writes) {
    const text = JSON.stringify(w.next, null, 2) + '\n';
    lines.push(w.id + ': ' + w.from + ' -> ' + w.next.status + (mode === 'apply' ? '' : ' (dry run)') + ' sha256 ' + sha(w.before).slice(0, 12) + (mode === 'apply' ? ' -> ' + sha(text).slice(0, 12) : ''));
    if (mode === 'apply') {
      writeFileSync(w.file + '.tmp', text);
      renameSync(w.file + '.tmp', w.file);
      if (readFileSync(w.file, 'utf8') !== text) throw new Error(w.file + ' did not read back as written');
    }
  }
  lines.push('approvals-writeback: ' + rows.length + ' outbox rows, ' + writes.length + ' file(s) ' + (mode === 'apply' ? 'written' : 'to write'));
  return { lines, exit: 0 };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const { values: a } = parseArgs({ options: { instance: { type: 'string' }, apply: { type: 'boolean', default: false }, check: { type: 'boolean', default: false }, reconcile: { type: 'boolean', default: false } } });
  if (!a.instance || [a.apply, a.check, a.reconcile].filter(Boolean).length > 1) {
    console.error('usage: approvals-writeback.mjs --instance <instance> [--apply | --check | --reconcile]');
    process.exit(2);
  }
  const { lines, exit } = writeback(a.instance, a.apply ? 'apply' : a.check ? 'check' : a.reconcile ? 'reconcile' : 'dry');
  for (const l of lines) console.log(l);
  process.exit(exit);
}
