// The supervisor (docs/DESIGN.md, The loop and Scheduling). runTick is one pass over the due jobs;
// runSupervisor is the daemon: a pid lock, a sleep hold, the BrowserSkill keeper and one tick on every
// 5-minute Seoul mark. A platform's pass is the loop step (src/loop/step.mjs); every job and platform
// result, failures included, goes to the ledger events and logs/events-*.jsonl.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dayKey } from '../core/clock.mjs';
import { loadInstance, repoRoot } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { effectiveMode } from '../core/settings.mjs';
import { importApprovals } from '../core/approvals-import.mjs';
import { JOB_HANDLERS, record } from './jobs.mjs';
import { acquireLock, releaseLock, runDir } from './lock.mjs';
import { dueJobs, JOBS, nextWake } from './schedule.mjs';
import { createBrowserKeeper, holdAwake } from './keepalive.mjs';

export { effectiveMode };
export { MAX_THREADS_PER_PLATFORM } from '../loop/index.mjs';

// fsw run exits with this code when newer code should take over; the scheduled task's launcher starts it
// again at once (scripts/task.ps1).
export const RESTART_EXIT = 75;

const stateFile = (instance) => join(runDir(instance), 'state.json');

const gitOut = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};

// The code a running supervisor should be on. A process keeps the modules it loaded at start, so newer
// code reaches it only through a restart. Run from a detached worktree (the scheduled task's deploy
// copy), it follows refs/heads/main and runs only committed code; run from a branch checkout (a
// developer's tree), it follows that checkout's HEAD and its files as they are.
export function codeState(cwd = repoRoot) {
  const head = gitOut(cwd, ['rev-parse', 'HEAD']);
  const detached = gitOut(cwd, ['symbolic-ref', '-q', 'HEAD']) === null;
  return { head, detached, target: detached ? gitOut(cwd, ['rev-parse', 'refs/heads/main']) : head };
}

// Loads the supervisor's whole static module graph from disk in a fresh process, so a commit that does
// not even import is never handed the machine.
export function probeNewCode(cwd = repoRoot) {
  const url = pathToFileURL(join(cwd, 'src', 'cli', 'run.mjs')).href;
  const script = 'try { await import(' + JSON.stringify(url) + ') } catch (e) { console.error(String(e?.stack ?? e).split("\\n")[0]); process.exit(1) }';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { ok: r.status === 0, detail: String(r.stderr || r.stdout || r.error?.message || '').trim().split(/\r?\n/)[0] };
}

// Probes a commit in a temporary worktree, so the deploy copy never checks out code that does not import.
export function probeCommit(commit, cwd = repoRoot) {
  const dir = join(tmpdir(), 'fsw-probe-' + process.pid + '-' + Date.now());
  const add = spawnSync('git', ['worktree', 'add', '--detach', dir, commit], { cwd, encoding: 'utf8', windowsHide: true });
  if (add.status !== 0) return { ok: false, detail: 'git worktree add failed: ' + String(add.stderr).trim().split(/\r?\n/)[0] };
  try {
    return probeNewCode(dir);
  } finally {
    if (spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd, windowsHide: true }).status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      spawnSync('git', ['worktree', 'prune'], { cwd, windowsHide: true });
    }
  }
}

// What to do at a tick boundary about the code on disk: keep running while HEAD is where the process
// started or at a commit whose probe already failed, hand over when a newer commit imports cleanly, and
// otherwise keep the running code and record the rejected commit so it is probed once, not every tick.
export function codeHandover({ started, head, rejected, probe }) {
  if (!started || !head || head === started || head === rejected) return { action: 'stay' };
  const p = probe();
  return p.ok ? { action: 'restart' } : { action: 'reject', detail: p.detail };
}

export function readState(instance) {
  const file = stateFile(instance);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { lastRuns: {} };
}

export function writeState(instance, state) {
  mkdirSync(runDir(instance), { recursive: true });
  const file = stateFile(instance);
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, file);
}

// ---- jobs ----

// One pass: every due job in schedule order, each isolated. A job that ran, failed or is not wired has
// had its turn for the period; the period's failure stays in the events for the digest, and the next
// period tries again.
// A platform whose poll keeps failing is invisible while the daemon itself stays healthy: the browser
// extension stalled for 25 minutes on 2026-10-25 and every tick failed quietly. After STUCK_POLLS failed
// polls in a row (half an hour of 5 minute ticks) the operator hears once, with the newest error.
export const STUCK_POLLS = 6;

async function reportStuckPolls(instance, state, summary, now) {
  const polled = summary.jobs.flatMap((j) => j.platforms ?? []);
  if (!polled.length) return;
  const streaks = { ...(state.pollFailures ?? {}) };
  for (const p of polled) streaks[p.platform] = p.status === 'failed' ? (streaks[p.platform] ?? 0) + 1 : 0;
  state.pollFailures = streaks;
  for (const p of polled.filter((x) => x.status === 'failed' && streaks[x.platform] === STUCK_POLLS)) {
    await notifyOperator(instance, {
      kind: 'supervisor',
      title: p.platform + ' failed ' + STUCK_POLLS + ' polls in a row',
      body: 'Newest error: ' + (p.error ?? 'unknown') + '\nA BrowserSkill timeout means the extension in Chrome stalled; reloading the extension or restarting Chrome brings it back, and the next tick reads again.',
      dedupeKey: 'poll-stuck:' + p.platform + ':' + dayKey(now),
    });
  }
}

export async function runTick(ctx = {}) {
  const instance = ctx.instance ?? loadInstance();
  const ownLedger = !ctx.ledger;
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  const now = ctx.now ?? new Date();
  const state = ctx.state ?? readState(instance);
  const forceMode = ctx.forceMode !== undefined ? ctx.forceMode : process.env.FSW_FORCE_MODE ?? null;
  effectiveMode('auto', forceMode);
  const handlers = { ...JOB_HANDLERS, ...ctx.handlers };
  let due = dueJobs(state.lastRuns ?? {}, now, ctx.jobs ?? JOBS);
  if (ctx.only) due = due.filter((d) => ctx.only.includes(d.id));
  // The keeper's daemon is a child of the supervisor that started it and ends with it, so after a code
  // handover nothing answers until a check starts a new one; a tick with work checks before its first job
  // (b2ec31d, which replaced the poll-only check of 0c64cbd).
  // A keeper check that throws (no bsk binary, a status that does not parse) is reported on the tick and
  // in the hourly job, and the jobs still run.
  const browser = due.length && ctx.keeper ? await ctx.keeper.check(now).catch((err) => ({ status: 'keeper check failed', code: err.code ?? null, detail: err.message })) : null;
  const job = { instance, ledger, now, forceMode, keeper: ctx.keeper, browser, log: ctx.log ?? (() => {}), openSurface: ctx.openSurface, decide: ctx.decide, runCodex: ctx.runCodex, spawnJob: ctx.spawnJob, notify: ctx.notify, withPage: ctx.withPage };
  const summary = { at: now.toISOString(), forceMode, jobs: [], ...(browser && browser.status !== 'daemon answering' ? { browser } : {}) };
  try {
    for (const { id, period } of due) {
      const started = Date.now();
      let out;
      try {
        out = await handlers[id](job);
      } catch (err) {
        out = { status: 'failed', error: err.message, code: err.code ?? null };
      }
      const { keepDue, ...rest } = out;
      const entry = { job: id, period, seconds: Math.round((Date.now() - started) / 1000), ...rest };
      record(job, 'supervisor.job', id, entry);
      summary.jobs.push(entry);
      if (!keepDue) state.lastRuns = { ...state.lastRuns, [id]: period };
    }
    summary.failures = summary.jobs.filter((j) => j.status === 'failed').length + summary.jobs.flatMap((j) => j.platforms ?? []).filter((p) => p.status === 'failed').length;
    await reportStuckPolls(instance, state, summary, now);
    record(job, 'supervisor.tick', null, { jobs: summary.jobs.map((j) => j.job + ':' + j.status), failures: summary.failures, forceMode, code: ctx.code ?? null });
    state.lastTick = { at: summary.at, failures: summary.failures };
    if (ctx.persist !== false) writeState(instance, state);
    return summary;
  } finally {
    if (ownLedger) ledger.close();
  }
}

// ---- daemon ----

export async function runSupervisor(ctx = {}) {
  const instance = ctx.instance ?? loadInstance();
  const log = ctx.log ?? ((line) => console.log(new Date().toISOString() + ' ' + line));
  const lock = acquireLock(instance);
  if (!lock.acquired) {
    log('supervisor already running as pid ' + lock.heldBy);
    return { status: 'already running', pid: lock.heldBy };
  }
  log('supervisor pid ' + process.pid + (lock.tookOverFrom ? ', took over the stale lock of pid ' + lock.tookOverFrom : ''));
  const ledger = openLedger(instance.paths.ledger);
  // Once per start, before the first tick: the approval files 2c77326 wrote become outbox rows (010's
  // importApprovals; a second start imports nothing). The files are never written, so a rollback to the
  // old code still reads them (architect D15). A failed import wrote no row (one transaction); the
  // supervisor runs on, says so in its log and to the operator, and the next start tries again.
  try {
    const imp = importApprovals(ledger, instance.paths.approvals);
    log('approvals import read ' + imp.read + ', imported ' + imp.imported + ', already ' + imp.already + ', reconciled ' + imp.reconciled + ', skipped ' + imp.skipped.length + (imp.skipped.length ? ': ' + imp.skipped.map((s) => s.file + ' (' + s.reason + ')').join('; ') : ''));
    if (imp.skipped.length) await (ctx.notify ?? notifyOperator)(instance, { kind: 'supervisor', title: 'Approval files the outbox could not import', body: imp.skipped.map((s) => s.file + ': ' + s.reason).join('\n'), dedupeKey: 'approvals-import:' + dayKey() });
  } catch (err) {
    log('approvals import failed: ' + (err.code ? err.code + ' ' : '') + err.message);
    await (ctx.notify ?? notifyOperator)(instance, { kind: 'supervisor', title: 'The approval import failed', body: err.message, dedupeKey: 'approvals-import:' + dayKey() });
  }
  let awake = null;
  try {
    awake = await (ctx.holdAwake ?? holdAwake)();
    log('sleep hold by pid ' + awake.pid);
  } catch (err) {
    ledger.addEvent({ kind: 'supervisor.keepalive_failed', payload: { code: err.code ?? null, message: err.message } });
    await notifyOperator(instance, { kind: 'supervisor', title: 'The supervisor could not hold the machine awake', body: err.message, dedupeKey: 'keepalive:' + dayKey() });
  }
  const keeper = (ctx.createBrowserKeeper ?? createBrowserKeeper)({ instance });
  let stopping = false;
  let wake = null;
  const stop = (signal) => {
    if (!stopping) log('stopping on ' + signal);
    stopping = true;
    wake?.();
  };
  const cleanup = () => {
    keeper.stop();
    awake?.stop();
    releaseLock(instance);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];
  for (const s of signals) process.on(s, stop);
  process.on('exit', cleanup);
  const code = ctx.codeState ?? codeState;
  const probe = ctx.probe ?? ((commit, at) => (at.detached ? probeCommit(commit) : probeNewCode()));
  const checkout = ctx.checkout ?? ((commit) => gitOut(repoRoot, ['checkout', '--detach', '--quiet', commit]) !== null);
  const tick = ctx.runTick ?? runTick;
  const sleep = ctx.sleep ?? ((ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(t);
      resolve();
    };
  }));
  const started = code().head;
  let rejected = null;
  let restart = false;
  // A timer can fire a few milliseconds before the mark it was set for, and a tick that read the clock then
  // covered the period before the mark: after a restart on 2026-10-26 the first wake found nothing due and
  // every later job ran one mark late. So a tick that woke just short of its mark runs at the mark.
  const clock = ctx.clock ?? Date.now;
  let mark = null;
  try {
    const state = readState(instance);
    let current = instance;
    while (!stopping) {
      // The config is read again every tick, so an operator edit (a mode, a budget) applies at the next
      // mark without a restart. A config that no longer parses keeps the last good one and tells the
      // operator, since stopping would end every platform's replies over one typo.
      if (!ctx.instance) {
        try {
          current = loadInstance();
        } catch (err) {
          log('config reload failed, keeping the last good config: ' + err.message);
          await notifyOperator(instance, { kind: 'supervisor', title: 'The instance config did not load', body: err.message, dedupeKey: 'config:' + dayKey() });
        }
      }
      const early = mark ? mark.getTime() - clock() : 0;
      const now = early > 0 && early < 1000 ? mark : new Date(clock());
      const summary = await tick({ instance: current, ledger, state, keeper, log, forceMode: ctx.forceMode, now, code: started });
      if (summary.jobs.length) log('tick ' + summary.jobs.map((j) => j.job + ':' + j.status).join(' ') + ' failures=' + summary.failures);
      if (stopping || ctx.once) break;
      const at = code();
      const head = at.target;
      let handover = codeHandover({ started, head, rejected, probe: () => probe(head, at) });
      // A deploy worktree moves to the probed commit before handing over; one that cannot move keeps
      // running what it has.
      if (handover.action === 'restart' && at.detached && !checkout(head)) handover = { action: 'reject', detail: 'git checkout of ' + head.slice(0, 7) + ' failed in ' + repoRoot };
      if (handover.action === 'restart') {
        log('code moved from ' + started.slice(0, 7) + ' to ' + head.slice(0, 7) + '; restarting');
        restart = true;
        break;
      }
      if (handover.action === 'reject') {
        rejected = head;
        log('code at ' + head.slice(0, 7) + ' does not load; keeping ' + started.slice(0, 7) + ': ' + handover.detail);
        await notifyOperator(instance, { kind: 'supervisor', title: 'New code does not load; the supervisor keeps running ' + started.slice(0, 7), body: handover.detail, dedupeKey: 'code:' + head });
      }
      mark = nextWake(new Date(clock()));
      await sleep(Math.max(0, mark.getTime() - clock()));
      wake = null;
    }
  } finally {
    for (const s of signals) process.off(s, stop);
    process.off('exit', cleanup);
    cleanup();
    ledger.close();
    log(restart ? 'supervisor exiting for a restart' : 'supervisor stopped');
  }
  return { status: restart ? 'restart' : 'stopped', pid: process.pid };
}
