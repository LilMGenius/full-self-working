#!/usr/bin/env node
// The takeover snapshot of the live ledger (003 "Verifier and recovery scripts"; 050 2.2, 2.5 and section
// 4, A3). --out takes a VACUUM INTO copy from a read-only connection, which SQLite builds as one
// consistent read even while the live supervisor writes through its WAL (a file copy of ledger.sqlite
// alone would miss the WAL), then records sha256, PRAGMA integrity_check, user_version and per-table
// counts beside it as <snapshot>.json. --verify rechecks a snapshot against its record; --check reads a
// live ledger's integrity and, with --against, that no table shrank below the snapshot; --restore puts a
// snapshot back only while no live node process holds the instance lock and the scheduled task serving
// the instance does not read Running (between the launcher's restarts the lock is stale while the task
// runs), keeping the replaced files.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pidAlive } from '../src/supervisor/run.mjs';

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function inspect(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check).join('; ');
    const userVersion = db.prepare('PRAGMA user_version').get().user_version;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const counts = Object.fromEntries(tables.map((t) => [t, db.prepare('SELECT count(*) AS n FROM "' + t + '"').get().n]));
    return { integrity, userVersion, counts };
  } finally {
    db.close();
  }
}

// Pure: findings when a live ledger is compared with a snapshot record.
export function compare(live, record) {
  const f = [];
  if (live.integrity !== 'ok') f.push('integrity_check: ' + live.integrity);
  for (const [t, n] of Object.entries(record.counts)) if ((live.counts[t] ?? 0) < n) f.push(t + ' has ' + (live.counts[t] ?? 0) + ' rows, the snapshot had ' + n);
  return f;
}

export function snapshot(ledger, out) {
  if (existsSync(out)) throw new Error(out + ' exists; a snapshot is never overwritten');
  const db = new DatabaseSync(ledger, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec("VACUUM INTO '" + out.replace(/'/g, "''") + "'");
  } finally {
    db.close();
  }
  const record = { source: resolve(ledger), takenAt: new Date().toISOString(), sha256: sha256(out), ...inspect(out) };
  if (record.integrity !== 'ok') throw new Error('the snapshot fails integrity_check: ' + record.integrity);
  writeFileSync(out + '.json', JSON.stringify(record, null, 2) + '\n');
  return record;
}

export function verify(snap) {
  const record = JSON.parse(readFileSync(snap + '.json', 'utf8'));
  const report = { sha256: sha256(snap), ...inspect(snap) };
  const f = [];
  if (report.sha256 !== record.sha256) f.push('sha256 differs from the record');
  if (report.integrity !== 'ok') f.push('integrity_check: ' + report.integrity);
  return { report, findings: f };
}

// The pid in <instance>/run/supervisor.pid when it is a live node process (pidAlive, the supervisor's own
// liveness rule), else null.
export function liveLockHolder(instance, alive = pidAlive) {
  const f = join(instance, 'run', 'supervisor.pid');
  if (!existsSync(f)) return null;
  const pid = Number.parseInt(readFileSync(f, 'utf8'), 10);
  return alive(pid) ? pid : null;
}

// The scheduled task's state and the instance its launcher serves: scripts/task.ps1 starts wscript on
// <instance>/run/fsw-run.vbs, so the instance is two folders above the .vbs its action names. instance is
// null when the action names no .vbs; state is '' when the task does not exist.
export function readTask(name) {
  const cmd = '$t = Get-ScheduledTask -TaskName ' + "'" + name.replace(/'/g, "''") + "'" + ' -ErrorAction SilentlyContinue; if ($t) { [string]$t.State; [string]$t.Actions[0].Arguments }';
  const [state = '', args = ''] = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/);
  return { state: state.trim(), instance: taskInstance(args) };
}

export function taskInstance(args) {
  const m = /"([^"]+\.vbs)"/i.exec(String(args ?? ''));
  return m ? dirname(dirname(m[1])) : null;
}

const sameDir = (x, y) => resolve(x).toLowerCase() === resolve(y).toLowerCase();

// Why the task stops a restore under instance, or null: it reads Running and serves this instance, or
// runs a launcher whose instance cannot be read.
export function taskBlocks(task, instance) {
  if (task.state !== 'Running') return null;
  if (task.instance && !sameDir(task.instance, instance)) return null;
  return 'the scheduled task reads Running' + (task.instance ? ' for this instance' : ' and its instance cannot be read') + '; stop it first (Stop-ScheduledTask fsw-supervisor); nothing was replaced';
}

// Whether file lies inside dir, compared case-insensitively as Windows paths are.
export function inside(file, dir) {
  const rel = relative(resolve(dir).toLowerCase(), resolve(file).toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function restore(snap, to, instance, { alive = pidAlive, task = () => readTask('fsw-supervisor') } = {}) {
  // The lock and the task checks speak for --instance only, so --to must be a file of that instance.
  if (!inside(to, instance)) throw new Error(resolve(to) + ' is not inside the instance ' + resolve(instance) + ', whose lock and task were checked; nothing was replaced');
  const record = JSON.parse(readFileSync(snap + '.json', 'utf8'));
  if (sha256(snap) !== record.sha256) throw new Error('the snapshot does not match its recorded sha256; nothing was replaced');
  const holder = liveLockHolder(instance, alive);
  if (holder) throw new Error('pid ' + holder + ' holds the instance lock; stop the supervisor first (Stop-ScheduledTask fsw-supervisor, then Stop-Process); nothing was replaced');
  const blocked = taskBlocks(task(), instance);
  if (blocked) throw new Error(blocked);
  const tmp = to + '.restore.tmp';
  copyFileSync(snap, tmp);
  if (sha256(tmp) !== record.sha256) throw new Error('the copied snapshot does not match its sha256; nothing was replaced');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // The kept copy is <to>.replaced-<stamp> with -wal and -shm after that name, the pair SQLite opens
  // together, so the rows still in the replaced WAL (the newest v0 writes) show when the kept file is opened.
  const keptBase = to + '.replaced-' + stamp;
  const kept = [];
  for (const ext of ['', '-wal', '-shm']) {
    if (!existsSync(to + ext)) continue;
    renameSync(to + ext, keptBase + ext);
    kept.push(keptBase + ext);
  }
  renameSync(tmp, to);
  return { restored: to, kept, sha256: record.sha256 };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const { values: a } = parseArgs({ options: { ledger: { type: 'string' }, out: { type: 'string' }, verify: { type: 'string' }, check: { type: 'string' }, against: { type: 'string' }, restore: { type: 'string' }, to: { type: 'string' }, instance: { type: 'string' }, task: { type: 'string', default: 'fsw-supervisor' } } });
  let findings = [];
  let report;
  try {
    if (a.out && a.ledger) report = snapshot(a.ledger, a.out);
    else if (a.verify) ({ report, findings } = verify(a.verify));
    else if (a.check) {
      report = inspect(a.check);
      findings = a.against ? compare(report, JSON.parse(readFileSync(a.against, 'utf8'))) : report.integrity === 'ok' ? [] : ['integrity_check: ' + report.integrity];
    } else if (a.restore && a.to && a.instance) report = restore(a.restore, a.to, a.instance, { task: () => readTask(a.task) });
    else {
      console.error('usage: ledger-snapshot.mjs --ledger <db> --out <file> | --verify <file> | --check <db> [--against <file.json>] | --restore <file> --to <db> --instance <dir> [--task fsw-supervisor]');
      process.exit(2);
    }
  } catch (err) {
    console.log('ledger-snapshot: ' + err.message);
    process.exit(1);
  }
  for (const f of findings) console.log(f);
  console.log(JSON.stringify(report));
  process.exit(findings.length ? 1 : 0);
}
