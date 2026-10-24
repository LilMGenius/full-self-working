// fsw run: the supervisor daemon. A second start while one lives is a no-op that exits 0, so the
// scheduled task's hourly start never stacks supervisors or reads as a failure.
import { RESTART_EXIT, runSupervisor } from '../supervisor/run.mjs';

export async function run(argv, ctx = {}) {
  const r = await (ctx.runSupervisor ?? runSupervisor)({ ...ctx, once: argv.includes('--once') });
  if (r.status === 'restart') return RESTART_EXIT;
  return r.status === 'already running' || r.status === 'stopped' ? 0 : 1;
}
