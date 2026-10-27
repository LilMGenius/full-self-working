// authorize(item, ctx) -> {verdict, violations, warnings, reasons}: the one decision on whether an
// outbound item may leave the machine (architect D6). Composition order: a form the platform lists unmapped
// (descriptor forms, wp8), the outbound gate with its slop
// lint (src/policy/gate.mjs), mode and outbound hours (src/supervisor/run.mjs:153-157, :192-196), what the
// model decided (src/pipeline/thread.mjs:187-193), operator-only kinds (src/orders/requests.mjs:3-4,
// src/orders/delivery.mjs:1-3), the price row and the cash budget (src/pipeline/thread.mjs:63-71,
// :195-205), all at 2c77326, the stated budget under the cost floor (003 Decisions of 20:30), the daily
// caps of b223ed7, the answered services of 9b23f5f, and the kinds a person confirms on the platform
// (descriptor automation.sendRequiresOperator, wp8). Every rule fails closed: a missing setting throws,
// an unknown cost refuses the spend. A send verdict that carries a HOLD_RULES reason means "may send, not
// now"; the outbox leaves such a row as it is.
import { isActive } from '../core/clock.mjs';
import { effectiveMode, ordersWatched, pipelineSettings } from '../core/settings.mjs';
import { answeredServices, catalogServicesFor } from '../economics/catalog.mjs';
import { foreignAmount, fxOfNote } from '../economics/fx.mjs';
import { gateOutbound } from './gate.mjs';

// soomgo's file picker shows 0/10 attachments; more files need packaging (src/orders/delivery.mjs:25-27).
export const MAX_DELIVERY_FILES = 10;
export const OPERATOR_ONLY_KINDS = ['pay_request', 'delivery'];
export const HOLD_RULES = ['mode.observe', 'hours.closed', 'budget.cash'];

export const spendsCash = (descriptor, threadKind) => threadKind === 'request' && descriptor.bidCost?.unit !== 'none';

// platforms.<id>.bidBudget = {monthlyKRW, stopAfterUnanswered} (src/core/config.schema.json). The default
// refuses every paid bid; a bid that costs nothing passes at monthlyKRW 0. The Seoul month's bid spend plus
// this bid must stay inside monthlyKRW, and fewer than stopAfterUnanswered sent proposals may be without a
// reply. Fails closed on an unknown cost or uncounted usage.
export const BID_BUDGET_DEFAULT = { monthlyKRW: 0, stopAfterUnanswered: 20 };

const knownKRW = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function bidBudgetCheck({ budget, usage, costKRW }) {
  const { monthlyKRW, stopAfterUnanswered } = { ...BID_BUDGET_DEFAULT, ...(budget ?? {}) };
  if (!knownKRW(monthlyKRW) || !(Number.isInteger(stopAfterUnanswered) && stopAfterUnanswered >= 0)) return { ok: false, reason: 'the bid budget is malformed (monthlyKRW, stopAfterUnanswered)' };
  if (!knownKRW(costKRW)) return { ok: false, reason: 'the bid cost in KRW is unknown' };
  if (usage?.unknownCost?.length) return { ok: false, reason: "the month's bid spend is unknown: no cost is recorded for " + usage.unknownCost.join(', ') + '; settle each with fsw approve <id> --sent --cost <KRW>' };
  if (!knownKRW(usage?.bidMonthKRW) || !(Number.isInteger(usage?.bidUnanswered) && usage.bidUnanswered >= 0)) return { ok: false, reason: 'the bid usage was not counted' };
  if (usage.bidMonthKRW + costKRW > monthlyKRW) return { ok: false, reason: "the month's bid budget is spent (" + usage.bidMonthKRW + ' + ' + costKRW + ' over ' + monthlyKRW + ' KRW)' };
  if (usage.bidUnanswered >= stopAfterUnanswered) return { ok: false, reason: usage.bidUnanswered + ' sent proposals have no reply; bids stop at ' + stopAfterUnanswered };
  return { ok: true };
}

// A proposal on a platform that charges for bids (bid credits, Connects) is what bidBudgetCheck guards.
export const spendsBids = (descriptor, kind) => kind === 'proposal' && (descriptor.bidCost?.unit ?? 'none') !== 'none';

// Why the terms a proposal hands propose (amount, currency, the rate they were stated at) cannot go out, or
// null: a proposal names its currency, a KRW one states its amountKRW, and a foreign one carries a dated rate of
// that currency and states exactly foreignAmount of its amountKRW at that rate, so an amount that disagrees with
// the price it came from is never sent.
export function proposalTermsProblem(item) {
  const { currency, amount, amountKRW, fx } = item;
  if (!currency) return 'the proposal names no currency for its amount';
  if (currency === 'KRW') return amount === amountKRW ? null : 'the proposal states ' + amount + ' KRW against its price of ' + amountKRW + ' KRW';
  if (!fx?.date || fx.currency !== currency || !(fx.krwPerUnit > 0)) return 'the proposal in ' + currency + ' carries no dated ' + currency + ' rate';
  let expected;
  try {
    expected = foreignAmount(amountKRW, currency, fxOfNote(fx));
  } catch (err) {
    return 'the proposal in ' + currency + ' has no amount to state: ' + err.message;
  }
  return amount === expected ? null : 'the proposal states ' + amount + ' ' + currency + ' where ' + amountKRW + ' KRW at ' + fx.krwPerUnit + ' KRW per ' + currency + ' (' + fx.date + ') is ' + expected;
}

// Fails closed: a missing limit or an unknown cost refuses the spend (src/pipeline/thread.mjs:63-71).
// spent marks a refusal that only the day's caps caused, so a later day's budget can pay it (b223ed7).
export function cashBudgetCheck({ budget, usage, costKRW }) {
  const { maxQuotesPerDay, maxCashPerDay } = budget ?? {};
  if (!Number.isInteger(maxQuotesPerDay) || typeof maxCashPerDay !== 'number') return { ok: false, reason: 'no cash budget configured (maxQuotesPerDay, maxCashPerDay)' };
  if (typeof costKRW !== 'number' || !Number.isFinite(costKRW)) return { ok: false, reason: 'the quote cost was not read from the page' };
  const spent = maxQuotesPerDay >= 1 && costKRW <= maxCashPerDay;
  if (usage.quotes + 1 > maxQuotesPerDay) return { ok: false, spent, reason: 'daily quote budget spent (' + usage.quotes + ' of ' + maxQuotesPerDay + ')' };
  if (usage.cashKRW + costKRW > maxCashPerDay) return { ok: false, spent, reason: 'daily cash budget spent (' + usage.cashKRW + ' + ' + costKRW + ' over ' + maxCashPerDay + ')' };
  return { ok: true };
}

// Whether the day's budget can pay for no quote at all: the quote count or the cash spent reached its cap.
// The descriptor records no smallest quote cost (숨고 varies it by category), so any cash left counts as
// room. A missing cap is left to cashBudgetCheck, which refuses at send time (b223ed7).
export function budgetSpent(budget, usage) {
  const { maxQuotesPerDay, maxCashPerDay } = budget ?? {};
  if (!Number.isInteger(maxQuotesPerDay) || typeof maxCashPerDay !== 'number') return false;
  return usage.quotes >= maxQuotesPerDay || usage.cashKRW >= maxCashPerDay;
}

const rule = (r, detail) => ({ rule: r, detail });

// The one owner of a platform's mode for a pass (003 Policy): FSW_FORCE_MODE only lowers the configured
// mode, and outside activeHours.outbound an auto platform runs as observe, leaving unread threads unread
// for the first tick inside the window (src/supervisor/run.mjs:192-196 at 2c77326); draft keeps planning
// items for the operator, which sends nothing. The loop step reads with mode and authorize holds sends with
// hoursOpen, so the two never disagree about the hours.
export function operatingMode(configMode, { forceMode = null, now = new Date(), instance } = {}) {
  if (!instance) throw new TypeError('operatingMode needs the instance');
  const hoursOpen = isActive(now, instance.config?.activeHours?.outbound ?? ['00:00', '00:00']);
  const mode = effectiveMode(configMode, forceMode);
  return { mode: mode === 'auto' && !hoursOpen ? 'observe' : mode, hoursOpen };
}

export function authorize(item, ctx) {
  const { descriptor, instance, priceRow = null, lessonsRules = [], mode, now = new Date(), usage = { quotes: 0, cashKRW: 0 }, approved = false } = ctx ?? {};
  if (!descriptor || !instance) throw new TypeError('authorize needs ctx.descriptor and ctx.instance');
  if (!['observe', 'draft', 'auto'].includes(mode)) throw new RangeError('authorize needs ctx.mode observe, draft or auto, got ' + mode);
  const operator = [];
  const holds = [];
  // 0. A kind this platform's surface lists unmapped (descriptor forms) has never been filled and read back
  // on its page, so it is refused, approved or not (wp8).
  const form = descriptor.forms?.[item.kind];
  if (form && form.mapped !== true) return { verdict: 'refuse', violations: [rule('form.unmapped', item.kind + ' form on ' + item.platform + ' is not mapped and read back')], warnings: [], reasons: [rule('form.unmapped', 'form unmapped')] };
  // A proposal's stated terms are what the form receives; terms that disagree with their price never go out.
  const terms = item.kind === 'proposal' ? proposalTermsProblem(item) : null;
  if (terms) return { verdict: 'refuse', violations: [rule('price.terms', terms)], warnings: [], reasons: [rule('price.terms', terms)] };
  // A proposal that spends the platform's bids goes out only inside the operator's bid budget, approved or not.
  if (spendsBids(descriptor, item.kind)) {
    const bid = bidBudgetCheck({ budget: instance.config?.platforms?.[item.platform]?.bidBudget, usage, costKRW: item.costKRW });
    if (!bid.ok) return { verdict: 'refuse', violations: [rule('budget.bid', 'a proposal on ' + item.platform + ' spends ' + descriptor.bidCost.unit + ': ' + bid.reason)], warnings: [], reasons: [rule('budget.bid', bid.reason)] };
  }
  // 1. The gate and its slop lint. A payment request sends no text (the platform form takes the amount).
  const g = item.kind === 'pay_request' ? { violations: [], warnings: [] } : gateOutbound(item, { descriptor, instance, priceRow, lessonsRules });
  const violations = [...g.violations];
  const files = item.attachments?.length ?? 0;
  if (item.kind === 'delivery' && files > MAX_DELIVERY_FILES) violations.push(rule('shape.attachments', files + ' files exceed the ' + MAX_DELIVERY_FILES + '-file attachment cap; deliver by hand'));
  if (violations.length && approved) return { verdict: 'refuse', violations, warnings: g.warnings, reasons: [rule('gate.refused', 'the approved text fails ' + violations.map((v) => v.rule).join(', '))] };
  if (violations.length) operator.push(rule('gate.blocked', 'the draft fails ' + violations.map((v) => v.rule).join(', ')));
  // 2. Mode and outbound hours.
  if (mode === 'observe') holds.push(rule('mode.observe', 'observe mode sends nothing'));
  if (mode === 'draft' && !approved) operator.push(rule('mode.draft', 'draft mode'));
  if (!operatingMode(mode, { now, instance }).hoursOpen) holds.push(rule('hours.closed', 'outside activeHours.outbound'));
  // 3. What the model decided; an approval is the operator's answer to all of these.
  const d = item.decision;
  if (d && !approved) {
    const label = item.serviceLabel ?? null;
    const allowed = catalogServicesFor(descriptor, label);
    const stage = item.thread?.stage ?? 'pre_order';
    if (d.intent === 'unsupported') operator.push(rule('decision.unsupported', 'unsupported service: ' + (d.operatorReason ?? 'not in the catalog or profile')));
    if (allowed && !allowed.includes(d.service)) operator.push(rule('decision.label', 'the decision names ' + d.service + ' but the platform labels this ' + label + ' (' + allowed.join(', ') + ')'));
    // A row planned while the instance answered its service waits for the operator once the instance stops
    // answering it, so turning a service off also stops its waiting quotes (9b23f5f).
    if (d.service && !answeredServices(instance.config, item.platform).includes(d.service)) operator.push(rule('decision.answered', 'service ' + d.service + ' is no longer answered on ' + item.platform + ' (config platforms.' + item.platform + '.services)'));
    if (d.needsOperator) operator.push(rule('decision.operator', 'operator needed: ' + (d.operatorReason ?? 'no reason given')));
    if (stage !== 'pre_order' && !ordersWatched(instance.config)) operator.push(rule('decision.stage', 'order stage ' + stage + ': replies after a hire go to the operator until config orders.watched is true'));
    const floor = pipelineSettings(instance.config).minAutoConfidence;
    if (d.confidence < floor) operator.push(rule('decision.confidence', 'confidence ' + d.confidence + ' is below ' + floor));
  }
  if (OPERATOR_ONLY_KINDS.includes(item.kind) && !approved) operator.push(rule('kind.operator_only', 'a ' + item.kind + ' always waits for the operator'));
  // 4. Price row and cash. A proposal answering a buyer request on a bidding board (U8.11 of wp8) is priced
  // by code like a quote and meets the same price rules; kmong's enterprise proposals (thread kind project,
  // decision.quote null) are priced by their own planner and keep their verdicts.
  const priced = item.kind === 'quote' || (item.kind === 'proposal' && (Boolean(d?.quote) || item.thread?.kind === 'request'));
  if (priced) {
    if (!approved && (!priceRow || priceRow.viable === false)) operator.push(rule('price.row', item.kind + ' without a viable price row for ' + (d?.service ?? 'unknown service')));
    // A customer who states a budget under the service's cost floor gets no cash quote: the floor would
    // quote several times what they named (a 30,000 KRW homepage request quoted 300,000 KRW, rejected by
    // the main session at 22:15 on 2026-10-25).
    const stated = d?.statedBudgetKRW;
    if (!approved && typeof stated === 'number' && typeof priceRow?.costFloorKRW === 'number' && stated < priceRow.costFloorKRW) operator.push(rule('budget.below_floor', 'the customer states ' + stated + ' KRW, under the ' + priceRow.costFloorKRW + ' KRW cost floor of ' + (d.service ?? 'the service')));
    // A proposal's bids are the bid budget's (rule 0); the daily cash caps are a quote's.
    if (item.kind === 'quote' && spendsCash(descriptor, item.thread?.kind)) {
      const check = cashBudgetCheck({ budget: instance.config?.platforms?.[item.platform], usage, costKRW: item.costKRW });
      // Only a refusal the day's caps alone caused waits, approved or not, for a later day's budget (b223ed7).
      // No caps, an unread cost or one quote costing more than a whole day's cash can never be paid, so it is
      // the operator's even after an approval; holding it would hold every newer cash quote with it.
      if (!check.ok && check.spent) holds.push(rule('budget.cash', 'cash quote refused: ' + check.reason));
      else if (!check.ok) operator.push(rule('budget.unpayable', 'cash quote refused: ' + check.reason));
    }
  }
  // 5. Kinds the platform sends only on a person's confirmation (descriptor automation.sendRequiresOperator).
  if ((descriptor.automation?.sendRequiresOperator ?? []).includes(item.kind) && !approved) operator.push(rule('automation.operator', item.platform + ' requires a person to confirm every ' + item.kind));
  return { verdict: operator.length ? 'operator' : 'send', violations, warnings: g.warnings, reasons: [...operator, ...holds] };
}

export const isHeld = (v) => v.verdict === 'send' && v.reasons.some((r) => HOLD_RULES.includes(r.rule));
