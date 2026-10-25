// fsw decide <platform> <thread.json> [--price-table <file>]: run the brain on a thread file and print
// the decision and gate result without sending anything. The thread file holds
// {kind, stage, customer, messages: [{direction: "in"|"out", text}]}. Prices come from the instance's
// newest price table, the one the supervisor quotes from, unless --price-table names another table file.
import { readFileSync } from 'node:fs';
import { loadInstance } from '../core/instance.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { decide } from '../brain/respond.mjs';
import { latestTable } from './price.mjs';

const USAGE = 'usage: fsw decide <platform> <thread.json> [--price-table <file>]';

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const positional = [];
  let priceFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--price-table') {
      if (i + 1 >= argv.length) throw new Error('--price-table needs a file');
      priceFile = argv[++i];
    } else positional.push(argv[i]);
  }
  const [platform, file] = positional;
  if (!platform || !file) throw new Error(USAGE);
  const instance = ctx.instance ?? loadInstance();
  const descriptor = loadDescriptor(platform);
  const thread = { platform, externalId: 'cli', kind: 'message', stage: 'pre_order', ...JSON.parse(readFileSync(file, 'utf8')) };
  const table = priceFile ? JSON.parse(readFileSync(priceFile, 'utf8')) : latestTable(instance.paths.pricing)?.table;
  const priceTable = (Array.isArray(table) ? table : table?.rows) ?? [];
  const result = await decide(thread, { instance, descriptor, priceTable, ...(ctx.runCodex ? { runCodex: ctx.runCodex } : {}) });
  log(JSON.stringify({ action: result.action, decision: result.decision, gate: result.gate ?? null, violations: result.violations ?? [], modelCalls: result.modelCalls }, null, 2));
  return 0;
}

