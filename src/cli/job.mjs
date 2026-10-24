// fsw job run <id>: run a paid job through its recipe and acceptance checks.
// fsw job check <id>: re-run acceptance on the job's existing work and say whether delivery is allowed.
import { checkJob, runJob } from '../jobs/run.mjs';

const USAGE = 'usage: fsw job run <id> | fsw job check <id>';

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const [sub, id] = argv;
  if (!['run', 'check'].includes(sub) || !id) {
    (ctx.error ?? console.error)(USAGE);
    return 2;
  }
  const printResults = (results) => {
    for (const r of results) log('  ' + (r.ok ? 'pass' : 'FAIL') + ' ' + r.check.padEnd(9) + ' ' + r.detail);
  };
  if (sub === 'check') {
    const { acceptance, delivery, qa } = await checkJob(id, ctx);
    log('job ' + id + ' acceptance ' + (acceptance.ok ? 'passed' : 'failed'));
    printResults(acceptance.results);
    log('captures ' + qa);
    log('delivery ' + (delivery.ok ? 'allowed' : 'not allowed') + ': ' + delivery.reason);
    return acceptance.ok ? 0 : 1;
  }
  const result = await runJob(id, ctx);
  if (result.status === 'refused') {
    log('job ' + id + ' refused: ' + result.reason);
    return 1;
  }
  log('job ' + id + ' ' + result.status + ' after ' + result.turns.length + ' turn(s), ' + result.agentMinutes.toFixed(1) + ' agent minutes in total');
  printResults(result.acceptance.results);
  for (const t of result.turns) for (const q of t.openQuestions ?? []) log('  open question: ' + q);
  return result.ok ? 0 : 1;
}
