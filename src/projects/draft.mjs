// Proposals for project boards (크몽 엔터프라이즈, 위시켓): the brain writes the parts (the need, an answer
// to every item the client asked for, a phased plan, the AI production note) through runCodex with a JSON
// schema; this module composes the text, checks the plan against the project and the cost floor, gates it
// on the board's descriptor, retries once with the violations, and asks an independent critic on a
// different model. improveProposal redrafts with the critic's problems while the critic fails, at most
// MAX_REWRITES times. sendDecision is the policy (config platforms.<id>.proposals) that turns the result
// into a send or an operator approval. A board whose descriptor forbids identifying details (위시켓) gets
// a profile without names, companies or project names, and the gate blocks any that slip through.
import { gateOutbound } from '../policy/gate.mjs';
import { runCodex as defaultRunCodex } from '../brain/codex.mjs';
import { loadGateRules } from '../brain/respond.mjs';
import { dayKey } from '../core/clock.mjs';
import { CRITIC_SCHEMA, PILOT_RE, buildCriticPrompt, buildProposalPrompt, toDay, won } from './prompt.mjs';

export const DEFAULT_CRITIC_MODEL = 'cpa/claude-opus-5-5';
export const DEFAULT_MIN_CRITIC_SCORE = 0.75;
export const MAX_REWRITES = 2;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ProposalError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ProposalError';
    this.code = code;
    Object.assign(this, detail);
  }
}

// ---- policy ----

// config platforms.<platform>.proposals; a missing or malformed value refuses every send instead of
// falling back to one that might send.
export function proposalPolicy(config, platform = 'kmong') {
  const p = config?.platforms?.[platform]?.proposals;
  const bad = (what) => Object.assign(new Error('config platforms.' + platform + '.proposals.' + what), { code: 'FSW_CONFIG_MISSING' });
  if (!p || typeof p !== 'object') throw bad('is missing');
  if (!Number.isInteger(p.maxPerDay) || p.maxPerDay < 0) throw bad('maxPerDay must be a non-negative integer');
  if (!['strong', 'some'].includes(p.minFit)) throw bad('minFit must be "strong" or "some"');
  if (typeof p.autoMaxKRW !== 'number' || !(p.autoMaxKRW >= 0)) throw bad('autoMaxKRW must be a non-negative number');
  return {
    maxPerDay: p.maxPerDay,
    minFit: p.minFit,
    autoMaxKRW: p.autoMaxKRW,
    criticModel: typeof p.criticModel === 'string' && p.criticModel ? p.criticModel : DEFAULT_CRITIC_MODEL,
    minCriticScore: typeof p.minCriticScore === 'number' ? p.minCriticScore : DEFAULT_MIN_CRITIC_SCORE,
    pages: Number.isInteger(p.pages) && p.pages > 0 ? p.pages : 3,
  };
}

// Proposals drafted today (sent or queued for the operator) count against maxPerDay; the page's own
// counter of what is left today caps it again, so the day never goes past either.
export function proposalsLeft({ policy, pageQuota, usedToday }) {
  if (!Number.isInteger(pageQuota) || pageQuota < 0) return 0;
  return Math.max(0, Math.min(pageQuota, policy.maxPerDay - usedToday));
}

// What counts against a board's maxPerDay: proposals sent, queued for the operator, or drafted while the
// board has no login (위시켓 scouting), on that board in the Seoul day.
export function usedToday(ledger, now = new Date(), platform = 'kmong') {
  const today = dayKey(now);
  return ledger.db.prepare("SELECT at FROM events WHERE platform = ? AND kind IN ('project.proposed', 'project.queued', 'project.drafted')").all(platform).filter((e) => dayKey(new Date(e.at)) === today).length;
}

// Auto sends need everything at once: auto mode inside the outbound hours, a strong fit, a total at or
// under autoMaxKRW and a passing critic. Anything else is the operator's call.
export function sendDecision({ policy, mode, sendingHours, fit, totalKRW, critic }) {
  const why = [];
  if (mode !== 'auto') why.push('platform mode is ' + mode);
  if (!sendingHours) why.push('outside the outbound hours');
  if (fit !== 'strong') why.push('fit is ' + fit);
  if (!(totalKRW <= policy.autoMaxKRW)) why.push('total ' + totalKRW + ' KRW is above autoMaxKRW ' + policy.autoMaxKRW);
  if (!critic) why.push('no critic result');
  else if (!critic.pass) why.push('critic ' + (critic.error ? 'failed: ' + critic.error : 'score ' + critic.score + ' below ' + policy.minCriticScore + (critic.problems?.length ? ' (' + critic.problems.slice(0, 3).join('; ') + ')' : '')));
  return why.length ? { action: 'approval', reason: why.join('; ') } : { action: 'send', reason: null };
}

// The smallest total the platform's form takes for this project: its descriptor ratio of the budget,
// rounded up to 10,000 KRW (kmong prints 최소 1540만원 for a 2200만원 budget). 0 when either is unknown.
export function minimumKRW(project, descriptor) {
  const ratio = descriptor?.enterprise?.minProposalRatio;
  if (!Number.isFinite(project?.amountKRW) || !(ratio > 0)) return 0;
  return Math.ceil((project.amountKRW * ratio) / 10_000) * 10_000;
}

// ---- the brain's parts ----

export const PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['need', 'answers', 'phases', 'terms', 'aiNote', 'closing', 'claimsUsed'],
  properties: {
    need: { type: 'string', description: 'two or three sentences restating what the client needs and why, in your own words' },
    answers: {
      type: 'array',
      description: 'one entry per requested item, in the order given',
      items: { type: 'object', additionalProperties: false, required: ['item', 'answer'], properties: { item: { type: 'string', description: 'the requested item restated in a short phrase' }, answer: { type: 'string' } } },
    },
    phases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'deliverables', 'startDate', 'endDate', 'priceKRW', 'pilot'],
        properties: {
          title: { type: 'string' },
          deliverables: { type: 'array', description: 'short noun phrases, one per deliverable; no prices, terms or client prerequisites', items: { type: 'string' } },
          startDate: { type: 'string', description: 'YYYY-MM-DD' },
          endDate: { type: 'string', description: 'YYYY-MM-DD' },
          priceKRW: { type: 'integer' },
          pilot: { type: 'boolean' },
        },
      },
    },
    terms: { type: 'string', description: 'the commercial terms in one or two sentences: whether the total includes VAT, the tax invoice, how payment is split, what is excluded and how extra work is priced' },
    aiNote: { type: 'string', description: 'how production uses AI tools with human review, plainly' },
    closing: { type: 'string', description: 'one or two sentences: what you need next from the client' },
    claimsUsed: { type: 'array', items: { type: 'string' } },
  },
};

export function parseParts(data) {
  const bad = (why) => new ProposalError('FSW_PROPOSAL_BAD_DRAFT', 'model draft rejected: ' + why, { data });
  if (!data || typeof data !== 'object') throw bad('not an object');
  for (const k of ['need', 'terms', 'aiNote', 'closing']) if (typeof data[k] !== 'string' || !data[k].trim()) throw bad(k);
  if (!Array.isArray(data.answers) || !data.answers.every((a) => typeof a?.item === 'string' && typeof a?.answer === 'string')) throw bad('answers');
  if (!Array.isArray(data.phases) || !data.phases.length) throw bad('phases');
  for (const [i, p] of data.phases.entries()) {
    if (typeof p?.title !== 'string' || !p.title.trim()) throw bad('phases[' + i + '].title');
    if (!Array.isArray(p.deliverables) || !p.deliverables.every((d) => typeof d === 'string')) throw bad('phases[' + i + '].deliverables');
    if (!Number.isInteger(p.priceKRW)) throw bad('phases[' + i + '].priceKRW');
    if (typeof p.pilot !== 'boolean') throw bad('phases[' + i + '].pilot');
  }
  if (!Array.isArray(data.claimsUsed)) throw bad('claimsUsed');
  return data;
}

export function composeText(parts) {
  const total = parts.phases.reduce((s, p) => s + p.priceKRW, 0);
  const out = [parts.need.trim(), ''];
  if (parts.answers.length) {
    out.push('[요청하신 내용에 대한 답변]');
    parts.answers.forEach((a, i) => out.push(i + 1 + '. ' + a.item.trim(), a.answer.trim(), ''));
  }
  out.push('[진행 계획]');
  parts.phases.forEach((p, i) => {
    out.push(i + 1 + '단계 ' + p.title.trim() + ' (' + p.startDate + ' ~ ' + p.endDate + ', ' + won(p.priceKRW) + ')');
    for (const d of p.deliverables.map((x) => x.trim()).filter(Boolean)) out.push('- ' + d);
  });
  out.push('합계 ' + won(total), '', '[계약 조건]', parts.terms.trim(), '', '[제작 방식]', parts.aiNote.trim(), '', parts.closing.trim());
  return out.join('\n');
}

// Deterministic checks of the parts against the project: every requested item answered, the plan
// inside the budget and above both the cost floor and the platform's minimum, dates that run forward
// from today and end by the project's end, a pilot first where the client asked for one, and the AI
// production note.
export function checkPlan(parts, project, { floorKRW, minKRW = 0, now = new Date() }) {
  const v = [];
  const add = (rule, detail) => v.push({ rule: 'plan.' + rule, detail });
  const requested = project.requested ?? [];
  if (parts.answers.length !== requested.length) add('answers', parts.answers.length + ' answers for ' + requested.length + ' requested items');
  parts.answers.forEach((a, i) => !a.answer.trim() && add('answers', 'answer ' + (i + 1) + ' is empty'));
  if (parts.phases.length < 2 || parts.phases.length > 5) add('phases', parts.phases.length + ' phases; use 2 to 5');
  const total = parts.phases.reduce((s, p) => s + p.priceKRW, 0);
  if (parts.phases.some((p) => p.priceKRW <= 0)) add('price', 'every phase needs a positive price');
  if (Number.isFinite(project.amountKRW) && total > project.amountKRW) add('budget', 'total ' + total + ' KRW is above the budget ' + project.amountKRW + ' KRW');
  if (total < floorKRW) add('floor', 'total ' + total + ' KRW is under the cost floor ' + floorKRW + ' KRW');
  if (minKRW && total < minKRW) add('minimum', 'total ' + total + ' KRW is under ' + minKRW + ' KRW, the least the platform form takes for this budget');
  const today = toDay(now);
  let prevStart = today;
  parts.phases.forEach((p, i) => {
    if (!DATE_RE.test(p.startDate) || !DATE_RE.test(p.endDate)) return add('dates', 'phase ' + (i + 1) + ' dates must be YYYY-MM-DD');
    if (p.startDate > p.endDate) add('dates', 'phase ' + (i + 1) + ' ends before it starts');
    if (p.startDate < prevStart) add('dates', 'phase ' + (i + 1) + ' starts before ' + prevStart);
    prevStart = p.startDate;
    if (!p.deliverables.some((d) => d.trim())) add('deliverables', 'phase ' + (i + 1) + ' has no deliverable');
  });
  const lastEnd = parts.phases.at(-1)?.endDate;
  if (project.endDate && DATE_RE.test(project.endDate) && lastEnd && lastEnd > project.endDate) add('dates', 'the plan ends ' + lastEnd + ', after the project end ' + project.endDate);
  if (PILOT_RE.test(project.description) && !parts.phases[0]?.pilot) add('pilot', 'the client asked for a pilot first; phase 1 must be it');
  if (!/AI/.test(parts.aiNote)) add('ai_note', 'the production note must say AI tools are used with human review');
  return { violations: v, totalKRW: total };
}

// A board whose descriptor forbids identifying details (contactPolicy.identity "forbidden") gets the
// profile with the seller's names, companies and employers swapped for neutral words and without project
// names, so the writer cannot copy one; the facts stay, and past work is described by what was built.
export const forbidsIdentity = (descriptor) => descriptor?.contactPolicy?.identity === 'forbidden';

export async function draftProposal(project, ctx) {
  const { instance, descriptor, service, floorKRW, runCodex = defaultRunCodex, now = new Date() } = ctx;
  if (!instance || !descriptor || !service || !Number.isFinite(floorKRW)) throw new TypeError('draftProposal needs instance, descriptor, service and floorKRW');
  const brain = instance.config?.brain ?? {};
  const lessonsRules = ctx.lessonsRules ?? loadGateRules(instance);
  const minKRW = minimumKRW(project, descriptor);
  const maxChars = Number.isInteger(descriptor.limits?.proposal?.maxChars) ? descriptor.limits.proposal.maxChars : null;
  const critique = ctx.critique ?? null;
  const board = { platform: descriptor.id, anonymous: forbidsIdentity(descriptor) };
  const attempt = async (extra) => {
    const { data } = await runCodex({ prompt: buildProposalPrompt({ project, instance, service, floorKRW, minKRW, maxChars, now, critique, ...board, ...extra }), schema: PROPOSAL_SCHEMA, model: ctx.model ?? brain.model, effort: ctx.effort ?? brain.effort, timeoutMs: ctx.timeoutMs ?? brain.timeoutMs });
    const parts = parseParts(data);
    const text = composeText(parts);
    const plan = checkPlan(parts, project, { floorKRW, minKRW, now });
    const gate = gateOutbound({ platform: descriptor.id, kind: 'proposal', text, thread: { stage: 'pre_order' } }, { descriptor, instance, lessonsRules });
    const proposal = { text, totalKRW: plan.totalKRW, phases: parts.phases, answers: parts.answers, terms: parts.terms, claimsUsed: parts.claimsUsed, service, floorKRW };
    return { proposal, gate, violations: [...plan.violations, ...gate.violations] };
  };
  const first = await attempt({});
  if (!first.violations.length) return { ok: true, ...first, modelCalls: 1 };
  const second = await attempt({ violations: first.violations, previous: first.proposal.text });
  if (!second.violations.length) return { ok: true, ...second, modelCalls: 2, retried: first.violations };
  return { ok: false, ...second, modelCalls: 2, firstViolations: first.violations };
}

// ---- critic ----

// A critic that cannot answer is a failed critic: the draft goes to the operator with the error.
export async function criticize(project, proposal, ctx) {
  const { instance, policy, descriptor, runCodex = defaultRunCodex } = ctx;
  const board = { platform: descriptor?.id ?? 'kmong', anonymous: forbidsIdentity(descriptor) };
  try {
    const { data } = await runCodex({ prompt: buildCriticPrompt({ project, proposal, instance, ...board }), schema: CRITIC_SCHEMA, model: policy.criticModel, effort: ctx.effort ?? 'medium', timeoutMs: ctx.timeoutMs ?? instance.config?.brain?.timeoutMs });
    if (typeof data?.score !== 'number') throw new ProposalError('FSW_CRITIC_BAD', 'critic answer has no score');
    const pass = data.score >= policy.minCriticScore && data.needRestated && data.everyItemAnswered && data.claimsBacked && data.pricePlausible;
    return { ...data, pass, model: policy.criticModel };
  } catch (err) {
    return { pass: false, error: (err.code ? err.code + ': ' : '') + err.message, model: policy.criticModel };
  }
}

// Drafts, asks the critic and, while the critic fails with problems it can name, redrafts with them, at
// most maxRewrites times. The result is the first passing draft, or else the best-scoring one that passed
// the gate, with every round's verdict in history. A draft the gate and plan block twice ends the loop:
// with nothing better it comes back not ok, as draftProposal reports it. ctx.critique starts the loop from
// an earlier verdict ({score, problems, text}), as when an approval waiting on a weak draft is reworked.
export async function improveProposal(project, ctx) {
  const { maxRewrites = MAX_REWRITES } = ctx;
  const history = [];
  let best = null;
  let critique = ctx.critique ?? null;
  let modelCalls = 0;
  for (let round = 0; round <= maxRewrites; round++) {
    const draft = await draftProposal(project, { ...ctx, critique });
    modelCalls += draft.modelCalls;
    if (!draft.ok) {
      history.push({ round, blocked: draft.violations.map((v) => v.rule) });
      if (!best) return { ...draft, critic: null, history, rewrites: round, modelCalls };
      break;
    }
    const critic = await criticize(project, draft.proposal, ctx);
    modelCalls += 1;
    history.push({ round, score: critic.score ?? null, pass: critic.pass, error: critic.error ?? null, problems: critic.problems ?? [] });
    if (!best || (critic.score ?? -1) > (best.critic.score ?? -1)) best = { ...draft, critic };
    if (critic.pass || critic.error || !(critic.problems ?? []).length) break;
    critique = { score: critic.score, problems: critic.problems, text: draft.proposal.text };
  }
  return { ...best, history, rewrites: history.length - 1, modelCalls };
}

