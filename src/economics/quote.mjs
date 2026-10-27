// The amount of a fixed quote where the platform publishes no price guide (kmong): the price row's base
// times the model's complexity, clamped to the row's floor and ceiling. The shape follows
// quoteForRequest (src/economics/pricing.mjs) with the row base standing in for the guide average, so the
// model never sets an amount (003 Brain). floorKRW and ceilingKRW sit on the 1,000 KRW grid, so rounding a
// clamped value never leaves the range.
import { COMPLEXITY_RANGE, roundTo1000 } from './pricing.mjs';

export function quoteFromRow({ row, complexity }) {
  const [cmin, cmax] = COMPLEXITY_RANGE;
  if (typeof complexity !== 'number' || complexity < cmin || complexity > cmax) throw new RangeError('complexity must be within [' + cmin + ', ' + cmax + '], got ' + complexity);
  if (!(row?.baseKRW > 0)) throw Object.assign(new Error('no price row base to quote from'), { code: 'FSW_PRICE_ROW_MISSING' });
  const raw = row.baseKRW * complexity;
  const clamped = Math.min(row.ceilingKRW ?? raw, Math.max(row.floorKRW ?? raw, raw));
  // reference is the row base before learning, so quoteResults reads this quote's index against the market.
  return { amountKRW: roundTo1000(clamped), basis: { source: 'price-row', base: row.baseKRW, reference: row.learned?.fromKRW ?? row.baseKRW, learnedFactor: row.learned?.factor ?? 1, complexity, raw, floorKRW: row.floorKRW ?? null, ceilingKRW: row.ceilingKRW ?? null } };
}
