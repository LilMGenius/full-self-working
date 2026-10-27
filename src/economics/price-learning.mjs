// Price rows that move with how fsw's own quotes ended (docs/DESIGN.md, Economics). One factor per
// (platform, service), folded over its decided cases oldest first, so the same cases give the same factor.
import { sellerNet } from './fees.mjs';
import { roundTo1000 } from './pricing.mjs';

const DECIDED = new Set(['won', 'lost', 'expired']);

// A won case moves the factor a step toward the index it won at; a lost or expired case moves it a step
// toward just under the index it lost at and never up, since a loss above the current price says nothing
// about the current price. Bounded to [1 - maxMove, 1 + maxMove] after every case.
export function learnedFactor(cases, { step, maxMove }) {
  let f = 1;
  for (const c of cases) {
    if (c.index == null || !DECIDED.has(c.result)) continue;
    const target = c.result === 'won' ? c.index : Math.min(c.index * (1 - step), f);
    f = Math.min(1 + maxMove, Math.max(1 - maxMove, f + step * (target - f)));
  }
  return f;
}

// results is quoteResults(...) as of asOf. Every row gets learned {cases, won, lost, expired, refused, open,
// priced, winRate, factor, fromKRW, capped, reason}; a viable row with minCases decided quotes in the
// lookback gets baseKRW = its base x factor, held between costFloorKRW and marketCeilingKRW, and the matching
// baseNetKRW. packages, floorKRW and ceilingKRW stay on the market (kmong gigs print packages, and the
// listing gate pins them to the table).
export function learnPriceRows(rows, results, { settings, descriptors, asOf }) {
  const { minCases, step, maxMove, lookbackDays } = settings;
  const since = asOf.getTime() - lookbackDays * 86_400_000;
  return rows.map((row) => {
    const mine = results.filter((r) => r.platform === row.platform && r.service === row.service && Date.parse(r.at) >= since);
    const n = (k) => mine.filter((r) => r.result === k).length;
    const decided = mine.filter((r) => DECIDED.has(r.result));
    const learned = { cases: decided.length, won: n('won'), lost: n('lost'), expired: n('expired'), refused: n('refused'), open: n('open'), priced: decided.filter((r) => r.index != null).length, winRate: (n('won') + 1) / (decided.length + 2), factor: 1, fromKRW: row.baseKRW, capped: false };
    if (!row.viable) return { ...row, learned: { ...learned, reason: 'row not viable' } };
    if (decided.length < minCases) return { ...row, learned: { ...learned, reason: decided.length + ' of ' + minCases + ' decided quotes' } };
    const factor = Math.round(learnedFactor(decided, { step, maxMove }) * 10_000) / 10_000;
    const raw = roundTo1000(row.baseKRW * factor);
    const base = Math.min(row.marketCeilingKRW, Math.max(row.costFloorKRW, raw));
    const capped = Math.abs(factor - 1) >= maxMove || base !== raw;
    return { ...row, baseKRW: base, baseNetKRW: sellerNet(base, descriptors[row.platform]).net, learned: { ...learned, factor, capped, reason: learned.priced + ' priced of ' + decided.length + ' decided quotes' } };
  });
}
