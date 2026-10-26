// fsw job run|check <id>: run a paid job through its recipe with the deal applying its run signals, or
// re-run its acceptance checks without a model. fsw job handoff <id> <step> [file ...] records an
// operator step of the last run that produces files; the delivery waits for every such step.
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { checkJobWithDeal, recordHandoff, runJobWithDeal } from '../loop/job.mjs';

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const [cmd, id, step, ...files] = argv;
  if (!['run', 'check', 'handoff'].includes(cmd) || !id || (cmd === 'handoff' && !step)) {
    (ctx.error ?? console.error)('usage: fsw job run|check <id> | fsw job handoff <id> <step> [file ...]');
    return 2;
  }
  const instance = ctx.instance ?? loadInstance();
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  try {
    if (cmd === 'handoff') {
      const r = await recordHandoff(id, step, files, { instance, ledger, notify: ctx.notify });
      log(JSON.stringify(r, null, 2));
      return r.recorded ? 0 : 1;
    }
    const r = await (cmd === 'run' ? runJobWithDeal : checkJobWithDeal)(id, { instance, ledger, executors: ctx.executors, recipeDir: ctx.recipeDir });
    log(JSON.stringify(r, null, 2));
    return cmd === 'run' ? (r.ok ? 0 : 1) : (r.acceptance.ok ? 0 : 1);
  } finally {
    if (!ctx.ledger) ledger.close();
  }
}
