// The value gate a paid quote passes before it is planned, and the pace a day's quote cash is spent at
// (docs/DESIGN.md, Decisions). Both are pure: the loop step reads the request, the decision, the price row and
// the replayed quote results, and asks these functions whether to send, drop or wait.
// FIT_RANK moved here from src/projects/score.mjs:146 and fitMeets from src/projects/draft.mjs:121 (c31b9af),
// so a paid quote and a kmong proposal read fit on one scale.
import { seoulParts } from '../core/clock.mjs';
import { sellerNet } from './fees.mjs';

export const FIT_RANK = { none: 0, some: 1, strong: 2 };
export const fitMeets = (fit, minFit) => FIT_RANK[fit] >= FIT_RANK[minFit];

// platforms.<id>.quoteGate (src/core/config.schema.json): the least fit a paid quote needs, and whether the
// day's cash is spread over the Seoul day.
export const QUOTE_GATE_DEFAULT = Object.freeze({ minFit: 'some', pace: 'even' });
export const gateSettings = (cfg) => ({ ...QUOTE_GATE_DEFAULT, ...(cfg?.quoteGate ?? {}) });

const RESOLVED = ['won', 'lost', 'expired'];

// One arm's resolved quotes at a known price basis (index != null), from quoteResults: a quote priced from the
// guide average has no index and says nothing about the price the arm quotes at now.
export function armCounts(results, platform, service) {
  const out = { won: 0, lost: 0, expired: 0 };
  for (const r of results) if (r.source === 'quote' && r.platform === platform && r.service === service && r.index != null && RESOLVED.includes(r.result)) out[r.result] += 1;
  return out;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// The win chance is the equal share 1 / (quotes on the request + 1), blended with the arm's resolved outcomes
// weighted by minCases (an instance without price learning judges at the share alone). The margin is what a
// win nets after fees less the work's cost floor, and the value is p x margin less the quote's cash cost
// (netKRW of quoteForRequest already subtracts that cost, so it is never the margin here). A quote whose fit is
// unknown or under the floor, whose request is full, or whose value is unknown or at most zero, drops. The value is
// known only when the chance, the margin and the value are all finite numbers: an arm count that is not a number
// would make each of them NaN, which no comparison with zero catches.
export function judgeQuote({ fit, quoteCount, quoteCostKRW, amountKRW, pricing = null, row, descriptor, arm, settings }) {
  const max = descriptor?.bidCost?.maxPerRequest;
  const known = Number.isInteger(quoteCount) && quoteCount >= 0;
  // An unknown count is bounded by the platform's cap (soomgo takes 10 quotes a request), so 1 / maxPerRequest is
  // the lowest share the request can give: a pessimistic bound on the win chance, never an optimistic guess.
  const p0 = known ? 1 / (quoteCount + 1) : Number.isInteger(max) && max > 0 ? 1 / max : null;
  const { won = 0, lost = 0, expired = 0 } = arm ?? {};
  const w = settings?.minCases;
  const chance = p0 == null ? null : Number.isInteger(w) && w > 0 ? (won + w * p0) / (won + lost + expired + w) : p0;
  const p = finite(chance) ? chance : null;
  const inputs = p != null && finite(amountKRW) && amountKRW >= 0 && finite(row?.costFloorKRW) && finite(quoteCostKRW) && pricing?.source !== 'model';
  const margin = inputs ? sellerNet(amountKRW, descriptor).net - row.costFloorKRW : null;
  const ev = inputs ? p * margin - quoteCostKRW : null;
  const valued = finite(margin) && finite(ev);
  const marginKRW = valued ? margin : null;
  const evKRW = valued ? ev : null;
  const out = (verdict, reason) => ({ verdict, reason, p, p0, marginKRW, evKRW });
  if (fit == null || !(fit in FIT_RANK)) return out('drop', 'gate: fit.unknown');
  if (!fitMeets(fit, settings?.minFit ?? QUOTE_GATE_DEFAULT.minFit)) return out('drop', 'gate: fit.low');
  if (known && Number.isInteger(max) && quoteCount >= max) return out('drop', 'expired: the request already has ' + quoteCount + ' quotes and ' + descriptor.id + ' takes ' + max);
  if (!valued) return out('drop', 'gate: value.unknown');
  if (evKRW <= 0) return out('drop', 'gate: value.negative');
  return out('send', 'gate: value.positive');
}

// Whether the day's quote cash ran ahead of the day: more spent than maxCashPerDay times the share of the Seoul
// day gone by. Checked before a request is opened, so one quote of overshoot is allowed and the day's first
// request always goes. A missing cap paces nothing, as budgetSpent (src/policy/authorize.mjs) leaves it to the
// send-time check; pace "off" turns the spread off.
export function paceSpent(cfg, usage, now) {
  const { maxQuotesPerDay, maxCashPerDay } = cfg ?? {};
  if (!Number.isInteger(maxQuotesPerDay) || typeof maxCashPerDay !== 'number') return false;
  if (gateSettings(cfg).pace === 'off') return false;
  const { hour, minute } = seoulParts(now);
  return usage.cashKRW > maxCashPerDay * ((hour * 60 + minute) / 1440);
}
