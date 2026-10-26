// scripts/ledger-snapshot.mjs on scratch WAL-mode ledgers; no live instance is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../src/core/ledger.mjs';
import { compare, inspect, restore, sha256, snapshot, taskBlocks, taskInstance } from '../scripts/ledger-snapshot.mjs';
import { tempDir } from './tmp.mjs';

const cli = (...args) => spawnSync(process.execPath, ['scripts/ledger-snapshot.mjs', ...args], { encoding: 'utf8', windowsHide: true });

// A live-like ledger: WAL mode, a connection still open, and rows not yet checkpointed into the main file.
function liveLedger() {
  const instance = tempDir('fsw-snap-');
  mkdirSync(join(instance, 'run'));
  const file = join(instance, 'ledger.sqlite');
  const ledger = openLedger(file);
  ledger.db.exec('PRAGMA wal_autocheckpoint = 0');
  for (let i = 0; i < 3; i++) ledger.addEvent({ kind: 'supervisor.tick', payload: { i } });
  ledger.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  return { instance, file, ledger };
}

test('a snapshot holds rows still in the WAL, which a copy of the main file alone misses, and records the file', () => {
  const { instance, file, ledger } = liveLedger();
  assert.ok(statSync(file + '-wal').size > 0);
  copyFileSync(file, join(instance, 'bare-copy.sqlite'));
  const bare = new DatabaseSync(join(instance, 'bare-copy.sqlite'), { readOnly: true });
  const bareEvents = bare.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'events'").get().n ? bare.prepare('SELECT count(*) AS n FROM events').get().n : 0;
  bare.close();
  assert.ok(bareEvents < 3);
  const out = join(instance, 'ledger-pre-v0-20261026-230600.sqlite');
  const record = snapshot(file, out);
  ledger.close();
  assert.deepEqual([record.integrity, record.userVersion, record.counts.events, record.counts.threads, record.counts.outbox], ['ok', 4, 3, 1, 0]);
  assert.equal(record.sha256, sha256(out));
  assert.deepEqual(JSON.parse(readFileSync(out + '.json', 'utf8')), record);
  assert.throws(() => snapshot(file, out), /never overwritten/);
});

test('--out and --verify pass on a fresh snapshot, and --verify fails once one byte of it changes', () => {
  const { instance, file, ledger } = liveLedger();
  const out = join(instance, 'snap.sqlite');
  const taken = cli('--ledger', file, '--out', out);
  ledger.close();
  assert.equal(taken.status, 0, taken.stdout + taken.stderr);
  assert.equal(JSON.parse(taken.stdout).userVersion, 4);
  assert.equal(cli('--verify', out).status, 0);
  assert.equal(cli('--ledger', file, '--out', out).status, 1);
  const bytes = readFileSync(out);
  bytes[bytes.length - 100] ^= 0xff;
  writeFileSync(out, bytes);
  const bad = cli('--verify', out);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /sha256 differs from the record/);
});

test('--check passes a ledger that grew and names a table that shrank below the snapshot', () => {
  const { instance, file, ledger } = liveLedger();
  const out = join(instance, 'snap.sqlite');
  snapshot(file, out);
  ledger.addEvent({ kind: 'supervisor.tick', payload: {} });
  assert.equal(cli('--check', file, '--against', out + '.json').status, 0);
  assert.equal(cli('--check', file).status, 0);
  ledger.db.exec('DELETE FROM events WHERE id <= 2');
  const shrank = cli('--check', file, '--against', out + '.json');
  ledger.close();
  assert.equal(shrank.status, 1);
  assert.match(shrank.stdout, /^events has 2 rows, the snapshot had 3$/m);
  assert.deepEqual(compare({ integrity: 'ok', counts: { events: 5 } }, { counts: { events: 3, outbox: 1 } }), ['outbox has 0 rows, the snapshot had 1']);
  assert.deepEqual(compare({ integrity: 'database disk image is malformed', counts: {} }, { counts: {} }), ['integrity_check: database disk image is malformed']);
  assert.equal(inspect(out).integrity, 'ok');
});

test('--restore refuses while a live node process holds the instance lock and replaces nothing', () => {
  const { instance, file, ledger } = liveLedger();
  const out = join(instance, 'snap.sqlite');
  snapshot(file, out);
  ledger.addEvent({ kind: 'after.snapshot', payload: {} });
  ledger.close();
  writeFileSync(join(instance, 'run', 'supervisor.pid'), process.pid + '\n');
  const before = sha256(file);
  const r = cli('--restore', out, '--to', file, '--instance', instance);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp('pid ' + process.pid + ' holds the instance lock'));
  assert.equal(sha256(file), before);
  assert.ok(!readdirSync(instance).some((f) => f.includes('.replaced-') || f.endsWith('.restore.tmp')));
});

test('--restore with the supervisor stopped puts the snapshot back and keeps the replaced files', () => {
  const { instance, file, ledger } = liveLedger();
  const out = join(instance, 'snap.sqlite');
  const record = snapshot(file, out);
  ledger.addEvent({ kind: 'after.snapshot', payload: {} });
  ledger.close();
  writeFileSync(join(instance, 'run', 'supervisor.pid'), '999999\n');
  const r = cli('--restore', out, '--to', file, '--instance', instance);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(sha256(file), record.sha256);
  const kept = JSON.parse(r.stdout).kept;
  assert.ok(kept.length >= 1 && kept.every((k) => existsSync(k)));
  const old = new DatabaseSync(kept[0], { readOnly: true });
  assert.equal(old.prepare("SELECT count(*) AS n FROM events WHERE kind = 'after.snapshot'").get().n, 1);
  old.close();
  assert.equal(inspect(file).counts.events, 3);
  unlinkSync(join(instance, 'run', 'supervisor.pid'));
  const tampered = join(instance, 'tampered.sqlite');
  copyFileSync(out, tampered);
  copyFileSync(out + '.json', tampered + '.json');
  const bytes = readFileSync(tampered);
  bytes[bytes.length - 100] ^= 0xff;
  writeFileSync(tampered, bytes);
  assert.throws(() => restore(tampered, file, instance, idle), /does not match its recorded sha256/);
});

test('the kept file is <to>.replaced-<stamp> with its -wal beside it, so a row that lived only in the WAL opens with it', () => {
  const { instance, file, ledger } = liveLedger();
  const out = join(instance, 'snap.sqlite');
  snapshot(file, out);
  ledger.addEvent({ kind: 'wal.only', payload: {} });
  // A stopped supervisor's ledger as it lies on disk: the main file and an uncheckpointed WAL.
  const to = join(instance, 'stopped.sqlite');
  copyFileSync(file, to);
  copyFileSync(file + '-wal', to + '-wal');
  ledger.close();
  const r = restore(out, to, instance, idle);
  assert.match(r.kept[0], /stopped\.sqlite\.replaced-[0-9TZ-]+$/);
  assert.equal(r.kept[1], r.kept[0] + '-wal');
  const kept = new DatabaseSync(r.kept[0]);
  assert.equal(kept.prepare("SELECT count(*) AS n FROM events WHERE kind = 'wal.only'").get().n, 1);
  kept.close();
  assert.equal(inspect(to).counts.events, 3);
});

const idle = { alive: () => false, task: () => ({ state: 'Ready', instance: null }) };

test('--restore refuses while the task serving this instance reads Running, even with a stale lock', () => {
  const { instance, file, ledger } = liveLedger();
  const out = join(instance, 'snap.sqlite');
  snapshot(file, out);
  ledger.close();
  writeFileSync(join(instance, 'run', 'supervisor.pid'), '999999\n');
  const before = sha256(file);
  const serving = { alive: () => false, task: () => ({ state: 'Running', instance: instance.toUpperCase() }) };
  assert.throws(() => restore(out, file, instance, serving), /the scheduled task reads Running for this instance/);
  assert.throws(() => restore(out, file, instance, { alive: () => false, task: () => ({ state: 'Running', instance: null }) }), /its instance cannot be read/);
  assert.equal(sha256(file), before);
  assert.ok(!readdirSync(instance).some((f) => f.includes('.replaced-')));
  assert.equal(restore(out, file, instance, { alive: () => false, task: () => ({ state: 'Running', instance: join(instance, 'elsewhere') }) }).restored, file);
});

test('the task instance is read from the launcher path task.ps1 registers', () => {
  assert.equal(taskInstance('//B //Nologo "C:\\fsw\\instance.local\\run\\fsw-run.vbs"'), 'C:\\fsw\\instance.local');
  assert.equal(taskInstance(''), null);
  assert.equal(taskBlocks({ state: 'Ready', instance: null }, 'C:\\x'), null);
  assert.equal(taskBlocks({ state: '', instance: null }, 'C:\\x'), null);
});
