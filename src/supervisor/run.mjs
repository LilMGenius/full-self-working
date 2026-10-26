// The supervisor (docs/DESIGN.md, The loop and Scheduling). runTick is one pass over the due jobs;
// runSupervisor is the daemon: a pid lock, a sleep hold, the BrowserSkill keeper and one tick on every
// 5-minute Seoul mark. A platform's pass is the loop step (src/loop/step.mjs); every job and platform
// result, failures included, goes to the ledger events and logs/events-*.jsonl.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dayKey } from '../core/clock.mjs';
import { loadInstance, repoRoot } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { logEvent } from '../core/log.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { effectiveMode } from '../core/settings.mjs';
import { importApprovals } from '../core/approvals-import.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { answeredServices } from '../economics/catalog.mjs';
import { latestTable, refreshPriceTable } from '../economics/price-table.mjs';
import { marketPlatforms, sampleMarket } from '../economics/sampling.mjs';
import { SAMPLERS, hasSurface } from '../surface/index.mjs';
import { withMarketPage } from '../surface/owned-page.mjs';
import { applyEffects, step } from '../loop/index.mjs';
import { startAllowed, sweep } from '../deal/index.mjs';
import { startDue } from '../work/index.mjs';
import { dueJobs, JOBS, nextWake } from './schedule.mjs';
import { createBrowserKeeper, holdAwake } from './keepalive.mjs';
import { writeSupply } from './supply.mjs';

export { effectiveMode };
export { MAX_THREADS_PER_PLATFORM } from '../loop/index.mjs';

// A platform that signed out is signed in again from the logins file config logins names
// ({<platform>: {method: 'email', email, password}}, kept outside the repository), at most once an hour,
// so a wrong password or a page that asks for a human check cannot lock the account by retrying. The
// values go only into the platform's form; the event records whether the sign-in worked (36400c4). The
// loop step calls it through its ctx when a surface reports no login.
// The attempt is recorded whether signIn returns or throws, since a throw after the form was sent (a
// click or tool timeout) has already submitted the password; any text the page or tool returns has the
// password cut out before it is stored or thrown on.
export const SIGN_IN_GAP_MS = 60 * 60_000;

export async function signInAgain({ id, surface, instance, ledger, now }) {
  if (typeof surface.signIn !== 'function') return null;
  const file = instance.config?.logins;
  if (!file || !existsSync(file)) return null;
  const login = JSON.parse(readFileSync(file, 'utf8'))[id];
  if (login?.method !== 'email' || !login.email || !login.password) return null;
  const last = ledger.db.prepare("SELECT at FROM events WHERE kind = 'platform.sign_in' AND platform = ? ORDER BY id DESC LIMIT 1").get(id);
  if (last && now.getTime() - Date.parse(last.at) < SIGN_IN_GAP_MS) return null;
  const scrub = (s) => (s == null ? null : String(s).split(login.password).join('[password]'));
  let r;
  try {
    r = await surface.signIn({ email: login.email, password: login.password });
  } catch (err) {
    const message = scrub(err.message);
    ledger.addEvent({ at: now.toISOString(), kind: 'platform.sign_in', platform: id, payload: { ok: false, code: err.code ?? null, reason: message } });
    throw Object.assign(new Error(message), { code: err.code ?? null });
  }
  ledger.addEvent({ at: now.toISOString(), kind: 'platform.sign_in', platform: id, payload: { ok: r?.signedIn === true, reason: scrub(r?.reason) } });
  return r?.signedIn === true ? surface.login() : null;
}

// fsw run exits with this code when newer code should take over; the scheduled task's launcher starts it
// again at once (scripts/task.ps1).
export const RESTART_EXIT = 75;

export const runDir = (instance) => join(instance.dir, 'run');
const lockFile = (instance) => join(runDir(instance), 'supervisor.pid');
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

// ---- pid lock ----

// A pid answers process.kill(pid, 0) while some process holds it. Windows recycles pids quickly, so a
// lock left by a crash before a reboot can name an unrelated process; on Windows the image must also be
// node.exe for the holder to count as a live supervisor.
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  if (process.platform !== 'win32') return true;
  const out = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /^"node\.exe"/im.test(out);
}

export function readLock(instance) {
  const file = lockFile(instance);
  if (!existsSync(file)) return null;
  const pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
  return { file, pid: Number.isInteger(pid) ? pid : null };
}

// Takes the lock for pid, or reports who holds it. A lock whose pid is not alive is stale and taken over.
export function acquireLock(instance, { pid = process.pid, alive = pidAlive } = {}) {
  const file = lockFile(instance);
  mkdirSync(runDir(instance), { recursive: true });
  let stale = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, pid + '\n');
      closeSync(fd);
      return { acquired: true, pid, tookOverFrom: stale };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = readLock(instance);
      if (held?.pid === pid) return { acquired: true, pid, tookOverFrom: null };
      if (held?.pid && alive(held.pid)) return { acquired: false, heldBy: held.pid };
      stale = held?.pid ?? null;
      unlinkSync(file);
    }
  }
  return { acquired: false, heldBy: readLock(instance)?.pid ?? null };
}

export function releaseLock(instance, pid = process.pid) {
  const held = readLock(instance);
  if (held?.pid === pid) unlinkSync(held.file);
}

// ---- jobs ----

const latestPriceRows = (instance) => latestTable(instance.paths.pricing)?.table.rows ?? [];

// One market run over the configured platforms of a cadence (config.market.cadence), each through its
// market engine (withMarketPage).
async function marketJob(ctx, cadence) {
  const ids = marketPlatforms(ctx.instance.config, cadence, SAMPLERS);
  if (!ids.length) return { status: 'skipped', detail: 'no platform samples on the ' + cadence + ' cadence' };
  const r = await sampleMarket(ctx.instance, { platforms: ids, samplers: SAMPLERS, withPage: ctx.withPage ?? withMarketPage, log: ctx.log });
  return { status: r.exitCode === 0 ? 'ok' : 'partial', sampled: ids, written: r.written, entries: r.entries.length, errors: r.errors };
}

function pollTargets(instance) {
  return Object.entries(instance.config.platforms ?? {}).filter(([, p]) => p.enabled && (p.mode === 'draft' || p.mode === 'auto')).map(([id]) => id);
}

// One loop step per platform, in parallel, each on its own surface session (architect D13).
async function runPlatforms(ids, ctx) {
  const priceTable = latestPriceRows(ctx.instance);
  const results = await Promise.all(ids.map((id) => step(id, { ...ctx, priceTable, signInAgain })));
  for (const r of results) record(ctx, 'supervisor.platform', r.platform, r);
  const failed = results.filter((r) => r.status === 'failed');
  return { status: failed.length ? (failed.length === results.length ? 'failed' : 'partial') : 'ok', platforms: results };
}

// Job handlers print through ctx.log and return {status, ...detail}; status is ok, partial, failed or
// skipped. The ids are the lastRuns keys of run/state.json and never change (D14).
export const JOB_HANDLERS = {
  // Supervisor self-check, the BrowserSkill keeper, the read pass on observe platforms, and the lead
  // supply report (architect D18, shipped here by the 000 amendment).
  async hourly(ctx) {
    const self = { pid: process.pid, uptimeMin: Math.round(process.uptime() / 60), rssMB: Math.round(process.memoryUsage().rss / 1048576), ledgerEvents: ctx.ledger.counts().events };
    // The tick checked the keeper before its first job (runTick, b2ec31d); the hourly job reports that check.
    const browser = ctx.browser ?? { status: 'no keeper' };
    // Observe platforms are not polled every 5 minutes, so their login and read pass runs here.
    const observeIds = Object.entries(ctx.instance.config.platforms ?? {}).filter(([, q]) => q.enabled && q.mode === 'observe').map(([id]) => id);
    const observed = observeIds.length ? await runPlatforms(observeIds, ctx) : { status: 'ok', platforms: [] };
    const supply = await writeSupply({ instance: ctx.instance, ledger: ctx.ledger, now: ctx.now, ...(ctx.openSurface ? { openSurface: ctx.openSurface } : {}) });
    const bad = ['daemon start failed', 'no daemon', 'keeper check failed'].includes(browser.status) || observed.status !== 'ok' || supply.status !== 'ok';
    return { status: bad ? 'partial' : 'ok', self, browser, observe: observed.platforms.map((q) => ({ platform: q.platform, status: q.status })), supply: { file: supply.file, platforms: supply.reports.map((r) => ({ platform: r.platform, status: r.status, awaitingReply: r.awaitingReply })) } };
  },
  async poll(ctx) {
    const ids = pollTargets(ctx.instance);
    if (!ids.length) return { status: 'skipped', detail: 'no platform in draft or auto mode' };
    return runPlatforms(ids, ctx);
  },
  // Ledger only, right after the poll: effects a crash lost come back (deal sweep), then paid and
  // revision jobs start within jobs.maxParallel. Delivery planning and closing happen in the deal when the
  // run and the money signals arrive.
  async orders(ctx) {
    const { instance, ledger } = ctx;
    const applied = await applyEffects(sweep(ledger, { instance }), { instance, ledger, spawnJob: ctx.spawnJob, notify: ctx.notify });
    const start = await startDue({ instance, ledger, ...(ctx.spawnJob ? { spawnJob: ctx.spawnJob } : {}), ...(ctx.notify ? { notify: ctx.notify } : {}), startAllowed: (job, recipe) => startAllowed(job, ledger, loadDescriptor(job.platform), recipe) });
    const failed = applied.filter((a) => a.error);
    return { status: failed.length ? 'partial' : 'ok', planned: applied.filter((a) => a.type === 'plan_outbox').length, ...start };
  },
  async projects(ctx) {
    const { projectsJob } = await import('../projects/job.mjs');
    return projectsJob(ctx);
  },
  // The daily market slot samples the day-cadence platforms and the hourly slice the hour-cadence ones.
  async market(ctx) {
    return marketJob(ctx, 'day');
  },
  async 'market-hour'(ctx) {
    return marketJob(ctx, 'hour');
  },
  // Each row's adapter flag says whether this build has a surface for its platform.
  async price(ctx) {
    const r = await refreshPriceTable(ctx.instance, { adapterFor: hasSurface, log: ctx.log });
    return { status: 'ok', written: r.written, rows: r.rows.length, viable: r.rows.filter((x) => x.viable).length };
  },
  async allocation(ctx) {
    const [{ armStats }, { allocate }, services] = await Promise.all([
      import('../economics/yield.mjs'),
      import('../economics/allocate.mjs'),
      import('../economics/services.json', { with: { type: 'json' } }).then((m) => m.default),
    ]);
    const enabled = Object.entries(ctx.instance.config.platforms ?? {}).filter(([, q]) => q.enabled).map(([id]) => id);
    const descriptors = Object.fromEntries(enabled.map((id) => [id, loadDescriptor(id)]));
    // A catalog service a platform does not answer (config platforms.<id>.services) gets no arm there (14d2f17).
    const arms = armStats(ctx.ledger, { descriptors, services, config: ctx.instance.config })
      .filter((a) => !(a.service in services) || answeredServices(ctx.instance.config, a.platform, services).includes(a.service));
    const weights = allocate(arms, { priceTable: latestPriceRows(ctx.instance), config: ctx.instance.config });
    const file = join(ctx.instance.paths.pricing, 'allocation-' + dayKey(ctx.now) + '.json');
    mkdirSync(ctx.instance.paths.pricing, { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify({ at: ctx.now.toISOString(), weights }, null, 2) + '\n');
    renameSync(file + '.tmp', file);
    return { status: 'ok', file, arms: weights.filter((w) => w.weight > 0).length };
  },
  async portfolio(ctx) {
    const { syncPortfolio } = await import('../portfolio/store.mjs');
    return { status: 'ok', shown: syncPortfolio(ctx.instance, ctx.ledger).length };
  },
  async publish(ctx) {
    // A forced observe pass is read-only, and a deploy is an outbound action; keepDue leaves the period
    // open so the first unforced tick still deploys today.
    if (ctx.forceMode === 'observe') return { status: 'skipped', detail: 'FSW_FORCE_MODE=observe skips the site deploy', keepDue: true };
    const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'publish.mjs')], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 15 * 60_000 });
    const tail = (r.stdout + r.stderr).trim().split('\n').slice(-5).join('\n');
    return { status: r.status === 0 ? 'ok' : 'failed', exitCode: r.status, detail: tail };
  },
  // Cases into lessons, then the playbook and learned gate rules (src/cli/learn.mjs:6-16 at 2c77326 folded in).
  async learn(ctx) {
    const [{ writeLessons }, { refreshPlaybook }] = await Promise.all([import('../learning/lessons.mjs'), import('../learning/playbook.mjs')]);
    const lessons = await writeLessons(ctx.instance, ctx.runCodex ? { runCodex: ctx.runCodex } : {});
    const pb = await refreshPlaybook(ctx.instance, ctx.runCodex ? { runCodex: ctx.runCodex } : {});
    return { status: 'ok', lessons: lessons.lessons.length, newCases: lessons.newCases, rules: pb.rules.length, refused: pb.rejected.length, playbookChanged: pb.playbookChanged };
  },
  async digest(ctx) {
    const { writeDigest } = await import('./digest.mjs');
    const d = await writeDigest({ instance: ctx.instance, ledger: ctx.ledger, now: ctx.now, ...(ctx.notify ? { notify: ctx.notify } : {}) });
    return { status: 'ok', file: d.file, notified: d.notified };
  },
  // Hourly: reads /my-gigs for every published gig; a gig on sale is announced once, a rejected one is
  // recorded as a learning case and rebuilt from kmong's notice.
  async listings(ctx) {
    const { listingsWatch } = await import('../listings/watch.mjs');
    return listingsWatch(ctx);
  },
  // Daily after the portfolio job: rebuilds a gig on sale whose top portfolio items changed.
  async 'listings-refresh'(ctx) {
    const { listingsRefresh } = await import('../listings/watch.mjs');
    return listingsRefresh(ctx);
  },
};

function record(ctx, kind, ref, payload) {
  const platform = payload.platform ?? null;
  ctx.ledger.addEvent({ kind, platform, ref, payload });
  logEvent(ctx.instance, kind, { ref, ...payload });
}

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
