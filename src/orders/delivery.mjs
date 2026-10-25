// Delivery and closing. A job whose acceptance passed is queued as a delivery approval carrying its
// deliverables and QA captures: the catalog's humanMinutes assume a person reviews every delivery, so
// nothing is sent before the operator approves. On approval the files go out through the adapter's
// observed send once deliveryAllowed passes; on a split platform the approval also authorizes the
// balance request for the amount it names, sent first, and the files follow when the balance is
// recorded. The delivery message asks the client whether the work may be shown in the portfolio.
// A delivered job whose payments are all received and confirmed is closed, the portfolio is synced and
// published, and the outcome becomes a learning case.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { closeApproval, listApprovals, queueApproval, updateApproval } from '../brain/approvals.mjs';
import { loadGateRules } from '../brain/respond.mjs';
import { repoRoot } from '../core/instance.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { matchFiles } from '../jobs/accept.mjs';
import { loadRecipe } from '../jobs/recipe.mjs';
import { deliveryAllowed, jobPaths } from '../jobs/run.mjs';
import { recordOutcome } from '../learning/outcomes.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { gateOutbound } from '../policy/gate.mjs';
import { syncPortfolio } from '../portfolio/store.mjs';
import { nextPart } from './requests.mjs';

// soomgo's file picker shows 0/10 attachments on the quote form; the chat limit was not observed, so the
// same cap holds there. More files need packaging, which is not built: such a job is refused for a person.
export const MAX_DELIVERY_FILES = 10;

export function deliveryText({ language, files }) {
  const names = files.map((f) => f.split('/').pop());
  if (language === 'en') {
    return [
      'Hello. The finished work is attached: ' + names.join(', ') + '.',
      'Please look it over and tell me if anything should change.',
      'May I show this work in my portfolio? I would show the result only, without your name or details. If you would rather not, just say so.',
    ].join('\n');
  }
  return [
    '안녕하세요. 요청하신 작업 결과물을 첨부해 드립니다.',
    '첨부 파일: ' + names.join(', '),
    '확인해 보시고 고칠 부분이 있으면 말씀해 주세요.',
    '이번 작업물을 제 포트폴리오에 소개해도 괜찮을까요? 고객님 정보는 빼고 결과물만 보여 드립니다. 원하지 않으시면 편하게 말씀해 주세요.',
  ].join('\n');
}

const listFiles = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(jpe?g|png)$/i.test(f)) : []);

export function deliverablesOf(instance, job, recipe) {
  const paths = jobPaths(instance, job.id);
  const files = [...new Set(recipe.deliverables.flatMap((d) => matchFiles(paths.work, d.path)))];
  return { files, absolute: files.map((f) => join(paths.work, f)), captures: listFiles(paths.qa).map((f) => join(paths.qa, f)) };
}

const pendingDelivery = (instance, jobId) =>
  listApprovals(instance).find((a) => a.orderItem && a.kind === 'delivery' && a.jobId === jobId && (a.status === 'open' || (a.status === 'approved' && !a.closedAt))) ?? null;

// Queues one delivery approval per accepted run.
export async function queueDeliveries({ instance, ledger }) {
  const out = [];
  for (const job of ledger.listJobs({ status: 'in_progress' })) {
    const run = job.meta?.lastRun;
    if (!run?.ok || job.meta?.delivery?.queuedFor === run.at || pendingDelivery(instance, job.id)) continue;
    const descriptor = loadDescriptor(job.platform);
    const recipe = loadRecipe(job.service);
    const thread = ledger.getThread(job.threadId);
    const d = deliverablesOf(instance, job, recipe);
    const language = thread?.language ?? job.meta?.language ?? 'ko';
    const balance = descriptor.milestones === 'multi_pay' ? nextPart(job, ledger.jobPayments(job.id), instance.config, descriptor, { rest: true }) : null;
    const tooMany = d.files.length > MAX_DELIVERY_FILES;
    const approval = await queueApproval(instance, {
      orderItem: true, platform: job.platform, kind: 'delivery', threadRef: thread.externalId, threadId: thread.id, jobId: job.id,
      files: d.absolute, captures: d.captures, balanceKRW: balance?.amountKRW ?? null, runAt: run.at,
      draft: deliveryText({ language, files: d.files }),
      reason: (tooMany ? d.files.length + ' files exceed the ' + MAX_DELIVERY_FILES + '-file attachment cap; deliver by hand. ' : '') +
        'acceptance passed for job ' + job.id + '; review the ' + d.files.length + ' deliverables and ' + d.captures.length + ' QA captures before approving' +
        (balance ? '. Approving also sends the ' + descriptor.name + ' payment request for the balance of ' + balance.amountKRW + ' KRW, and the files go out once it is paid' : ''),
      title: job.platform + ' delivery for job ' + job.id,
    });
    ledger.upsertJob({ id: job.id, meta: { ...job.meta, delivery: { queuedFor: run.at, approvalId: approval.id } } });
    ledger.addEvent({ kind: 'order.delivery_queued', platform: job.platform, ref: job.id, payload: { approvalId: approval.id, files: d.files.length, captures: d.captures.length, balanceKRW: balance?.amountKRW ?? null } });
    out.push(approval.id);
  }
  return out;
}

function gateThread(ledger, thread) {
  const msgs = ledger.threadMessages(thread.id);
  return {
    stage: 'post_order',
    lastInboundText: msgs.filter((m) => m.direction === 'in').at(-1)?.body ?? '',
    language: thread.language ?? null,
    recentOutbound: msgs.filter((m) => m.direction === 'out').slice(-10).map((m) => m.body ?? ''),
  };
}

// Acts on one approved delivery. Returns {id, action}.
export async function sendDelivery({ instance, ledger, descriptor, adapter, approval, notify = notifyOperator }) {
  const job = ledger.getJob(approval.jobId);
  const close = (status, detail) => {
    closeApproval(instance, approval.id, { status, detail });
    ledger.addEvent({ kind: 'order.delivery_' + status, platform: approval.platform, ref: approval.jobId, payload: { approvalId: approval.id, detail } });
    return { id: approval.id, action: status };
  };
  if (!job || job.status !== 'in_progress' || job.meta?.lastRun?.at !== approval.runAt) return close('stale', 'the job moved on since this delivery was queued');
  if (approval.files.length > MAX_DELIVERY_FILES) return close('blocked', approval.files.length + ' files exceed the attachment cap');
  const missing = approval.files.filter((f) => !existsSync(f));
  if (missing.length) return close('blocked', 'deliverables missing: ' + missing.join(', '));
  const recipe = loadRecipe(job.service);
  const allowed = deliveryAllowed(job, ledger, descriptor, recipe);
  if (!allowed.ok) {
    const balance = descriptor.milestones === 'multi_pay' ? nextPart(job, ledger.jobPayments(job.id), instance.config, descriptor, { rest: true }) : null;
    if (balance && !approval.balanceRequest) {
      if (balance.amountKRW !== approval.balanceKRW) {
        updateApproval(instance, approval.id, { balanceRequest: { skipped: true, reason: 'due ' + balance.amountKRW + ' differs from the approved ' + approval.balanceKRW } });
        await notify(instance, { kind: 'order', title: 'balance for job ' + job.id + ' changed since approval', body: 'Approved ' + approval.balanceKRW + ' KRW, now due ' + balance.amountKRW + ' KRW. No request was sent; request it by hand or reject and re-queue the delivery.', dedupeKey: 'balance-changed:' + approval.id });
        return { id: approval.id, action: 'waiting' };
      }
      if (typeof adapter.payRequest !== 'function') return close('blocked', job.platform + ' has no payment request in its adapter');
      const r = await adapter.payRequest(approval.threadRef, { amountKRW: balance.amountKRW, approved: true });
      updateApproval(instance, approval.id, { balanceRequest: { amountKRW: balance.amountKRW, at: new Date().toISOString(), observed: r?.observed === true, reason: r?.reason ?? null } });
      ledger.addEvent({ kind: 'order.balance_request_' + (r?.observed ? 'sent' : 'unobserved'), platform: job.platform, ref: job.id, payload: { approvalId: approval.id, amountKRW: balance.amountKRW, reason: r?.reason ?? null } });
      if (!r?.observed) await notify(instance, { kind: 'order', title: 'balance request for job ' + job.id + ' was not observed', body: (r?.reason ?? 'no reason given') + '\nThe files wait until the balance is recorded; check the chat.', dedupeKey: 'balance-unobserved:' + approval.id });
      return { id: approval.id, action: r?.observed ? 'balance_requested' : 'balance_unobserved' };
    }
    if (!approval.waiting) updateApproval(instance, approval.id, { waiting: allowed.reason });
    return { id: approval.id, action: 'waiting' };
  }
  const text = approval.finalText ?? approval.draft;
  const thread = ledger.getThread(approval.threadId);
  const gate = gateOutbound({ platform: job.platform, kind: 'message', text, attachments: approval.files.map((f) => f.split(/[\\/]/).pop()), thread: gateThread(ledger, thread) }, { descriptor, instance, lessonsRules: loadGateRules(instance) });
  if (!gate.ok) {
    closeApproval(instance, approval.id, { status: 'blocked', violations: gate.violations });
    ledger.addEvent({ kind: 'order.delivery_blocked', platform: job.platform, ref: job.id, payload: { approvalId: approval.id, violations: gate.violations } });
    return { id: approval.id, action: 'blocked' };
  }
  const res = await adapter.send(approval.threadRef, { text, files: approval.files, gate });
  if (res?.observed !== true) {
    closeApproval(instance, approval.id, { status: 'unobserved', detail: res?.reason ?? null });
    ledger.addEvent({ kind: 'order.delivery_unobserved', platform: job.platform, ref: job.id, payload: { approvalId: approval.id, reason: res?.reason ?? null } });
    await notify(instance, { kind: 'order', title: 'delivery of job ' + job.id + ' was not observed', body: (res?.reason ?? 'no reason given') + '\nCheck the chat before sending again.', dedupeKey: 'delivery-unobserved:' + approval.id });
    return { id: approval.id, action: 'unobserved' };
  }
  const at = new Date().toISOString();
  ledger.addMessage({ threadId: thread.id, direction: 'out', body: res.text ?? text, externalId: res.externalId ?? null, attachments: approval.files.map((f) => f.split(/[\\/]/).pop()), gate });
  ledger.upsertJob({ id: job.id, status: 'delivered', deliveredAt: at, meta: { ...job.meta, delivery: { ...(job.meta?.delivery ?? {}), at, approvalId: approval.id, files: approval.files.length }, portfolio: { permission: 'pending', askedAt: at } } });
  closeApproval(instance, approval.id, { status: 'sent' });
  ledger.addEvent({ kind: 'job.delivered', platform: job.platform, ref: job.id, payload: { approvalId: approval.id, files: approval.files.length } });
  return { id: approval.id, action: 'sent' };
}

// Every payment received, and on an escrow platform each one confirmed or remitted by the platform.
export function settled(job, ledger, descriptor) {
  const payments = ledger.jobPayments(job.id);
  const paid = payments.reduce((s, p) => s + p.amountKRW, 0);
  if (!payments.length || !(job.priceKRW > 0) || paid < job.priceKRW) return false;
  if (!descriptor.escrow) return true;
  const done = new Set(ledger.listMoneyEvents({ jobId: job.id }).filter((e) => ['confirmed', 'remitted'].includes(e.event) && e.paymentId).map((e) => e.paymentId));
  return payments.every((p) => done.has(p.id));
}

export function runPublish(instance) {
  const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'publish.mjs'), '--instance', instance.dir], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, timeout: 15 * 60_000 });
  return { ok: r.status === 0, exitCode: r.status, detail: (String(r.stdout) + String(r.stderr)).trim().split('\n').slice(-3).join('\n') };
}

// Closes settled delivered jobs, and settled jobs the operator delivers (handed over by
// src/orders/run.mjs), whose full payment and the platform's confirmation are the evidence the sessions
// took place. A review is recorded when the platform showed one; no adapter reads review ratings yet, so
// that part is a named gap. publish deploys only when the content hash changed.
export async function closeSettledJobs({ instance, ledger, publish = runPublish, forceMode = null }) {
  const closed = [];
  const operatorJobs = ledger.listJobs({ status: 'in_progress' }).filter((j) => j.meta?.operator);
  for (const job of [...ledger.listJobs({ status: 'delivered' }), ...operatorJobs]) {
    const descriptor = loadDescriptor(job.platform);
    if (!settled(job, ledger, descriptor)) continue;
    const at = new Date().toISOString();
    ledger.upsertJob({ id: job.id, status: 'closed', closedAt: at, ...(job.deliveredAt ? {} : { deliveredAt: at }) });
    const deliveredAt = job.deliveredAt ?? at;
    const payments = ledger.jobPayments(job.id);
    const thread = job.threadId ? ledger.getThread(job.threadId) : null;
    recordOutcome(instance, ledger, {
      kind: 'job_closed', platform: job.platform, service: job.service, threadRef: thread?.externalId ?? null, jobId: job.id,
      text: 'job ' + job.id + ' (' + job.service + ') closed: ' + payments.reduce((s, p) => s + p.amountKRW, 0) + ' KRW in ' + payments.length + ' payment(s), delivered ' + deliveredAt + ', ' + Math.round(job.agentMinutes ?? 0) + ' agent minutes',
      note: 'portfolio permission ' + (job.meta?.portfolio?.permission ?? 'pending'),
    });
    ledger.addEvent({ kind: 'job.closed', platform: job.platform, ref: job.id, payload: { payments: payments.length } });
    closed.push(job.id);
  }
  if (!closed.length) return { closed };
  const shown = syncPortfolio(instance, ledger).length;
  // A forced observe pass is read-only, and a deploy is an outbound action; the daily publish job deploys later.
  const published = forceMode === 'observe' ? { ok: true, skipped: 'FSW_FORCE_MODE=observe' } : publish(instance);
  if (!published.ok) ledger.addEvent({ kind: 'site.publish_failed', payload: { detail: published.detail } });
  return { closed, shown, published };
}

