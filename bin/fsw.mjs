#!/usr/bin/env node
// fsw command line. Each wired verb's handler lives in src/cli/<verb>.mjs and exports run(argv).
import { loadInstance } from '../src/core/instance.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openLedger } from '../src/core/ledger.mjs';
import { listDescriptors, loadDescriptor } from '../src/platforms/registry.mjs';

const VERBS = {
  tick: 'run one supervisor pass over every enabled platform',
  run: 'start the supervisor daemon',
  status: 'show the instance, ledger counts and enabled platforms',
  probe: 'probe <platform>: check the login and page shapes of one platform',
  market: 'refresh market samples',
  price: 'rebuild the price table',
  publish: 'build and deploy the portfolio site when it changed',
  learn: 'turn finished outcomes into lessons',
  approve: 'approve a drafted outbound item',
  decide: 'decide <platform> <thread.json>: run the brain on a thread file without sending',
  schedule: 'install or show the scheduled task',
  help: 'show this help',
};

const HANDLERS = { market: 'market', price: 'price', approve: 'approvals', learn: 'learn', decide: 'decide' };

function help() {
  console.log('usage: fsw <verb> [args]\n');
  for (const [verb, what] of Object.entries(VERBS)) console.log(`  ${verb.padEnd(9)} ${what}`);
}

function status() {
  const instance = loadInstance({ allowExampleConfig: true });
  const configSource = existsSync(join(instance.dir, 'config.json')) ? 'config.json' : 'example defaults (no config.json in the instance)';
  console.log(`instance  ${instance.dir}`);
  console.log(`config    ${configSource}`);
  const ledger = openLedger(instance.paths.ledger);
  try {
    console.log(`ledger    ${instance.paths.ledger}`);
    for (const [table, n] of Object.entries(ledger.counts())) console.log(`  ${table.padEnd(9)} ${n}`);
  } finally {
    ledger.close();
  }
  const known = new Set(listDescriptors());
  console.log('platforms');
  for (const [id, p] of Object.entries(instance.config.platforms ?? {})) {
    if (!p.enabled) continue;
    const name = known.has(id) ? loadDescriptor(id).name : 'no descriptor';
    const overrides = Object.entries(p).filter(([k]) => !['enabled', 'mode'].includes(k)).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  ${id.padEnd(11)} ${p.mode.padEnd(8)} ${name}${overrides ? '  ' + overrides : ''}`);
  }
}

const [verb = 'help'] = process.argv.slice(2);
if (verb === 'help' || verb === '--help' || verb === '-h') help();
else if (verb === 'status') status();
else if (verb in HANDLERS) {
  const result = await (await import(`../src/cli/${HANDLERS[verb]}.mjs`)).run(process.argv.slice(3));
  process.exitCode = typeof result === 'number' ? result : (result?.exitCode ?? 0);
} else if (verb in VERBS) {
  console.error(`fsw ${verb}: not wired yet`);
  process.exit(2);
} else {
  console.error(`fsw: unknown verb ${verb}`);
  help();
  process.exit(1);
}
