// The supervisor's hourly projects job (Seoul minute 0): read new 크몽 엔터프라이즈 projects, judge each
// page version once, draft proposals for the best within the day's quota and improve each with the
// critic's problems, send the ones the policy allows, drop the ones only the critic still rejects, queue
// the rest for the operator, send what the operator approved, and read what happened to sent proposals.
// A proposal that turns into a chat arrives in the 크몽 inbox, which the poll job answers; a meeting, a
// selection or a close becomes a learning case.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey, isActive } from '../core/clock.mjs';
import { logEvent } from '../core/log.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { closeApproval, getApproval, listApprovals, queueApproval, updateApproval } from '../brain/approvals.mjs';
import { loadGateRules } from '../brain/respond.mjs';
import { recordOutcome } from '../learning/outcomes.mjs';
import { latestAllocation } from '../economics/priority.mjs';
import { gateOutbound } from '../policy/gate.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { CATEGORIES, detailUrl } from '../platforms/kmong/projects.mjs';
import { fitMeets, improveProposal, proposalPolicy, proposalsLeft, sendDecision, usedToday } from './draft.mjs';
import { FIT_RANK, SUB_ROOT, SUB_SERVICES, markProject, needsJudgement, projectThread, rememberJudgement, scoreProject } from './score.mjs';

export const APPROVAL_KIND = 'project_proposal';
const MODES = ['observe', 'draft', 'auto'];

// Root tabs that hold a sub category whose services the profile fits at minFit or better.
export function categoriesFor(profile, minFit) {
  const roots = new Set();
  for (const [root, subs] of Object.entries(SUB_ROOT)) {
    for (const sub of subs) {
      if ((SUB_SERVICES[sub] ?? []).some((s) => FIT_RANK[profile?.serviceFit?.[s]?.strength ?? 'none'] >= FIT_RANK[minFit])) roots.add(Number(root));
    }
  }
  return Object.entries(CATEGORIES).filter(([, id]) => roots.has(id)).map(([key]) => key);
}

export const proposalsDir = (instance) => join(instance.dir, 'proposals');

export function saveProposalRecord(instance, id, patch) {
  const dir = proposalsDir(instance);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, id + '.json');
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(file + '.tmp', JSON.stringify(next, null, 2) + '\n');
  renameSync(file + '.tmp', file);
  return file;
}

const stateFile = (instance) => join(instance.dir, 'run', 'projects.json');
export const readJobState = (instance) => (existsSync(stateFile(instance)) ? JSON.parse(readFileSync(stateFile(instance), 'utf8')) : {});
function writeJobState(instance, state) {
  mkdirSync(join(instance.dir, 'run'), { recursive: true });
  writeFileSync(stateFile(instance) + '.tmp', JSON.stringify(state, null, 2) + '\n');
  renameSync(stateFile(instance) + '.tmp', stateFile(instance));
}

// 제안하기 opened the registration dialog: remember it for the Seoul day, so no draft is spent on a form
// that cannot open, and tell the operator once.
async function profileBlocked(instance, now) {
  writeJobState(instance, { ...readJobState(instance), enterpriseProfile: { missing: true, day: dayKey(now), at: now.toISOString() } });
  await notifyOperator(instance, { kind: 'operator', title: 'kmong 엔터프라이즈 프로필 등록이 필요합니다', body: '제안하기가 엔터프라이즈 프로필 등록 화면으로 막혀 있습니다. /enterprise/seller/profile 에서 이력서 PDF와 포트폴리오를 올리고 등록하면 다음 정시부터 제안을 보냅니다.', dedupeKey: 'kmong-enterprise-profile:' + dayKey(now) });
}

const krw = (n) => Number(n).toLocaleString('en-US') + '원';

// The operator's Korean summary of one proposal waiting for a decision.
export function approvalSummary(project, proposal, reason) {
  return '크몽 엔터프라이즈 제안 검토: ' + project.title + ' (예산 ' + krw(project.amountKRW) + ', 제안 마감 ' + (project.deadlineAt ?? '미상') + '). 제안 금액 ' + krw(proposal.totalKRW) + ', ' + proposal.phases.length + '단계. 보류 사유: ' + reason;
}

// The time the job's own clock says, so the events usedToday counts fall on the Seoul day the job's
// quota was read for, however long the pass ran.
const stamp = (ctx) => (ctx.now ?? new Date()).toISOString();

async function queueProposal(ctx, { project, verdict, proposal, gate, critic, violations = [], reason }) {
  const { instance, ledger } = ctx;
  const row = projectThread(ledger, project.id);
  // orderItem keeps the chat pipeline (flushApprovals, openApprovalFor) away from it; this job sends it.
  const approval = await queueApproval(instance, {
    orderItem: true, platform: 'kmong', kind: APPROVAL_KIND, threadRef: 'project:' + project.id, threadId: row?.id ?? null, service: verdict.service,
    reason: approvalSummary(project, proposal, reason), title: 'kmong 제안 검토: ' + project.title, draft: proposal.text,
    quote: { amountKRW: proposal.totalKRW }, project: { id: project.id, title: project.title, amountKRW: project.amountKRW, deadlineAt: project.deadlineAt, url: detailUrl(project.id) },
    proposal: { totalKRW: proposal.totalKRW, phases: proposal.phases, floorKRW: proposal.floorKRW }, critic: critic ?? null, violations, warnings: gate?.warnings ?? [],
  });
  markProject(ledger, project.id, 'queued', { proposal: { approvalId: approval.id, queuedAt: new Date().toISOString(), totalKRW: proposal.totalKRW } });
  ledger.addEvent({ at: stamp(ctx), kind: 'project.queued', platform: 'kmong', ref: project.id, payload: { approvalId: approval.id, reason } });
  saveProposalRecord(instance, project.id, { project, score: verdict, proposal, gate, critic: critic ?? null, approvalId: approval.id, status: 'queued', reason });
  return { id: project.id, action: 'queued', approvalId: approval.id, reason };
}

// What happens to an improved draft (improveProposal): sent when the policy allows it; dropped when the
// critic alone still stood in the way after every rewrite, since the operator would only be asked to
// approve a proposal the reviewer would not shortlist; an operator approval for every other hold.
export function nextStep({ policy, mode, sendingHours, verdict, best }) {
  if (!best.ok) return { action: 'queue', reason: 'gate or plan blocked the draft twice: ' + best.violations.map((v) => v.rule).join(', ') };
  const base = { policy, mode, sendingHours, fit: verdict.fit, totalKRW: best.proposal.totalKRW };
  const decision = sendDecision({ ...base, critic: best.critic });
  if (decision.action === 'send') return decision;
  const criticOnly = best.critic && !best.critic.pass && !best.critic.error && sendDecision({ ...base, critic: { pass: true } }).action === 'send';
  if (!criticOnly) return { action: 'queue', reason: decision.reason };
  return { action: 'drop', reason: 'critic score ' + best.critic.score + ' after ' + best.rewrites + ' rewrite' + (best.rewrites === 1 ? '' : 's') + ': ' + (best.critic.problems ?? []).slice(0, 3).join('; ') };
}

// A project the loop will not propose to: the reason stays on its thread and record, and the case goes to
// learning so the scorer and the playbook can see which projects the profile cannot win.
function dropProposal(ctx, { project, verdict, best, reason }) {
  const { instance, ledger } = ctx;
  markProject(ledger, project.id, 'dropped', { dropReason: reason, proposal: { droppedAt: new Date().toISOString(), totalKRW: best.proposal.totalKRW, criticScore: best.critic?.score ?? null } });
  ledger.addEvent({ kind: 'project.dropped', platform: 'kmong', ref: project.id, payload: { reason, score: best.critic?.score ?? null, rewrites: best.rewrites } });
  saveProposalRecord(instance, project.id, { project, score: verdict, proposal: best.proposal, gate: best.gate, critic: best.critic, history: best.history, status: 'dropped', reason });
  recordOutcome(instance, ledger, { kind: 'lead_lost', platform: 'kmong', service: verdict.service, threadRef: 'project:' + project.id, text: best.proposal.text, note: 'not proposed: ' + reason });
  return { id: project.id, action: 'dropped', reason };
}

export const outboundMode = (instance, forceMode) => {
  const cfg = instance.config?.platforms?.kmong ?? {};
  const rank = Object.fromEntries(MODES.map((m, i) => [m, i]));
  return forceMode && rank[forceMode] < rank[cfg.mode] ? forceMode : cfg.mode;
};

// Sends one gated proposal and records it only when the page showed it.
async function send(ctx, { seller, project, verdict, proposal, gate, critic, approvalId = null }) {
  const { instance, ledger } = ctx;
  const res = await seller.propose(project, proposal, { gate, taxInvoice: instance.business?.taxInvoice ?? null });
  saveProposalRecord(instance, project.id, { project, score: verdict, proposal, gate, critic: critic ?? null, send: { at: new Date().toISOString(), observed: res.observed, reason: res.reason ?? null, code: res.code ?? null, steps: res.steps }, ...(approvalId ? { approvalId } : {}) });
  if (res.code === 'FSW_KMONG_ENTERPRISE_PROFILE') return { observed: false, blocked: 'profile', res };
  if (!res.observed) {
    if (res.submitted) {
      markProject(ledger, project.id, 'unobserved', { proposal: { at: new Date().toISOString(), totalKRW: proposal.totalKRW } });
      ledger.addEvent({ kind: 'send.unobserved', platform: 'kmong', ref: project.id, payload: { reason: res.reason } });
    }
    return { observed: false, res };
  }
  markProject(ledger, project.id, 'proposed', { proposal: { at: new Date().toISOString(), totalKRW: proposal.totalKRW, status: res.status, label: res.label, approvalId } });
  ledger.addEvent({ at: stamp(ctx), kind: 'project.proposed', platform: 'kmong', ref: project.id, payload: { totalKRW: proposal.totalKRW, service: verdict.service, approvalId } });
  saveProposalRecord(instance, project.id, { status: res.status ?? 'unknown', observedStatus: res.label ?? null });
  logEvent(instance, 'project.proposed', { id: project.id, totalKRW: proposal.totalKRW });
  return { observed: true, res };
}

// Approved proposals: the operator's final text passes the gate again, then the form.
export async function flushProposalApprovals(ctx, { seller, reader }) {
  const { instance, ledger } = ctx;
  const descriptor = loadDescriptor('kmong');
  const lessonsRules = loadGateRules(instance);
  const out = [];
  for (const a of listApprovals(instance, { status: 'approved' })) {
    if (a.kind !== APPROVAL_KIND || a.platform !== 'kmong' || a.closedAt) continue;
    const text = a.finalText ?? a.draft;
    const gate = gateOutbound({ platform: 'kmong', kind: 'proposal', text, thread: { stage: 'pre_order' } }, { descriptor, instance, lessonsRules });
    if (!gate.ok) {
      closeApproval(instance, a.id, { status: 'blocked', violations: gate.violations });
      out.push({ id: a.id, action: 'blocked' });
      continue;
    }
    const project = await reader.readProject(a.project.id);
    if (project.status !== 'APPROVAL' || (Number.isInteger(project.deadlineDays) && project.deadlineDays < 0)) {
      closeApproval(instance, a.id, { status: 'expired', detail: 'project is ' + project.status });
      out.push({ id: a.id, action: 'expired' });
      continue;
    }
    const verdict = projectThread(ledger, project.id)?.meta?.judgement ?? { service: a.service };
    const r = await send(ctx, { seller, project, verdict, proposal: { ...a.proposal, text }, gate, critic: a.critic, approvalId: a.id });
    if (r.blocked === 'profile') {
      out.push({ id: a.id, action: 'waiting', detail: 'enterprise profile not registered' });
      break;
    }
    closeApproval(instance, a.id, { status: r.observed ? 'sent' : 'unobserved', detail: r.res?.reason ?? null });
    out.push({ id: a.id, action: r.observed ? 'sent' : 'unobserved' });
  }
  return out;
}

// Outcome of a status change read from /seller/proposals, as a learning case. A meeting or selection
// is a proposal result; a close without selection is a lost lead.
export function outcomeFor(status) {
  if (status === 'meeting' || status === 'selected') return { kind: 'proposal_result', note: status };
  if (status === 'closed') return { kind: 'lead_lost', note: 'closed without selection' };
  return null;
}

export async function readStatuses(ctx, { seller }) {
  const { instance, ledger } = ctx;
  const sent = ledger.listThreads({ platform: 'kmong' }).filter((t) => t.kind === 'project' && ['proposed', 'meeting', 'unobserved'].includes(t.status));
  if (!sent.length) return { read: 0, changed: [] };
  const list = await seller.proposals(sent.map((t) => t.meta?.judgement?.title).filter(Boolean));
  const changed = [];
  for (const t of sent) {
    const title = t.meta?.judgement?.title;
    const hit = list.found.find((f) => f.title === title);
    if (!hit || hit.status === 'unknown' || hit.status === 'waiting' || hit.status === t.meta?.proposal?.status) continue;
    const id = Number(t.externalId.replace('project:', ''));
    const next = hit.status === 'meeting' ? 'meeting' : hit.status;
    markProject(ledger, id, next, { proposal: { ...t.meta.proposal, status: hit.status, label: hit.label, statusAt: new Date().toISOString() } });
    const outcome = outcomeFor(hit.status);
    const file = join(proposalsDir(instance), id + '.json');
    const text = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).proposal?.text : null;
    if (outcome && text) recordOutcome(instance, ledger, { ...outcome, platform: 'kmong', service: t.service, threadRef: t.externalId, text });
    saveProposalRecord(instance, id, { status: hit.status, observedStatus: hit.label });
    changed.push({ id, status: hit.status });
  }
  return { read: sent.length, quota: list.quota, changed };
}

// One pass. ctx: instance, ledger, now, forceMode, log, plus openReader, openSeller, runCodex for tests.
export async function projectsJob(ctx) {
  const { instance, ledger, now = new Date() } = ctx;
  const cfg = instance.config?.platforms?.kmong;
  if (!cfg?.enabled) return { status: 'skipped', detail: 'kmong is not enabled' };
  let policy;
  try {
    policy = proposalPolicy(instance.config);
  } catch (err) {
    return { status: 'skipped', detail: err.message };
  }
  const mode = outboundMode(instance, ctx.forceMode);
  const sendingHours = isActive(now, instance.config.activeHours?.outbound ?? ['00:00', '00:00']);
  const descriptor = loadDescriptor('kmong');
  const allocation = latestAllocation(instance);
  const openReader = ctx.openReader ?? (async () => (await import('../platforms/kmong/projects.mjs')).openProjectReader());
  const openSeller = ctx.openSeller ?? (async () => (await import('../platforms/kmong/projects.mjs')).openProjectSeller());
  const result = { status: 'ok', mode, listed: 0, judged: 0, kept: 0, drafted: [], sent: [], queued: [], dropped: [], errors: [] };
  const reader = await openReader();
  // A signed-in session lives only as long as one step: drafting takes minutes, and the browser daemon
  // drops a session left idle that long, so each read or send opens its own and closes it.
  const useSeller = async (fn) => {
    const s = await openSeller();
    try {
      return await fn(s);
    } finally {
      await s.stop().catch((err) => result.errors.push({ ref: 'seller.stop', code: err.code ?? null, message: err.message }));
    }
  };
  try {
    const listed = new Map();
    for (const category of categoriesFor(instance.profile, policy.minFit)) {
      const { projects } = await reader.listProjects({ category, sort: 'latest', pages: policy.pages, now });
      for (const p of projects) listed.set(p.id, p);
    }
    result.listed = listed.size;
    for (const p of listed.values()) {
      if (!needsJudgement(ledger, p)) continue;
      const verdict = scoreProject(p, { profile: instance.profile, config: instance.config, descriptor, allocation, minFit: policy.minFit, now });
      rememberJudgement(ledger, p, verdict, now);
      result.judged += 1;
    }
    const candidates = ledger.listThreads({ platform: 'kmong' })
      .filter((t) => t.kind === 'project' && t.status === 'candidate' && t.meta?.judgement?.keep && listed.has(Number(t.externalId.replace('project:', ''))))
      .sort((a, b) => b.meta.judgement.score - a.meta.judgement.score);
    result.kept = candidates.length;
    const state = readJobState(instance);
    const profileMissing = state.enterpriseProfile?.missing && state.enterpriseProfile.day === dayKey(now);
    const outbound = mode !== 'observe';
    if (outbound && profileMissing) {
      result.detail = 'enterprise profile not registered (checked ' + state.enterpriseProfile.at + '); drafting waits for it';
    }
    if (outbound && (candidates.length || listApprovals(instance, { status: 'approved' }).some((a) => a.kind === APPROVAL_KIND && !a.closedAt)) && !profileMissing) {
      const pageQuota = await useSeller((s) => s.quota());
      let left = proposalsLeft({ policy, pageQuota, usedToday: usedToday(ledger, now) });
      result.quota = { page: pageQuota, left };
      for (const t of candidates) {
        if (left <= 0) break;
        const id = Number(t.externalId.replace('project:', ''));
        try {
          const project = await reader.readProject(id, { now });
          const verdict = scoreProject(project, { profile: instance.profile, config: instance.config, descriptor, allocation, minFit: policy.minFit, now });
          rememberJudgement(ledger, project, verdict, now);
          if (!verdict.keep || !fitMeets(verdict.fit, policy.minFit)) continue;
          const best = await improveProposal(project, { instance, descriptor, service: verdict.service, floorKRW: verdict.floorKRW, policy, runCodex: ctx.runCodex, now });
          result.drafted.push(id);
          left -= 1;
          const step = nextStep({ policy, mode, sendingHours, verdict, best });
          if (step.action === 'drop') {
            result.dropped.push(dropProposal(ctx, { project, verdict, best, reason: step.reason }));
            continue;
          }
          if (step.action === 'queue') {
            result.queued.push(await queueProposal(ctx, { project, verdict, proposal: best.proposal, gate: best.gate, critic: best.critic, violations: best.ok ? [] : best.violations, reason: step.reason }));
            continue;
          }
          const r = await useSeller((s) => send(ctx, { seller: s, project, verdict, proposal: best.proposal, gate: best.gate, critic: best.critic }));
          if (r.blocked === 'profile') {
            await profileBlocked(instance, now);
            result.queued.push(await queueProposal(ctx, { project, verdict, proposal: best.proposal, gate: best.gate, critic: best.critic, reason: '엔터프라이즈 프로필 미등록' }));
            break;
          }
          if (r.observed) result.sent.push(id);
          else result.queued.push(await queueProposal(ctx, { project, verdict, proposal: best.proposal, gate: best.gate, critic: best.critic, reason: 'the form did not take the proposal: ' + (r.res?.reason ?? 'unknown') }));
        } catch (err) {
          result.errors.push({ id, code: err.code ?? null, message: err.message });
          ledger.addEvent({ kind: 'project.error', platform: 'kmong', ref: id, payload: { code: err.code ?? null, message: err.message } });
          if (err.code === 'FSW_PACING_LIMIT') break;
        }
      }
      if (sendingHours && readJobState(instance).enterpriseProfile?.day !== dayKey(now)) {
        result.approvalsSent = await useSeller((s) => flushProposalApprovals(ctx, { seller: s, reader }));
        if (result.approvalsSent.some((a) => a.action === 'waiting')) await profileBlocked(instance, now);
      }
    }
    if (outbound && ledger.listThreads({ platform: 'kmong' }).some((t) => t.kind === 'project' && ['proposed', 'meeting', 'unobserved'].includes(t.status))) {
      result.statuses = await useSeller((s) => readStatuses(ctx, { seller: s }));
    }
    if (result.errors.length) result.status = 'partial';
    return result;
  } finally {
    await reader.close();
  }
}




// Reworks one open proposal approval through the improve loop, starting from the critic's verdict it
// already holds: a draft the policy would now send goes out and closes the approval; one only the critic
// still rejects is dropped and the approval closed with the reason; anything else keeps the approval open
// with the best draft and its verdict, so the operator always reads the strongest version.
export async function reviseApproval(ctx, approvalId) {
  const { instance, ledger, now = new Date() } = ctx;
  const a = getApproval(instance, approvalId);
  if (a.kind !== APPROVAL_KIND || a.status !== 'open') throw Object.assign(new Error('approval ' + approvalId + ' is not an open proposal approval (' + a.kind + ', ' + a.status + ')'), { code: 'FSW_APPROVAL_STATE' });
  const policy = proposalPolicy(instance.config);
  const descriptor = loadDescriptor('kmong');
  const mode = outboundMode(instance, ctx.forceMode);
  const sendingHours = isActive(now, instance.config.activeHours?.outbound ?? ['00:00', '00:00']);
  const openReader = ctx.openReader ?? (async () => (await import('../platforms/kmong/projects.mjs')).openProjectReader());
  const openSeller = ctx.openSeller ?? (async () => (await import('../platforms/kmong/projects.mjs')).openProjectSeller());
  const reader = await openReader();
  let project;
  try {
    project = await reader.readProject(a.project.id, { now });
  } finally {
    await reader.close();
  }
  if (project.status !== 'APPROVAL' || (Number.isInteger(project.deadlineDays) && project.deadlineDays < 0)) {
    closeApproval(instance, a.id, { status: 'expired', detail: 'project is ' + project.status });
    return { id: a.id, action: 'expired' };
  }
  const verdict = scoreProject(project, { profile: instance.profile, config: instance.config, descriptor, allocation: latestAllocation(instance), minFit: policy.minFit, now });
  rememberJudgement(ledger, project, verdict, now);
  if (!verdict.keep) {
    closeApproval(instance, a.id, { status: 'dropped', detail: verdict.reason });
    markProject(ledger, project.id, 'dropped', { dropReason: verdict.reason });
    return { id: a.id, action: 'dropped', reason: verdict.reason };
  }
  const critique = a.critic && !a.critic.pass && !a.critic.error && a.critic.problems?.length ? { score: a.critic.score, problems: a.critic.problems, text: a.draft } : null;
  const best = await improveProposal(project, { instance, descriptor, service: verdict.service, floorKRW: verdict.floorKRW, policy, runCodex: ctx.runCodex, now, critique });
  const step = nextStep({ policy, mode, sendingHours, verdict, best });
  const revised = { revisedAt: new Date().toISOString(), history: best.history ?? [] };
  if (step.action === 'drop') {
    const r = dropProposal(ctx, { project, verdict, best, reason: step.reason });
    closeApproval(instance, a.id, { status: 'dropped', detail: step.reason, ...revised });
    return { id: a.id, ...r };
  }
  if (step.action === 'send') {
    const pageQuota = await (async () => { const s = await openSeller(); try { return await s.quota(); } finally { await s.stop(); } })();
    if (proposalsLeft({ policy, pageQuota, usedToday: usedToday(ledger, now) }) > 0) {
      const s = await openSeller();
      let r;
      try {
        r = await send(ctx, { seller: s, project, verdict, proposal: best.proposal, gate: best.gate, critic: best.critic, approvalId: a.id });
      } finally {
        await s.stop();
      }
      if (r.observed) {
        closeApproval(instance, a.id, { status: 'sent', detail: 'revised and sent by the improve loop', ...revised });
        return { id: a.id, action: 'sent', totalKRW: best.proposal.totalKRW };
      }
      step.reason = 'the form did not take the proposal: ' + (r.res?.reason ?? 'unknown');
    } else step.reason = 'no proposals left today';
  }
  updateApproval(instance, a.id, {
    draft: best.ok ? best.proposal.text : a.draft,
    quote: { amountKRW: best.proposal.totalKRW },
    proposal: { totalKRW: best.proposal.totalKRW, phases: best.proposal.phases, floorKRW: best.proposal.floorKRW },
    critic: best.critic ?? null,
    violations: best.ok ? [] : best.violations,
    reason: approvalSummary(project, best.proposal, step.reason),
    ...revised,
  });
  saveProposalRecord(instance, project.id, { project, score: verdict, proposal: best.proposal, gate: best.gate, critic: best.critic, history: best.history, approvalId: a.id, status: 'queued', reason: step.reason });
  return { id: a.id, action: 'kept', reason: step.reason, score: best.critic?.score ?? null };
}

