// fsw tick [--once] [--only job,job]: one supervisor pass over the jobs due now, printing each job and each
// platform's result. FSW_FORCE_MODE=observe|draft lowers every platform's mode for the pass. A one-shot
// tick reports the BrowserSkill daemon without starting one, since the daemon would die with the tick.
import { loadInstance } from '../core/instance.mjs';
import { createBrowserKeeper } from '../supervisor/keepalive.mjs';
import { acquireLock, codeState, releaseLock, runTick } from '../supervisor/run.mjs';

export function formatTick(summary) {
  const lines = ['tick ' + summary.at + (summary.forceMode ? ' (forced ' + summary.forceMode + ')' : '')];
  if (!summary.jobs.length) lines.push('  no job due');
  for (const j of summary.jobs) {
    const detail = j.error ?? j.detail ?? (j.browser ? 'browser ' + j.browser.status + ', ' + j.browser.browsers + ' connected' : '');
    lines.push('  ' + j.job.padEnd(10) + ' ' + j.status + (detail ? '  ' + String(detail).split('\n')[0] : '') + '  [' + j.seconds + 's]');
    for (const p of j.platforms ?? []) {
      const parts = [p.status, 'mode ' + (p.mode ?? p.configMode)];
      if (p.error) parts.push(p.error);
      if (p.login) parts.push('login ' + (p.login.loggedIn ? 'ok' : 'missing'));
      for (const k of ['inbound', 'transitions', 'deferred']) if (p[k] != null) parts.push(k + ' ' + p[k]);
      const sent = Object.entries(p.outbox ?? {}).map(([a, n]) => a + ' ' + n).join(', ');
      if (sent) parts.push('outbox ' + sent);
      const threads = Object.entries(p.threads ?? {}).map(([a, n]) => a + ' ' + n).join(', ');
      if (threads) parts.push('threads ' + threads);
      if (p.errors?.length) parts.push(p.errors.length + ' thread errors: ' + p.errors.map((e) => e.ref + ' ' + e.message).join('; '));
      lines.push('    ' + p.platform.padEnd(8) + ' ' + parts.join(', '));
    }
  }
  lines.push('  failures ' + summary.failures);
  return lines.join('\n');
}

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  // A tick is always one pass; --once names it, so the takeover rehearsal runs the same command against
  // 2c77326 (which ignores the flag) and v0. Any other flag is a typo and stops before a pass.
  const unknown = argv.filter((a) => a.startsWith('--') && !['--once', '--only'].includes(a));
  if (unknown.length) {
    (ctx.error ?? console.error)('usage: fsw tick [--once] [--only job,job]; unknown ' + unknown.join(' '));
    return 2;
  }
  const instance = ctx.instance ?? loadInstance();
  const at = argv.indexOf('--only');
  const only = at >= 0 ? String(argv[at + 1] ?? '').split(',').filter(Boolean) : null;
  const keeper = createBrowserKeeper({ instance, canStart: false });
  // One process per instance drains the outbox (003 Tick): the tick holds the supervisor's pid lock for its
  // pass, taking over a stale one as runSupervisor does, and refuses before reading anything while a live
  // supervisor holds it.
  const lock = acquireLock(instance, ctx.alive ? { alive: ctx.alive } : {});
  if (!lock.acquired) {
    (ctx.error ?? console.error)('supervisor already running as pid ' + lock.heldBy + '; fsw tick runs only while it is stopped');
    return 1;
  }
  try {
    const summary = await (ctx.runTick ?? runTick)({ instance, keeper, only, log, code: codeState().head });
    log(formatTick(summary));
    return summary.failures ? 1 : 0;
  } finally {
    releaseLock(instance);
  }
}
