// fsw market [platform...]: sample the market of the named platforms, or of every platform the config
// lists, through sampleMarket with the surface samplers, each through its market engine (010; argv as at
// src/cli/market.mjs:86-88 at 2c77326).
import { loadInstance } from '../core/instance.mjs';
import { sampleMarket } from '../economics/sampling.mjs';
import { SAMPLERS } from '../surface/index.mjs';
import { withMarketPage } from '../surface/owned-page.mjs';

export async function run(argv, ctx = {}) {
  const instance = ctx.instance ?? loadInstance();
  return sampleMarket(instance, { platforms: argv.filter((a) => !a.startsWith('-')), samplers: ctx.samplers ?? SAMPLERS, withPage: ctx.withPage ?? withMarketPage, log: ctx.log ?? console.log, ...(ctx.loadFx ? { loadFx: ctx.loadFx } : {}), ...(ctx.now ? { now: ctx.now } : {}) });
}
