// The supervisor's orders job (every 5 Seoul minutes): starts paid jobs in their own processes, at most
// config jobs.maxParallel at once across the machine. A job starts once the ledger's payment rows meet
// its recipe's beforeStart level (a recorded deposit, or the whole order held in escrow) and it has an
// agreed scope; runJob re-checks both in the child.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../core/instance.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { operatorDelivered } from '../economics/catalog.mjs';
import { agreedScope, jobPaths, pidAlive, runningJobs, startAllowed } from '../jobs/run.mjs';
import { loadRecipe } from '../jobs/recipe.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { closeSettledJobs, queueDeliveries } from './delivery.mjs';
import { startRevisions } from './revision.mjs';

// Starts fsw job run <id> detached, its output in jobs/<id>/qa/runner.log. Returns the child pid.
export function spawnJobRun(instance, jobId) {
  const paths = jobPaths(instance, jobId);
  mkdirSync(paths.qa, { recursive: true });
  const log = join(paths.qa, 'runner.log');
  const fd = openSync(log, 'a');
  try {
    const child = spawn(process.execPath, [join(repoRoot, 'bin', 'fsw.mjs'), 'job', 'run', String(jobId)], {
      cwd: repoRoot, env: { ...process.env, FSW_INSTANCE: instance.dir }, detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
    });
    child.unref();
    return { pid: child.pid, log };
  } finally {
    closeSync(fd);
  }
}

// Why an ordered job cannot start now, or null when it can.
export function startBlocker(job, ledger) {
  if (job.meta?.manual) return job.meta.manual;
  if (!job.service) return 'no catalog service';
  if (operatorDelivered(job.service)) return 'delivered by the operator, so no job run starts';
  const recipe = loadRecipe(job.service);
  const pay = startAllowed(job, ledger, loadDescriptor(job.platform), recipe);
  if (!pay.ok) return pay.reason;
  const quote = job.threadId ? ledger.listQuotes({ threadId: job.threadId, status: 'accepted' }).at(-1) ?? null : null;
  if (!agreedScope(job, quote)) return 'no agreed scope (no accepted quote with scope and no job.meta.scope)';
  return null;
}

// One pass over ordered jobs. A job is spawned once: its runner pid is kept in meta.runner, and a runner
// that exited with the job still ordered is reported to the operator instead of being started again.
// Gap: there is no command to clear meta.runner for a retry; the operator edits the job or runs
// fsw job run <id> by hand.
export async function startJobs({ instance, ledger, spawnJob = spawnJobRun, notify = notifyOperator, alive = pidAlive }) {
  const max = instance.config.jobs?.maxParallel ?? 1;
  const out = { started: [], waiting: [], blocked: [], failedRunners: [] };
  let running = runningJobs(instance).length;
  for (const job of ledger.listJobs({ status: 'ordered' })) {
    const runner = job.meta?.runner;
    if (runner) {
      if (alive(runner.pid)) {
        out.waiting.push({ id: job.id, reason: 'runner ' + runner.pid + ' is starting' });
        running += 1;
        continue;
      }
      if (!runner.reported) {
        ledger.upsertJob({ id: job.id, meta: { ...job.meta, runner: { ...runner, reported: true } } });
        ledger.addEvent({ kind: 'job.runner_exited', platform: job.platform, ref: job.id, payload: { pid: runner.pid, log: runner.log } });
        await notify(instance, { kind: 'job', title: 'job ' + job.id + ' did not start', body: 'Its runner exited with the job still ordered. See ' + runner.log, dedupeKey: 'runner-exited:' + job.id + ':' + runner.pid });
      }
      out.failedRunners.push(job.id);
      continue;
    }
    const why = startBlocker(job, ledger);
    if (why) {
      out.blocked.push({ id: job.id, reason: why });
      continue;
    }
    if (running >= max) {
      out.waiting.push({ id: job.id, reason: running + ' jobs running, jobs.maxParallel is ' + max });
      continue;
    }
    const r = spawnJob(instance, job.id);
    running += 1;
    ledger.upsertJob({ id: job.id, meta: { ...job.meta, runner: { pid: r.pid, log: r.log, at: new Date().toISOString() } } });
    ledger.addEvent({ kind: 'job.spawned', platform: job.platform, ref: job.id, payload: { pid: r.pid, log: r.log } });
    out.started.push(job.id);
  }
  return out;
}

// The supervisor handler: start paid jobs, queue accepted ones for delivery, close settled ones.
export async function ordersJob(ctx) {
  const start = await startJobs({ instance: ctx.instance, ledger: ctx.ledger });
  const revisions = await startRevisions({ instance: ctx.instance, ledger: ctx.ledger, spawnJob: spawnJobRun });
  const deliveries = await queueDeliveries({ instance: ctx.instance, ledger: ctx.ledger });
  const closing = await closeSettledJobs({ instance: ctx.instance, ledger: ctx.ledger, forceMode: ctx.forceMode });
  return { status: closing.published && !closing.published.ok ? 'partial' : 'ok', ...start, revisionsStarted: revisions.started, deliveriesQueued: deliveries, closed: closing.closed, published: closing.published ?? null };
}

