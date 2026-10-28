// The effects the deal returns for the loop to carry out after its commit (src/deal/advance.mjs): the operator's
// payment request and hand-over items, the delivery, a notice and a learning case. sweep re-derives the first three.
import { deliveryText } from './delivery-text.mjs';
import { nextPart } from './levels.mjs';

const baseName = (f) => String(f).split(/[\\/]/).pop();
export const notifyEffect = (title, body, dedupeKey) => ({ type: 'notify', note: { kind: 'order', title, body, dedupeKey } });
export const caseEffect = (c) => ({ type: 'record_case', case: c });

// The operator item that asks for the next part through the platform's own request (src/orders/requests.mjs:36-52).
export function payRequestEffect({ job, thread, part, descriptor, paidBeforeKRW, rest, why }) {
  return {
    type: 'plan_outbox',
    item: {
      platform: job.platform, threadId: thread.id, jobId: job.id, kind: 'pay_request',
      payload: {
        text: descriptor.name + ' payment request: ' + part.amountKRW + ' KRW, ' + part.label,
        amountKRW: part.amountKRW, part: part.label + (part.of ? ' (' + (part.index + 1) + ' of ' + part.of + ')' : ''), rest, paidBeforeKRW,
        service: job.service, thread: { kind: thread.kind, stage: 'post_order' },
        reason: why + ': request ' + part.label + ' of ' + part.amountKRW + ' KRW through ' + descriptor.name + ' for job ' + job.id + ' (total ' + job.priceKRW + ' KRW)',
      },
    },
  };
}

// The operator steps of the last run (its recipe's user-handoff steps) with what the operator recorded
// for each; a step recorded for an earlier run is not done for this one. Only a step that produces files is
// recorded; one that produces none is confirmed in the delivery approval, which waits for the operator.
function handoffState(job) {
  const run = job.meta?.lastRun;
  const done = job.meta?.handoffs ?? {};
  return (run?.handoffs ?? []).map((h) => ({ ...h, done: done[h.id]?.runAt === run.at ? done[h.id] : null }));
}

export const makesFiles = (h) => Boolean(h.produces?.length);

// The delivery item and, on a split platform, the balance request (src/orders/delivery.mjs:57-84, split
// into two operator items: the files wait in readiness until the balance is recorded). Nothing is planned
// while an operator step of the run is unrecorded, and the delivery carries the files each step recorded.
export function deliveryEffects(ledger, { job, descriptor, config }) {
  const run = job.meta?.lastRun;
  const thread = job.threadId ? ledger.getThread(job.threadId) : null;
  if (!run?.ok || !thread || !Array.isArray(run.files)) return [];
  const steps = handoffState(job);
  const recorded = steps.filter(makesFiles);
  if (recorded.some((h) => !h.done)) return [];
  const confirm = steps.filter((h) => !makesFiles(h));
  const files = [...run.files, ...recorded.flatMap((h) => h.done.files)];
  const stepNote = (recorded.length ? '; operator steps recorded: ' + recorded.map((h) => h.id + ' (' + (h.done.files.length ? h.done.files.length + ' files' : 'not applicable') + ')').join(', ') : '')
    + (confirm.length ? '; confirm before approving that you did: ' + confirm.map((h) => h.id + ' (' + h.ask + ')').join('; ') : '');
  const msgs = ledger.threadMessages(thread.id);
  const language = thread.language ?? job.meta?.language ?? 'ko';
  const effects = [{
    type: 'plan_outbox',
    item: {
      platform: job.platform, threadId: thread.id, jobId: job.id, kind: 'delivery',
      payload: {
        text: deliveryText({ language, files: files.map(baseName) }), files, captures: run.captures ?? [], runAt: run.at, service: job.service,
        review: run.review ?? { verdict: 'error', findings: [{ severity: 'blocker', file: null, detail: 'no review ran' }] },
        handoffs: steps.map((h) => (makesFiles(h) ? { id: h.id, output: h.output, at: h.done.at, files: h.done.files } : { id: h.id, output: h.output, confirm: h.ask })),
        thread: { kind: thread.kind, stage: 'post_order', lastInboundText: msgs.filter((m) => m.direction === 'in').at(-1)?.body ?? '', language: thread.language ?? null, recentOutbound: msgs.filter((m) => m.direction === 'out').slice(-10).map((m) => m.body ?? '') },
        reason: 'acceptance passed for job ' + job.id + stepNote + '; review the ' + files.length + ' deliverables and ' + (run.captures ?? []).length + ' QA captures before approving',
      },
    },
  }];
  if (descriptor.milestones === 'multi_pay') {
    const payments = ledger.jobPayments(job.id);
    const part = nextPart(job, payments, config, descriptor, { rest: true });
    if (part) effects.push(payRequestEffect({ job, thread, part, descriptor, paidBeforeKRW: payments.reduce((s, p) => s + p.amountKRW, 0), rest: true, why: 'delivery ready' }));
  }
  return effects;
}

// The payment an operator-delivered job waits for before the operator starts.
export const OPERATOR_START_LEVEL = 'deposit';

// The operator's schedule-the-sessions item: the balance request, approved with fsw approve when the
// sessions are done, so the balance and the close follow the usual flow. sweep re-derives it.
export function handOverEffect({ job, thread, part, descriptor, paidBeforeKRW }) {
  return payRequestEffect({ job, thread, part, descriptor, paidBeforeKRW, rest: true, why: 'deposit received for ' + job.service + ' job ' + job.id + '; schedule the sessions with the client in the ' + descriptor.name + ' chat and teach them, then approve this item' });
}
