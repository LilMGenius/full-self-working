// runJobWithDeal(jobId, ctx): the job child (fsw job run <id>). It supplies the work runner's executors
// (codex and jwc, the executor seam of architect D10), the deal's payment check, and a report door that
// applies each run signal to the deal and carries out its effects, so the child never writes jobs.status.
import { runCodex } from '../brain/codex.mjs';
import { DEFAULT_JWC_MODEL, runJwc } from '../brain/jwc.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { advance, deliveryAllowed, startAllowed } from '../deal/index.mjs';
import { checkJob, loadRecipe, runJob } from '../work/index.mjs';
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
    runJwc: executors.runJwc ?? runJwc,
    jwcModel: executors.jwcModel ?? DEFAULT_JWC_MODEL,
    openRenderer: executors.openRenderer,
    startAllowed: (j, recipe) => startAllowed(j, ledger, descriptor, recipe),
    deliveryAllowed: (j, recipe) => deliveryAllowed(j, ledger, descriptor, recipe),
  };
}

export const runJobWithDeal = (jobId, ctx) => runJob(jobId, seam(jobId, ctx));
export const checkJobWithDeal = (jobId, ctx) => checkJob(jobId, seam(jobId, ctx));
