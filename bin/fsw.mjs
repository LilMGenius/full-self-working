#!/usr/bin/env node
// fsw command line. Each wired verb's handler lives in src/cli/<verb>.mjs and exports run(argv).
import { loadInstance } from '../src/core/instance.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openLedger } from '../src/core/ledger.mjs';
import { listDescriptors, loadDescriptor } from '../src/platforms/registry.mjs';

const VERBS = {
  init: 'init [dir]: create an operator instance from the placeholder example and print the remaining steps',
  profile: 'profile build <file-or-folder-or-url>... | accept: draft profile.json from your background with a cited source for every claim, then promote it after you read it',
  doctor: 'check what a running agent needs, one line per check; exit 1 when a required check fails',
  tick: 'run one supervisor pass over the due jobs [--only job,job]; FSW_FORCE_MODE=observe|draft lowers every platform mode',
  run: 'start the supervisor daemon (a no-op while one runs); FSW_FORCE_MODE applies here too',
  status: 'show the instance, ledger counts and enabled platforms',
  probe: 'probe <platform>: check the login and page shapes of one platform',
  market: 'refresh market samples',
  price: 'rebuild the price table',
  publish: 'build and deploy the portfolio site when it changed',
  learn: 'turn finished outcomes into lessons',
  approve: 'approve a drafted outbound item',
  decide: 'decide <platform> <thread.json>: run the brain on a thread file without sending',
  job: 'job run|check <id>: run a paid job through its recipe, or re-run its acceptance checks',
  schedule: 'schedule install|status|uninstall: the logon and hourly task that keeps the supervisor running',
  listings: 'listings build|render|check|publish <service>: write a kmong gig spec and images for review, or submit it',
  order: 'order list|permission|review: record what the client said on the platform (portfolio permission, review)',
  services: 'services soomgo [--apply] [--only <service>]: set the items each offered soomgo service matches requests on; a dry run unless --apply',
  help: 'show this help',
};

const HANDLERS = { init: 'init', profile: 'profile', doctor: 'doctor', tick: 'tick', run: 'run', schedule: 'schedule', market: 'market', price: 'price', approve: 'approvals', learn: 'learn', decide: 'decide', job: 'job', listings: 'listings', order: 'order', services: 'services' };

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
