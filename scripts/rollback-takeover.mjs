#!/usr/bin/env node
// node scripts/rollback-takeover.mjs --repo <repo> --code <deploy worktree> --instance <instance> --old <commit> --from <commit> [--task fsw-supervisor] [--abort-after-min 6] [--apply]
// The scripted rollback to the 2c77326 line (003 "Verifier and recovery scripts"; 050 2.5 and section 4,
// A5). Waiting on the launcher is too slow: after a crash it sleeps five minutes (scripts/task.ps1) and the
// task ignores a second trigger (MultipleInstances IgnoreNew). So: stop the task and the lock holder, write
// the approval outcomes back (A2), move main from --from to --old with a compare-and-swap (detaching the
// main checkout first when it has main checked out, and switching it back after, so its index and files
// follow main and the next fast-forward is not refused), check --old out in the deploy worktree, start the
// task, and prove a live lock and a fresh supervisor.tick. Everything after the task stops runs under
// try/finally, so a step that throws still starts the task, and a rerun whose main already is --old skips
// the compare-and-swap. Until the write-back has finished and main names --old, the old line is never
// started: the old code sends every approved file and every budget-deferred open quote it finds, so
// starting it over files v0 did not update would send them a second time, which is worse than a failed
// rollback, and with main still at --from (someone moved main, so the compare-and-swap failed) the old
// supervisor would hand over to v0 again after one tick; a failure before that point checks --from out
// again, starts the task (v0 keeps running) and exits 2 naming the step.
// Without --apply it prints the nine steps and runs nothing. Exit 0: rolled back and live; 1: live on the
// old line, but a later step failed and is named; 2: the write-back or the compare-and-swap of main did
// not finish (v0 restarted on
// --from), or no live lock with a fresh tick within --abort-after-min of the newest supervisor.tick before
// the rollback began, so the gap takeover-check measures stays under its eight minutes, or the task did not
// start on a second try (the failure is printed); 3: a usage error, or the task is missing or disabled, in
// which case nothing was stopped, since a stopped supervisor no task can start stays down.
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pidAlive } from '../src/supervisor/run.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim();

// Pure: the ordered steps, printed in a dry run and run in order under --apply.
export const steps = ({ repo, code, instance, old, from, task }) => [
  ['stop the task', 'Stop-ScheduledTask -TaskName ' + task + ' (first checks that the task exists and is not Disabled; refuses with nothing stopped otherwise)'],
  ['stop the lock holder', 'Stop-Process -Id <pid in ' + join(instance, 'run', 'supervisor.pid') + '> -Force, then remove that lock file while it still names the stopped pid'],
  ['write approval outcomes back', 'node scripts/approvals-writeback.mjs --instance ' + instance + ' --apply'],
  ['leave main in the main checkout', 'git -C ' + repo + ' switch --detach --quiet (only when step 5 runs and symbolic-ref -q HEAD is refs/heads/main)'],
  ['move main back', 'git -C ' + repo + ' update-ref -m rollback refs/heads/main ' + old + ' ' + from + ' (skipped when refs/heads/main already is ' + old + ', so a rerun changes nothing)'],
  ['return the main checkout to main', 'git -C ' + repo + ' switch --quiet main (only when step 4 detached it, in a finally of its own)'],
  ['check out the old line', 'git -C ' + code + ' checkout --detach --quiet ' + old + ' (always: finally after step 1; ' + from + ' instead when steps 2, 3 or 5 failed, so the old code never starts over files the write-back did not update or while main still names ' + from + ')'],
  ['start the task', 'Start-ScheduledTask -TaskName ' + task + ' (always: finally after step 1; retried once, exit 2 with the failure when both fail)'],
  ['prove a live lock and a fresh tick', 'poll ' + join(instance, 'run', 'supervisor.pid') + ' and supervisor.tick until --abort-after-min after the newest tick'],
];

// The real side effects; test/rollback-takeover.test.mjs passes its own task controller and clock.
// Removes <instance>/run/supervisor.pid when its first line still names pid, so a pid Windows hands to
// another node process cannot make the old acquireLock answer already running. Returns whether it did.
export function removeLockOf(instance, pid) {
  const file = join(instance, 'run', 'supervisor.pid');
  if (!existsSync(file) || Number.parseInt(readFileSync(file, 'utf8'), 10) !== pid) return false;
  unlinkSync(file);
  return true;
}

export const realIo = (a) => ({
  ps,
  removeLock: (pid) => removeLockOf(a.instance, pid),
  // The task's state, '' when it does not exist.
  taskState: (name) => ps('(Get-ScheduledTask -TaskName ' + "'" + name.replace(/'/g, "''") + "'" + ' -ErrorAction SilentlyContinue).State'),
  git: (args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim(),
  gitQuiet: (args) => spawnSync('git', args, { encoding: 'utf8', windowsHide: true }),
  writeback: () => spawnSync(process.execPath, [fileURLToPath(new URL('./approvals-writeback.mjs', import.meta.url)), '--instance', a.instance, '--apply'], { encoding: 'utf8', windowsHide: true }),
  // The newest supervisor.tick, or the newest after since.
  lastTick: (since) => {
    const db = new DatabaseSync(join(a.instance, 'ledger.sqlite'), { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      return (since ? db.prepare("SELECT at FROM events WHERE kind = 'supervisor.tick' AND at > ? ORDER BY at DESC LIMIT 1").get(since) : db.prepare("SELECT at FROM events WHERE kind = 'supervisor.tick' ORDER BY at DESC LIMIT 1").get())?.at ?? null;
    } finally {
      db.close();
    }
  },
  pidNow: () => {
    const lockFile = join(a.instance, 'run', 'supervisor.pid');
    return existsSync(lockFile) ? Number.parseInt(readFileSync(lockFile, 'utf8'), 10) : null;
  },
  alive: pidAlive,
  sleep,
  now: () => Date.now(),
  log: console.log,
});

export async function runRollback(a, io) {
  const t0 = io.now();
  const say = (m) => io.log(((io.now() - t0) / 1000).toFixed(0) + 's ' + m);
  const abortMs = Number(a['abort-after-min']) * 60_000;
  // The deadline counts from the last tick, the start of the gap takeover-check measures; when that is
  // already past, the rollback still runs and waits one more --abort-after-min, and the gap check fails.
  const lastTick = io.lastTick(null);
  const deadline = (lastTick ? Date.parse(lastTick) : t0) + abortMs;
  const until = deadline > t0 ? deadline : t0 + abortMs;
  const state = io.taskState(a.task);
  if (!state || state === 'Disabled') {
    say('task ' + a.task + ' is ' + (state || 'missing') + '; nothing was stopped, since no task could start a supervisor again');
    return 3;
  }
  io.ps('Stop-ScheduledTask -TaskName ' + a.task + ' -ErrorAction SilentlyContinue');
  say('task stopped');
  let oldPid = null;
  let failed = null;
  let startedAt = null;
  let startFailed = null;
  // True once the write-back finished and main names --old; until then the old line must not start: over
  // files the write-back did not update it would send them again, and with main still at --from it would
  // hand over to v0 again after one tick (see the header).
  let switched = false;
  try {
    oldPid = io.pidNow();
    if (io.alive(oldPid)) {
      io.ps('Stop-Process -Id ' + oldPid + ' -Force');
      say('lock holder ' + oldPid + ' stopped' + (io.removeLock(oldPid) ? ', its lock file removed' : ''));
    } else say('lock holder ' + oldPid + ' not running');
    const wb = io.writeback();
    if (wb.stdout) io.log(wb.stdout.trimEnd());
    if (wb.status !== 0) throw new Error('write approval outcomes back: ' + (wb.stderr || 'exit ' + wb.status));
    if (io.git(['-C', a.repo, 'rev-parse', 'refs/heads/main']) === a.old) {
      say('main already at ' + a.old.slice(0, 7) + '; compare-and-swap skipped');
      switched = true;
    } else {
      const onMain = io.gitQuiet(['-C', a.repo, 'symbolic-ref', '-q', 'HEAD']).stdout.trim() === 'refs/heads/main';
      if (onMain) io.git(['-C', a.repo, 'switch', '--detach', '--quiet']);
      try {
        try {
          io.git(['-C', a.repo, 'update-ref', '-m', 'rollback: main to the archive tip', 'refs/heads/main', a.old, a.from]);
        } catch (err) {
          throw new Error('main moved: the compare-and-swap from ' + a.from.slice(0, 7) + ' to ' + a.old.slice(0, 7) + ' failed: ' + err.message);
        }
        switched = true;
      } finally {
        if (onMain) io.git(['-C', a.repo, 'switch', '--quiet', 'main']);
      }
      say('main' + (onMain ? ' and the main checkout' : '') + ' at ' + a.old.slice(0, 7));
    }
  } catch (err) {
    failed = err.message;
    say('step failed: ' + failed);
  } finally {
    // Whatever failed above, a supervisor comes back rather than staying down: the old line once the
    // write-back finished and main names it, else v0 on --from.
    const line = switched ? a.old : a.from;
    try {
      io.git(['-C', a.code, 'checkout', '--detach', '--quiet', line]);
      say('deploy worktree at ' + line.slice(0, 7) + (switched ? '' : ' (--from: the rollback did not get past the write-back and main)'));
    } catch (err) {
      failed ??= 'check out ' + line.slice(0, 7) + ': ' + err.message;
      say('check out ' + line.slice(0, 7) + ' failed: ' + err.message);
    }
    startedAt = new Date(io.now()).toISOString();
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        io.ps('Start-ScheduledTask -TaskName ' + a.task);
        say('task started' + (attempt > 1 ? ' on the second try' : ''));
        startFailed = null;
        break;
      } catch (err) {
        startFailed = 'start the task: ' + err.message;
        say('start the task failed (try ' + attempt + ' of 2): ' + err.message);
      }
    }
  }
  if (startFailed) {
    say('no supervisor runs: ' + startFailed + (failed ? '; earlier ' + failed : '') + '; start it by hand (Start-ScheduledTask ' + a.task + ')');
    return 2;
  }
  if (deadline <= t0) say('the last tick at ' + lastTick + ' is already ' + a['abort-after-min'] + ' min old; waiting until ' + new Date(until).toISOString());
  while (io.now() < until) {
    await io.sleep(5000);
    const pid = io.pidNow();
    const tick = io.lastTick(startedAt);
    if (pid !== oldPid && io.alive(pid) && tick) {
      if (!switched) {
        say('pid ' + pid + ' holds the lock and ticked at ' + tick + ' on ' + a.from.slice(0, 7) + '; not rolled back: ' + failed);
        return 2;
      }
      say('pid ' + pid + ' holds the lock and ticked at ' + tick + (failed ? '; but ' + failed : '; rollback done'));
      return failed ? 1 : 0;
    }
  }
  say('no live lock with a fresh tick within ' + a['abort-after-min'] + ' min of the last tick (' + lastTick + ')' + (failed ? '; ' + failed : '') + (switched ? '; restore by hand from the ledger snapshot (050 section 4)' : '; not rolled back, the deploy worktree is at ' + a.from.slice(0, 7)));
  return 2;
}

export const OPTIONS = { repo: { type: 'string' }, code: { type: 'string' }, instance: { type: 'string' }, old: { type: 'string' }, from: { type: 'string' }, task: { type: 'string', default: 'fsw-supervisor' }, 'abort-after-min': { type: 'string', default: '6' }, apply: { type: 'boolean', default: false } };

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  let a;
  try {
    a = parseArgs({ options: OPTIONS }).values;
    for (const k of ['repo', 'code', 'instance', 'old', 'from']) if (!a[k]) throw new Error('--' + k + ' is required');
    if (!/^[0-9a-f]{40}$/.test(a.old) || !/^[0-9a-f]{40}$/.test(a.from)) throw new Error('--old and --from take full 40-character commit ids, since the compare-and-swap compares them with refs/heads/main');
  } catch (err) {
    console.error('rollback-takeover: ' + err.message);
    process.exit(3);
  }
  if (!a.apply) {
    steps(a).forEach(([what, cmd], i) => console.log(i + 1 + '. ' + what + ': ' + cmd));
    process.exit(0);
  }
  process.exit(await runRollback(a, realIo(a)));
}
