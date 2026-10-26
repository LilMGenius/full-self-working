// fsw schedule install|status|uninstall: the per-user scheduled task that starts the supervisor at
// logon and re-checks it hourly at minute 0; scripts/task.ps1 owns the task definition.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from '../core/instance.mjs';

const FLAGS = { install: [], status: ['-Status'], uninstall: ['-Unregister'] };

export async function run(argv, ctx = {}) {
  const [action = 'status'] = argv;
  if (!(action in FLAGS)) {
    (ctx.error ?? console.error)('usage: fsw schedule install|status|uninstall');
    return 1;
  }
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'scripts', 'task.ps1'), ...FLAGS[action]], { stdio: 'inherit', windowsHide: true });
  if (r.error) throw r.error;
  return r.status ?? 1;
}
