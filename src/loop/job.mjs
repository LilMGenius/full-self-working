// runJobWithDeal(jobId, ctx): the job child (fsw job run <id>). It supplies the work runner's executor
// (codex, the executor seam of architect D10), the deal's payment check, and a report door that
// applies each run signal to the deal and carries out its effects, so the child never writes jobs.status.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { runCodex } from '../brain/codex.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { advance, deliveryAllowed, startAllowed } from '../deal/index.mjs';
import { checkJob, jobPaths, loadRecipe, runJob } from '../work/index.mjs';
import { applyEffects } from './effects.mjs';

function seam(jobId, { instance, ledger, executors = {}, recipeDir, notify, spawnJob }) {
  const job = ledger.getJob(jobId);
  if (!job) throw Object.assign(new Error('no job ' + jobId + ' in the ledger'), { code: 'FSW_JOB_MISSING' });
  const descriptor = loadDescriptor(job.platform);
  const load = (service) => loadRecipe(service, recipeDir ? { dir: recipeDir } : {});
  const report = async (signal) => {
    const now = new Date();
    const r = advance(ledger, { ...signal, at: signal.at ?? now.toISOString() }, { instance, descriptor, now, loadRecipe: load });
    await applyEffects(r.effects, { instance, ledger, notify, spawnJob, loadRecipe: load });
    return r;
  };
  return {
    instance, ledger, recipeDir, notify, report,
    runCodex: executors.runCodex ?? runCodex,
    openRenderer: executors.openRenderer,
    startAllowed: (j, recipe) => startAllowed(j, ledger, descriptor, recipe),
    deliveryAllowed: (j, recipe) => deliveryAllowed(j, ledger, descriptor, recipe),
  };
}

export const runJobWithDeal = (jobId, ctx) => runJob(jobId, seam(jobId, ctx));
export const checkJobWithDeal = (jobId, ctx) => checkJob(jobId, seam(jobId, ctx));

// fsw job handoff <id> <step> [file ...]: the operator finished one user-handoff step of the job's last
// run that produces files. Its files are copied into jobs/<id>/handoff/<step>/, so the delivery carries
// them wherever they were made, and the deal plans the delivery once every such step is recorded.
export async function recordHandoff(jobId, step, files, ctx) {
  const { instance } = ctx;
  const s = seam(jobId, ctx);
  const job = ctx.ledger.getJob(jobId);
  const missing = files.filter((f) => !existsSync(f) || !statSync(f).isFile());
  if (missing.length) throw Object.assign(new Error('not a file: ' + missing.join(', ')), { code: 'FSW_HANDOFF_FILE' });
  const dir = join(jobPaths(instance, jobId).dir, 'handoff', String(step).replace(/[^A-Za-z0-9_-]/g, '_'));
  if (files.length) mkdirSync(dir, { recursive: true });
  const copies = files.map((f) => {
    const to = join(dir, basename(f));
    if (resolve(f) !== resolve(to)) copyFileSync(f, to);
    return to;
  });
  const r = await s.report({ type: 'handoff_done', platform: job.platform, jobId, evidence: { step, files: copies } });
  const after = ctx.ledger.getJob(jobId);
  const recorded = after.meta?.handoffs?.[step]?.runAt === after.meta?.lastRun?.at && after.meta?.handoffs?.[step]?.files?.length === copies.length;
  const steps = (after.meta?.lastRun?.handoffs ?? []).filter((h) => h.produces?.length).map((h) => h.id);
  return { recorded, step, files: copies, pending: steps.filter((id) => after.meta?.handoffs?.[id]?.runAt !== after.meta.lastRun.at), delivery: r.effects.some((e) => e.item?.kind === 'delivery') };
}
