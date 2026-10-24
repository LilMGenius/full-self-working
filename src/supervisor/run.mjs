// The supervisor (docs/DESIGN.md, The loop and Scheduling). runTick is one pass over the due jobs;
// runSupervisor is the daemon: a pid lock, a sleep hold, the BrowserSkill keeper and one tick on every
// 5-minute Seoul mark. Every job and platform result, failures included, goes to the ledger events and
// logs/events-*.jsonl; a job that is not wired yet is recorded as "not wired", never as done.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dayKey, isActive } from '../core/clock.mjs';
import { loadInstance, repoRoot } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { logEvent } from '../core/log.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { MODES, flushApprovals, processThread } from '../pipeline/thread.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { dueJobs, JOBS, nextWake } from './schedule.mjs';
import { createBrowserKeeper, holdAwake } from './keepalive.mjs';

// One platform reads at most this many threads per tick, so a long backlog cannot hold the tick past
// the next 5-minute mark; the rest wait for the following tick.
export const MAX_THREADS_PER_PLATFORM = 10;

// fsw run exits with this code when newer code should take over; the scheduled task's launcher starts it
// again at once (scripts/task.ps1).
export const RESTART_EXIT = 75;

export const runDir = (instance) => join(instance.dir, 'run');
const lockFile = (instance) => join(runDir(instance), 'supervisor.pid');
const stateFile = (instance) => join(runDir(instance), 'state.json');

// The commit the code on disk comes from. A running process keeps the modules it loaded at start, so a
// newer commit reaches the supervisor only through a restart.
export function codeVersion(cwd = repoRoot) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Loads the supervisor's whole static module graph from disk in a fresh process, so a commit that does
// not even import is never handed the machine.
export function probeNewCode(cwd = repoRoot) {
  const url = pathToFileURL(join(cwd, 'src', 'cli', 'run.mjs')).href;
  const script = 'try { await import(' + JSON.stringify(url) + ') } catch (e) { console.error(String(e?.stack ?? e).split("\\n")[0]); process.exit(1) }';
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { ok: r.status === 0, detail: String(r.stderr || r.stdout || r.error?.message || '').trim().split(/\r?\n/)[0] };
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

// ---- modes ----

const RANK = Object.fromEntries(MODES.map((m, i) => [m, i]));

// FSW_FORCE_MODE can only lower a platform's mode (auto > draft > observe), so an override can make the
// agent read without sending and never makes it send where the instance config does not.
export function effectiveMode(configMode, forceMode) {
  if (forceMode == null || forceMode === '') return configMode;
  if (!MODES.includes(forceMode)) throw new RangeError('FSW_FORCE_MODE must be one of ' + MODES.join(', ') + ', got ' + forceMode);
  return RANK[forceMode] < RANK[configMode] ? forceMode : configMode;
}

// ---- adapters ----

const openerName = (id) => 'open' + id[0].toUpperCase() + id.slice(1);

// Default adapter loader: src/platforms/<id>/adapter.mjs exporting open<Id>(). A missing module or
// export returns null, which the tick reports as "adapter missing".
export async function loadAdapter(id) {
  const file = join(repoRoot, 'src', 'platforms', id, 'adapter.mjs');
  if (!existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  const open = mod[openerName(id)];
  return typeof open === 'function' ? open : null;
}

// Whether a listed item needs a pass this tick: new to the ledger, unread, or newer than what the ledger
// holds. An item parked as skipped at the list time it still shows waits for a newer message.
export const needsWork = (ref, row) => {
  if (!row) return true;
  if (row.meta?.skipped && row.meta.skipped.at === (ref.at ?? null)) return false;
  if (ref.unread) return true;
  if (!ref.at) return false;
  const seen = Math.max(Date.parse(row.lastInboundAt ?? 0) || 0, Date.parse(row.lastOutboundAt ?? 0) || 0);
  return Date.parse(ref.at) > seen;
};

// One platform's pipeline on its own adapter session (one tab): login, inbox, requests, orders, then
// approved items when sending is allowed. A thread that throws is recorded and the next one still runs.
export async function runPlatform(id, ctx) {
  const { instance, ledger, now, priceTable, forceMode, readOnly = false } = ctx;
  const cfg = instance.config.platforms[id];
  const result = { platform: id, configMode: cfg.mode, mode: null, status: 'ok', login: null, threads: {}, errors: [] };
  const open = await (ctx.loadAdapter ?? loadAdapter)(id);
  if (!open) return { ...result, status: 'failed', error: 'adapter missing' };
  let mode = effectiveMode(cfg.mode, forceMode);
  const sendingHours = isActive(now, instance.config.activeHours?.outbound ?? ['00:00', '00:00']);
  // Outside the outbound hours an auto platform only reads, leaving unread threads unread for the
  // first tick inside the window; draft keeps queueing approvals, which sends nothing.
  if (mode === 'auto' && !sendingHours) mode = 'observe';
  result.mode = mode;
  const descriptor = loadDescriptor(id);
  let adapter;
  try {
    adapter = await open();
    result.login = await adapter.login();
    if (!result.login?.loggedIn) {
      await notifyOperator(instance, { kind: 'login', title: id + ' needs a login', body: 'Sign in to ' + descriptor.name + ' in Chrome; the supervisor reads it again on the next tick.', dedupeKey: 'login:' + id + ':' + dayKey(now) });
      return { ...result, status: 'failed', error: 'not logged in' };
    }
    if (readOnly) return result;
    const refs = [];
    for (const source of ['inbox', 'requests']) {
      if (typeof adapter[source] !== 'function') continue;
      const list = await adapter[source]();
      result[source] = list.length;
      refs.push(...list.map((r) => ({ kind: source === 'requests' ? 'request' : 'message', ...r })));
    }
    if (typeof adapter.orders === 'function') {
      const orders = await adapter.orders();
      result.orders = orders.total ?? orders.orders?.length ?? null;
      ledger.addEvent({ kind: 'orders.read', platform: id, payload: { counts: orders.counts ?? null, total: orders.total ?? null, gap: orders.gap ?? null } });
    }
    const known = new Map(ledger.listThreads({ platform: id }).map((t) => [t.externalId, t]));
    const work = refs.filter((r) => needsWork(r, known.get(String(r.id))));
    // The cap bounds pages opened per tick. An item settled from its list row (a notice, a closed or old
    // item, a service outside the catalog) opens nothing, so it does not take one of the slots.
    let opened = 0;
    let done = 0;
    for (const threadRef of work) {
      if (opened >= MAX_THREADS_PER_PLATFORM) break;
      done += 1;
      try {
        const r = await processThread({ platform: id, threadRef, adapter, ledger, instance, descriptor, priceTable, mode, now, ...(ctx.decide ? { decide: ctx.decide } : {}) });
        result.threads[r.action] = (result.threads[r.action] ?? 0) + 1;
        if (r.opened !== false && r.action !== 'pending_approval') opened += 1;
      } catch (err) {
        opened += 1;
        result.errors.push({ ref: String(threadRef.id), code: err.code ?? null, message: err.message });
        ledger.addEvent({ kind: 'thread.error', platform: id, ref: threadRef.id, payload: { code: err.code ?? null, message: err.message } });
        if (err.code === 'FSW_PACING_LIMIT' || err.code === 'FSW_CONFIG_MISSING') break;
      }
    }
    result.deferred = work.length - done;
    if (mode !== 'observe' && sendingHours) result.approvalsSent = (await flushApprovals({ platform: id, adapter, ledger, instance, descriptor })).length;
    if (result.errors.length) result.status = 'partial';
    return result;
  } catch (err) {
    return { ...result, status: 'failed', error: err.message, code: err.code ?? null };
  } finally {
    if (adapter?.stop) await adapter.stop().catch((err) => result.errors.push({ ref: 'stop', message: err.message }));
  }
}

// ---- jobs ----

const notWired = (what) => ({ status: 'not wired', detail: what });

async function latestPriceRows(instance) {
  const { latestTable } = await import('../cli/price.mjs');
  return latestTable(instance.paths.pricing)?.table.rows ?? [];
}

function pollTargets(instance) {
  return Object.entries(instance.config.platforms ?? {}).filter(([, p]) => p.enabled && (p.mode === 'draft' || p.mode === 'auto')).map(([id]) => id);
}

async function runPlatforms(ids, ctx, extra = {}) {
  const priceTable = await latestPriceRows(ctx.instance);
  const results = await Promise.all(ids.map((id) => runPlatform(id, { ...ctx, priceTable, ...extra })));
  for (const r of results) record(ctx, 'supervisor.platform', r.platform, r);
  const failed = results.filter((r) => r.status === 'failed');
  return { status: failed.length ? (failed.length === results.length ? 'failed' : 'partial') : 'ok', platforms: results };
}

// Job handlers print through ctx.log and return {status, ...detail}; status is ok, partial, failed,
// skipped or not wired.
export const JOB_HANDLERS = {
  async hourly(ctx) {
    const self = { pid: process.pid, uptimeMin: Math.round(process.uptime() / 60), rssMB: Math.round(process.memoryUsage().rss / 1048576), ledgerEvents: ctx.ledger.counts().events };
    const browser = ctx.keeper ? await ctx.keeper.check(ctx.now) : { status: 'no keeper' };
    // Observe platforms are not polled every 5 minutes, so their login and read pass runs here.
    const observeIds = Object.entries(ctx.instance.config.platforms ?? {}).filter(([, p]) => p.enabled && p.mode === 'observe').map(([id]) => id);
    const observed = observeIds.length ? await runPlatforms(observeIds, ctx) : { status: 'ok', platforms: [] };
    const status = browser.status === 'daemon start failed' || browser.status === 'no daemon' || observed.status !== 'ok' ? 'partial' : 'ok';
    return { status, self, browser, observe: observed.platforms.map((p) => ({ platform: p.platform, status: p.status })) };
  },
  async poll(ctx) {
    const ids = pollTargets(ctx.instance);
    if (!ids.length) return { status: 'skipped', detail: 'no platform in draft or auto mode' };
    return runPlatforms(ids, ctx);
  },
  async market(ctx) {
    const { run } = await import('../cli/market.mjs');
    const r = await run([], { instance: ctx.instance, log: ctx.log });
    return { status: r.exitCode === 0 ? 'ok' : 'partial', written: r.written, entries: r.entries.length, errors: r.errors };
  },
  async price(ctx) {
    const { run } = await import('../cli/price.mjs');
    const r = await run([], { instance: ctx.instance, log: ctx.log });
    return { status: 'ok', written: r.written, rows: r.rows.length, viable: r.rows.filter((x) => x.viable).length };
  },
  async allocation(ctx) {
    const [{ armStats }, { allocate }, services] = await Promise.all([
      import('../economics/yield.mjs'),
      import('../economics/allocate.mjs'),
      import('../economics/services.json', { with: { type: 'json' } }).then((m) => m.default),
    ]);
    const enabled = Object.entries(ctx.instance.config.platforms ?? {}).filter(([, p]) => p.enabled).map(([id]) => id);
    const descriptors = Object.fromEntries(enabled.map((id) => [id, loadDescriptor(id)]));
    const arms = armStats(ctx.ledger, { descriptors, services, config: ctx.instance.config });
    const weights = allocate(arms, { priceTable: await latestPriceRows(ctx.instance), config: ctx.instance.config });
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
    // A forced observe pass is read-only, and a deploy is an outbound action.
    // keepDue leaves the period open, so the first unforced tick still deploys today.
    if (ctx.forceMode === 'observe') return { status: 'skipped', detail: 'FSW_FORCE_MODE=observe skips the site deploy', keepDue: true };
    const script = join(repoRoot, 'scripts', 'publish.mjs');
    if (!existsSync(script)) return notWired('scripts/publish.mjs does not exist yet; the portfolio_site worker adds it');
    const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 15 * 60_000 });
    const tail = (r.stdout + r.stderr).trim().split('\n').slice(-5).join('\n');
    return { status: r.status === 0 ? 'ok' : 'failed', exitCode: r.status, detail: tail };
  },
  async learn(ctx) {
    const { run } = await import('../cli/learn.mjs');
    await run([], { instance: ctx.instance, log: ctx.log });
    return { status: 'ok' };
  },
  async digest(ctx) {
    const { writeDigest } = await import('./digest.mjs');
    const d = await writeDigest({ instance: ctx.instance, ledger: ctx.ledger, now: ctx.now });
    return { status: 'ok', file: d.file, notified: d.notified };
  },
  // Listing experiments need src/listings builders and an adapter upsertListing that reads the saved
  // gig back; until both exist this job records that it did nothing.
  async listings() {
    return notWired('listing experiments need src/listings builders and adapter upsertListing');
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
export async function runTick(ctx = {}) {
  const instance = ctx.instance ?? loadInstance();
  const ownLedger = !ctx.ledger;
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  const now = ctx.now ?? new Date();
  const state = ctx.state ?? readState(instance);
  const forceMode = ctx.forceMode !== undefined ? ctx.forceMode : process.env.FSW_FORCE_MODE ?? null;
  effectiveMode('auto', forceMode);
  const handlers = { ...JOB_HANDLERS, ...ctx.handlers };
  const job = { instance, ledger, now, forceMode, keeper: ctx.keeper, log: ctx.log ?? (() => {}), loadAdapter: ctx.loadAdapter, decide: ctx.decide };
  let due = dueJobs(state.lastRuns ?? {}, now, ctx.jobs ?? JOBS);
  if (ctx.only) due = due.filter((d) => ctx.only.includes(d.id));
  const summary = { at: now.toISOString(), forceMode, jobs: [] };
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
    record(job, 'supervisor.tick', null, { jobs: summary.jobs.map((j) => j.job + ':' + j.status), failures: summary.failures, forceMode });
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
  let awake = null;
  try {
    awake = await holdAwake();
    log('sleep hold by pid ' + awake.pid);
  } catch (err) {
    ledger.addEvent({ kind: 'supervisor.keepalive_failed', payload: { code: err.code ?? null, message: err.message } });
    await notifyOperator(instance, { kind: 'supervisor', title: 'The supervisor could not hold the machine awake', body: err.message, dedupeKey: 'keepalive:' + dayKey() });
  }
  const keeper = createBrowserKeeper({ instance });
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
  try {
    const state = readState(instance);
    let current = instance;
    const started = (ctx.codeVersion ?? codeVersion)();
    let rejected = null;
    let restart = false;
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
      const summary = await runTick({ instance: current, ledger, state, keeper, log, forceMode: ctx.forceMode });
      if (summary.jobs.length) log('tick ' + summary.jobs.map((j) => j.job + ':' + j.status).join(' ') + ' failures=' + summary.failures);
      if (stopping || ctx.once) break;
      const head = (ctx.codeVersion ?? codeVersion)();
      const handover = codeHandover({ started, head, rejected, probe: ctx.probeNewCode ?? probeNewCode });
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
      const ms = Math.max(0, nextWake(new Date()).getTime() - Date.now());
      await new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
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
