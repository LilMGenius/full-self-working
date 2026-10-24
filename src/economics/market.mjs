// Market summaries from listing samples. Quantiles use linear interpolation between order statistics
// (Hyndman and Fan 1996, definition 7, the default of R and NumPy): h = (n - 1) p.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EconomicsError } from './errors.mjs';

export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

// Lower weighted median: the smallest value whose cumulative weight reaches half the total.
// Samples without reviews carry no weight; with no weight at all there is no review-weighted median.
export function weightedMedian(pairs) {
  const weighted = pairs.filter((p) => p.weight > 0).sort((a, b) => a.value - b.value);
  const total = weighted.reduce((s, p) => s + p.weight, 0);
  if (total === 0) return null;
  let cum = 0;
  for (const p of weighted) {
    cum += p.weight;
    if (cum >= total / 2) return p.value;
  }
  return weighted.at(-1).value;
}

export function summarize(samples) {
  const groups = new Map();
  samples.forEach((s, i) => {
    if (typeof s?.priceKRW !== 'number' || !Number.isFinite(s.priceKRW) || !s.platform || !s.category) {
      throw new EconomicsError('FSW_MARKET_SAMPLE_INVALID', `sample ${i} needs platform, category and a numeric priceKRW`, { index: i });
    }
    const key = `${s.platform}\u0000${s.category}`;
    if (!groups.has(key)) groups.set(key, { platform: s.platform, category: s.category, rows: [] });
    groups.get(key).rows.push(s);
  });
  return [...groups.values()].map(({ platform, category, rows }) => {
    const prices = rows.map((r) => r.priceKRW).sort((a, b) => a - b);
    const reviewCounts = rows.map((r) => r.reviews).filter((r) => Number.isFinite(r));
    const observed = rows.map((r) => r.observedAt).filter(Boolean).sort();
    return {
      platform,
      category,
      n: prices.length,
      minKRW: prices[0],
      p25: quantile(prices, 0.25),
      median: quantile(prices, 0.5),
      p75: quantile(prices, 0.75),
      maxKRW: prices.at(-1),
      reviewWeightedMedian: weightedMedian(rows.map((r) => ({ value: r.priceKRW, weight: Number.isFinite(r.reviews) ? r.reviews : 0 }))),
      topSellerReviewCount: reviewCounts.length ? Math.max(...reviewCounts) : null,
      observedAt: observed.at(-1) ?? null,
    };
  });
}

const SUMMARY_RE = /^summary-(\d{4})(\d{2})(\d{2})\.json$/;

// Newest summary-YYYYMMDD.json in the instance's market directory. observedAt is the file's day.
export function latestSummary(instance) {
  const dir = instance?.paths?.market;
  const files = dir && existsSync(dir) ? readdirSync(dir).filter((f) => SUMMARY_RE.test(f)).sort() : [];
  if (!files.length) {
    throw new EconomicsError('FSW_MARKET_NO_SUMMARY', `no summary-YYYYMMDD.json in ${dir}; run market sampling first`, { dir });
  }
  const file = files.at(-1);
  const [, y, m, d] = file.match(SUMMARY_RE);
  const entries = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  if (!Array.isArray(entries)) throw new EconomicsError('FSW_MARKET_SUMMARY_INVALID', `${file} is not an array of entries`, { file });
  return { file: join(dir, file), day: `${y}${m}${d}`, observedAt: `${y}-${m}-${d}`, entries };
}
