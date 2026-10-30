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
import { foreignAmount, fxNote, loadFx as defaultLoadFx } from '../economics/fx.mjs';
import { FIT_RANK } from '../economics/quote-gate.mjs';
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

// The fit scale of a request, best first (FIT_RANK of the quote gate).
export const FITS = Object.keys(FIT_RANK).sort((a, b) => FIT_RANK[b] - FIT_RANK[a]);

export const DECISION_SCHEMA = (ids) => ({
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'service', 'language', 'reply', 'quote', 'needsOperator', 'operatorReason', 'confidence', 'claimsUsed', 'statedBudgetKRW', 'fit', 'fitReason', 'portfolioPermission', 'permissionQuote'],
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
    fit: { type: ['string', 'null'], enum: [...FITS, null], description: 'for a buyer request you would quote, how well its deliverables fit the service you chose and the past work behind it; null on any other conversation' },
    fitReason: { type: ['string', 'null'], description: 'one sentence on why fit is what it is; null when fit is null' },
    portfolioPermission: { type: ['string', 'null'], enum: ['granted', 'conditional', 'refused', null], description: 'the customer answered the portfolio question: granted only when the consent sets no condition, limitation, preference or timing about what, where, how or when the work is shown; conditional when it sets one; refused; or null when the conversation holds no answer' },
    permissionQuote: { type: ['string', 'null'], description: 'the customer sentence that answers it (for conditional, the sentence that sets the condition), copied verbatim; null when portfolioPermission is null' },
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
  // The paid-quote gate (src/economics/quote-gate.mjs) reads fit; a decision without it parses as null, which the
  // gate drops as fit.unknown.
  const fit = data.fit ?? null;
  const fitReason = data.fitReason ?? null;
  if (fit !== null && !FITS.includes(fit)) throw bad('fit ' + fit);
  if (fitReason !== null && typeof fitReason !== 'string') throw bad('fitReason');
  let permission = data.portfolioPermission ?? null;
  const permissionQuote = data.permissionQuote ?? null;
  if (![null, 'granted', 'conditional', 'refused'].includes(permission)) throw bad('portfolioPermission ' + permission);
  if (permissionQuote !== null && typeof permissionQuote !== 'string') throw bad('permissionQuote');
  // A grant the model cannot quote is no grant, but the reply and the quote in the same answer still stand;
  // the loop records the dropped claim (permission.unverified) and notifies the operator.
  let permissionIssue = null;
  if (permission === 'granted' && !(permissionQuote ?? '').trim()) {
    permission = null;
    permissionIssue = 'the model answered granted without the client sentence';
  }
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
    fit,
    fitReason,
    portfolioPermission: permission,
    permissionQuote,
    permissionIssue,
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

// A buyer request on a bidding board is answered with a proposal (U8.11 of wp8), elsewhere with a quote.
export const biddingBoard = (descriptor) => [descriptor?.model].flat().includes('bidding');
// A proposal on a board priced outside KRW also states its code-set price in the project's own currency (a
// freelancer client posts in INR, EUR or USD), at the day's rate, which travels with it so the drain can tell a
// stale rate.
export const needsFx = (thread, descriptor) => thread.kind === 'request' && biddingBoard(descriptor) && (descriptor.currency ?? 'KRW') !== 'KRW';
// The currency the project states its budget in, as the surface read it; null when it stated none.
export const projectCurrency = (thread) => thread.currency ?? thread.budget?.currency ?? null;

// The terms of a converted proposal: the project's currency, the amount at the day's rate and that rate. A
// project with no currency, no day's rate, or a rate without its currency leaves amount and fx null, so
// authorize refuses the proposal by name (price.terms) and the operator is told why.
function foreignTerms(thread, amountKRW, fx) {
  const currency = projectCurrency(thread);
  if (!currency || !fx || !amountKRW) return { currency, amount: null, fx: null };
  try {
    return { currency, amount: foreignAmount(amountKRW, currency, fx), fx: fxNote(currency, fx) };
  } catch (err) {
    if (err.code !== 'FSW_FX_MISSING') throw err;
    return { currency, amount: null, fx: null };
  }
}

export function outboundItem(thread, decision, text, { descriptor = null, fx = null } = {}) {
  const answer = biddingBoard(descriptor) ? 'proposal' : 'quote';
  // A quote form answers a buyer request; inside a chat no platform maps one, so a priced chat answer is a
  // message whose amount line code appends (priceLine), and the gate prices it like a quote (soomgo
  // 2026-10-29: a chat quote reached the request-page quote form and was refused before typing).
  const kind = thread.kind === 'request' ? answer : 'message';
  if (kind === 'message' && typeof decision.quote?.amountKRW === 'number') text = String(text ?? '') + '\n\n' + priceLine(decision.quote, decision.language);
  const amountKRW = decision.quote?.amountKRW;
  const foreign = kind === 'proposal' && needsFx(thread, descriptor) ? foreignTerms(thread, amountKRW, fx) : {};
  // decision rides on the item so the loop stores it in the outbox payload and authorize reads its rules.
  return {
    platform: thread.platform, kind, text, amountKRW, ...foreign,
    costKRW: thread.kind === 'request' ? thread.quoteCostKRW ?? null : 0, serviceLabel: thread.serviceLabel ?? null,
    attachments: [], thread: gateThread(thread), decision,
  };
}

// The amount line of a priced chat answer, written by code from the priced quote and its split, so the buyer
// reads only a price the code set. It is a sentence a person would write: a labelled 'Quote: ...' line read
// as a receipt from a bot (soomgo, 2026-10-29).
export function priceLine(quote, language) {
  const won = (n) => n.toLocaleString('en') + (language === 'en' ? ' KRW' : '원');
  const parts = quote.split?.mechanism === 'multi_pay' ? quote.split.parts ?? [] : [];
  if (language === 'en') return 'The price is ' + won(quote.amountKRW) + (parts.length ? ', paid as ' + parts.map((p) => p.label_en + ' ' + won(p.amountKRW)).join(' and ') : '') + '.';
  return '금액은 ' + won(quote.amountKRW) + '입니다.' + (parts.length ? ' ' + parts.map((p) => p.label_ko + ' ' + won(p.amountKRW)).join(', ') + '으로 나눠 받습니다.' : '');
}

const SYSTEM_DECISION = Object.freeze({
  intent: 'system', service: null, language: null, reply: null, quote: null,
  needsOperator: false, operatorReason: null, confidence: 1, claimsUsed: [], statedBudgetKRW: null, fit: null, fitReason: null, portfolioPermission: null, permissionQuote: null, permissionIssue: null,
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
    lessons: ctx.lessons ?? loadLessons(instance, { platform: descriptor.id }),
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
      // A fixed quote is priced here, never by the model: from the price row base times the model's
      // complexity, held inside the market guide on a guide platform (quoteForRequest) and inside the
      // row's floor and ceiling elsewhere (quoteFromRow). An hourly quote or one without a price row keeps the model's figure and is
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
  // The day's rate for a board priced outside KRW, read once and only once the model has drafted a reply. A
  // rate that cannot be read leaves the proposal without one, which authorize refuses (price.terms) with that
  // reason rather than a guessed amount.
  let fx = null;
  let fxError = null;
  const rate = async () => {
    if (fx || fxError || !needsFx(thread, descriptor) || !projectCurrency(thread)) return;
    try {
      fx = await (ctx.loadFx ?? defaultLoadFx)(instance);
    } catch (err) {
      if (err.code !== 'FSW_FX_UNAVAILABLE') throw err;
      fxError = err;
    }
  };
  const gate = (decision) => {
    const priceRow = decision.service ? priceRowFor(priceTable, descriptor.id, decision.service) : null;
    const item = outboundItem(thread, decision, decision.reply, { descriptor, fx });
    return { item, priceRow, result: gateOutbound(item, { descriptor, instance, priceRow, lessonsRules }) };
  };

  const first = await ask({});
  if (first.reply === null) return { decision: first, item: null, priceRow: null, modelCalls: 1 };
  await rate();
  let g = gate(first);
  if (g.result.ok) return { decision: first, item: g.item, priceRow: g.priceRow, modelCalls: 1 };
  // One redraft with the violations. Whatever comes back is planned; authorize runs the gate again and
  // sends a still-blocked draft to the operator, as the approval path did before.
  const second = await ask({ violations: g.result.violations, previousReply: first.reply });
  const decision = second.reply === null ? { ...second, reply: first.reply } : second;
  g = gate(decision);
  return { decision, item: g.item, priceRow: g.priceRow, modelCalls: 2 };
}
