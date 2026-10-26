#!/usr/bin/env node
// fsw command line. Each verb's handler lives in src/cli/<file>.mjs and exports run(argv).
const VERBS = {
  init: 'init [dir]: create an operator instance from the placeholder example and print the remaining steps',
  profile: 'profile build <file-or-folder-or-url>... | accept: draft profile.json from your background with a cited source for every claim, then promote it after you read it',
  doctor: 'check what a running agent needs, one line per check; exit 1 when a required check fails',
  settings: 'settings | settings set <key> <value> | settings reset <key>: list, change or reset an operator choice in config.json',
  status: 'show the instance, ledger and outbox counts, the last tick and the enabled platforms',
  tick: 'tick [--once] [--only job,job]: run one supervisor pass over the due jobs; FSW_FORCE_MODE=observe|draft lowers every platform mode',
  run: 'start the supervisor daemon (a no-op while one runs) [--once]; FSW_FORCE_MODE applies here too',
  schedule: 'schedule install|status|uninstall: the logon and hourly task that keeps the supervisor running',
  approve: 'approve [list] | approve <id> [--text "..."] | approve <id> --reject [--reason "..."] | approve <id> --sent [--cost <KRW>] | approve show <id>: answer an outbound item waiting for you, or settle a send the surface could not observe',
  deal: 'deal list | deal <jobId> permission granted|denied | deal <jobId> review --rating <1-5>: record what the client said on the platform',
  job: 'job run|check <id>: run a paid job through its recipe, or re-run its acceptance checks; job handoff <id> <step> [file ...]: record an operator step with its files',
  probe: 'probe <platform> <op>: one read operation of a platform surface (login, sense, read, orders, supply)',
  market: 'market [platform...]: refresh market samples',
  price: 'rebuild the price table',
  publish: 'build and deploy the portfolio site when it changed',
  listings: 'listings build|render|check|publish <service>: write a kmong gig spec and images for review, or submit it',
  projects: 'projects list|show|draft|propose|revise|run|status: kmong enterprise projects, judged and proposed within the daily quota',
  onboard: 'onboard <platform> [--apply] [--step <id>]: walk the seller onboarding and fill it from the instance; a dry run unless --apply',
  services: 'services soomgo [--apply] [--only <service>]: set the items each offered soomgo service matches requests on; a dry run unless --apply',
  edits: 'edits soomgo [--apply] [--only intro|detail|templates]: type the approved profile text and quote templates; saves only approved parts with --apply',
  help: 'show this help',
};

const HANDLERS = { init: 'init', profile: 'profile', doctor: 'doctor', settings: 'settings', status: 'status', tick: 'tick', run: 'run', schedule: 'schedule', approve: 'approvals', deal: 'deal', job: 'job', probe: 'probe', market: 'market', price: 'price', publish: 'publish', listings: 'listings', projects: 'projects', services: 'services', edits: 'edits', onboard: 'onboard' };

function help() {
  console.log('usage: fsw <verb> [args]\n');
  for (const [verb, what] of Object.entries(VERBS)) console.log('  ' + verb.padEnd(9) + ' ' + what);
}

const [verb = 'help'] = process.argv.slice(2);
if (verb === 'help' || verb === '--help' || verb === '-h') help();
else if (verb in HANDLERS) {
  const result = await (await import('../src/cli/' + HANDLERS[verb] + '.mjs')).run(process.argv.slice(3));
  process.exitCode = typeof result === 'number' ? result : (result?.exitCode ?? 0);
} else {
  console.error('fsw: unknown verb ' + verb);
  help();
  process.exit(1);
}
