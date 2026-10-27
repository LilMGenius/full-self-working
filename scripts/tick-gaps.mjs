#!/usr/bin/env node
// node scripts/tick-gaps.mjs --instance <instance> --since <ISO> [--until <ISO>]
// The measurement behind takeover-check's --gap-min (003 "Verifier and recovery scripts"; 050 2.5): every
// gap between supervisor.tick events in the window, the longest five and the trailing gap to --until (or
// now). Reads the ledger read-only; always exits 0 once the window is read (a measurement, not a gate).
import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gaps } from './takeover-check.mjs';

// Pure: each gap with the tick it ends at, the longest five and the trailing gap, in minutes.
export function measure(tickTimes, until) {
  const mins = gaps(tickTimes, until);
  const rows = mins.map((min, i) => ({ from: new Date(tickTimes[i]).toISOString(), to: i + 1 < tickTimes.length ? new Date(tickTimes[i + 1]).toISOString() : 'until', min: Math.round(min * 100) / 100 }));
  const longest = [...rows].sort((x, y) => y.min - x.min).slice(0, 5);
  return { ticks: tickTimes.length, gaps: rows, longest, trailingMin: rows.at(-1)?.min ?? null };
}

export function tickTimes(instance, since, until) {
  const db = new DatabaseSync(join(instance, 'ledger.sqlite'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare("SELECT at FROM events WHERE kind = 'supervisor.tick' AND at >= ? AND at <= ? ORDER BY at, id").all(new Date(since).toISOString(), new Date(until).toISOString()).map((r) => Date.parse(r.at));
  } finally {
    db.close();
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  let a;
  try {
    a = parseArgs({ options: { instance: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' } } }).values;
    if (!a.instance || !a.since) throw new Error('--instance and --since are required');
    for (const k of ['since', 'until']) if (a[k] != null && Number.isNaN(Date.parse(a[k]))) throw new Error('--' + k + ' is not an ISO time: ' + a[k]);
  } catch (err) {
    console.error('tick-gaps: ' + err.message + '\nusage: tick-gaps.mjs --instance <instance> --since <ISO> [--until <ISO>]');
    process.exit(2);
  }
  const until = a.until ? Date.parse(a.until) : Date.now();
  const m = measure(tickTimes(a.instance, Date.parse(a.since), until), until);
  for (const g of m.gaps) console.log(g.from + ' -> ' + g.to + ' ' + g.min.toFixed(2) + ' min');
  console.log(JSON.stringify({ since: new Date(Date.parse(a.since)).toISOString(), until: new Date(until).toISOString(), ticks: m.ticks, longest: m.longest, trailingMin: m.trailingMin }));
}
