// Synthetic fixtures only: no value here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, latestSummary, quantile } from '../src/economics/market.mjs';
import { sellerNet } from '../src/economics/fees.mjs';
import { buildPriceTable, costFloor, quoteForRequest, splitPayment } from '../src/economics/pricing.mjs';

const tiered = {
  id: 'tiered',
  name: '티어마켓',
  milestones: 'reorder',
  bidCost: { unit: 'none' },
  fees: {
    seller: [{ uptoKRW: 700000, rate: 0.164 }, { uptoKRW: 2000000, rate: 0.094 }, { uptoKRW: null, rate: 0.044 }],
    paymentNetworkRate: 0.033,
    vatOnFees: 0.1,
  },
};
const free = { id: 'free', name: '무료마켓', milestones: 'multi_pay', bidCost: { unit: 'cash per quote' }, fees: { seller: 0, paymentNetworkRate: 0, vatOnFees: 0 } };
const config = { yield: { minNetKRWPerAgentHour: 20000 }, payment: { depositRatio: 0.5, milestoneThresholdKRW: 1000000, milestones: [0.3, 0.4, 0.3] } };

test('summarize interpolates quantiles linearly and weights the median by reviews', () => {
  const row = (priceKRW, reviews) => ({ platform: 'p', category: 'c', priceKRW, reviews });
  const [odd] = summarize([50, 10, 40, 20, 30].map((p) => row(p, 0)));
  assert.deepEqual([odd.p25, odd.median, odd.p75, odd.minKRW, odd.maxKRW, odd.n], [20, 30, 40, 10, 50, 5]);
  assert.equal(odd.reviewWeightedMedian, null);
  const [even] = summarize([1, 2, 3, 4].map((p) => row(p, 1)));
  assert.deepEqual([even.p25, even.median, even.p75], [1.75, 2.5, 3.25]);
  const [w] = summarize([row(10, 1), row(20, 1), row(100, 10), row(5, undefined)]);
  assert.equal(w.reviewWeightedMedian, 100);
  assert.equal(w.topSellerReviewCount, 10);
  assert.equal(quantile([], 0.5), null);
  assert.throws(() => summarize([{ platform: 'p', category: 'c', priceKRW: 'x' }]), { code: 'FSW_MARKET_SAMPLE_INVALID' });
});

test('latestSummary reads the newest summary file and fails by name when none exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-market-'));
  assert.throws(() => latestSummary({ paths: { market: dir } }), { code: 'FSW_MARKET_NO_SUMMARY' });
  writeFileSync(join(dir, 'summary-20261001.json'), JSON.stringify([{ old: true }]));
  writeFileSync(join(dir, 'summary-20261025.json'), JSON.stringify([{ old: false }]));
  writeFileSync(join(dir, 'samples-20261030.jsonl'), '');
  const s = latestSummary({ paths: { market: dir } });
  assert.equal(s.observedAt, '2026-10-25');
  assert.deepEqual(s.entries, [{ old: false }]);
});

test('sellerNet applies marginal tiers, the payment-network fee and VAT on fees', () => {
  // 500,000: 82,000 seller + 16,500 network = 98,500, VAT 9,850, fees 108,350.
  const a = sellerNet(500000, tiered);
  assert.equal(a.fees, 108350);
  assert.equal(a.net, 391650);
  // 3,000,000: 114,800 + 122,200 + 44,000 = 281,000 seller, 99,000 network, VAT 38,000, fees 418,000.
  const b = sellerNet(3000000, tiered);
  assert.equal(b.fees, 418000);
  assert.equal(b.net, 2582000);
  assert.ok(Math.abs(b.effectiveRate - 418000 / 3000000) < 1e-12);
  assert.equal(sellerNet(100000, free).net, 100000);
});

test('sellerNet fails closed when the descriptor has no numeric fee data', () => {
  assert.throws(() => sellerNet(1000, { id: 'x', fees: { seller: 'unknown', paymentNetworkRate: 0, vatOnFees: 0 } }), { code: 'FSW_FEES_MISSING' });
  assert.throws(() => sellerNet(1000, { id: 'x', fees: { seller: 0.1, vatOnFees: 0 } }), { code: 'FSW_FEES_MISSING' });
  assert.throws(() => sellerNet(1000, { id: 'x' }), { code: 'FSW_FEES_MISSING' });
});

const services = {
  _notes: { a: 'ignored' },
  svc: { kmongCategory: 'cat', soomgoGuide: null, agentHours: { standard: 1, deluxe: 2, premium: 4 } },
  slow: { kmongCategory: 'cheap', soomgoGuide: null, agentHours: { standard: 3, deluxe: 6, premium: 12 } },
};
const summary = {
  observedAt: '2026-01-01',
  entries: [
    { platform: 'kmong', category: 'cat', n: 30, p25: 10000, median: 20000, p75: 40000 },
    { platform: 'kmong', category: 'cheap', n: 30, p25: 5000, median: 5000, p75: 9000 },
  ],
};
const table = (reviews, strength = 'some', descriptor = free) =>
  buildPriceTable({ summary, services, profile: { serviceFit: { svc: { strength } } }, sellerStats: { kmong: { reviews } }, config, descriptors: { kmong: descriptor } });

test('price tiers switch at 5 and 30 reviews and round to 1,000 KRW', () => {
  const base = (n) => table(n).find((r) => r.service === 'svc').baseKRW;
  assert.equal(base(4), 14000); // 10,000 + 0.35 x 10,000 = 13,500, rounded
  assert.equal(base(5), 20000);
  assert.equal(base(29), 20000);
  assert.equal(base(30), 30000);
  const strong = table(5, 'strong').find((r) => r.service === 'svc');
  assert.equal(strong.baseKRW, 23000);
  assert.deepEqual(strong.packages, { standard: 23000, deluxe: 51000, premium: 92000 });
  assert.equal(table(5, 'none').find((r) => r.service === 'svc').baseKRW, 18000);
  assert.equal(strong.ceilingKRW, 92000); // max(40,000 x 1.5, premium)
  assert.equal(strong.basis.observedAt, '2026-01-01');
});

test('cost floor is the smallest 1,000 KRW gross reaching the net per agent hour', () => {
  assert.equal(costFloor({ agentHours: 3, minNetPerAgentHour: 20000, descriptor: free }), 60000);
  // Fees take 21.67% of 26,000 (5,634), leaving 20,366; 25,000 leaves 19,582.
  assert.equal(costFloor({ agentHours: 1, minNetPerAgentHour: 20000, descriptor: tiered }), 26000);
  const svc = table(5, 'some', tiered).find((r) => r.service === 'svc');
  assert.equal(svc.costFloorKRW, 26000);
  assert.equal(svc.floorKRW, 26000);
  assert.equal(svc.viable, false);
});

test('a row under its cost floor stays in the table as not viable with a reason', () => {
  const slow = table(5).find((r) => r.service === 'slow');
  assert.equal(slow.baseKRW, 5000);
  assert.equal(slow.costFloorKRW, 60000);
  assert.equal(slow.viable, false);
  assert.match(slow.reason, /cost floor 60000/);
  assert.equal(table(5).find((r) => r.service === 'svc').viable, true);
  assert.throws(() => buildPriceTable({ summary, services, profile: {}, sellerStats: {}, config, descriptors: { kmong: free } }), { code: 'FSW_SELLER_STATS_MISSING' });
});

test('request quotes scale the guide average, clamp to the guide and respect the cost floor plus quote cost', () => {
  const guide = { avgKRW: 100000, minKRW: 80000, maxKRW: 150000 };
  const row = { costFloorKRW: 20000, ceilingKRW: 150000 };
  const q = (complexity, extra = {}) => quoteForRequest({ guide, complexity, row, descriptor: free, config, quoteCostKRW: 1990, ...extra });
  assert.equal(q(1).amountKRW, 100000);
  assert.equal(q(0.6).amountKRW, 80000);
  assert.equal(q(1.6).amountKRW, 150000);
  const floored = q(0.6, { row: { costFloorKRW: 90000, ceilingKRW: 150000 } });
  assert.equal(floored.amountKRW, 92000);
  assert.equal(floored.floorApplied, true);
  assert.equal(floored.netKRW, 92000 - 1990);
  assert.throws(() => q(1.7), RangeError);
  assert.throws(() => q(1, { quoteCostKRW: undefined }), { code: 'FSW_QUOTE_COST_MISSING' });
});

const sum = (parts) => parts.reduce((s, p) => s + p.amountKRW, 0);

test('크몽-style reorder: one full order below the threshold', () => {
  const s = splitPayment(500000, config, tiered);
  assert.equal(s.mechanism, 'reorder');
  assert.equal(s.parts.length, 1);
  assert.equal(s.parts[0].amountKRW, 500000);
  assert.match(s.note_ko, /보관/);
});

test('크몽-style reorder: phase orders with distinct deliverables above the threshold', () => {
  const s = splitPayment(3000000, config, tiered);
  assert.deepEqual(s.parts.map((p) => p.amountKRW), [900000, 1200000, 900000]);
  assert.equal(new Set(s.parts.map((p) => p.deliverable_ko)).size, 3);
  const two = splitPayment(2000000, { ...config, payment: { ...config.payment, milestones: [0.4, 0.6] } }, tiered);
  assert.deepEqual(two.parts.map((p) => p.label_ko), ['1단계 시안 및 설계', '2단계 최종 제작 및 납품']);
  assert.deepEqual(two.parts.map((p) => p.amountKRW), [800000, 1200000]);
  assert.notEqual(two.parts[0].deliverable_ko, two.parts[1].deliverable_ko);
});

test('multi_pay: deposit and balance below the threshold, milestones above, sums exact', () => {
  const s = splitPayment(333000, config, free);
  assert.equal(s.mechanism, 'multi_pay');
  assert.deepEqual(s.parts.map((p) => [p.label_en, p.amountKRW]), [['Deposit', 167000], ['Balance', 166000]]);
  assert.match(s.note_ko, /숨고페이 결제 요청을 2번/);
  const m = splitPayment(1000000, config, free);
  assert.deepEqual(m.parts.map((p) => p.amountKRW), [300000, 400000, 300000]);
  assert.equal(sum(splitPayment(1234567, config, free).parts), 1234567);
});

test('native milestones split like multi_pay; none is one payment; unknown fails closed', () => {
  const native = { ...free, milestones: 'native' };
  assert.deepEqual(splitPayment(200000, config, native).parts.map((p) => p.amountKRW), [100000, 100000]);
  assert.equal(splitPayment(2000000, config, native).parts.length, 3);
  assert.equal(splitPayment(200000, config, { ...free, milestones: 'none' }).parts.length, 1);
  assert.throws(() => splitPayment(200000, config, { ...free, milestones: 'unknown' }), { code: 'FSW_SPLIT_UNKNOWN' });
});
