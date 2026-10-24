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

// Review tiers: fewer than 5, 5 to 29, 30 or more reviews on that platform.
export function tierBase({ reviews, p25, median, p75 }) {
  if (reviews < 5) return p25 + 0.35 * (median - p25);
  if (reviews < 30) return median;
  return p75 == null ? median : median + 0.5 * (p75 - median);
}

// Smallest gross on the 1,000 KRW grid whose seller net per standard agent hour reaches the minimum.
// Net grows with gross on every descriptor (no marginal fee reaches 100%), so binary search applies.
export function costFloor({ agentHours, minNetPerAgentHour, descriptor }) {
  requireNumber(agentHours, 'agentHours.standard', 'FSW_SERVICE_INVALID');
  requireNumber(minNetPerAgentHour, 'config.yield.minNetKRWPerAgentHour');
  const target = agentHours * minNetPerAgentHour;
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
  throw new EconomicsError('FSW_MARKET_SUMMARY_INVALID', `summary entry ${platform}/${category} has neither quantiles nor guide figures`, { platform, category });
}

const CATEGORY_FIELD = { kmong: 'kmongCategory', soomgo: 'soomgoGuide' };

export function buildPriceTable({ summary, services, profile, sellerStats, config, descriptors }) {
  const entries = summary?.entries;
  if (!Array.isArray(entries)) throw new EconomicsError('FSW_MARKET_SUMMARY_INVALID', 'summary.entries must be an array');
  const minNet = requireNumber(config?.yield?.minNetKRWPerAgentHour, 'config.yield.minNetKRWPerAgentHour');
  const rows = [];
  for (const [platform, descriptor] of Object.entries(descriptors)) {
    const field = CATEGORY_FIELD[platform];
    // A platform without a catalog field has no category mapping yet; adding one to services.json closes it.
    if (!field) continue;
    const reviews = requireNumber(sellerStats?.[platform]?.reviews, `sellerStats.${platform}.reviews`, 'FSW_SELLER_STATS_MISSING');
    for (const [service, def] of Object.entries(services)) {
      if (service.startsWith('_')) continue;
      const category = def[field];
      const market = marketFor(entries, platform, category);
      if (!market) continue;
      const listed = profile?.serviceFit?.[service];
      // A service the profile does not list has no evidence behind it, which is what "none" means.
      const fitStrength = listed?.strength ?? 'none';
      const fit = FIT_MULTIPLIER[fitStrength];
      if (fit == null) throw new EconomicsError('FSW_PROFILE_INVALID', `serviceFit.${service}.strength is ${fitStrength}`, { service });
      const base = roundTo1000(tierBase({ reviews, ...market }) * fit);
      const packages = Object.fromEntries(Object.entries(PACKAGE_FACTORS).map(([k, f]) => [k, roundTo1000(base * f)]));
      const costFloorKRW = costFloor({ agentHours: def.agentHours?.standard, minNetPerAgentHour: minNet, descriptor });
      const row = {
        platform,
        service,
        category,
        baseKRW: base,
        packages,
        floorKRW: Math.max(costFloorKRW, roundTo1000(market.low)),
        ceilingKRW: Math.max(roundTo1000(market.high), packages.premium),
        costFloorKRW,
        basis: { n: market.n, p25: market.p25, median: market.median, p75: market.p75, source: market.source, observedAt: summary.observedAt ?? null, reviews },
        fitStrength,
        fitListed: Boolean(listed),
        viable: base >= costFloorKRW,
      };
      if (!row.viable) {
        row.reason = `base ${base} KRW is under the cost floor ${costFloorKRW} KRW (${def.agentHours.standard} agent hours at ${minNet} KRW net per hour)`;
      }
      rows.push(row);
    }
  }
  return rows;
}

export const priceRowFor = (table, platform, service) => table.find((r) => r.platform === platform && r.service === service) ?? null;

// Quote for a request on a guide platform. quoteCostKRW is what sending the quote costs (숨고캐시);
// it is required wherever the descriptor says quotes are paid, since the descriptor holds no number.
export function quoteForRequest({ guide, complexity, row, descriptor, config, quoteCostKRW }) {
  const [cmin, cmax] = COMPLEXITY_RANGE;
  if (typeof complexity !== 'number' || complexity < cmin || complexity > cmax) {
    throw new RangeError(`complexity must be within [${cmin}, ${cmax}], got ${complexity}`);
  }
  const avg = requireNumber(guide?.avgKRW, 'guide.avgKRW', 'FSW_MARKET_SUMMARY_INVALID');
  const min = requireNumber(guide?.minKRW, 'guide.minKRW', 'FSW_MARKET_SUMMARY_INVALID');
  const max = requireNumber(guide?.maxKRW, 'guide.maxKRW', 'FSW_MARKET_SUMMARY_INVALID');
  const paid = descriptor?.bidCost?.unit && descriptor.bidCost.unit !== 'none';
  const quoteCost = paid ? requireNumber(quoteCostKRW, 'quoteCostKRW', 'FSW_QUOTE_COST_MISSING') : 0;
  const costFloorKRW = requireNumber(row?.costFloorKRW, 'row.costFloorKRW', 'FSW_PRICE_ROW_MISSING');
  const raw = avg * complexity;
  const clamped = Math.min(max, Math.max(min, raw));
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
    basis: { guideAvg: avg, guideMin: min, guideMax: max, complexity, raw, clamped, costFloorKRW },
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
