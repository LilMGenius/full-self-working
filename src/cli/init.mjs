// fsw init [dir]: creates an operator instance from examples/instance, never overwriting a file that
// exists, and says what is left to do. The instance directory is the only place personal data lives.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, instanceDir } from '../core/instance.mjs';

// A directory holds an instance when any file the loader requires is in it.
export const INSTANCE_MARKERS = ['profile.json', 'business.json', 'config.json'];

export class InstanceExistsError extends Error {
  constructor(dir, found) {
    super(`instance already exists in ${dir} (${found.join(', ')}); init never overwrites, so edit those files or pick another directory`);
    this.name = 'InstanceExistsError';
    this.code = 'FSW_INSTANCE_EXISTS';
    this.dir = dir;
  }
}

export function initInstance(dir) {
  const target = instanceDir(dir);
  const found = INSTANCE_MARKERS.filter((f) => existsSync(join(target, f)));
  if (found.length) throw new InstanceExistsError(target, found);
  mkdirSync(target, { recursive: true });
  const created = [];
  const skipped = [];
  for (const name of readdirSync(exampleDir)) {
    const to = join(target, name);
    if (existsSync(to)) skipped.push(name);
    else {
      copyFileSync(join(exampleDir, name), to);
      created.push(name);
    }
  }
  return { dir: target, created, skipped };
}

export function nextSteps(dir) {
  const elsewhere = dir !== instanceDir(undefined);
  return [
    ...(elsewhere ? [`set FSW_INSTANCE to ${dir} (PowerShell: $env:FSW_INSTANCE = '${dir}') so every fsw command finds it`] : []),
    'put your background in files (a CV, a LinkedIn export, notes, repository folders) and run: fsw profile build <file-or-folder>...',
    `read ${join(dir, 'profile.draft.json')} and profile.review.md, fix what is wrong, then run: fsw profile accept`,
    'fill business.json (company, registration number, e-mail, payout account) and review config.json (platforms, modes, cash caps)',
    'sign in to each enabled platform in Chrome, then run: fsw doctor',
    'when doctor passes, run: fsw schedule install',
  ];
}

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const error = ctx.error ?? console.error;
  if (argv.length > 1 || argv[0]?.startsWith('--')) {
    error('usage: fsw init [dir]');
    return 1;
  }
  let result;
  try {
    result = initInstance(argv[0]);
  } catch (err) {
    if (err.code !== 'FSW_INSTANCE_EXISTS') throw err;
    error(`fsw init: ${err.code}: ${err.message}`);
    return 1;
  }
  log(`created instance ${result.dir}`);
  for (const f of result.created) log(`  + ${f}`);
  for (const f of result.skipped) log(`  = ${f} (kept)`);
  log('\nThe files hold placeholder values; fsw doctor reports them until you replace them.\nnext steps');
  nextSteps(result.dir).forEach((s, i) => log(`  ${i + 1}. ${s}`));
  return 0;
}
