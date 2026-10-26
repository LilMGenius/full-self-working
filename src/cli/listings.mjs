// fsw listings: build <service> writes a 크몽 gig spec and its images under the instance for review;
// render redraws the images of a written spec; check runs its checks again; publish submits it through
// the listing surface. The code lives in src/listings/gig.mjs; the supervisor runs src/listings/watch.mjs.
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { build, publish, readSpec, render } from '../listings/gig.mjs';

const USAGE = 'usage: fsw listings build|render <service> [--refresh-proofs] | check <service> | publish <service> [--no-submit] [--replace-images]';

export async function run(argv, ctx = {}) {
  const [cmd, service, ...rest] = argv;
  const log = ctx.log ?? console.log;
  if (!['build', 'render', 'publish', 'check'].includes(cmd) || !service) {
    console.error(USAGE);
    return { exitCode: 2 };
  }
  const instance = ctx.instance ?? loadInstance();
  try {
    if (cmd === 'build' || cmd === 'render') {
      const opts = { instance, log, runCodex: ctx.runCodex, refreshProofs: rest.includes('--refresh-proofs') };
      const r = cmd === 'build' ? await build(service, opts) : await render(service, opts);
      log('listings: wrote ' + r.file);
      log('  title  ' + r.spec.title);
      log('  prices ' + r.spec.packages.map((p) => p.tier + ' ' + p.priceKRW).join(', '));
      log('  images ' + [r.spec.images.main, ...r.spec.images.detail].join(', '));
      return { exitCode: 0, ...r };
    }
    if (cmd === 'check') {
      const { violations } = readSpec(instance, service);
      for (const v of violations) log('  ' + v.field + ' [' + v.rule + '] ' + v.detail);
      log('listings: ' + service + ' ' + (violations.length ? violations.length + ' violations' : 'passes every check'));
      return { exitCode: violations.length ? 1 : 0, violations };
    }
    const ledger = openLedger(instance.paths.ledger);
    try {
      const r = await publish(service, { instance, log, ledger, adapter: ctx.adapter, submit: !rest.includes('--no-submit'), replaceImages: rest.includes('--replace-images') ? ['main', 'detail'] : [] });
      log('listings: ' + JSON.stringify(r));
      return { exitCode: r.observed ? 0 : 1, ...r };
    } finally {
      ledger.close();
    }
  } catch (err) {
    log('listings: ' + (err.code ?? 'error') + ' ' + err.message);
    for (const v of err.violations ?? []) log('  ' + v.field + ' [' + v.rule + '] ' + v.detail);
    return { exitCode: 1, error: err.message, code: err.code ?? null, violations: err.violations ?? [] };
  }
}
