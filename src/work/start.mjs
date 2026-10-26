// Starts paid and revision jobs in their own processes, at most config jobs.maxParallel at once across
// the machine (src/orders/run.mjs:16-85 and src/orders/revision.mjs:47-80 at 2c77326, one pass now).
// A job starts once its payment meets the recipe's beforeStart level and it has an agreed scope; the
// deal's check is passed in as startAllowed(job, recipe), since work never imports deal.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../core/instance.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { operatorDelivered } from '../economics/catalog.mjs';
import { JobError, agreedScope, jobPaths, pidAlive, runningJobs } from './run.mjs';
import { loadRecipe } from './recipe.mjs';

// fsw job run <id>, detached, its output in jobs/<id>/qa/runner.log. Returns {pid, log}.
export function spawnJobRun(instance, jobId) {
  const paths = jobPaths(instance, jobId);
  mkdirSync(paths.qa, { recursive: true });
  const log = join(paths.qa, 'runner.log');
  const fd = openSync(log, 'a');
  try {
    const child = spawn(process.execPath, [join(repoRoot, 'bin', 'fsw.mjs'), 'job', 'run', String(jobId)], { cwd: repoRoot, env: { ...process.env, FSW_INSTANCE: instance.dir }, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.unref();
    return { pid: child.pid, log };
  } finally {
    closeSync(fd);
  }
}

export function startBlocker(job, ledger, { startAllowed, load = loadRecipe }) {
  if (job.meta?.manual) return job.meta.manual;
  if (!job.service) return 'no catalog service';
  // The deal hands an operator-delivered job to the operator (src/orders/run.mjs:38 at 14d2f17).
  if (operatorDelivered(job.service)) return 'delivered by the operator, so no job run starts';
  const pay = startAllowed(job, load(job.service));
  if (!pay.ok) return pay.reason;
  const quote = job.meta?.quoteId ? ledger.getQuote(job.meta.quoteId) : null;
  if (!agreedScope(job, quote)) return 'no agreed scope (no accepted quote with scope and no job.meta.scope)';
  return null;
}

// One pass over ordered and revision jobs. A job is spawned once per round: its runner pid sits in
// meta.runner (meta.revisionRunner with the round for a revision), and a runner that exited with the
// job unchanged is reported to the operator instead of being started again.
export async function startDue({ instance, ledger, startAllowed, spawnJob = spawnJobRun, notify = notifyOperator, alive = pidAlive, load = loadRecipe }) {
  if (typeof startAllowed !== 'function') throw new JobError('FSW_JOB_SEAM', 'startDue needs the deal payment check');
  const max = instance.config.jobs?.maxParallel ?? 1;
  const out = { started: [], waiting: [], blocked: [], failedRunners: [] };
  let running = runningJobs(instance).length;
  for (const job of [...ledger.listJobs({ status: 'ordered' }), ...ledger.listJobs({ status: 'revision' })]) {
    const revision = job.status === 'revision';
    const round = (job.meta?.revisions ?? []).filter((r) => !r.extra).length;
    const field = revision ? 'revisionRunner' : 'runner';
    const runner = job.meta?.[field];
    if (runner && (!revision || runner.round === round)) {
      if (alive(runner.pid)) {
        out.waiting.push({ id: job.id, reason: 'runner ' + runner.pid + ' is starting' });
        running += 1;
        continue;
      }
      if (!runner.reported) {
        ledger.upsertJob({ id: job.id, meta: { ...job.meta, [field]: { ...runner, reported: true } } });
        ledger.addEvent({ kind: 'job.runner_exited', platform: job.platform, ref: job.id, payload: { pid: runner.pid, log: runner.log, revision } });
        await notify(instance, { kind: 'job', title: 'job ' + job.id + ' did not start', body: 'Its runner exited with the job still ' + job.status + '. See ' + runner.log, dedupeKey: 'runner-exited:' + job.id + ':' + runner.pid });
      }
      out.failedRunners.push(job.id);
      continue;
    }
    const why = revision ? null : startBlocker(job, ledger, { startAllowed, load });
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
    ledger.upsertJob({ id: job.id, meta: { ...job.meta, [field]: { ...(revision ? { round } : {}), pid: r.pid, log: r.log, at: new Date().toISOString() } } });
    ledger.addEvent({ kind: revision ? 'job.revision_spawned' : 'job.spawned', platform: job.platform, ref: job.id, payload: { pid: r.pid, log: r.log, ...(revision ? { round } : {}) } });
    out.started.push(job.id);
  }
  return out;
}
