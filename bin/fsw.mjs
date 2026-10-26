#!/usr/bin/env node
// fsw command line. Each wired verb's handler lives in src/cli/<verb>.mjs and exports run(argv). This
// phase wires approve and job; 040 owns the rest of the verb list.
const VERBS = {
  approve: 'approve [list] | approve <id> [--text "..."] | approve <id> --reject [--reason "..."] | approve <id> --sent [--cost <KRW>] | approve show <id>: answer an outbound item waiting for you, or settle a send the surface could not observe',
  job: 'job run|check <id>: run a paid job through its recipe, or re-run its acceptance checks',
  help: 'show this help',
};

const HANDLERS = { approve: 'approvals', job: 'job' };

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
