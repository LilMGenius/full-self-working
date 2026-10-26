// decide(thread, ctx) -> {decision, item, priceRow, modelCalls}: classify one conversation, draft the
// reply and quote through the model, and pass the draft through the outbound gate. A blocked draft goes
// back once with its violations; whatever the second answer is gets planned, and authorize gates it again
// (003 Brain). Platform system notices never reach the model.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateOutbound } from '../policy/gate.mjs';
import { COMPLEXITY_RANGE, guideOf, priceRowFor, quoteForRequest, splitPayment } from '../economics/pricing.mjs';
import { quoteFromRow } from '../economics/quote.mjs';
import { answeredCatalog } from '../economics/catalog.mjs';
import { isSystemNotice } from '../core/notices.mjs';
import { runCodex as defaultRunCodex } from './codex.mjs';
import { INTENTS, buildDecisionPrompt, catalogIds, loadCatalog, loadLessons, loadPlaybook } from './prompts.mjs';

export { isSystemNotice };

export class BrainError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'BrainError';
    this.code = code;
    Object.assign(this, detail);
  }
}

// Inbound messages after my last outbound message; these are what a reply would answer.
export function pendingInbound(thread) {
  const msgs = thread.messages ?? [];
  let i = msgs.length;
  while (i > 0 && msgs[i - 1].direction !== 'out') i--;
  return msgs.slice(i).filter((m) => m.direction === 'in');
}

// A thread is a system thread when everything waiting for an answer is a platform notice.
export function matchSystemNotice(thread) {
  const pending = pendingInbound(thread);
  return pending.length > 0 && pending.every(isSystemNotice);
}

export const DECISION_SCHEMA = (ids) => ({
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'service', 'language', 'reply', 'quote', 'needsOperator', 'operatorReason', 'confidence', 'claimsUsed', 'statedBudgetKRW', 'portfolioPermission', 'permissionQuote'],
  properties: {
    intent: { type: 'string', enum: INTENTS },
    service: { type: ['string', 'null'], enum: [...ids, null] },
    language: { type: 'string', description: 'ISO 639-1 code of the reply language' },
    reply: { type: ['string', 'null'] },
    quote: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['amountKRW', 'scope', 'deliveryDays', 'priceType', 'complexity'],
          properties: {
            amountKRW: { type: 'integer' },
            scope: { type: 'array', items: { type: 'string' } },
            deliveryDays: { type: 'integer' },
            priceType: { type: 'string', enum: ['fixed', 'hourly'] },
            complexity: { type: 'number', minimum: COMPLEXITY_RANGE[0], maximum: COMPLEXITY_RANGE[1] },
          },
        },
      ],
    },
    needsOperator: { type: 'boolean' },
    operatorReason: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    claimsUsed: { type: 'array', items: { type: 'string' } },
    statedBudgetKRW: { type: ['integer', 'null'], description: 'the budget the customer states for this work, in a request field or in the text, in KRW; null when none is stated' },
    portfolioPermission: { type: ['string', 'null'], enum: ['granted', 'refused', null], description: 'the customer answered the portfolio question: granted, refused, or null when the conversation holds no answer' },
    permissionQuote: { type: ['string', 'null'], description: 'the customer sentence that answers it, copied verbatim; null when portfolioPermission is null' },
  },
});

// The model's answer is untrusted input; this is the one place it is checked.
export function parseDecision(data, ids) {
  const bad = (why) => new BrainError('FSW_BRAIN_BAD_DECISION', 'model decision rejected: ' + why, { data });
  if (!data || typeof data !== 'object') throw bad('not an object');
  if (!INTENTS.includes(data.intent)) throw bad('intent ' + data.intent);
  if (data.service !== null && !ids.includes(data.service)) throw bad('service ' + data.service);
  if (typeof data.language !== 'string' || !data.language) throw bad('language');
  if (data.reply !== null && typeof data.reply !== 'string') throw bad('reply');
  if (typeof data.needsOperator !== 'boolean') throw bad('needsOperator');
  if (data.operatorReason !== null && typeof data.operatorReason !== 'string') throw bad('operatorReason');
  if (typeof data.confidence !== 'number' || data.confidence < 0 || data.confidence > 1) throw bad('confidence');
  if (!Array.isArray(data.claimsUsed) || !data.claimsUsed.every((c) => typeof c === 'string')) throw bad('claimsUsed');
  const q = data.quote;
  if (q !== null) {
    if (typeof q !== 'object' || !Number.isInteger(q.amountKRW) || q.amountKRW <= 0) throw bad('quote.amountKRW');
    if (!Array.isArray(q.scope) || !q.scope.every((s) => typeof s === 'string')) throw bad('quote.scope');
    if (!Number.isInteger(q.deliveryDays) || q.deliveryDays <= 0) throw bad('quote.deliveryDays');
    if (!['fixed', 'hourly'].includes(q.priceType)) throw bad('quote.priceType');
    if (typeof q.complexity !== 'number' || q.complexity < COMPLEXITY_RANGE[0] || q.complexity > COMPLEXITY_RANGE[1]) throw bad('quote.complexity');
  }
  // A decision written before the field existed (an older fixture) parses as null.
  const stated = data.statedBudgetKRW ?? null;
  if (stated !== null && !(Number.isInteger(stated) && stated > 0)) throw bad('statedBudgetKRW');
  const permission = data.portfolioPermission ?? null;
  const permissionQuote = data.permissionQuote ?? null;
  if (![null, 'granted', 'refused'].includes(permission)) throw bad('portfolioPermission ' + permission);
  if (permissionQuote !== null && typeof permissionQuote !== 'string') throw bad('permissionQuote');
  if (permission === 'granted' && !(permissionQuote ?? '').trim()) throw bad('portfolioPermission granted without permissionQuote');
  return {
    intent: data.intent,
    service: data.service,
    language: data.language,
    reply: data.reply && data.reply.trim() ? data.reply.trim() : null,
    quote: q === null ? null : { amountKRW: q.amountKRW, scope: q.scope, deliveryDays: q.deliveryDays, priceType: q.priceType, complexity: q.complexity },
    needsOperator: data.needsOperator,
    operatorReason: data.operatorReason,
    confidence: data.confidence,
    claimsUsed: data.claimsUsed,
    statedBudgetKRW: stated,
    portfolioPermission: permission,
    permissionQuote,
  };
}

export function loadGateRules(instance) {
  const file = join(instance.paths.lessons, 'gate-rules.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

export function gateThread(thread) {
  const pending = pendingInbound(thread);
  const lastIn = [...(thread.messages ?? [])].reverse().find((m) => m.direction === 'in' && !isSystemNotice(m));
  return {
    stage: thread.stage ?? 'pre_order',
    kind: thread.kind ?? 'message',
    lastInboundText: String((pending.at(-1) ?? lastIn)?.text ?? (pending.at(-1) ?? lastIn)?.body ?? ''),
    language: thread.language ?? null,
    recentOutbound: (thread.messages ?? []).filter((m) => m.direction === 'out').slice(-10).map((m) => String(m.text ?? m.body ?? '')),
  };
}

export function outboundItem(thread, decision, text) {
  const kind = thread.kind === 'request' || decision.quote ? 'quote' : 'message';
  // decision rides on the item so the loop stores it in the outbox payload and authorize reads its rules.
  return {
    platform: thread.platform, kind, text, amountKRW: decision.quote?.amountKRW,
    costKRW: thread.kind === 'request' ? thread.quoteCostKRW ?? null : 0, serviceLabel: thread.serviceLabel ?? null,
    attachments: [], thread: gateThread(thread), decision,
  };
}

const SYSTEM_DECISION = Object.freeze({
  intent: 'system', service: null, language: null, reply: null, quote: null,
  needsOperator: false, operatorReason: null, confidence: 1, claimsUsed: [], statedBudgetKRW: null, portfolioPermission: null, permissionQuote: null,
});

export async function decide(thread, ctx) {
  const { instance, descriptor, priceTable = [], runCodex = defaultRunCodex } = ctx;
  if (!instance || !descriptor) throw new TypeError('decide needs ctx.instance and ctx.descriptor');
  if (matchSystemNotice(thread)) return { decision: { ...SYSTEM_DECISION }, item: null, priceRow: null, modelCalls: 0 };

  // The model chooses only among the services this instance answers on the platform, and sees only their
  // price rows.
  const catalog = ctx.catalog ?? answeredCatalog(instance.config, descriptor.id, loadCatalog());
  const ids = catalogIds(catalog);
  const brain = instance.config?.brain ?? {};
  const base = {
    thread,
    instance,
    descriptor,
    catalog,
    priceRows: priceTable.filter((r) => r.platform === descriptor.id && ids.includes(r.service)),
    playbook: ctx.playbook ?? loadPlaybook(instance, descriptor.id),
    lessons: ctx.lessons ?? loadLessons(instance),
  };
  const lessonsRules = ctx.lessonsRules ?? loadGateRules(instance);
  const ask = async (extra) => {
    const { data } = await runCodex({
      prompt: buildDecisionPrompt({ ...base, ...extra }),
      schema: DECISION_SCHEMA(ids),
      model: ctx.model ?? brain.model,
      effort: ctx.effort ?? brain.effort,
      timeoutMs: ctx.timeoutMs ?? brain.timeoutMs,
    });
    const decision = parseDecision(data, ids);
    if (decision.quote) {
      // A fixed quote is priced here, never by the model: on a guide platform from the guide average
      // times the model's complexity (quoteForRequest), elsewhere from the price row base times it
      // (quoteFromRow). An hourly quote or one without a price row keeps the model's figure and is
      // marked so; authorize then sends it to the operator (no viable price row) or checks its range.
      const row = decision.service ? priceRowFor(priceTable, descriptor.id, decision.service) : null;
      const guide = thread.kind === 'request' ? guideOf(row) : null;
      if (decision.quote.priceType === 'fixed' && guide) {
        const priced = quoteForRequest({ guide, complexity: decision.quote.complexity, row, descriptor, config: instance.config, quoteCostKRW: thread.quoteCostKRW, budget: thread.budget });
        decision.quote.amountKRW = priced.amountKRW;
        decision.quote.pricing = priced.basis;
      } else if (decision.quote.priceType === 'fixed' && row?.baseKRW > 0) {
        const priced = quoteFromRow({ row, complexity: decision.quote.complexity });
        decision.quote.amountKRW = priced.amountKRW;
        decision.quote.pricing = priced.basis;
      } else {
        decision.quote.pricing = { source: 'model', reason: row ? 'hourly quote' : 'no price row' };
      }
      decision.quote.split = splitPayment(decision.quote.amountKRW, instance.config, descriptor);
    }
    return decision;
  };
  const gate = (decision) => {
    const priceRow = decision.service ? priceRowFor(priceTable, descriptor.id, decision.service) : null;
    const item = outboundItem(thread, decision, decision.reply);
    return { item, priceRow, result: gateOutbound(item, { descriptor, instance, priceRow, lessonsRules }) };
  };

  const first = await ask({});
  if (first.reply === null) return { decision: first, item: null, priceRow: null, modelCalls: 1 };
  let g = gate(first);
  if (g.result.ok) return { decision: first, item: g.item, priceRow: g.priceRow, modelCalls: 1 };
  // One redraft with the violations. Whatever comes back is planned; authorize runs the gate again and
  // sends a still-blocked draft to the operator, as the approval path did before.
  const second = await ask({ violations: g.result.violations, previousReply: first.reply });
  const decision = second.reply === null ? { ...second, reply: first.reply } : second;
  g = gate(decision);
  return { decision, item: g.item, priceRow: g.priceRow, modelCalls: 2 };
}
