// decide(thread, ctx): classify one conversation, draft the reply and quote through the model, and pass
// the draft through the outbound gate. A blocked draft goes back once with its violations; a second
// block becomes an approval request. Platform system notices never reach the model.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateOutbound } from '../policy/gate.mjs';
import { COMPLEXITY_RANGE, guideOf, priceRowFor, quoteForRequest, splitPayment } from '../economics/pricing.mjs';
import { runCodex as defaultRunCodex } from './codex.mjs';
import { INTENTS, buildDecisionPrompt, catalogIds, loadCatalog, loadLessons, loadPlaybook } from './prompts.mjs';

export class BrainError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'BrainError';
    this.code = code;
    Object.assign(this, detail);
  }
}

// Notices the platform writes into the chat itself. They need no reply, and answering them would
// spend a message on nobody.
export const SYSTEM_NOTICE_PATTERNS = [
  /고객(?:님)?이\s*\d+\s*시간\s*동안\s*견적(?:서)?[을를]?\s*읽지\s*않/,
  /견적(?:서)?[을를]?\s*(?:읽었어요|읽었습니다|확인했어요|확인했습니다)/,
  /견적(?:서)?\s*(?:열람|확인)\s*알림/,
  /(?:채팅|대화)(?:방)?이\s*종료되었/,
  /숨고페이\s*결제(?:가)?\s*(?:완료|요청|취소)/,
  /(?:리뷰|후기)가\s*(?:등록|작성)되었/,
  /주문이\s*(?:접수|취소|완료)되었/,
  /구매\s*확정(?:이|을)?\s*(?:되었|하였|했습니다|완료)/,
  /자동\s*(?:견적|응답)\s*(?:으로|이)\s*(?:발송|전송)/,
];

export function isSystemNotice(message) {
  if (message?.system === true) return true;
  const text = String(message?.text ?? message?.body ?? '').trim();
  return text.length > 0 && SYSTEM_NOTICE_PATTERNS.some((re) => re.test(text));
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
  required: ['intent', 'service', 'language', 'reply', 'quote', 'needsOperator', 'operatorReason', 'confidence', 'claimsUsed'],
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
    lastInboundText: String((pending.at(-1) ?? lastIn)?.text ?? (pending.at(-1) ?? lastIn)?.body ?? ''),
    language: thread.language ?? null,
    recentOutbound: (thread.messages ?? []).filter((m) => m.direction === 'out').slice(-10).map((m) => String(m.text ?? m.body ?? '')),
  };
}

export function outboundItem(thread, decision, text) {
  const kind = thread.kind === 'request' || decision.quote ? 'quote' : 'message';
  return { platform: thread.platform, kind, text, amountKRW: decision.quote?.amountKRW, thread: gateThread(thread) };
}

const SYSTEM_DECISION = Object.freeze({
  intent: 'system', service: null, language: null, reply: null, quote: null,
  needsOperator: false, operatorReason: null, confidence: 1, claimsUsed: [],
});

export async function decide(thread, ctx) {
  const { instance, descriptor, priceTable = [], runCodex = defaultRunCodex } = ctx;
  if (!instance || !descriptor) throw new TypeError('decide needs ctx.instance and ctx.descriptor');
  if (matchSystemNotice(thread)) return { action: 'none', decision: { ...SYSTEM_DECISION }, modelCalls: 0 };

  const catalog = ctx.catalog ?? loadCatalog();
  const ids = catalogIds(catalog);
  const brain = instance.config?.brain ?? {};
  const base = {
    thread,
    instance,
    descriptor,
    catalog,
    priceRows: priceTable.filter((r) => r.platform === descriptor.id),
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
      // A buyer request on a platform with a price guide is priced here, not by the model: the guide
      // average times the model's complexity, clamped to the guide and kept above the cost floor plus
      // what sending the quote costs. The reply text carries no amount, since the form shows it.
      const row = thread.kind === 'request' && decision.service ? priceRowFor(priceTable, descriptor.id, decision.service) : null;
      const guide = guideOf(row);
      if (guide && decision.quote.priceType === 'fixed') {
        const priced = quoteForRequest({ guide, complexity: decision.quote.complexity, row, descriptor, config: instance.config, quoteCostKRW: thread.quoteCostKRW });
        decision.quote.amountKRW = priced.amountKRW;
        decision.quote.pricing = priced.basis;
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

  let decision = await ask({});
  if (decision.reply === null) return { action: 'none', decision, modelCalls: 1 };
  let g = gate(decision);
  if (g.result.ok) return { action: 'reply', decision, item: g.item, priceRow: g.priceRow, gate: g.result, modelCalls: 1 };

  const firstViolations = g.result.violations;
  const firstDraft = decision.reply;
  decision = await ask({ violations: firstViolations, previousReply: firstDraft });
  if (decision.reply === null) {
    return { action: 'approval', decision, draft: firstDraft, violations: firstViolations, modelCalls: 2, reason: 'gate blocked the draft and the retry gave no reply' };
  }
  g = gate(decision);
  if (g.result.ok) return { action: 'reply', decision, item: g.item, priceRow: g.priceRow, gate: g.result, modelCalls: 2, retried: firstViolations };
  return { action: 'approval', decision, draft: decision.reply, item: g.item, priceRow: g.priceRow, gate: g.result, violations: g.result.violations, modelCalls: 2, reason: 'gate blocked the draft twice' };
}
