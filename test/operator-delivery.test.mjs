import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { listApprovals, resolveApproval } from '../src/brain/approvals.mjs';
import { flushApprovals } from '../src/pipeline/thread.mjs';
import { answeredServices } from '../src/economics/catalog.mjs';
import { recordMoney } from '../src/orders/money.mjs';
import { startJobs } from '../src/orders/run.mjs';
import { closeSettledJobs } from '../src/orders/delivery.mjs';
import { tempDir } from './tmp.mjs';

const LESSONS_ON_SOOMGO = (c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, services: [...answeredServices(c, 'soomgo'), 'lesson_tutoring'] } } });
const quiet = async () => ({});

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-operator-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}

// The soomgo lines as an opened chat prints them, with made-up amounts.
const PAID = '숨고페이\n고객이 결제한 금액을 숨고가\n안전하게 보관하고 있어요\n협의한 날짜와 금액이 맞는지 확인해 주세요.\n\n서비스명: 프로그래밍/코딩 레슨\n서비스 금액: 140,000원\n정산 예정 금액: 140,000원';
const HIRED = '숨고 알리미\n고용이 확정됐어요\n10월 28일 (화) 오전 10:00분까지\n고용을 취소할 수 있습니다.';
const CONFIRMED = '숨고페이\n거래가 확정됐어요\n정산정보가 올바른지 확인해 주세요. 고수 인증 후, 1시간 이내에 140,000원이 고수님 계좌로 안전하게 입금됩니다.';

// A hired soomgo lesson of 280,000 KRW whose 140,000 KRW deposit the client paid on their own.
async function paidLesson(instance, ledger) {
  const descriptor = loadDescriptor('soomgo');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'l1', kind: 'message', service: 'lesson_tutoring' });
  ledger.addQuote({ threadId: thread.id, platform: 'soomgo', service: 'lesson_tutoring', amountKRW: 280000, scope: ['60분 수업 8회'], deliveryDays: 28, costKRW: 0, status: 'sent' });
  const notices = [{ text: HIRED, at: '2026-10-25T10:00:00+09:00' }, { text: PAID, at: '2026-10-25T11:30:00+09:00' }];
  await recordMoney({ ledger, instance, platform: 'soomgo', descriptor, thread, notices, now: new Date('2026-10-25T12:00:00+09:00'), notify: quiet });
  return ledger.listJobs().find((j) => j.threadId === thread.id);
}

test('a paid job the operator delivers starts no job run', async () => {
  const instance = makeInstance(LESSONS_ON_SOOMGO);
  const ledger = openLedger(':memory:');
  const job = await paidLesson(instance, ledger);
  assert.deepEqual([job.service, job.meta.manual], ['lesson_tutoring', undefined]);
  const spawned = [];
  const spawnJob = (_i, id) => spawned.push(id);
  const out = await startJobs({ instance, ledger, spawnJob, alive: () => false, notify: quiet });
  assert.deepEqual([spawned, out.started, out.operator], [[], [], [job.id]]);
  assert.equal(ledger.getJob(job.id).status, 'in_progress');
  // Handed over once: the next pass finds no ordered job and still spawns nothing.
  assert.deepEqual((await startJobs({ instance, ledger, spawnJob, alive: () => false, notify: quiet })).operator, []);
  assert.deepEqual(spawned, []);
});

test('the operator is told to schedule the sessions, and approving that item asks for the balance and leads to the close', async () => {
  const instance = makeInstance(LESSONS_ON_SOOMGO);
  const ledger = openLedger(':memory:');
  const descriptor = loadDescriptor('soomgo');
  const job = await paidLesson(instance, ledger);
  await startJobs({ instance, ledger, spawnJob: () => { throw new Error('no runner'); }, alive: () => false, notify: quiet });
  const item = listApprovals(instance, { status: 'open' }).find((a) => a.jobId === job.id);
  assert.deepEqual([item.kind, item.amountKRW, item.rest], ['pay_request', 140000, true]);
  assert.equal(item.title, 'soomgo job ' + job.id + ': schedule the sessions');
  assert.match(item.reason, /^deposit received for lesson_tutoring job .*Schedule the sessions with the client in the 숨고 chat and teach them; approve this item when they are done: request Balance of 140000 KRW/);
  // The deposit request queued at the hire was overtaken by the client's own payment.
  assert.equal(listApprovals(instance).find((a) => a.jobId === job.id && !a.rest).status, 'stale');
  // The sessions are done: the operator approves, the balance request goes out, the client pays and confirms.
  resolveApproval(instance, item.id, { approve: true });
  const calls = [];
  const adapter = { async payRequest(id, o) { calls.push([id, o.amountKRW]); return { observed: true }; } };
  const out = await flushApprovals({ platform: 'soomgo', adapter, ledger, instance, descriptor });
  assert.deepEqual([out, calls], [[{ id: item.id, action: 'sent' }], [['l1', 140000]]]);
  const thread = ledger.getThread(job.threadId);
  const notices = [{ text: PAID, at: '2026-11-20T11:00:00+09:00' }, { text: CONFIRMED, at: '2026-11-20T11:10:00+09:00' }, { text: CONFIRMED, at: '2026-11-20T11:20:00+09:00' }];
  await recordMoney({ ledger, instance, platform: 'soomgo', descriptor, thread, notices, now: new Date('2026-11-20T12:00:00+09:00'), notify: quiet });
  const closing = await closeSettledJobs({ instance, ledger, publish: () => ({ ok: true }) });
  assert.deepEqual(closing.closed, [job.id]);
  assert.equal(ledger.getJob(job.id).status, 'closed');
});

test('where no balance request applies, the handover is a plain notice to the operator', async () => {
  const instance = makeInstance((c) => LESSONS_ON_SOOMGO(c));
  const ledger = openLedger(':memory:');
  const job = await paidLesson(instance, ledger);
  // The client paid the whole price, so no balance is due.
  ledger.upsertJob({ id: job.id, priceKRW: 140000 });
  const notices = [];
  await startJobs({ instance, ledger, spawnJob: () => { throw new Error('no runner'); }, alive: () => false, notify: async (_i, n) => notices.push(n) });
  assert.equal(listApprovals(instance, { status: 'open' }).filter((a) => a.jobId === job.id).length, 0);
  assert.deepEqual(notices.map((n) => n.title), ['soomgo job ' + job.id + ': schedule the sessions']);
  assert.match(notices[0].body, /No balance request was queued: nothing is due/);
});
