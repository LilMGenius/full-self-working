// fsw job run|check <id>: run a paid job through its recipe with the deal applying its run signals, or
// re-run its acceptance checks without a model.
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { checkJobWithDeal, runJobWithDeal } from '../loop/job.mjs';

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const [cmd, id] = argv;
  if (!['run', 'check'].includes(cmd) || !id) {
    (ctx.error ?? console.error)('usage: fsw job run|check <id>');
    return 2;
  }
  const instance = ctx.instance ?? loadInstance();
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  try {
    const r = await (cmd === 'run' ? runJobWithDeal : checkJobWithDeal)(id, { instance, ledger, executors: ctx.executors, recipeDir: ctx.recipeDir });
    log(JSON.stringify(r, null, 2));
    return cmd === 'run' ? (r.ok ? 0 : 1) : (r.acceptance.ok ? 0 : 1);
  } finally {
    if (!ctx.ledger) ledger.close();
  }
}
