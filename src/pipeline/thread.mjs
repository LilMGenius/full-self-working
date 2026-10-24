// processThread: one conversation through read, decide, gate and act, by platform mode.
//   observe: record what the inbox shows; never open an unread thread.
//   draft:   every outbound item becomes an operator approval.
//   auto:    send through the adapter when the gate passed; the adapter re-checks gate.ok.
// The ledger records an outbound message or quote only when the adapter reports it observed the result
// on the page. Quotes that spend platform cash (숨고캐시) need auto mode and room in the Seoul-day budget.
import { createHash } from 'node:crypto';
import { dayKey } from '../core/clock.mjs';
import { gateOutbound } from '../policy/gate.mjs';
import { CATEGORY_FIELD } from '../economics/pricing.mjs';
import { decide as defaultDecide, isSystemNotice, loadGateRules } from '../brain/respond.mjs';
import { closeApproval, listApprovals, openApprovalFor, queueApproval } from '../brain/approvals.mjs';
import catalog from '../economics/services.json' with { type: 'json' };

export const MODES = ['observe', 'draft', 'auto'];

export const spendsCash = (descriptor, kind) => kind === 'request' && descriptor.bidCost?.unit !== 'none';

// The catalog services a platform's own service label can become: those whose market category is the
// label, plus the ones the descriptor's serviceLabels adds for a coarse label (숨고 files a cafe homepage
// under 웹 개발). undefined: the platform gave no label, so there is nothing to check; an empty list: the
// label is a service the catalog does not hold.
export function catalogServicesFor(descriptor, label, services = catalog) {
  const field = CATEGORY_FIELD[descriptor.id];
  if (!field || !label) return undefined;
  const ids = Object.entries(services).filter(([id, def]) => !id.startsWith('_') && def[field] === label).map(([id]) => id);
  return [...new Set([...ids, ...(descriptor.serviceLabels?.[label] ?? [])])];
}

// pipeline settings every non-observe pass needs: hours after which an item is too old to answer, per
// kind, and the decision confidence below which auto mode asks the operator instead of sending. A missing
// value is a config error raised before anything is opened, never a default that answers any age.
export function pipelineSettings(config) {
  const p = config?.pipeline ?? {};
  const windows = p.replyWindowHours ?? {};
  for (const [path, v] of [['replyWindowHours.message', windows.message], ['replyWindowHours.request', windows.request], ['minAutoConfidence', p.minAutoConfidence]]) {
    if (typeof v !== 'number' || !(v >= 0)) throw Object.assign(new Error('config pipeline.' + path + ' must be a number'), { code: 'FSW_CONFIG_MISSING' });
  }
  return { replyWindowHours: windows, minAutoConfidence: p.minAutoConfidence };
}

// Why a listed item gets no answer, read from the list alone so nothing is opened: the platform closed
// the request, or its newest message is older than the reply window, where an answer reads as a bot
// waking up.
export function skipReason(threadRef, kind, now, settings) {
  if (kind === 'request' && (threadRef.quotable === false || (threadRef.expiresAt && Date.parse(threadRef.expiresAt) <= now.getTime()))) return 'expired';
  const windowHours = settings.replyWindowHours[kind === 'request' ? 'request' : 'message'];
  if (!threadRef.at) return null;
  const ageHours = (now.getTime() - Date.parse(threadRef.at)) / 3_600_000;
  return ageHours > windowHours ? 'stale: newest message is ' + Math.round(ageHours) + ' hours old, window ' + windowHours : null;
}

// Quotes and cash for one platform on the Seoul day of now, counted from the ledger.
export function quotaUsage(ledger, platform, now = new Date()) {
  const today = dayKey(now);
  const quotes = ledger.listQuotes({ platform }).filter((q) => dayKey(new Date(q.at)) === today);
  return { quotes: quotes.length, cashKRW: quotes.reduce((s, q) => s + (q.costKRW ?? 0), 0) };
}

// Fails closed: a missing limit or an unknown cost refuses the spend.
export function cashBudgetCheck({ budget, usage, costKRW }) {
  const { maxQuotesPerDay, maxCashPerDay } = budget ?? {};
  if (!Number.isInteger(maxQuotesPerDay) || typeof maxCashPerDay !== 'number') return { ok: false, reason: 'no cash budget configured (maxQuotesPerDay, maxCashPerDay)' };
  if (typeof costKRW !== 'number' || !Number.isFinite(costKRW)) return { ok: false, reason: 'the quote cost was not read from the page' };
  if (usage.quotes + 1 > maxQuotesPerDay) return { ok: false, reason: 'daily quote budget spent (' + usage.quotes + ' of ' + maxQuotesPerDay + ')' };
  if (usage.cashKRW + costKRW > maxCashPerDay) return { ok: false, reason: 'daily cash budget spent (' + usage.cashKRW + ' + ' + costKRW + ' over ' + maxCashPerDay + ')' };
  return { ok: true };
}

const msgText = (m) => String(m.text ?? m.body ?? '');
const msgExternalId = (m) => String(m.externalId ?? m.id ?? createHash('sha1').update((m.at ?? '') + '\n' + msgText(m)).digest('hex').slice(0, 16));

function stageOf(full, threadRef, kind, ledger, threadId) {
  if (full?.stage ?? threadRef.stage) return full?.stage ?? threadRef.stage;
  if (kind === 'order') return 'post_order';
  return ledger.listQuotes({ threadId, status: 'accepted' }).length ? 'quote_accepted' : 'pre_order';
}

// A buyer request has no chat yet: its text is the one inbound message the reply answers.
function threadFromRead(full, { platform, ref, kind, stage, threadRef }) {
  const messages = kind === 'request'
    ? [{ direction: 'in', text: [full.title, full.text ?? full.body, ...(full.answers ?? []).map((a) => (a.q ? a.q + ': ' : '') + (a.a ?? a))].filter(Boolean).join('\n'), externalId: 'request', at: full.at }]
    : (full.messages ?? []);
  return { platform, externalId: ref, kind, stage, customer: full.customer ?? threadRef.customer ?? null, title: full.title ?? threadRef.title ?? null, language: full.language ?? null, quoteCostKRW: full.quoteCostKRW ?? threadRef.quoteCostKRW ?? null, messages };
}

function splitAmounts(quote) {
  const parts = quote.split?.parts ?? [];
  return parts.length > 1 ? { depositKRW: parts[0].amountKRW, balanceKRW: quote.amountKRW - parts[0].amountKRW } : { depositKRW: null, balanceKRW: null };
}

// Sends one gated item and records it only when the adapter observed it. Returns {observed, res}.
async function act({ adapter, ledger, platform, threadId, ref, kind, text, quote, service, gate, allowSpendCash, costKRW }) {
  const viaQuote = kind === 'request';
  const res = viaQuote
    ? await adapter.quote(ref, { amountKRW: quote.amountKRW, priceType: quote.priceType ?? 'fixed', text, gate, allowSpendCash })
    : await adapter.send(ref, { text, files: [], gate });
  if (res?.observed !== true) return { observed: false, res };
  const body = typeof res.text === 'string' && res.text ? res.text : text;
  ledger.addMessage({ threadId, direction: 'out', body, externalId: res.externalId ?? null, gate });
  if (quote) {
    ledger.addQuote({
      threadId, platform, service, amountKRW: quote.amountKRW, ...splitAmounts(quote), scope: quote.scope, deliveryDays: quote.deliveryDays,
      costKRW: viaQuote ? res.cashSpentKRW ?? costKRW ?? 0 : 0, status: 'sent',
    });
  }
  return { observed: true, res };
}

export async function processThread({ platform, threadRef, adapter, ledger, instance, descriptor, priceTable = [], mode, budget, now = new Date(), decide = defaultDecide, runCodex }) {
  if (!MODES.includes(mode)) throw new RangeError('mode must be one of ' + MODES.join(', ') + ', got ' + mode);
  const ref = String(threadRef.id ?? threadRef.externalId);
  const kind = threadRef.kind ?? 'message';
  const unread = threadRef.unread !== false;
  const settings = mode === 'observe' ? null : pipelineSettings(instance.config);
  const row = ledger.upsertThread({ platform, externalId: ref, kind, customer: threadRef.customer });
  const event = (k, payload = {}) => ledger.addEvent({ kind: k, platform, ref, payload });

  const pending = openApprovalFor(instance, platform, ref);
  if (pending) {
    event('thread.pending_approval', { approvalId: pending.id });
    return { action: 'pending_approval', approvalId: pending.id };
  }
  if (unread && threadRef.preview && isSystemNotice({ text: threadRef.preview })) {
    event('thread.system', { preview: threadRef.preview });
    return { action: 'system', opened: false };
  }
  // A skipped item is remembered with the list time it was skipped at, so the supervisor leaves it alone
  // until a newer message arrives.
  const park = (action, reason) => {
    ledger.upsertThread({ platform, externalId: ref, kind, meta: { skipped: { at: threadRef.at ?? null, reason } } });
    event('thread.' + action, { reason, service: threadRef.service ?? null });
    return { action, opened: false, reason };
  };
  const skip = settings && skipReason(threadRef, kind, now, settings);
  if (skip) return park('skipped', skip);
  const allowed = catalogServicesFor(descriptor, threadRef.service);
  // A request or conversation in a service outside the catalog (숨고 lessons, for one) is the operator's
  // own business, and the platform's app already alerts the operator: it stays unread instead of being
  // opened, marked read and left unanswered, no model call is spent on it, and the digest counts it.
  if (allowed?.length === 0 && mode !== 'observe') return park('operator', 'service ' + threadRef.service + ' is not in the catalog');
  if (mode === 'observe' && unread) {
    event('thread.observed', { unread: true, preview: threadRef.preview ?? null });
    return { action: 'observed', opened: false };
  }

  const willReply = mode !== 'observe';
  const full = kind === 'request' ? await adapter.readRequest(ref) : await adapter.readThread(ref, { willReply });
  const stage = stageOf(full, threadRef, kind, ledger, row.id);
  const thread = threadFromRead(full, { platform, ref, kind, stage, threadRef });
  for (const m of thread.messages) {
    if (m.direction === 'in') ledger.addMessage({ threadId: row.id, direction: 'in', body: msgText(m), externalId: msgExternalId(m), at: m.at, attachments: m.attachments });
  }
  if (mode === 'observe') {
    event('thread.observed', { unread: false, messages: thread.messages.length });
    return { action: 'observed', opened: true };
  }

  const result = await decide(thread, { instance, descriptor, priceTable, ...(runCodex ? { runCodex } : {}) });
  const d = result.decision;
  ledger.upsertThread({ platform, externalId: ref, kind, service: d.service ?? undefined, language: d.language ?? undefined, status: d.intent, meta: { stage } });
  event('brain.decision', { intent: d.intent, service: d.service, action: result.action, confidence: d.confidence, modelCalls: result.modelCalls, needsOperator: d.needsOperator });
  if (result.action === 'none') return { action: 'none', intent: d.intent };

  const text = result.action === 'approval' ? result.draft : d.reply;
  const itemKind = result.item?.kind ?? (kind === 'request' || d.quote ? 'quote' : 'message');
  const queue = async (reason, extra = {}) => {
    const approval = await queueApproval(instance, {
      platform, threadRef: ref, threadId: row.id, threadKind: kind, kind: itemKind, reason, draft: text, quote: d.quote, service: d.service,
      intent: d.intent, violations: result.violations ?? [], warnings: result.gate?.warnings ?? [], item: result.item ?? null, priceRow: result.priceRow ?? null,
      title: platform + ' ' + (d.intent === 'unsupported' ? 'unsupported request' : itemKind) + ': ' + reason, ...extra,
    });
    event('approval.queued', { approvalId: approval.id, reason });
    return { action: 'queued', approvalId: approval.id, reason };
  };

  if (result.action === 'approval') return queue(result.reason);
  if (d.intent === 'unsupported') return queue('unsupported service: ' + (d.operatorReason ?? 'not in the catalog or profile'));
  if (allowed && !allowed.includes(d.service)) return queue('the decision names ' + d.service + ' but the platform labels this ' + threadRef.service + ' (' + allowed.join(', ') + ')');
  if (d.needsOperator) return queue('operator needed: ' + (d.operatorReason ?? 'no reason given'));
  if (mode === 'draft') return queue('draft mode');
  if (d.confidence < settings.minAutoConfidence) return queue('confidence ' + d.confidence + ' is below ' + settings.minAutoConfidence);

  if (d.quote && (!result.priceRow || result.priceRow.viable === false)) return queue('quote without a viable price row for ' + (d.service ?? 'unknown service'));
  let costKRW = null;
  const cash = spendsCash(descriptor, kind);
  if (cash) {
    costKRW = full.quoteCostKRW ?? threadRef.quoteCostKRW ?? null;
    const check = cashBudgetCheck({ budget: budget ?? instance.config?.platforms?.[platform], usage: quotaUsage(ledger, platform, now), costKRW });
    if (!check.ok) {
      event('quote.budget_refused', { reason: check.reason, costKRW });
      return queue('cash quote refused: ' + check.reason, { costKRW });
    }
  }
  const sent = await act({ adapter, ledger, platform, threadId: row.id, ref, kind, text, quote: d.quote, service: d.service, gate: result.gate, allowSpendCash: cash, costKRW });
  if (!sent.observed) {
    event('send.unobserved', { kind: itemKind, detail: sent.res?.error ?? null });
    return queue('the adapter did not observe the sent ' + itemKind + '; check the thread before resending', { unobserved: true });
  }
  event(itemKind === 'quote' ? 'quote.sent' : 'message.sent', { amountKRW: d.quote?.amountKRW ?? null, costKRW });
  return { action: 'sent', kind: itemKind };
}

// Sends items the operator approved. The final text passes the gate again, since an operator edit is
// new text; an approved cash quote is the operator's authorization to spend.
export async function flushApprovals({ platform, adapter, ledger, instance, descriptor }) {
  const out = [];
  const lessonsRules = loadGateRules(instance);
  for (const a of listApprovals(instance, { status: 'approved' })) {
    if (a.platform !== platform || a.closedAt) continue;
    const item = { ...(a.item ?? { platform, kind: a.kind, thread: { stage: 'pre_order' } }), text: a.finalText, amountKRW: a.quote?.amountKRW };
    const gate = gateOutbound(item, { descriptor, instance, priceRow: a.priceRow ?? null, lessonsRules });
    if (!gate.ok) {
      closeApproval(instance, a.id, { status: 'blocked', violations: gate.violations });
      ledger.addEvent({ kind: 'approval.blocked', platform, ref: a.threadRef, payload: { approvalId: a.id, violations: gate.violations } });
      out.push({ id: a.id, action: 'blocked' });
      continue;
    }
    const sent = await act({ adapter, ledger, platform, threadId: a.threadId, ref: a.threadRef, kind: a.threadKind ?? 'message', text: a.finalText, quote: a.quote, service: a.service, gate, allowSpendCash: spendsCash(descriptor, a.threadKind), costKRW: a.costKRW ?? null });
    if (!sent.observed) {
      closeApproval(instance, a.id, { status: 'unobserved' });
      ledger.addEvent({ kind: 'send.unobserved', platform, ref: a.threadRef, payload: { approvalId: a.id } });
      out.push({ id: a.id, action: 'unobserved' });
      continue;
    }
    closeApproval(instance, a.id, { status: 'sent' });
    ledger.addEvent({ kind: 'approval.sent', platform, ref: a.threadRef, payload: { approvalId: a.id, edited: a.edited } });
    out.push({ id: a.id, action: 'sent' });
  }
  return out;
}
