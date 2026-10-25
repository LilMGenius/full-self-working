// fsw onboard <platform> [--apply] [--step <id>]: walks a marketplace's seller onboarding in the
// operator's signed-in Chrome and fills it from the instance. Without --apply it is a dry run: each step
// is typed and read back and nothing is saved, so a wizard that opens a step only after the one before it
// is saved stops at the first unsaved step. An already finished step reports done and is left as it is.
//
// The interface a platform implements, in src/platforms/<id>/onboarding.mjs:
//   export const STEPS = [{ id, detect: { path, heading } }]   ordered steps and how each page is known
//   export async function onboard(session, ctx) -> [{ step, state, detail }]
//     session  the driver session (src/browser/driver.mjs), opened and stopped here
//     ctx      { instance, apply, step, descriptor, ledger, log, evidenceDir }; step is null for every step
//     state    done (already as the instance says), filled (typed and read back; saved under --apply),
//              needs-operator (detail names what the operator must do), unmapped (a page the script
//              does not know yet; detail is its outline)
// The module reads its operator answers from config.onboarding.<platform>, and every text it types passes
// gateOutbound as kind profile first. Shared page helpers live in src/platforms/onboarding.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSession } from '../browser/driver.mjs';
import { loadInstance, repoRoot } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { humanize } from '../platforms/onboarding.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';

const USAGE = 'usage: fsw onboard <platform> [--apply] [--step <id>] [--force]';

export function parseArgs(argv) {
  const [platform, ...rest] = argv;
  const stepAt = rest.indexOf('--step');
  const step = stepAt >= 0 ? rest[stepAt + 1] : null;
  if (!platform || platform.startsWith('-') || (stepAt >= 0 && (!step || step.startsWith('-')))) throw new Error(USAGE);
  return { platform, apply: rest.includes('--apply'), step, force: rest.includes('--force') };
}

export const hasOnboarding = (platform, root = repoRoot) => existsSync(join(root, 'src', 'platforms', platform, 'onboarding.mjs'));

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const { platform, apply, step, force } = parseArgs(argv);
  if (!ctx.module && !hasOnboarding(platform)) throw new Error('no onboarding script for ' + platform + ' (src/platforms/' + platform + '/onboarding.mjs)');
  const mod = ctx.module ?? (await import('../platforms/' + platform + '/onboarding.mjs'));
  if (step && !mod.STEPS.some((s) => s.id === step)) throw new Error(platform + ' has no step ' + step + '; steps: ' + mod.STEPS.map((s) => s.id).join(', '));
  const instance = ctx.instance ?? loadInstance();
  const descriptor = ctx.descriptor ?? loadDescriptor(platform);
  const evidenceDir = join(instance.paths.logs, 'onboarding', platform);
  mkdirSync(evidenceDir, { recursive: true });
  // Onboarding is a person's pace through one wizard, so a descriptor may set a separate cap for it, a
  // human gap before each action and a cooldown between runs, since a site that sees the same wizard
  // walked again and again signs the session out.
  const pacing = descriptor.onboardingPacing ?? descriptor.pacing;
  const now = ctx.now ?? Date.now;
  const stamp = join(evidenceDir, 'last-run.json');
  const last = existsSync(stamp) ? JSON.parse(readFileSync(stamp, 'utf8')).at : null;
  const wait = last && pacing.cooldownMs ? last + pacing.cooldownMs - now() : 0;
  if (wait > 0 && !force) {
    log(platform + ': the last run was ' + Math.round((now() - last) / 60000) + ' min ago; the next may start in ' + Math.ceil(wait / 60000) + ' min (--force skips the wait)');
    return 1;
  }
  writeFileSync(stamp, JSON.stringify({ at: now() }));
  const opened = ctx.session ? null : await openSession('onboard-' + platform, { platform, pacing });
  const session = ctx.session ?? humanize(opened, pacing);
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  let results = [];
  try {
    results = await mod.onboard(session, { instance, apply, step, descriptor, ledger, log, evidenceDir });
    const filled = results.filter((r) => r.state === 'filled').map((r) => r.step);
    if (apply && filled.length) ledger.addEvent({ kind: 'platform.onboarding', platform, ref: filled.join(','), payload: { results } });
  } finally {
    if (opened) await opened.stop();
    if (!ctx.ledger) ledger.close();
  }
  log((apply ? 'applied' : 'dry run') + ', ' + platform + ':');
  for (const r of results) log('  ' + r.step.padEnd(18) + ' ' + r.state.padEnd(14) + ' ' + (r.detail ?? ''));
  return 0;
}

