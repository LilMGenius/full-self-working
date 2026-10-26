#!/usr/bin/env node
// Read-only takeover check (003 "Verifier and recovery scripts"; 050 2.1, 2.5 and 2.7). --since handover
// checks the newest handover in supervisor.log from the tick before it, with its old commit as --from unless
// given, which is the check after every move of main. Exit 0 only when:
// local main, the deploy HEAD and --expect are one commit; the lock names a live node process and the
// scheduled task is Running; the ledger is at --version and, with --takeovers, holds exactly that many
// takeover events, the newest naming --expect (the lock holder must also be the supervisor: a node whose
// command line runs bin/fsw.mjs run, or runs from the deploy worktree); no gap between supervisor.tick events since --since, the
// newest tick before --since and the trailing gap to now included (so the gap a handover opens right at
// --since counts), exceeds --gap-min; the newest tick ran --expect (its code field, or for a
// 2c77326 tick, which has none, the newest handover or the deploy HEAD); and supervisor.log since --since
// parses into exactly --moves ordered handover transactions, --restarts restarts and --imports approval
// import lines. Writes nothing. Exit 1 names each failure; 2 is a usage error.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pidAlive } from '../src/supervisor/run.mjs';

// 003 "supervisor.log lines and the tick event": the lines runSupervisor logs at 2c77326 and at v0.
export const FORMATS = {
  pid: /^\S+ supervisor pid (\d+)(?:, took over the stale lock of pid \d+)?$/,
  tick: /^\S+ tick (?:\S+:\S+ )+failures=\d+$/,
  moved: /^\S+ code moved from ([0-9a-f]{7,40}) to ([0-9a-f]{7,40}); restarting$/,
  exiting: /^\S+ supervisor exiting for a restart$/,
  stopped: /^\S+ supervisor stopped$/,
  imports: /^\S+ approvals import read \d+, imported \d+, already \d+, reconciled \d+, skipped \d+(?:: .+)?$/,
};

// The time a log line starts with, or NaN for a line without one (a stack trace the launcher's redirect
// caught), which Date.parse alone would read leniently: 'file:///.../run.mjs:451' parses as a year 2045.
export const timeOf = (line) => (/^\d{4}-\d{2}-\d{2}T\S+ /.test(line) ? Date.parse(line.slice(0, line.indexOf(' '))) : NaN);

// Pure: the handover transactions in log lines. A handover is a tick, `code moved from A to B`, then
// `supervisor exiting for a restart`, then the new process's `supervisor pid`, then a tick from it (its
// import line may come between); one handover starts where the one before ended unless a restart came
// between them, since a restart runs whatever the deploy worktree held, and times never go back.
// A `supervisor pid` that no exiting line precedes is a restart (a stop, a crash or a scripted rollback).
export function parseLog(lines) {
  const ev = [];
  for (const l of lines) {
    for (const [k, re] of Object.entries(FORMATS)) {
      const m = l.match(re);
      if (m) {
        ev.push({ k, m, at: timeOf(l) });
        break;
      }
    }
  }
  const problems = [];
  const moves = [];
  let restarts = 0;
  for (let i = 1; i < ev.length; i++) if (!(ev[i].at >= ev[i - 1].at)) problems.push('log time goes back at ' + new Date(ev[i].at).toISOString());
  const main = ev.filter((e) => e.k !== 'imports');
  let lastMove = -1;
  let lastRestart = -1;
  const seg = [];
  main.forEach((e, i) => {
    if (e.k === 'pid' && main[i - 1]?.k !== 'exiting') {
      restarts += 1;
      lastRestart = i;
    }
    if (e.k !== 'moved') return;
    lastMove = i;
    const [, from, to] = e.m;
    if (main[i - 1]?.k !== 'tick') problems.push('the handover to ' + to + ' follows no tick');
    if (main[i + 1]?.k !== 'exiting') problems.push('the handover to ' + to + ' has no exiting line next');
    if (main[i + 2]?.k !== 'pid') problems.push('the handover to ' + to + ' has no new supervisor pid after the exit');
    if (main[i + 3]?.k !== 'tick') problems.push('the handover to ' + to + ' has no tick from the new process');
    moves.push({ from, to });
    seg.push(restarts);
  });
  for (let j = 1; j < moves.length; j++) if (seg[j] === seg[j - 1] && !(moves[j].from.startsWith(moves[j - 1].to) || moves[j - 1].to.startsWith(moves[j].from))) problems.push('handover ' + (j + 1) + ' starts at ' + moves[j].from + ', the one before ended at ' + moves[j - 1].to);
  // A restart after the newest handover (the rollback script starts the task on the old line) runs
  // whatever the deploy worktree held, not the newest handover's target.
  return { moves, restarts, imports: ev.filter((e) => e.k === 'imports').length, problems, restartAfterMove: lastRestart > lastMove };
}

// The newest handover in supervisor.log lines: the log time of the tick before it, so a window starting
// there holds the whole handover, and the commits it moved between. null when the log holds none.
export function newestHandover(lines) {
  const mi = lines.findLastIndex((l) => FORMATS.moved.test(l));
  if (mi < 0) return null;
  const [, from, to] = lines[mi].match(FORMATS.moved);
  const ti = lines.slice(0, mi).findLastIndex((l) => FORMATS.tick.test(l));
  return { since: ti < 0 ? null : lines[ti].slice(0, lines[ti].indexOf(' ')), from, to };
}

// --since and --from as given, or for --since handover the newest handover's window and old commit, which
// every later move of main needs checked (050 2.7): a fixed window misses the move, and one that starts
// after the tick before it reads the handover as following no tick.
export function resolveWindow(a, lines) {
  if (a.since !== 'handover') {
    if (Number.isNaN(Date.parse(a.since))) throw new Error('--since is not an ISO time: ' + a.since);
    return { since: a.since, from: a.from };
  }
  const h = newestHandover(lines);
  if (!h) throw new Error('--since handover: no handover in supervisor.log');
  if (!h.since) throw new Error('--since handover: no tick before the newest handover');
  return { since: h.since, from: a.from ?? h.from };
}

// Pure: tick gaps in minutes, the trailing gap to now included.
export function gaps(tickTimes, now) {
  const all = tickTimes.length ? [...tickTimes, now] : [];
  return all.slice(1).map((t, i) => (t - all[i]) / 60_000);
}

// Pure: the report and the failures for what read() gathered. o holds the options as numbers, with
// takeovers null when --takeovers was not given.
export function evaluate(s, o) {
  const parsed = parseLog(s.lines);
  const tickGaps = gaps([...(s.before != null ? [s.before] : []), ...s.ticks.map((t) => t.at)], s.now);
  const worst = tickGaps.length ? Math.max(...tickGaps) : null;
  const newest = s.ticks.at(-1) ?? null;
  const ranBy = newest?.code ?? (parsed.restartAfterMove ? s.deploy : parsed.moves.at(-1)?.to ?? s.deploy);
  const short = (c) => String(c).slice(0, 7);
  const f = [...parsed.problems];
  if (s.main !== s.expect) f.push('local main at ' + short(s.main) + ', expected ' + short(s.expect));
  if (s.deploy !== s.expect) f.push('deploy worktree at ' + short(s.deploy) + ', expected ' + short(s.expect));
  if (!s.lockAlive) f.push('the lock names pid ' + s.lockPid + ', which is not a live node process');
  else if (s.lockCommand != null && !isSupervisor(s.lockCommand, s.code)) f.push('the lock names pid ' + s.lockPid + ', a node process that is not the supervisor: ' + s.lockCommand);
  if (s.taskState !== 'Running') f.push('task ' + o.task + ' is ' + (s.taskState || 'missing') + ', expected Running');
  if (s.version !== o.version) f.push('ledger user_version ' + s.version + ', expected ' + o.version);
  if (!newest) f.push('no supervisor.tick event since ' + o.since);
  if (worst != null && worst > o.gapMin) f.push('a ' + worst.toFixed(1) + ' min gap between supervisor ticks (the last gap runs to now)');
  if (newest && !s.expect.startsWith(ranBy)) f.push('the newest tick ran ' + short(ranBy) + ', expected ' + short(s.expect));
  if (parsed.moves.length !== o.moves) f.push(parsed.moves.length + ' handovers since ' + o.since + ', expected ' + o.moves);
  if (o.moves > 0 && parsed.moves.length && !parsed.restartAfterMove && !s.expect.startsWith(parsed.moves.at(-1).to)) f.push('the newest handover moved to ' + parsed.moves.at(-1).to + ', expected ' + short(s.expect));
  if (s.from && parsed.moves.length && !s.from.startsWith(parsed.moves[0].from)) f.push('the first handover started at ' + parsed.moves[0].from + ', expected ' + short(s.from));
  if (parsed.restarts !== o.restarts) f.push(parsed.restarts + ' restarts since ' + o.since + ', expected ' + o.restarts);
  if (parsed.imports !== o.imports) f.push(parsed.imports + ' approval import lines since ' + o.since + ', expected ' + o.imports);
  if (o.takeovers != null && s.takeovers.length !== o.takeovers) f.push(s.takeovers.length + ' takeover events, expected ' + o.takeovers);
  if (o.takeovers != null && o.takeovers > 0 && s.takeovers.length && s.takeovers.at(-1).to !== s.expect) f.push('the newest takeover event names ' + s.takeovers.at(-1).to + ', expected ' + s.expect);
  const report = { main: short(s.main), deploy: short(s.deploy), expect: short(s.expect), lockPid: s.lockPid, lockAlive: s.lockAlive, taskState: s.taskState, version: s.version, takeovers: s.takeovers, tickBeforeSince: s.before != null ? new Date(s.before).toISOString() : null, ticks: s.ticks.length, worstGapMin: worst, trailingGapMin: tickGaps.at(-1) ?? null, ranBy: short(ranBy), moves: parsed.moves, restarts: parsed.restarts, imports: parsed.imports, logLinesSince: s.lines.slice(-12) };
  return { report, failures: f };
}

const taskStateOf = (task) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-ScheduledTask -TaskName ' + JSON.stringify(task).replace(/"/g, "'") + ' -ErrorAction SilentlyContinue).State'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return '';
  }
};

// Pure: whether a command line is the supervisor: node running bin/fsw.mjs run, or anything started from
// the deploy worktree (scripts/task.ps1 runs node "<code>\bin\fsw.mjs" run). Paths compare case-insensitively.
export function isSupervisor(commandLine, codeDir) {
  const c = String(commandLine ?? '').toLowerCase().replace(/\//g, '\\');
  if (/bin\\fsw\.mjs"?\s+run(\s|$)/.test(c)) return true;
  return Boolean(codeDir) && c.includes(String(codeDir).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '') + '\\');
}

// The command line of a live pid (Win32_Process), or null when it cannot be read.
export const commandLineOf = (pid) => {
  if (!Number.isInteger(pid)) return null;
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CommandLine'], { encoding: 'utf8', windowsHide: true }).trim() || null;
  } catch {
    return null;
  }
};

// Everything the check reads: the refs, the lock, the task, the ledger and supervisor.log since --since.
export function read(a, now = Date.now(), { commandLine = commandLineOf } = {}) {
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  const since = Date.parse(a.since);
  const lockFile = join(a.instance, 'run', 'supervisor.pid');
  const lockPid = existsSync(lockFile) ? Number.parseInt(readFileSync(lockFile, 'utf8'), 10) : null;
  const db = new DatabaseSync(join(a.instance, 'ledger.sqlite'), { readOnly: true });
  let version, takeovers, ticks, before;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    version = db.prepare('PRAGMA user_version').get().user_version;
    takeovers = db.prepare("SELECT at, payload FROM events WHERE kind = 'takeover' ORDER BY id").all().map((r) => ({ at: r.at, ...JSON.parse(r.payload ?? '{}') }));
    ticks = db.prepare("SELECT at, payload FROM events WHERE kind = 'supervisor.tick' AND at >= ? ORDER BY at").all(new Date(since).toISOString()).map((r) => ({ at: Date.parse(r.at), code: JSON.parse(r.payload ?? '{}')?.code ?? null }));
    const prior = db.prepare("SELECT at FROM events WHERE kind = 'supervisor.tick' AND at < ? ORDER BY at DESC LIMIT 1").get(new Date(since).toISOString());
    before = prior ? Date.parse(prior.at) : null;
  } finally {
    db.close();
  }
  const log = join(a.instance, 'logs', 'supervisor.log');
  const lines = existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => timeOf(l) >= since) : [];
  return {
    now,
    expect: git(a.repo, 'rev-parse', a.expect),
    from: a.from ? git(a.repo, 'rev-parse', a.from) : null,
    main: git(a.repo, 'rev-parse', 'refs/heads/main'),
    deploy: git(a.code, 'rev-parse', 'HEAD'),
    lockPid,
    lockAlive: pidAlive(lockPid),
    lockCommand: pidAlive(lockPid) ? commandLine(lockPid) : null,
    code: a.code,
    taskState: taskStateOf(a.task),
    version,
    takeovers,
    before,
    ticks,
    lines,
  };
}

export const OPTIONS = { repo: { type: 'string' }, code: { type: 'string' }, instance: { type: 'string' }, since: { type: 'string' }, expect: { type: 'string' }, version: { type: 'string' }, from: { type: 'string' }, 'gap-min': { type: 'string', default: '8' }, moves: { type: 'string', default: '0' }, restarts: { type: 'string', default: '0' }, imports: { type: 'string', default: '0' }, takeovers: { type: 'string' }, task: { type: 'string', default: 'fsw-supervisor' } };

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  let a;
  try {
    a = parseArgs({ options: OPTIONS }).values;
    for (const k of ['repo', 'code', 'instance', 'since', 'expect', 'version']) if (!a[k]) throw new Error('--' + k + ' is required');
    const log = join(a.instance, 'logs', 'supervisor.log');
    Object.assign(a, resolveWindow(a, existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/) : []));
  } catch (err) {
    console.error('takeover-check: ' + err.message + '\nusage: takeover-check.mjs --repo <repo> --code <deploy worktree> --instance <instance> --since <ISO|handover> --expect <commit> --version <n> [--from <commit>] [--gap-min 8] [--moves 0] [--restarts 0] [--imports 0] [--takeovers <n>] [--task fsw-supervisor]');
    process.exit(2);
  }
  const o = { since: a.since, task: a.task, version: Number(a.version), gapMin: Number(a['gap-min']), moves: Number(a.moves), restarts: Number(a.restarts), imports: Number(a.imports), takeovers: a.takeovers == null ? null : Number(a.takeovers) };
  const { report, failures } = evaluate(read(a), o);
  console.log(JSON.stringify({ ...report, failures }, null, 1));
  process.exit(failures.length ? 1 : 0);
}
