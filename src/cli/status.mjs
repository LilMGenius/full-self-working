// fsw status: the instance, ledger counts, outbox items by status, the last tick and the enabled
// platforms (bin/fsw.mjs:40-60 at 2c77326, plus the outbox and the tick).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { listDescriptors, loadDescriptor } from '../platforms/registry.mjs';
import { readState } from '../supervisor/run.mjs';

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const instance = ctx.instance ?? loadInstance({ allowExampleConfig: true });
  log('instance  ' + instance.dir);
  log('config    ' + (existsSync(join(instance.dir, 'config.json')) ? 'config.json' : 'example defaults (no config.json in the instance)'));
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  try {
    log('ledger    ' + instance.paths.ledger);
    for (const [table, n] of Object.entries(ledger.counts())) log('  ' + table.padEnd(13) + ' ' + n);
    const byStatus = ledger.db.prepare('SELECT status, count(*) AS n FROM outbox GROUP BY status ORDER BY status').all();
    log('outbox' + (byStatus.length ? '' : '    empty'));
    for (const r of byStatus) log('  ' + r.status.padEnd(18) + ' ' + r.n);
  } finally {
    if (!ctx.ledger) ledger.close();
  }
  const state = readState(instance);
  log('last tick ' + (state.lastTick ? state.lastTick.at + ', failures ' + state.lastTick.failures : 'none'));
  const known = new Set(listDescriptors());
  log('platforms');
  for (const [id, p] of Object.entries(instance.config.platforms ?? {})) {
    if (!p.enabled) continue;
    const name = known.has(id) ? loadDescriptor(id).name : 'no descriptor';
    // An object setting (proposals, bidBudget) prints as JSON; 2c77326 printed it as [object Object].
    const overrides = Object.entries(p).filter(([k]) => !['enabled', 'mode'].includes(k)).map(([k, v]) => k + '=' + (v !== null && typeof v === 'object' ? JSON.stringify(v) : v)).join(' ');
    log('  ' + id.padEnd(11) + ' ' + p.mode.padEnd(8) + ' ' + name + (overrides ? '  ' + overrides : ''));
  }
  return 0;
}
