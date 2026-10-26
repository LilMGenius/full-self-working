// applyEffects(effects, ctx): carries out what the deal returned, after its transaction committed. One
// failed effect is recorded and the rest still run.
import { notifyOperator } from '../core/notify.mjs';
import { recordOutcome } from '../learning/outcomes.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { syncPortfolio } from '../portfolio/store.mjs';
import { plan, setStatus } from '../outbox/index.mjs';
import { startAllowed } from '../deal/index.mjs';
import { loadRecipe, startDue } from '../work/index.mjs';

export async function applyEffects(effects, ctx) {
  const { instance, ledger } = ctx;
  const out = [];
  let started = false;
  let synced = false;
  for (const e of effects) {
    try {
      if (e.type === 'plan_outbox') out.push({ type: e.type, id: plan(ledger, e.item).id });
      else if (e.type === 'close_outbox') {
        // Rows the deal says are no longer due go stale with the deal's reason, so the operator is not
        // asked and the drain sends nothing; a row another pass moved first is left alone (setStatus null).
        const open = ledger.listOutbox({ jobId: e.jobId, kinds: [e.kind], statuses: ['awaiting_operator', 'approved'] });
        const closed = open.filter((r) => setStatus(ledger, r.id, { from: r.status, to: 'stale', reason: e.reason }));
        out.push({ type: e.type, closed: closed.map((r) => r.id) });
      }
      else if (e.type === 'start_run') {
        if (started) continue;
        started = true;
        const load = ctx.loadRecipe ?? ((service) => loadRecipe(service));
        out.push({ type: e.type, ...(await startDue({ instance, ledger, load, ...(ctx.spawnJob ? { spawnJob: ctx.spawnJob } : {}), ...(ctx.notify ? { notify: ctx.notify } : {}), startAllowed: (job, recipe) => startAllowed(job, ledger, loadDescriptor(job.platform), recipe) })) });
      } else if (e.type === 'record_case') out.push({ type: e.type, id: recordOutcome(instance, ledger, e.case).id });
      else if (e.type === 'sync_portfolio') {
        if (synced) continue;
        synced = true;
        out.push({ type: e.type, shown: syncPortfolio(instance, ledger).length });
      } else if (e.type === 'notify') out.push({ type: e.type, ...(await (ctx.notify ?? notifyOperator)(instance, e.note)) });
      else throw new RangeError('unknown deal effect ' + e.type);
    } catch (err) {
      ledger.addEvent({ kind: 'effect.failed', payload: { type: e.type, code: err.code ?? null, message: err.message } });
      out.push({ type: e.type, error: err.message });
    }
  }
  return out;
}
