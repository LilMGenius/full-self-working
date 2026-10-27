// Price table, request quotes and payment splits (docs/DESIGN.md, Economics).
//
// A row's base comes from the newest market summary. Platforms with listing samples (크몽) give
// quantiles; platforms that publish a price guide (숨고) give only {avg, min, max}, so for those the
// guide average stands in for the median, the guide minimum for p25, and the 30-plus tier stays at
// the average because a guide has no p75.
import { sellerNet } from './fees.mjs';
import { EconomicsError, requireNumber } from './errors.mjs';

export const FIT_MULTIPLIER = { strong: 1.15, some: 1.0, none: 0.9 };
export const PACKAGE_FACTORS = { standard: 1, deluxe: 2.2, premium: 4 };
export const COMPLEXITY_RANGE = [0.6, 1.6];

export const roundTo1000 = (x) => Math.round(x / 1000) * 1000;
const ceilTo1000 = (x) => Math.ceil(x / 1000) * 1000;

// Review tiers: fewer than 5, 5 to 29, 30 or more reviews of the service on that platform. A seller new to a
// service enters at the first tier so the first jobs win, and price learning raises the row from there.
export function tierBase({ reviews, p25, median, p75 }) {
  if (reviews < 5) return p25 + 0.35 * (median - p25);
  if (reviews < 30) return median;
  return p75 == null ? median : median + 0.5 * (p75 - median);
}

// Smallest gross on the 1,000 KRW grid whose seller net covers what the standard package costs the
// operator: agent hours at their compute cost and operator review minutes at the operator's hourly
// value. Agent hours run in parallel at compute cost, so charging them like labour put every
// entry-level market under the floor. Net grows with gross on every descriptor (no marginal fee
// reaches 100%), so binary search applies.
export function costFloor({ agentHours, humanMinutes, agentHourCostKRW, humanHourValueKRW, descriptor }) {
  requireNumber(agentHours, 'agentHours.standard', 'FSW_SERVICE_INVALID');
  requireNumber(humanMinutes, 'humanMinutes.standard', 'FSW_SERVICE_INVALID');
  requireNumber(agentHourCostKRW, 'config.yield.agentHourCostKRW');
  requireNumber(humanHourValueKRW, 'config.yield.humanHourValueKRW');
  const target = agentHours * agentHourCostKRW + (humanMinutes / 60) * humanHourValueKRW;
  let lo = 0;
  let hi = Math.max(1000, Math.ceil(target));
  while (sellerNet(hi, descriptor).net < target) hi *= 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sellerNet(mid, descriptor).net >= target) hi = mid;
    else lo = mid + 1;
  }
  let gross = ceilTo1000(lo);
  while (sellerNet(gross, descriptor).net < target) gross += 1000;
  return gross;
}

function marketFor(entries, platform, category) {
  if (!category) return null;
  const e = entries.find((x) => x.platform === platform && x.category === category);
  if (!e) return null;
  if ([e.p25, e.median, e.p75].every((v) => typeof v === 'number')) {
    return { source: 'listing-quantiles', n: e.n, p25: e.p25, median: e.median, p75: e.p75, low: e.p25, high: e.p75 * 1.5 };
  }
  if (typeof e.avgKRW === 'number' && typeof e.minKRW === 'number' && typeof e.maxKRW === 'number') {
    return { source: 'price-guide', n: e.n, p25: e.minKRW, median: e.avgKRW, p75: null, low: e.minKRW, high: e.maxKRW };
  }
  // A guide that publishes only its average (숨고's lesson guides) has no spread, so the average stands
  // for its minimum and maximum too, and a request quote lands on it.
  if (typeof e.avgKRW === 'number' && e.minKRW == null && e.maxKRW == null) {
    return { source: 'price-guide', n: e.n, p25: e.avgKRW, median: e.avgKRW, p75: null, low: e.avgKRW, high: e.avgKRW };
  }
  throw new EconomicsError('FSW_MARKET_SUMMARY_INVALID', `summary entry ${platform}/${category} has neither quantiles nor guide figures`, { platform, category });
}

// The services.json field that names each platform's market category, read by pricing and sampling.
export const CATEGORY_FIELD = { kmong: 'kmongCategory', soomgo: 'soomgoGuide', freelancer: 'freelancerJob', wishket: 'wishketField', fiverr: 'fiverrQuery' };

export function buildPriceTable({ summary, services, profile, sellerStats, config, descriptors }) {
  const entries = summary?.entries;
  if (!Array.isArray(entries)) throw new EconomicsError('FSW_MARKET_SUMMARY_INVALID', 'summary.entries must be an array');
  const agentHourCostKRW = requireNumber(config?.yield?.agentHourCostKRW, 'config.yield.agentHourCostKRW');
  const humanHourValueKRW = requireNumber(config?.yield?.humanHourValueKRW, 'config.yield.humanHourValueKRW');
  const rows = [];
  for (const [platform, descriptor] of Object.entries(descriptors)) {
    const field = CATEGORY_FIELD[platform];
    // A platform without a catalog field has no category mapping yet; adding one to services.json closes it.
    if (!field) continue;
    const platformReviews = requireNumber(sellerStats?.[platform]?.reviews, `sellerStats.${platform}.reviews`, 'FSW_SELLER_STATS_MISSING');
    // byService holds the reviews the ledger ties to each service through its job. The rest of the platform's
    // total names no service: it counts for an operator-delivered service (catalog deliveryOf; work the operator
    // did before fsw kept a ledger) and never for an agent-delivered one, whose first jobs it did not win.
    // Gap: a review of agent-delivered work the ledger never tied to its job also lands in that rest and credits the
    // operator-delivered service; counting only reviews older than the ledger, and listing newer untied ones for the
    // operator to link, closes it.
    const byService = sellerStats[platform].byService ?? {};
    const unattributed = Math.max(0, platformReviews - Object.values(byService).reduce((s, n) => s + n, 0));
    for (const [service, def] of Object.entries(services)) {
      if (service.startsWith('_')) continue;
      const reviews = (byService[service] ?? 0) + ((def.delivery ?? 'agent') === 'operator' ? unattributed : 0);
      const category = def[field];
      const market = marketFor(entries, platform, category);
      if (!market) continue;
      const listed = profile?.serviceFit?.[service];
      // A service the profile does not list has no evidence behind it, which is what "none" means.
      const fitStrength = listed?.strength ?? 'none';
      const fit = FIT_MULTIPLIER[fitStrength];
      if (fit == null) throw new EconomicsError('FSW_PROFILE_INVALID', `serviceFit.${service}.strength is ${fitStrength}`, { service });
      const marketBase = roundTo1000(tierBase({ reviews, ...market }) * fit);
      const costFloorKRW = costFloor({ agentHours: def.agentHours?.standard, humanMinutes: def.humanMinutes?.standard, agentHourCostKRW, humanHourValueKRW, descriptor });
      const marketCeilingKRW = roundTo1000(market.high);
      // A market entry price under the cost floor is raised to the floor, which buyers above the
      // median still pay; a floor above the market's ceiling means nobody does, and the row is out.
      const base = Math.max(marketBase, costFloorKRW);
      const packages = Object.fromEntries(Object.entries(PACKAGE_FACTORS).map(([k, f]) => [k, roundTo1000(base * f)]));
      const row = {
        platform,
        service,
        category,
        baseKRW: base,
        marketBaseKRW: marketBase,
        pricedAtFloor: base > marketBase,
        baseNetKRW: sellerNet(base, descriptor).net,
        packages,
        floorKRW: Math.max(costFloorKRW, roundTo1000(market.low)),
        ceilingKRW: Math.max(marketCeilingKRW, packages.premium),
        costFloorKRW,
        marketCeilingKRW,
        basis: { n: market.n, p25: market.p25, median: market.median, p75: market.p75, high: market.high, source: market.source, observedAt: summary.observedAt ?? null, reviews, platformReviews },
        fitStrength,
        fitListed: Boolean(listed),
        viable: costFloorKRW <= marketCeilingKRW,
      };
      if (!row.viable) {
        row.reason = `cost floor ${costFloorKRW} KRW is above the market ceiling ${marketCeilingKRW} KRW (${def.agentHours.standard} agent hours and ${def.humanMinutes.standard} operator minutes)`;
      }
      rows.push(row);
    }
  }
  return rows;
}

export const priceRowFor = (table, platform, service) => table.find((r) => r.platform === platform && r.service === service) ?? null;

// The guide a price-guide row was built from: average, minimum and maximum (median, p25 and high in its
// basis). null for a row priced from listing quantiles.
export const guideOf = (row) => (row?.basis?.source === 'price-guide' ? { avgKRW: row.basis.median, minKRW: row.basis.p25, maxKRW: row.basis.high } : null);

// Quote for a request on a guide platform: the price row's base (its review tier, fit and learned factor, as
// quoteFromRow in src/economics/quote.mjs) times the model's complexity, clamped to the guide's minimum and
// maximum. The guide average sets no amount: a seller with few reviews of the service enters at the first
// tier, and pricing every request from the average sent first quotes at the market middle that none of them won.
// quoteCostKRW is what sending the quote costs (숨고캐시);
// it is required wherever the descriptor says quotes are paid, since the descriptor holds no number.
// A guide whose unit is per item (장 for photos) prices one item, and this quote has no quantity yet:
// until the brain's request decision carries one and multiplies it here, such a quote covers one item.
// A budget the buyer stated ({minKRW, maxKRW}, either side null) moves the price toward it without
// leaving the guide: up to its minimum when the guide price is below what the buyer expects to pay,
// down to its maximum when above.
export function quoteForRequest({ guide, complexity, row, descriptor, config, quoteCostKRW, budget = null }) {
  const [cmin, cmax] = COMPLEXITY_RANGE;
  if (typeof complexity !== 'number' || complexity < cmin || complexity > cmax) {
    throw new RangeError(`complexity must be within [${cmin}, ${cmax}], got ${complexity}`);
  }
  const avg = requireNumber(guide?.avgKRW, 'guide.avgKRW', 'FSW_MARKET_SUMMARY_INVALID');
  const base = requireNumber(row?.baseKRW, 'row.baseKRW', 'FSW_PRICE_ROW_MISSING');
  const min = requireNumber(guide?.minKRW, 'guide.minKRW', 'FSW_MARKET_SUMMARY_INVALID');
  const max = requireNumber(guide?.maxKRW, 'guide.maxKRW', 'FSW_MARKET_SUMMARY_INVALID');
  const paid = descriptor?.bidCost?.unit && descriptor.bidCost.unit !== 'none';
  const quoteCost = paid ? requireNumber(quoteCostKRW, 'quoteCostKRW', 'FSW_QUOTE_COST_MISSING') : 0;
  const costFloorKRW = requireNumber(row?.costFloorKRW, 'row.costFloorKRW', 'FSW_PRICE_ROW_MISSING');
  // The row base already carries the learned factor (src/economics/price-learning.mjs); reference is the base
  // before learning, so quoteResults reads this quote's index against what it was priced from. The guide clamp
  // keeps the amount inside the market's minimum and maximum, and the floor above the cost floor plus the quote cost.
  const factor = row.learned?.factor ?? 1;
  const reference = row.learned?.fromKRW ?? base;
  const raw = base * complexity;
  let clamped = Math.min(max, Math.max(min, raw));
  if (budget?.minKRW) clamped = Math.max(clamped, Math.min(budget.minKRW, max));
  if (budget?.maxKRW) clamped = Math.min(clamped, Math.max(budget.maxKRW, min));
  const minimum = ceilTo1000(costFloorKRW + quoteCost);
  const amountKRW = Math.max(roundTo1000(clamped), minimum);
  const net = sellerNet(amountKRW, descriptor).net - quoteCost;
  return {
    amountKRW,
    quoteCostKRW: quoteCost,
    netKRW: net,
    floorApplied: amountKRW === minimum && roundTo1000(clamped) < minimum,
    aboveGuide: amountKRW > max,
    aboveCeiling: row.ceilingKRW != null && amountKRW > row.ceilingKRW,
    basis: { source: 'price-row', base, reference, learnedFactor: factor, complexity, raw, guideAvg: avg, guideMin: min, guideMax: max, budget, clamped, costFloorKRW },
  };
}

// Phase orders for platforms that hold each order in escrow and forbid splitting one deliverable into
// several orders (크몽 counts that as sales inflation). Each phase is its own deliverable.
const PHASES = {
  2: [
    { label_ko: '1단계 시안 및 설계', label_en: 'Phase 1: draft and design', deliverable_ko: '시안, 설계 문서', deliverable_en: 'draft and design document' },
    { label_ko: '2단계 최종 제작 및 납품', label_en: 'Phase 2: final build and delivery', deliverable_ko: '최종 결과물', deliverable_en: 'final deliverable' },
  ],
  3: [
    { label_ko: '1단계 시안 및 설계', label_en: 'Phase 1: draft and design', deliverable_ko: '시안, 설계 문서', deliverable_en: 'draft and design document' },
    { label_ko: '2단계 핵심 기능 제작', label_en: 'Phase 2: core build', deliverable_ko: '핵심 기능이 동작하는 중간 결과물', deliverable_en: 'working core build' },
    { label_ko: '3단계 최종 완성 및 납품', label_en: 'Phase 3: final build and delivery', deliverable_ko: '최종 결과물', deliverable_en: 'final deliverable' },
  ],
};

function splitByRatios(amount, ratios) {
  const parts = ratios.map((r) => roundTo1000(amount * r));
  parts[parts.length - 1] = amount - parts.slice(0, -1).reduce((s, x) => s + x, 0);
  return parts;
}

function milestoneRatios(config) {
  const ratios = config?.payment?.milestones;
  if (!Array.isArray(ratios) || ratios.length < 2 || !ratios.every((r) => typeof r === 'number' && r > 0)) {
    throw new EconomicsError('FSW_CONFIG_MISSING', 'config.payment.milestones must list at least two positive ratios');
  }
  if (Math.abs(ratios.reduce((s, r) => s + r, 0) - 1) > 1e-9) {
    throw new EconomicsError('FSW_CONFIG_INVALID', 'config.payment.milestones must sum to 1');
  }
  return ratios;
}

export function splitPayment(amountKRW, config, descriptor) {
  requireNumber(amountKRW, 'amountKRW', 'FSW_AMOUNT_INVALID');
  const threshold = requireNumber(config?.payment?.milestoneThresholdKRW, 'config.payment.milestoneThresholdKRW');
  const mechanism = descriptor?.milestones;
  const large = amountKRW >= threshold;
  const full = [{ label_ko: '전체 금액', label_en: 'Full amount', amountKRW }];

  if (mechanism === 'reorder') {
    if (!large) {
      return {
        mechanism,
        parts: full,
        note_ko: `${descriptor.name ?? descriptor.id}에서는 전체 금액을 한 번에 주문합니다. 결제 금액은 작업 완료와 구매 확정 전까지 플랫폼이 보관하므로 의뢰인과 전문가 모두 보호됩니다.`,
      };
    }
    const ratios = milestoneRatios(config);
    const phases = PHASES[ratios.length];
    // Phase deliverables are defined for 2 and 3 milestones; a longer milestone list needs its own phase table.
    if (!phases) throw new EconomicsError('FSW_CONFIG_INVALID', `no phase deliverables defined for ${ratios.length} milestones on a reorder platform`);
    const amounts = splitByRatios(amountKRW, ratios);
    return {
      mechanism,
      parts: phases.map((p, i) => ({ ...p, amountKRW: amounts[i] })),
      note_ko: `단계마다 결과물이 다른 별도 주문으로 진행합니다. 앞 단계 결과물을 납품하고 구매 확정을 받은 뒤 다음 단계 주문을 만듭니다. 같은 결과물을 여러 주문으로 나누지 않습니다.`,
    };
  }

  if (mechanism === 'multi_pay' || mechanism === 'native') {
    // 숨고페이 also bounds each payment (15,000 to 5,000,000 KRW) but the descriptor states that only in
    // splitMechanism prose; a numeric per-payment range in the descriptor would let this check it.
    let parts;
    if (large) {
      parts = splitByRatios(amountKRW, milestoneRatios(config)).map((a, i) => ({ label_ko: `${i + 1}차 중도금`, label_en: `Milestone ${i + 1}`, amountKRW: a }));
    } else {
      const ratio = requireNumber(config?.payment?.depositRatio, 'config.payment.depositRatio');
      const [deposit, balance] = splitByRatios(amountKRW, [ratio, 1 - ratio]);
      parts = [
        { label_ko: '선금', label_en: 'Deposit', amountKRW: deposit },
        { label_ko: '잔금', label_en: 'Balance', amountKRW: balance },
      ];
    }
    const note_ko = mechanism === 'multi_pay'
      ? `같은 채팅방에서 숨고페이 결제 요청을 ${parts.length}번 보냅니다. 첫 결제 확인 후 작업을 시작하고, 납품 시점에 다음 결제를 요청합니다.`
      : `플랫폼의 마일스톤 기능으로 ${parts.length}회에 나누어 결제합니다.`;
    return { mechanism, parts, note_ko };
  }

  if (mechanism === 'none') {
    return { mechanism, parts: full, note_ko: '이 플랫폼은 분할 결제 수단이 없어 전체 금액을 한 번에 결제합니다.' };
  }
  throw new EconomicsError('FSW_SPLIT_UNKNOWN', `descriptor ${descriptor?.id} names no known split mechanism (${mechanism})`, { platform: descriptor?.id });
}
