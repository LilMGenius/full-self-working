#!/usr/bin/env node
// node scripts/approvals-writeback.mjs --instance <instance> [--apply | --check | --reconcile]
// Before main moves back to the 2c77326 line (003 "Verifier and recovery scripts"; 050 2.5 and the
// rollback, A2): the old code sends every operator/approvals/<id>.json whose status is approved (the
// pipeline's flushApprovals and the projects job at a8ae31c), and v0 decides those items in the outbox.
// This writes each imported row's outcome back into its file, so nothing v0 sent or settled goes out
// again, and writes each open row v0 planned itself as a file in the 2c77326 shape (v0OnlyFile), since the
// old code never reads the outbox and would drop it. A file already in a final status
// (the old code sent or closed it) is never rewritten. Every file is read and every write planned before
// any file is written: an unreadable file or a row with no file status stops the run with exit 1 and
// nothing written, since a partial write-back leaves the old code files it would send again. Dry run by
// default; --apply writes each file atomically and prints its sha256 before and after. --check writes
// nothing and exits 1 while an
// imported row and its file disagree (050 2.1, before a forward move); --reconcile first runs
// importApprovals, whose reconcile moves an open row under a final file (010 2.5), then checks the same
// way. A ledger below version 4 has no outbox yet: every mode prints so and exits 0.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FINAL_FILE, KIND_OF as IMPORT_KIND, OPEN_ROW, SENT_FILE, STATUS_OF, importApprovals } from '../src/core/approvals-import.mjs';
import { dayKey } from '../src/core/clock.mjs';
import { openLedger, outboxKey } from '../src/core/ledger.mjs';

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

// Outbox kinds as the 2c77326 files name them (src/brain/approvals.mjs and its callers at a8ae31c).
const OLD_KIND = { message: 'message', quote: 'quote', pay_request: 'pay_request', delivery: 'delivery', proposal: 'project_proposal' };

// The file a row v0 planned itself is written under: the approval id v0 gave it (the drain gives one when a
// row goes to the operator or turns unobserved), else one in the 2c77326 format (Seoul day, platform, eight
// hex) taken from the row key, so a rerun picks the same file. --apply records that id on the row, so a
// later forward import finds the row by it and never imports the file as a second row.
export const v0OnlyId = (row) => row.approvalId ?? dayKey(new Date(row.createdAt)) + '-' + row.platform + '-' + createHash('sha1').update(row.key).digest('hex').slice(0, 8);

// Which status the old file takes for a row v0 planned itself, chosen per status:
// - awaiting_operator: open, so the operator still sees it (fsw approve under the old code);
// - approved: approved, with the operator's final text, so the old code sends it once;
// - sending and unobserved: unobserved, with the press for a cash quote (a sending quote may have spent its
//   cost, as v0's drain counts it), so nobody resends it blind;
// - planned: open. Nothing proves the old pipeline plans the same item again from its thread: v0 recorded
//   the thread's decision in the ledger, and an order item or a proposal comes from state the old code may
//   not revisit. Open puts it before the operator instead of dropping it.
// - observed, rejected, stale, blocked: no file, nothing is left to send.
const V0_STATUS = { awaiting_operator: 'open', planned: 'open', approved: 'approved', sending: 'unobserved', unobserved: 'unobserved' };

// Pure: the 2c77326 approval file for a row v0 planned itself, {record} or {problem}, or null for none.
export function v0OnlyFile(row) {
  const status = V0_STATUS[row.status];
  if (!status) return null;
  const p = row.payload ?? {};
  const kind = OLD_KIND[row.kind];
  if (!kind) return { problem: 'row ' + row.id + ' has kind ' + row.kind + ', which no approval file names' };
  if (p.threadRef == null || p.threadRef === '') return { problem: 'row ' + row.id + ' has no thread ref, so the old code could not send it' };
  const text = p.text ?? null;
  const record = {
    id: v0OnlyId(row), status, createdAt: row.createdAt, platform: row.platform, kind, threadRef: p.threadRef, threadId: row.threadId ?? null,
    reason: row.reason ?? p.reason ?? 'planned by v0 as outbox row ' + row.id, draft: text, title: row.platform + ' ' + kind + ' from the v0 outbox', fromOutbox: row.id,
  };
  if (row.kind === 'message' || row.kind === 'quote') {
    Object.assign(record, {
      threadKind: p.thread?.kind ?? 'message', service: p.service ?? p.decision?.service ?? null, intent: p.decision?.intent ?? null, violations: [], warnings: [],
      quote: row.kind === 'quote' ? { amountKRW: p.amountKRW ?? null, scope: p.scope ?? null, deliveryDays: p.deliveryDays ?? null, split: p.split ?? null, priceType: p.priceType ?? 'fixed' } : null,
      item: { platform: row.platform, kind: row.kind, text, amountKRW: p.amountKRW ?? null, thread: p.thread ?? { stage: 'pre_order' } },
      priceRow: p.priceRow ?? null, costKRW: p.costKRW ?? null,
    });
  } else if (row.kind === 'proposal') Object.assign(record, { project: p.project ?? null, proposal: p.proposal ?? null, critic: p.critic ?? null, service: p.service ?? null, violations: p.violations ?? [] });
  else if (row.kind === 'pay_request') Object.assign(record, { orderItem: true, jobId: row.jobId ?? null, amountKRW: p.amountKRW ?? null, part: p.part ?? null, rest: p.rest === true, paidBeforeKRW: p.paidBeforeKRW ?? null });
  else Object.assign(record, { orderItem: true, jobId: row.jobId ?? null, files: p.files ?? [], captures: p.captures ?? [], runAt: p.runAt ?? null, balanceKRW: null });
  if (status === 'approved') Object.assign(record, { resolvedAt: row.operator?.resolvedAt ?? row.updatedAt, finalText: row.operator?.finalText ?? text, edited: row.operator?.edited === true });
  if (status === 'unobserved') {
    const spent = row.kind === 'quote' && (row.receipt?.pressed === true || (row.status === 'sending' && p.costKRW != null && row.receipt?.pressed !== false));
    Object.assign(record, { closedAt: row.updatedAt, detail: row.reason ?? 'sent under v0 and not observed; check the thread', ...(spent ? { pressed: { at: row.receipt?.pressedAt ?? row.updatedAt, costKRW: row.receipt?.costKRW ?? p.costKRW ?? null } } : {}) });
  }
  return { record };
}

// The outbox key the importer gives a file (rowFromApproval in src/core/approvals-import.mjs), or null
// for a file it cannot key.
export function fileKey(a) {
  const kind = IMPORT_KIND[a.kind];
  if (!kind || !a.platform || a.threadRef == null || a.threadRef === '') return null;
  return outboxKey({ platform: a.platform, threadRef: String(a.threadRef), kind, text: a.finalText ?? a.draft ?? null, amountKRW: a.quote?.amountKRW ?? a.amountKRW ?? null, files: a.files ?? [] });
}

// Rows whose item went out or may have: a second file holding the same item follows them.
const WENT_OUT = ['observed', 'sending', 'unobserved'];
// Rows the importer moves when a file holding their item reads sent (FOLLOWS in approvals-import.mjs).
const FOLLOWS_FILE = [...OPEN_ROW, 'sending'];

// Pure: the next content of a file the importer skipped because an older file holding the same item owns
// the row ('same key as outbox row N'), or null. Only a send closes the duplicate, as the importer and the
// old code treat it: a rejection or a stale row of one file leaves the other one as it is.
export function duplicateNext(row, record) {
  if (!WENT_OUT.includes(row.status) || FINAL_FILE.includes(fileStatus(record))) return null;
  const out = fileOutcome(row);
  return { ...record, ...out, detail: 'the same item as ' + (row.approvalId ?? 'outbox row ' + row.id) + (out.detail ? '; ' + out.detail : '') };
}

// Every file no row owns whose key equals a row's key, with that row.
function duplicates(rows, records) {
  const owned = new Set(rows.map((r) => r.approvalId).filter(Boolean));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out = [];
  for (const [id, found] of records) {
    if (owned.has(id)) continue;
    const row = byKey.get(fileKey(found.record));
    if (row) out.push({ id, found, row });
  }
  return out;
}

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
      const made = v0OnlyFile(row);
      if (!made) continue;
      if (made.problem) {
        problems.push(made.problem);
        continue;
      }
      const id = made.record.id;
      const found = records.get(id);
      if (found && FINAL_FILE.includes(fileStatus(found.record))) continue;
      const next = found ? { ...found.record, ...made.record } : made.record;
      if (found && JSON.stringify(next) === JSON.stringify(found.record)) continue;
      writes.push({ id, file: found?.file ?? null, before: found?.text ?? '', from: found ? found.record.status : 'none (v0 row ' + row.id + ')', next, assign: row.approvalId ? null : { rowId: row.id, approvalId: id, updatedAt: row.updatedAt } });
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
  for (const { id, found, row } of duplicates(rows, records)) {
    const next = duplicateNext(row, found.record);
    if (next) writes.push({ id, file: found.file, before: found.text, from: found.record.status, next });
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
    // A duplicate file disagrees with its row when the row's item went out and the file could still send
    // it, or the file sent it and the row could still send it again (the importer's reconcile closes that).
    for (const { id, found, row } of duplicates(rows, read.records)) {
      const fs = fileStatus(found.record);
      if (duplicateNext(row, found.record) || (SENT_FILE.includes(fs) && FOLLOWS_FILE.includes(row.status))) findings.push(id + ': holds the same item as row ' + row.id + ', which is ' + row.status + ', and the file is ' + found.record.status);
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
      const file = w.file ?? join(dir, w.id + '.json');
      mkdirSync(dir, { recursive: true });
      writeFileSync(file + '.tmp', text);
      renameSync(file + '.tmp', file);
      if (readFileSync(file, 'utf8') !== text) throw new Error(file + ' did not read back as written');
    }
  }
  // The ids of files written for rows v0 planned itself go onto those rows, so a later import finds each
  // row by its file and never imports the file as a second row.
  const assigns = writes.map((w) => w.assign).filter(Boolean);
  if (mode === 'apply' && assigns.length) {
    const l = openLedger(file0);
    try {
      l.db.exec('BEGIN');
      for (const a of assigns) l.updateOutbox(a.rowId, { approvalId: a.approvalId, updatedAt: a.updatedAt });
      l.db.exec('COMMIT');
    } catch (err) {
      l.db.exec('ROLLBACK');
      throw err;
    } finally {
      l.close();
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
