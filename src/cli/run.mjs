// fsw run: the supervisor daemon. A second start while one lives is a no-op that exits 0, so the
// scheduled task's hourly start never stacks supervisors or reads as a failure.
import { RESTART_EXIT, runSupervisor } from '../supervisor/run.mjs';

// The launcher (scripts/task.ps1) waits for this process and starts the next supervisor only once it
// is gone, so a supervisor that returned leaves within EXIT_GRACE_MS with its code even when a handle
// it could not close (a child that outlives its kill, a stray timer or socket) would keep the event
// loop alive; on 2026-10-26 one such handle held the old supervisor for six minutes after a handover.
// The timer is unref'd, so a process whose loop drains first exits on its own with the same code.
export const EXIT_GRACE_MS = 5000;

export async function run(argv, ctx = {}) {
  const r = await (ctx.runSupervisor ?? runSupervisor)({ ...ctx, once: argv.includes('--once') });
  const code = r.status === 'restart' ? RESTART_EXIT : r.status === 'already running' || r.status === 'stopped' ? 0 : 1;
  const exit = ctx.exit ?? ((c) => process.exit(c));
  setTimeout(() => exit(code), ctx.exitGraceMs ?? EXIT_GRACE_MS).unref();
  return code;
}
