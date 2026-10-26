// The supervisor's hourly projects job (Seoul minute 0): read new 크몽 엔터프라이즈 projects, judge each
// page version once, draft proposals for the best within the day's quota and improve each with the
// critic's problems, plan one outbox row of kind proposal for each draft the policy keeps (the kmong poll's
// outbox drain sends it through Surface.propose, or asks the operator), drop the ones only the critic still
// rejects, carry what the drain sent onto the project threads, and read what happened to sent proposals.
// A proposal that turns into a chat arrives in the 크몽 inbox, which the poll job answers; a meeting, a
// selection or a close becomes a learning case. This job never sends (003 Outbox).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey } from '../core/clock.mjs';
import { logEvent } from '../core/log.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { effectiveMode } from '../core/settings.mjs';
import { recordOutcome } from '../learning/outcomes.mjs';
import { latestAllocation } from '../economics/priority.mjs';
import { plan, setStatus } from '../outbox/index.mjs';
import { operatingMode } from '../policy/authorize.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { CATEGORIES, detailUrl } from '../platforms/kmong/projects.mjs';
import { fitMeets, improveProposal, proposalPolicy, proposalsLeft, sendDecision, usedToday } from './draft.mjs';
import { FIT_RANK, SUB_ROOT, SUB_SERVICES, markProject, needsJudgement, projectThread, rememberJudgement, scoreProject } from './score.mjs';

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

// One outbox row per proposal (003 Outbox, kind proposal; payload keys project, proposal, critic,
// violations, summary, service). auto is nextStep's plan: needsOperator false, so the kmong drain sends it
// when authorize lets it go; a held one reaches the operator through that drain. Every proposal marks its
// project queued, so the next hourly run never drafts it again.
export function planProposal(ctx, { project, verdict, proposal, critic, violations = [], auto, reason }) {
  const { instance, ledger } = ctx;
  const row = projectThread(ledger, project.id);
  const summary = approvalSummary(project, proposal, reason ?? 'sent by policy');
  const planned = plan(ledger, {
    platform: 'kmong', threadId: row.id, jobId: null, kind: 'proposal',
    payload: {
      text: proposal.text, amountKRW: proposal.totalKRW, service: verdict.service, summary,
      thread: { kind: 'project', stage: 'pre_order' },
      decision: { intent: 'quote_request', service: verdict.service, language: 'ko', reply: proposal.text, quote: null, needsOperator: !auto, operatorReason: auto ? null : summary, confidence: 1, claimsUsed: [] },
      project: { id: project.id, title: project.title, amountKRW: project.amountKRW, deadlineAt: project.deadlineAt, url: detailUrl(project.id) },
      proposal: { totalKRW: proposal.totalKRW, phases: proposal.phases, floorKRW: proposal.floorKRW }, critic: critic ?? null, violations,
    },
  });
  markProject(ledger, project.id, 'queued', { proposal: { outboxId: planned.id, queuedAt: new Date().toISOString(), totalKRW: proposal.totalKRW } });
  if (!auto) ledger.addEvent({ at: stamp(ctx), kind: 'project.queued', platform: 'kmong', ref: project.id, payload: { outboxId: planned.id, reason } });
  saveProposalRecord(instance, project.id, { project, score: verdict, proposal, critic: critic ?? null, outboxId: planned.id, status: auto ? 'planned' : 'queued', reason: reason ?? null });
  return { id: project.id, action: auto ? 'planned' : 'queued', outboxId: planned.id, reason: reason ?? null };
}

// What happens to an improved draft (improveProposal): planned for the drain with needsOperator false
// when the policy allows it; dropped when the
// critic alone still stood in the way after every rewrite, since the operator would only be asked to
// approve a proposal the reviewer would not shortlist; an operator approval for every other hold.
export function nextStep({ policy, mode, sendingHours, verdict, best }) {
  if (!best.ok) return { action: 'queue', reason: 'gate or plan blocked the draft twice: ' + best.violations.map((v) => v.rule).join(', ') };
  const base = { policy, mode, sendingHours, fit: verdict.fit, totalKRW: best.proposal.totalKRW };
  const decision = sendDecision({ ...base, critic: best.critic });
  if (decision.action === 'send') return { action: 'plan', reason: null };
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

// What the kmong drain did with proposal rows, carried onto project threads and records the way the old
// send did (src/projects/job.mjs:118-135 at 2c77326): an observed row marks its project proposed and counts
// against the day (project.proposed); an unobserved one marks it unobserved, which readStatuses then reads
// back from /seller/proposals. A send.deferred event with the enterprise profile code, newer than the last
// profile state, sets the day memory and tells the operator once (profileBlocked).
// A row the approvals import closed as sent or unobserved by the 2c77326 code (receipt.pipeline) is skipped,
// as the deal sweep skips it: that code already marked the project and wrote its project.proposed event.
export async function syncProposals(ctx) {
  const { instance, ledger, now = new Date() } = ctx;
  const out = [];
  for (const row of ledger.listOutbox({ platform: 'kmong', kinds: ['proposal'], statuses: ['observed', 'unobserved'] }).filter((r) => r.receipt?.pipeline !== 'd605c5d')) {
    const id = row.payload.project.id;
    const prev = projectThread(ledger, id)?.meta?.proposal ?? {};
    if (prev.syncedOutboxId === row.id) continue;
    const proposal = { ...prev, at: row.updatedAt, totalKRW: row.payload.amountKRW, outboxId: row.id, syncedOutboxId: row.id };
    if (row.status === 'observed') {
      markProject(ledger, id, 'proposed', { proposal: { ...proposal, status: row.receipt?.status ?? 'unknown', label: row.receipt?.snippet ?? null } });
      ledger.addEvent({ at: stamp(ctx), kind: 'project.proposed', platform: 'kmong', ref: id, payload: { totalKRW: row.payload.amountKRW, service: row.payload.service, outboxId: row.id } });
      logEvent(instance, 'project.proposed', { id, totalKRW: row.payload.amountKRW });
    } else markProject(ledger, id, 'unobserved', { proposal });
    saveProposalRecord(instance, id, { outboxId: row.id, send: { at: row.updatedAt, observed: row.status === 'observed', reason: row.reason ?? null }, status: row.status === 'observed' ? row.receipt?.status ?? 'unknown' : 'unobserved' });
    out.push({ id, outboxId: row.id, status: row.status });
  }
  const since = Date.parse(readJobState(instance).enterpriseProfile?.at ?? 0) || 0;
  const deferred = ledger.db.prepare("SELECT payload, at FROM events WHERE platform = 'kmong' AND kind = 'send.deferred'").all();
  if (deferred.some((e) => Date.parse(e.at) > since && dayKey(new Date(e.at)) === dayKey(now) && JSON.parse(e.payload).code === 'FSW_KMONG_ENTERPRISE_PROFILE')) await profileBlocked(instance, now);
  return out;
}

// Proposal rows still waiting whose project closed or passed its deadline go stale before the drain
// reaches them (the check of flushProposalApprovals, src/projects/job.mjs:152-157 at 2c77326).
export async function expireProposals(ctx, { reader }) {
  const { ledger, now = new Date() } = ctx;
  const out = [];
  for (const row of ledger.listOutbox({ platform: 'kmong', kinds: ['proposal'], statuses: ['planned', 'awaiting_operator', 'approved'] })) {
    const project = await reader.readProject(row.payload.project.id, { now });
    if (project.status === 'APPROVAL' && !(Number.isInteger(project.deadlineDays) && project.deadlineDays < 0)) continue;
    if (setStatus(ledger, row.id, { from: row.status, to: 'stale', reason: 'project is ' + project.status })) out.push({ id: row.payload.project.id, outboxId: row.id, action: 'stale' });
  }
  return out;
}

// The kmong mode this job plans under and whether the outbound hours are open, from the policy's one
// function (003 Policy, operatingMode), the predicate authorize holds sends with.
function modeAndHours(ctx, now) {
  const kmongMode = ctx.instance.config?.platforms?.kmong?.mode;
  return { mode: effectiveMode(kmongMode, ctx.forceMode), sendingHours: operatingMode(kmongMode, { forceMode: ctx.forceMode, now, instance: ctx.instance }).hoursOpen };
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
  const { mode, sendingHours } = modeAndHours(ctx, now);
  const descriptor = loadDescriptor('kmong');
  const allocation = latestAllocation(instance);
  const openReader = ctx.openReader ?? (async () => (await import('../platforms/kmong/projects.mjs')).openProjectReader());
  const openSeller = ctx.openSeller ?? (async () => (await import('../platforms/kmong/projects.mjs')).openProjectSeller());
  const result = { status: 'ok', mode, listed: 0, judged: 0, kept: 0, drafted: [], planned: [], queued: [], dropped: [], errors: [] };
  const reader = await openReader();
  // A signed-in session lives only as long as one step: drafting takes minutes, and the browser daemon
  // drops a session left idle that long, so each read opens its own and closes it.
  const useSeller = async (fn) => {
    const s = await openSeller();
    try {
      return await fn(s);
    } finally {
      await s.stop().catch((err) => result.errors.push({ ref: 'seller.stop', code: err.code ?? null, message: err.message }));
    }
  };
  try {
    const outbound = mode !== 'observe';
    // What the drain did since the last pass, before the day's quota and profile memory are read.
    if (outbound) {
      result.synced = await syncProposals(ctx);
      result.expired = await expireProposals(ctx, { reader });
    }
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
    if (outbound && profileMissing) {
      result.detail = 'enterprise profile not registered (checked ' + state.enterpriseProfile.at + '); drafting waits for it';
    }
    if (outbound && candidates.length && !profileMissing) {
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
          const planned = planProposal(ctx, { project, verdict, proposal: best.proposal, critic: best.critic, violations: best.ok ? [] : best.violations, auto: step.action === 'plan', reason: step.reason });
          (planned.action === 'planned' ? result.planned : result.queued).push(planned);
        } catch (err) {
          result.errors.push({ id, code: err.code ?? null, message: err.message });
          ledger.addEvent({ kind: 'project.error', platform: 'kmong', ref: id, payload: { code: err.code ?? null, message: err.message } });
          if (err.code === 'FSW_PACING_LIMIT') break;
        }
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

// Reworks one proposal waiting for the operator through the improve loop, starting from the critic's
// verdict it already holds: a draft only the critic still rejects is dropped and the row rejected with the
// reason; a draft whose text changed replaces the row (rejected as revised) with a new one, planned for
// the drain when the policy would now send it and the day has a proposal left; an unchanged draft keeps
// the row, so the operator always reads the strongest version.
export async function reviseApproval(ctx, approvalId) {
  const { instance, ledger, now = new Date() } = ctx;
  const row = ledger.outboxByApproval(approvalId);
  if (!row || row.kind !== 'proposal' || row.status !== 'awaiting_operator') throw Object.assign(new Error('approval ' + approvalId + ' is not a proposal waiting for the operator (' + (row ? row.kind + ', ' + row.status : 'no outbox row') + ')'), { code: 'FSW_APPROVAL_STATE' });
  const policy = proposalPolicy(instance.config);
  const descriptor = loadDescriptor('kmong');
  const { mode, sendingHours } = modeAndHours(ctx, now);
  const openReader = ctx.openReader ?? (async () => (await import('../platforms/kmong/projects.mjs')).openProjectReader());
  const openSeller = ctx.openSeller ?? (async () => (await import('../platforms/kmong/projects.mjs')).openProjectSeller());
  const reader = await openReader();
  let project;
  try {
    project = await reader.readProject(row.payload.project.id, { now });
  } finally {
    await reader.close();
  }
  if (project.status !== 'APPROVAL' || (Number.isInteger(project.deadlineDays) && project.deadlineDays < 0)) {
    setStatus(ledger, row.id, { from: 'awaiting_operator', to: 'stale', reason: 'project is ' + project.status });
    return { id: approvalId, action: 'expired' };
  }
  const verdict = scoreProject(project, { profile: instance.profile, config: instance.config, descriptor, allocation: latestAllocation(instance), minFit: policy.minFit, now });
  rememberJudgement(ledger, project, verdict, now);
  if (!verdict.keep) {
    setStatus(ledger, row.id, { from: 'awaiting_operator', to: 'rejected', reason: 'dropped: ' + verdict.reason });
    markProject(ledger, project.id, 'dropped', { dropReason: verdict.reason });
    return { id: approvalId, action: 'dropped', reason: verdict.reason };
  }
  const critic = row.payload.critic;
  const critique = critic && !critic.pass && !critic.error && critic.problems?.length ? { score: critic.score, problems: critic.problems, text: row.payload.text } : null;
  const best = await improveProposal(project, { instance, descriptor, service: verdict.service, floorKRW: verdict.floorKRW, policy, runCodex: ctx.runCodex, now, critique });
  const step = nextStep({ policy, mode, sendingHours, verdict, best });
  if (step.action === 'drop') {
    const r = dropProposal(ctx, { project, verdict, best, reason: step.reason });
    setStatus(ledger, row.id, { from: 'awaiting_operator', to: 'rejected', reason: 'dropped: ' + step.reason });
    return { id: approvalId, ...r };
  }
  if (!best.ok || best.proposal.text === row.payload.text) return { id: approvalId, action: 'kept', reason: step.reason, score: best.critic?.score ?? null };
  let auto = false;
  let reason = step.reason;
  if (step.action === 'plan') {
    const pageQuota = await (async () => { const s = await openSeller(); try { return await s.quota(); } finally { await s.stop(); } })();
    auto = proposalsLeft({ policy, pageQuota, usedToday: usedToday(ledger, now) }) > 0;
    if (!auto) reason = 'no proposals left today';
  }
  setStatus(ledger, row.id, { from: 'awaiting_operator', to: 'rejected', reason: 'revised' });
  const planned = planProposal(ctx, { project, verdict, proposal: best.proposal, critic: best.critic, violations: [], auto, reason: reason ?? 'revised by the improve loop' });
  return { id: approvalId, action: 'revised', outboxId: planned.outboxId, planned: planned.action, reason, score: best.critic?.score ?? null };
}
