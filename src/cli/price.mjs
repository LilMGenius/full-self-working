// fsw price: rebuild the price table through refreshPriceTable (010); each row's adapter flag says whether
// this build has a surface for its platform.
import { loadInstance } from '../core/instance.mjs';
import { refreshPriceTable } from '../economics/price-table.mjs';
import { hasSurface } from '../surface/index.mjs';

export async function run(argv, ctx = {}) {
  const instance = ctx.instance ?? loadInstance();
  const r = await refreshPriceTable(instance, { adapterFor: hasSurface, log: ctx.log ?? console.log });
  return { exitCode: 0, ...r };
}
