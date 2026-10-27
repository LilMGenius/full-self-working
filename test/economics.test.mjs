// Synthetic fixtures only: no value here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarize, latestSummary, quantile } from '../src/economics/market.mjs';
import { sellerNet } from '../src/economics/fees.mjs';
import { buildPriceTable, costFloor, quoteForRequest, splitPayment } from '../src/economics/pricing.mjs';
import { armStats } from '../src/economics/yield.mjs';
import { allocate, beta, mulberry32 } from '../src/economics/allocate.mjs';
import { quoteResults } from '../src/economics/quote-results.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { tempDir } from './tmp.mjs';

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
const config = { yield: { agentHourCostKRW: 2000, humanHourValueKRW: 30000 }, payment: { depositRatio: 0.5, milestoneThresholdKRW: 1000000, milestones: [0.3, 0.4, 0.3] } };

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
  const dir = tempDir('fsw-market-');
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

test('whole-amount tiers charge the whole gross at one rate, and the cost floor crosses the cliff', () => {
  const cliff = { id: 'cliff', fees: { seller: [{ uptoKRW: 5000000, rate: 0.25 }, { uptoKRW: null, rate: 0.2 }], sellerTierBasis: 'whole', paymentNetworkRate: 0, vatOnFees: 0 } };
  assert.equal(sellerNet(4999000, cliff).net, 3749250);
  assert.equal(sellerNet(5000000, cliff).net, 4000000);
  // No gross under 5,000,000 nets 3,800,000 (the most is 3,749,999), so the floor is the cliff itself.
  assert.equal(costFloor({ agentHours: 1900, humanMinutes: 0, agentHourCostKRW: 2000, humanHourValueKRW: 30000, descriptor: cliff }), 5000000);
  assert.throws(() => sellerNet(1000, { ...cliff, fees: { ...cliff.fees, sellerTierBasis: 'flat' } }), { code: 'FSW_FEES_MISSING' });
});

const services = {
  _notes: { a: 'ignored' },
  svc: { kmongCategory: 'cat', soomgoGuide: null, agentHours: { standard: 1, deluxe: 2, premium: 4 }, humanMinutes: { standard: 15 } },
  slow: { kmongCategory: 'cheap', soomgoGuide: null, agentHours: { standard: 3, deluxe: 6, premium: 12 }, humanMinutes: { standard: 30 } },
  mid: { kmongCategory: 'mid', soomgoGuide: null, agentHours: { standard: 2, deluxe: 4, premium: 8 }, humanMinutes: { standard: 20 } },
};
const summary = {
  observedAt: '2026-01-01',
  entries: [
    { platform: 'kmong', category: 'cat', n: 30, p25: 10000, median: 20000, p75: 40000 },
    { platform: 'kmong', category: 'cheap', n: 30, p25: 5000, median: 5000, p75: 9000 },
    { platform: 'kmong', category: 'mid', n: 30, p25: 6000, median: 8000, p75: 20000 },
  ],
};
// reviews of each service on the platform, all tied to their service through the ledger.
const byService = (reviews) => Object.fromEntries(Object.keys(services).filter((s) => !s.startsWith('_')).map((s) => [s, reviews]));
const table = (reviews, strength = 'some', descriptor = free) =>
  buildPriceTable({ summary, services, profile: { serviceFit: { svc: { strength } } }, sellerStats: { kmong: { reviews: reviews * 3, byService: byService(reviews) } }, config, descriptors: { kmong: descriptor } });

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
  assert.equal(table(5, 'some', tiered).find((r) => r.service === 'svc').baseNetKRW, 20000 - 4334);
});

const floorArgs = { agentHourCostKRW: 2000, humanHourValueKRW: 30000 };

test('cost floor is the smallest 1,000 KRW gross whose net covers agent hours and operator minutes', () => {
  // 3 agent hours at 2,000 plus 30 operator minutes at 30,000 per hour is 21,000 KRW of net.
  assert.equal(costFloor({ agentHours: 3, humanMinutes: 30, ...floorArgs, descriptor: free }), 21000);
  // 1 agent hour plus 15 operator minutes is 9,500 KRW of net; fees decide the gross.
  const gross = costFloor({ agentHours: 1, humanMinutes: 15, ...floorArgs, descriptor: tiered });
  assert.ok(sellerNet(gross, tiered).net >= 9500);
  assert.ok(sellerNet(gross - 1000, tiered).net < 9500);
  assert.equal(gross % 1000, 0);
  assert.throws(() => costFloor({ agentHours: 1, humanMinutes: 15, descriptor: free }), { code: 'FSW_CONFIG_MISSING' });
});

test('a market entry price under the cost floor is raised to the floor and stays offerable', () => {
  const mid = table(5).find((r) => r.service === 'mid');
  // The 5 to 29 tier asks the 8,000 median at fit none (0.9), 7,000; 2 agent hours and 20 operator minutes cost 14,000.
  assert.equal(mid.marketBaseKRW, 7000);
  assert.equal(mid.costFloorKRW, 14000);
  assert.equal(mid.baseKRW, 14000);
  assert.equal(mid.pricedAtFloor, true);
  assert.deepEqual(mid.packages, { standard: 14000, deluxe: 31000, premium: 56000 });
  assert.equal(mid.viable, true);
  const svc = table(5).find((r) => r.service === 'svc');
  assert.equal(svc.pricedAtFloor, false);
  assert.equal(svc.viable, true);
});

test('a service whose cost floor is above the market ceiling is priced out, with a reason and a quotable range', () => {
  const slow = table(5).find((r) => r.service === 'slow');
  // The market tops out at p75 x 1.5 = 13,500, rounded to 14,000; the floor is 21,000.
  assert.equal(slow.costFloorKRW, 21000);
  assert.equal(slow.viable, false);
  assert.match(slow.reason, /cost floor 21000 KRW is above the market ceiling 14000 KRW/);
  for (const row of table(5)) assert.ok(row.ceilingKRW >= row.floorKRW, row.service + ': ceiling ' + row.ceilingKRW + ' under floor ' + row.floorKRW);
  assert.throws(() => buildPriceTable({ summary, services, profile: {}, sellerStats: {}, config, descriptors: { kmong: free } }), { code: 'FSW_SELLER_STATS_MISSING' });
  assert.throws(() => buildPriceTable({ summary, services, profile: {}, sellerStats: { kmong: { reviews: 5 } }, config: { yield: { humanHourValueKRW: 30000 } }, descriptors: { kmong: free } }), { code: 'FSW_CONFIG_MISSING' });
});

test('request quotes scale the row base, clamp to the guide and respect the cost floor plus quote cost', () => {
  const guide = { avgKRW: 100000, minKRW: 80000, maxKRW: 150000 };
  const row = { baseKRW: 100000, costFloorKRW: 20000, ceilingKRW: 150000 };
  const q = (complexity, extra = {}) => quoteForRequest({ guide, complexity, row, descriptor: free, config, quoteCostKRW: 1990, ...extra });
  assert.equal(q(1).amountKRW, 100000);
  assert.equal(q(0.6).amountKRW, 80000);
  assert.equal(q(1.6).amountKRW, 150000);
  const floored = q(0.6, { row: { baseKRW: 100000, costFloorKRW: 90000, ceilingKRW: 150000 } });
  assert.equal(floored.amountKRW, 92000);
  assert.equal(floored.floorApplied, true);
  assert.equal(floored.netKRW, 92000 - 1990);
  assert.throws(() => q(1.7), RangeError);
  assert.throws(() => q(1, { quoteCostKRW: undefined }), { code: 'FSW_QUOTE_COST_MISSING' });
  assert.throws(() => q(1, { row: { costFloorKRW: 20000 } }), { code: 'FSW_PRICE_ROW_MISSING' });
});

// The founder's pricing decision of 2026-10-27: a service the seller has fewer than 5 reviews for prices at the
// first tier, and a request quote starts from that row instead of the guide average. Guide figures are synthetic,
// shaped like a soomgo detail page guide (minimum 35,000, average 300,000).
const soomgo = { ...free, id: 'soomgo' };
const detailGuide = { observedAt: '2026-10-27', entries: [{ platform: 'soomgo', category: '상세', n: 100, avgKRW: 300000, minKRW: 35000, maxKRW: 1500000 }, { platform: 'soomgo', category: '과외', n: 100, avgKRW: 40000, minKRW: 20000, maxKRW: 90000 }] };
const guideServices = {
  detail: { soomgoGuide: '상세', agentHours: { standard: 5 }, humanMinutes: { standard: 60 } },
  lesson: { soomgoGuide: '과외', delivery: 'operator', agentHours: { standard: 0 }, humanMinutes: { standard: 60 } },
};
const guideTable = (stats) => buildPriceTable({ summary: detailGuide, services: guideServices, profile: { serviceFit: { detail: { strength: 'some' }, lesson: { strength: 'some' } } }, sellerStats: { soomgo: stats }, config, descriptors: { soomgo } });

test('reviews tier each service by its own count: an untied platform total counts for an operator service only', () => {
  const rows = Object.fromEntries(guideTable({ reviews: 20 }).map((r) => [r.service, r]));
  // 35,000 + 0.35 x (300,000 - 35,000) = 127,750, rounded: the 20 reviews name no agent-delivered service.
  assert.deepEqual([rows.detail.baseKRW, rows.detail.basis.reviews, rows.detail.basis.platformReviews], [128000, 0, 20]);
  assert.deepEqual([rows.lesson.baseKRW, rows.lesson.basis.reviews], [40000, 20]);
  const tied = Object.fromEntries(guideTable({ reviews: 20, byService: { detail: 5 } }).map((r) => [r.service, r]));
  assert.deepEqual([tied.detail.baseKRW, tied.detail.basis.reviews, tied.lesson.basis.reviews], [300000, 5, 15]);
  assert.equal(Object.fromEntries(guideTable({ reviews: 3, byService: { detail: 4 } }).map((r) => [r.service, r])).lesson.basis.reviews, 0, 'more tied than the total leaves nothing untied');
});

test('a detail page request at complexity 1.0 is quoted at the first-tier row base, not the guide average', () => {
  const row = guideTable({ reviews: 20 }).find((r) => r.service === 'detail');
  const guide = { avgKRW: 300000, minKRW: 35000, maxKRW: 1500000 };
  const q = (complexity, r = row) => quoteForRequest({ guide, complexity, row: r, descriptor: soomgo, config, quoteCostKRW: 990 });
  assert.equal(q(1).amountKRW, 128000);
  assert.deepEqual([q(1).basis.source, q(1).basis.base, q(1).basis.reference, q(1).basis.guideAvg], ['price-row', 128000, 128000, 300000]);
  assert.equal(q(1.3).amountKRW, 166000);
  // 5 agent hours at 2,000 and 60 operator minutes at 30,000 an hour cost 40,000; with the 990 quote cost, 41,000.
  assert.equal(q(0.6, { ...row, baseKRW: 50000 }).amountKRW, 41000, 'held at the cost floor plus the quote cost, above the guide minimum');
  const learned = q(1, { ...row, baseKRW: 115000, learned: { factor: 0.9, fromKRW: 128000 } });
  assert.deepEqual([learned.amountKRW, learned.basis.reference, learned.basis.learnedFactor], [115000, 128000, 0.9]);
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

test('armStats sums evidence-backed revenue, fees per payment, quote and tool costs, and weighted hours', () => {
  const ledger = openLedger(':memory:');
  const t1 = ledger.upsertThread({ platform: 'tiered', externalId: 'a', kind: 'order', service: 'svc' });
  ledger.upsertJob({ id: 'j1', threadId: t1.id, platform: 'tiered', service: 'svc', status: 'closed', priceKRW: 500000, agentMinutes: 600, humanMinutes: 60, costKRW: 10000 });
  ledger.addPayment({ jobId: 'j1', kind: 'full', amountKRW: 500000, evidence: 'order state' });
  ledger.upsertJob({ id: 'j2', platform: 'tiered', service: 'svc', status: 'lost' });
  for (const [ext, status] of [['b', 'accepted'], ['c', 'declined'], ['d', 'expired']]) {
    const t = ledger.upsertThread({ platform: 'free', externalId: ext, kind: 'request', service: 'svc' });
    ledger.addQuote({ threadId: t.id, platform: 'free', service: 'svc', amountKRW: 100000, costKRW: 1990, status });
    if (status === 'accepted') {
      ledger.upsertJob({ id: 'j3', threadId: t.id, platform: 'free', service: 'svc', status: 'delivered', agentMinutes: 120 });
      ledger.addPayment({ jobId: 'j3', kind: 'deposit', amountKRW: 50000, evidence: 'pay' });
      ledger.addPayment({ jobId: 'j3', kind: 'balance', amountKRW: 50000, evidence: 'pay' });
    }
  }
  const stats = armStats(ledger, { descriptors: { tiered, free }, services, config: { yield: { humanHourWeight: 4 } } });
  const t = stats.find((a) => a.platform === 'tiered' && a.service === 'svc');
  assert.deepEqual([t.leads, t.quotes, t.wins, t.losses, t.revenueKRW], [2, 0, 1, 1, 500000]);
  assert.equal(t.netKRW, 391650 - 10000);
  assert.deepEqual([t.agentHours, t.humanHours, t.weightedHours], [10, 1, 14]);
  assert.equal(t.netPerWeightedHour, 381650 / 14);
  assert.equal(t.expectedHours, 14);
  const f = stats.find((a) => a.platform === 'free' && a.service === 'svc');
  assert.deepEqual([f.leads, f.quotes, f.wins, f.losses, f.revenueKRW, f.netKRW], [3, 3, 1, 2, 100000, 100000 - 3 * 1990]);
  assert.equal(f.expectedHours, 2); // no closed job yet: 1 agent hour + 15 human minutes x weight 4
  const idle = stats.find((a) => a.platform === 'free' && a.service === 'slow');
  assert.deepEqual([idle.leads, idle.netKRW, idle.netPerWeightedHour], [0, 0, null]);
  ledger.close();
});

test('Marsaglia-Tsang Beta draws match the Beta mean', () => {
  const rng = mulberry32(7);
  let s = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) s += beta(9, 3, rng);
  assert.ok(Math.abs(s / n - 0.75) < 0.01, `mean ${s / n}`);
  let low = 0;
  for (let i = 0; i < n; i++) low += beta(0.5, 0.5, rng);
  assert.ok(Math.abs(low / n - 0.5) < 0.01, `mean ${low / n}`);
});

const allocConfig = {
  yield: { explorationFloor: 0.05, explorationShare: 0.3, exploreUntilLeads: 10 },
  platforms: { p: { enabled: true }, off: { enabled: false } },
};
const rowP = (service, baseNetKRW, viable = true) => ({ platform: 'p', service, baseNetKRW, viable, reason: viable ? undefined : 'under cost floor' });
const allocTable = [rowP('star', 500000), rowP('new', 10000), rowP('dud', 10000), rowP('nv', 900000, false), { platform: 'off', service: 'star', baseNetKRW: 500000, viable: true }];
const allocArms = [
  { platform: 'p', service: 'star', leads: 40, wins: 30, losses: 2, expectedHours: 5 },
  { platform: 'p', service: 'new', leads: 0, wins: 0, losses: 0, expectedHours: 5 },
  { platform: 'p', service: 'dud', leads: 20, wins: 0, losses: 20, expectedHours: 50 },
  { platform: 'p', service: 'nv', leads: 0, wins: 0, losses: 0, expectedHours: 1 },
  { platform: 'p', service: 'unpriced', leads: 0, wins: 0, losses: 0, expectedHours: 1 },
  { platform: 'off', service: 'star', leads: 0, wins: 0, losses: 0, expectedHours: 1 },
];

test('allocate is deterministic for a seed and independent of arm order', () => {
  const a = allocate(allocArms, { priceTable: allocTable, config: allocConfig, rng: mulberry32(42) });
  const b = allocate([...allocArms].reverse(), { priceTable: allocTable, config: allocConfig, rng: mulberry32(42) });
  assert.deepEqual(a, b);
  assert.ok(Math.abs(a.reduce((s, r) => s + r.weight, 0) - 1) < 1e-12);
  assert.equal(a[0].service, 'star');
});

test('allocate keeps the exploration floor for young arms and zeroes non-viable, unpriced and disabled arms', () => {
  const w = Object.fromEntries(allocate(allocArms, { priceTable: allocTable, config: allocConfig, rng: mulberry32(1) }).map((r) => [`${r.platform}/${r.service}`, r]));
  assert.ok(w['p/new'].weight >= 0.05 - 1e-12);
  assert.equal(w['p/new'].exploring, true);
  assert.ok(w['p/dud'].weight < 0.05, 'an arm past its exploration leads may fall under the floor');
  assert.equal(w['p/nv'].weight, 0);
  assert.equal(w['p/nv'].reason, 'under cost floor');
  assert.equal(w['p/unpriced'].weight, 0);
  assert.equal(w['off/star'].weight, 0);
  assert.equal(w['off/star'].reason, 'platform not enabled');
});

test('an arm whose price row has no adapter gets no weight, whatever its value', () => {
  const table = [rowP('star', 500000), { ...rowP('ghost', 900000), adapter: false }];
  const arms = ['star', 'ghost'].map((service) => ({ platform: 'p', service, leads: 0, wins: 0, losses: 0, expectedHours: 4 }));
  const w = Object.fromEntries(allocate(arms, { priceTable: table, config: allocConfig, rng: mulberry32(7) }).map((r) => [r.service, r]));
  assert.equal(w.ghost.weight, 0);
  assert.equal(w.ghost.reason, 'no adapter');
  assert.equal(w.star.weight, 1);
});

test('with more young arms than the floors can serve, the floors share the exploration mass and value still leads', () => {
  const services = Array.from({ length: 24 }, (_, i) => 's' + String(i).padStart(2, '0'));
  const table = services.map((s, i) => rowP(s, (i + 1) * 20000));
  const arms = services.map((s) => ({ platform: 'p', service: s, leads: 0, wins: 0, losses: 0, expectedHours: 4 }));
  const runs = 200;
  const mean = Object.fromEntries(services.map((s) => [s, 0]));
  const rng = mulberry32(3);
  for (let k = 0; k < runs; k++) for (const r of allocate(arms, { priceTable: table, config: allocConfig, rng })) mean[r.service] += r.weight / runs;
  const floor = 0.3 / 24;
  for (const s of services) assert.ok(mean[s] >= floor - 1e-12, s + ' kept its exploration floor');
  assert.ok(mean.s23 > 3 * mean.s00, 'the most valuable arm gets several times the least valuable one');
  assert.ok(mean.s23 > 1 / 24 + 0.02, 'weights are not uniform');
});

test('armStats counts an aged quote of a quoted job as a loss, a refused send apart, and a chat job deciding its request quote once', () => {
  const ledger = openLedger(':memory:');
  const T0 = '2026-10-01T00:00:00.000Z';
  // A quote whose job still waits at quoted, 15 days old: the results call it expired, and no job counted it.
  const q = ledger.upsertThread({ platform: 'free', externalId: 'q', kind: 'request', service: 'svc' });
  ledger.addQuote({ threadId: q.id, platform: 'free', service: 'svc', amountKRW: 100000, costKRW: 1990, status: 'sent', at: T0 });
  ledger.upsertJob({ id: 'jq', threadId: q.id, platform: 'free', service: 'svc', status: 'quoted' });
  // A soomgo-style hire: the job moved to its chat and names the request thread its quote sits on.
  const r = ledger.upsertThread({ platform: 'free', externalId: 'r', kind: 'request', service: 'svc' });
  const c = ledger.upsertThread({ platform: 'free', externalId: 'c', kind: 'message', service: 'svc' });
  ledger.addQuote({ threadId: r.id, platform: 'free', service: 'svc', amountKRW: 100000, costKRW: 1990, status: 'declined', at: T0 });
  ledger.upsertJob({ id: 'jc', threadId: c.id, platform: 'free', service: 'svc', status: 'lost', meta: { requestThreadId: r.id } });
  // A send the platform refused: no quote row, never seen by the client.
  const f = ledger.upsertThread({ platform: 'free', externalId: 'f', kind: 'request', service: 'svc' });
  ledger.addOutbox({ key: 'k-f', platform: 'free', threadId: f.id, kind: 'quote', payload: { amountKRW: 100000, service: 'svc' }, status: 'stale', receipt: { refused: 'FSW_SOOMGO_REQUEST_FULL', at: T0 }, createdAt: T0 });
  const results = quoteResults(ledger, { asOf: new Date('2026-10-16T00:00:00.000Z'), expireAfterDays: 14 });
  const arm = armStats(ledger, { descriptors: { free }, services, config: { yield: { humanHourWeight: 4 } }, results }).find((a) => a.platform === 'free' && a.service === 'svc');
  assert.deepEqual([arm.wins, arm.losses, arm.refused, arm.quotes, arm.quoteCostPerQuoteKRW], [0, 2, 1, 2, 1990]);
  const statusesOnly = armStats(ledger, { descriptors: { free }, services, config: { yield: { humanHourWeight: 4 } } }).find((a) => a.platform === 'free' && a.service === 'svc');
  assert.deepEqual([statusesOnly.losses, statusesOnly.refused], [1, 1], 'without the age rule the waiting quote is open');
  const none = armStats(openLedger(':memory:'), { descriptors: { free }, services, config: { yield: { humanHourWeight: 4 } } }).find((a) => a.platform === 'free' && a.service === 'svc');
  assert.equal(none.quoteCostPerQuoteKRW, 0);
  ledger.close();
});

test('allocate charges each arm the cost of a quote, so a costly quote scores lower at the same draw', () => {
  const table = [rowP('svc', 300000)];
  const arm = { platform: 'p', service: 'svc', leads: 20, wins: 2, losses: 8, expectedHours: 5 };
  const [cheap] = allocate([{ ...arm, quoteCostPerQuoteKRW: 0 }], { priceTable: table, config: allocConfig, rng: mulberry32(9) });
  const [costly] = allocate([{ ...arm, quoteCostPerQuoteKRW: 20000 }], { priceTable: table, config: allocConfig, rng: mulberry32(9) });
  assert.equal(costly.winRate, cheap.winRate);
  assert.deepEqual([cheap.quoteCostKRW, costly.quoteCostKRW], [0, 20000]);
  assert.equal(costly.score, Math.max(0, cheap.winRate * 300000 - 20000) / 5);
  assert.ok(costly.score < cheap.score);
  const [ruinous] = allocate([{ ...arm, quoteCostPerQuoteKRW: 10_000_000 }], { priceTable: table, config: allocConfig, rng: mulberry32(9) });
  assert.equal(ruinous.score, 0, 'never below 0');
});
