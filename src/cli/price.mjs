// fsw price: rebuild the price table through refreshPriceTable (010); each row's adapter flag says whether
// this build has a surface for its platform.
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { refreshPriceTable } from '../economics/price-table.mjs';
import { hasSurface } from '../surface/index.mjs';

export async function run(argv, ctx = {}) {
  const instance = ctx.instance ?? loadInstance();
  // The ledger the price job replays, so fsw price and the 00:00 job write the same table for a day.
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  try {
    const r = await refreshPriceTable(instance, { adapterFor: hasSurface, ledger, log: ctx.log ?? console.log });
    return { exitCode: 0, ...r };
  } finally {
    if (!ctx.ledger) ledger.close();
  }
}
