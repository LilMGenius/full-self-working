// fsw tick [--only job,job]: one supervisor pass over the jobs due now, printing each job and each
// platform's result. FSW_FORCE_MODE=observe|draft lowers every platform's mode for the pass. A one-shot
// tick reports the BrowserSkill daemon without starting one, since the daemon would die with the tick.
import { loadInstance } from '../core/instance.mjs';
import { createBrowserKeeper } from '../supervisor/keepalive.mjs';
import { runTick } from '../supervisor/run.mjs';

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
      for (const k of ['inbox', 'requests', 'orders', 'deferred', 'approvalsSent']) if (p[k] != null) parts.push(k + ' ' + p[k]);
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
  const instance = ctx.instance ?? loadInstance();
  const at = argv.indexOf('--only');
  const only = at >= 0 ? String(argv[at + 1] ?? '').split(',').filter(Boolean) : null;
  const keeper = createBrowserKeeper({ instance, canStart: false });
  const summary = await runTick({ instance, keeper, only, log });
  log(formatTick(summary));
  return summary.failures ? 1 : 0;
}
