// Revision requests on delivered work. A customer who asks for changes after a delivery reopens the job:
// the request is kept on the job and recorded as a learning case, the job goes to status revision, and
// the orders job runs it again with the request in its brief; the run's acceptance then queues the usual
// delivery approval. Each package includes one revision round, which the catalog hours and the brain's
// rules (src/brain/prompts.mjs) assume, so a further round is extra paid work: it goes to the operator
// with the request instead of running.
import { notifyOperator } from '../core/notify.mjs';
import { recordOutcome } from '../learning/outcomes.mjs';
import { pidAlive, runningJobs } from '../jobs/run.mjs';

export const INCLUDED_REVISIONS = 1;

// The newest job opened from this conversation, or null.
export function jobForThread(ledger, platform, threadId) {
  const jobs = ledger.listJobs({ platform }).filter((j) => j.threadId === threadId);
  return jobs.sort((a, b) => String(a.deliveredAt ?? a.startedAt ?? '').localeCompare(String(b.deliveredAt ?? b.startedAt ?? ''))).at(-1) ?? null;
}

// Called after a decision on a conversation. Returns null when the decision is no revision request on a
// delivered job; otherwise what was done: reopened, extra (sent to the operator) or duplicate.
export async function noteRevision({ instance, ledger, platform, thread, decision, text, notify = notifyOperator, now = new Date() }) {
  if (decision?.intent !== 'revision') return null;
  const request = String(text ?? '').trim();
  const job = jobForThread(ledger, platform, thread.id);
  if (!request || !job || job.status !== 'delivered') return null;
  const revisions = job.meta?.revisions ?? [];
  if (revisions.some((r) => r.text === request)) return { action: 'duplicate', jobId: job.id };
  const round = revisions.filter((r) => !r.extra).length + 1;
  const extra = round > INCLUDED_REVISIONS;
  const entry = { at: now.toISOString(), text: request, round, extra };
  recordOutcome(instance, ledger, { kind: 'revision_request', platform, service: job.service, threadRef: thread.externalId, jobId: job.id, text: request, note: extra ? 'beyond the included rounds' : 'round ' + round });
  if (extra) {
    ledger.upsertJob({ id: job.id, meta: { ...job.meta, revisions: [...revisions, entry] } });
    ledger.addEvent({ kind: 'job.revision_extra', platform, ref: job.id, payload: { round } });
    await notify(instance, {
      kind: 'job', title: 'job ' + job.id + ': revision beyond the included round',
      body: 'The package includes ' + INCLUDED_REVISIONS + ' revision round. Quote the extra round or approve it free by setting the job status to revision.\nRequest: ' + request,
      dedupeKey: 'revision-extra:' + job.id + ':' + revisions.length,
    });
    return { action: 'extra', jobId: job.id, round };
  }
  ledger.upsertJob({ id: job.id, status: 'revision', meta: { ...job.meta, revisions: [...revisions, entry] } });
  ledger.addEvent({ kind: 'job.revision_opened', platform, ref: job.id, payload: { round } });
  return { action: 'reopened', jobId: job.id, round };
}

// Starts jobs in status revision, once per revision round and within jobs.maxParallel, the same way the
// orders job starts paid ones; runJob moves the job to in_progress as soon as it begins.
export async function startRevisions({ instance, ledger, spawnJob, alive = pidAlive, notify = notifyOperator }) {
  const max = instance.config.jobs?.maxParallel ?? 1;
  const out = { started: [], waiting: [], failedRunners: [] };
  let running = runningJobs(instance).length;
  for (const job of ledger.listJobs({ status: 'revision' })) {
    const round = (job.meta?.revisions ?? []).filter((r) => !r.extra).length;
    const runner = job.meta?.revisionRunner;
    if (runner?.round === round) {
      if (alive(runner.pid)) {
        out.waiting.push({ id: job.id, reason: 'revision runner ' + runner.pid + ' is starting' });
        running += 1;
        continue;
      }
      if (!runner.reported) {
        ledger.upsertJob({ id: job.id, meta: { ...job.meta, revisionRunner: { ...runner, reported: true } } });
        await notify(instance, { kind: 'job', title: 'job ' + job.id + ': the revision run did not start', body: 'See ' + runner.log, dedupeKey: 'revision-runner:' + job.id + ':' + runner.pid });
      }
      out.failedRunners.push(job.id);
      continue;
    }
    if (running >= max) {
      out.waiting.push({ id: job.id, reason: running + ' jobs running, jobs.maxParallel is ' + max });
      continue;
    }
    const r = spawnJob(instance, job.id);
    running += 1;
    ledger.upsertJob({ id: job.id, meta: { ...job.meta, revisionRunner: { round, pid: r.pid, log: r.log, at: new Date().toISOString() } } });
    ledger.addEvent({ kind: 'job.revision_spawned', platform: job.platform, ref: job.id, payload: { round, pid: r.pid } });
    out.started.push(job.id);
  }
  return out;
}
