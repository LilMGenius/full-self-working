// fsw publish [--force] [--dry-run]: builds the portfolio site from the instance and deploys it only when its
// content hash changed; scripts/publish.mjs owns the build, the deploy and its verification.
import { publish } from '../../scripts/publish.mjs';

export async function run(argv, ctx = {}) {
  const opts = { force: false, dryRun: false };
  for (const a of argv) {
    if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error('usage: fsw publish [--force] [--dry-run]');
  }
  await (ctx.publish ?? publish)({ instance: ctx.instanceDir, ...opts, log: ctx.log ?? console.log });
  return 0;
}

