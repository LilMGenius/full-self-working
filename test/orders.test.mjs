import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { classifyNotice } from '../src/orders/notices.mjs';
import { recordMoney, recordOrderCounters } from '../src/orders/money.mjs';
import { processThread } from '../src/pipeline/thread.mjs';
import { listApprovals } from '../src/brain/approvals.mjs';
import { parseChats, parseChatThread } from '../src/platforms/soomgo/parse.mjs';

function makeInstance(edit = (c) => c) {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-orders-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}

// The soomgo pay lines as an opened chat prints them (2026-10-25), with a made-up amount.
const NOTICE = {
  requested: '숨고페이\n고객에게 거래를 요청했어요\n고객이 요청을 확인하고 있어요. 고객이 결제를 완료하면 서비스를 진행해 주세요.\n\n서비스명: 웹 개발\n서비스 진행일: 2026.10.20(화)\n서비스 금액: 300,000원',
  paid: '숨고페이\n고객이 결제한 금액을 숨고가\n안전하게 보관하고 있어요\n협의한 날짜와 금액이 맞는지 확인해 주세요.\n\n서비스명: 웹 개발\n서비스 금액: 300,000원\n정산 예정 금액: 300,000원',
  confirmed: '숨고페이\n거래가 확정됐어요\n정산정보가 올바른지 확인해 주세요. 고수 인증 후, 1시간 이내에 300,000원이 고수님 계좌로 안전하게 입금됩니다.',
  remitted: '숨고페이\n입금 완료되었습니다\n고객과 거래가 만족스러웠다면 다음에 또 숨고페이를 이용해보세요.\n\n정산계좌: 예시은행 ****0000\n정산금액: 300,000원',
  hired: '숨고 알리미\n고용이 확정됐어요\n10월 24일 (금) 오전 10:00분까지\n고용을 취소할 수 있습니다.',
};
const NOW = new Date('2026-10-20T15:00:00+09:00');
const quietNotify = async () => ({});

test('money notices are told apart from noise and from customer text, with their amounts', () => {
  assert.deepEqual(classifyNotice({ text: NOTICE.paid }), { class: 'money', event: 'paid', amountKRW: 300000 });
  assert.deepEqual(classifyNotice({ text: NOTICE.requested }), { class: 'money', event: 'pay_requested', amountKRW: 300000 });
  assert.deepEqual(classifyNotice({ text: NOTICE.confirmed }), { class: 'money', event: 'confirmed', amountKRW: 300000 });
  assert.deepEqual(classifyNotice({ text: NOTICE.remitted }), { class: 'money', event: 'remitted', amountKRW: 300000 });
  assert.equal(classifyNotice({ text: NOTICE.hired }).event, 'hired');
  // The list row prints a line without its title.
  assert.equal(classifyNotice({ text: '고객과 거래가 만족스러웠다면 다음에 또 숨고페이를 이용해보세요.\n\n정산금액: 30,000원' }).event, 'remitted');
  assert.equal(classifyNotice({ text: '고객이 48시간 동안 견적을 읽지 않아서 견적 발송에 사용된 1990캐시를 보너스 캐시로 보상해드렸습니다.' }).class, 'noise');
  assert.equal(classifyNotice({ text: '고객님이 견적을 조회하였습니다' }).class, 'noise');
  assert.equal(classifyNotice({ text: '아무 텍스트', type: 'RQ_001' }).class, 'noise');
  assert.equal(classifyNotice({ text: '결제는 언제 하면 될까요?' }), null);
  assert.equal(classifyNotice({ text: '견적 금액 300,000원 괜찮을까요?' }), null);
});

test('a paid notice records exactly one payment row, and every repeat read leaves it at one', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const descriptor = loadDescriptor('soomgo');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message', service: 'landing_page_web' });
  ledger.addQuote({ threadId: thread.id, platform: 'soomgo', service: 'landing_page_web', amountKRW: 600000, depositKRW: 300000, balanceKRW: 300000, scope: ['page'], deliveryDays: 7, costKRW: 0, status: 'sent' });
  const notices = [{ text: NOTICE.hired, at: '2026-10-20T10:00:00+09:00' }, { text: NOTICE.requested, at: '2026-10-20T11:00:00+09:00' }, { text: NOTICE.paid, at: '2026-10-20T11:30:00+09:00' }];
  const args = { ledger, instance, platform: 'soomgo', descriptor, thread, now: NOW, notify: quietNotify };
  await recordMoney({ ...args, notices });
  await recordMoney({ ...args, notices });
  // The list row shows the same paid line at the same minute, without its title.
  await recordMoney({ ...args, threadRef: { notice: NOTICE.paid.split('\n').slice(3).join('\n'), at: '2026-10-20T11:30:41+09:00', status: 'hired' } });
  const job = ledger.listJobs({ platform: 'soomgo' })[0];
  const payments = ledger.jobPayments(job.id);
  assert.equal(payments.length, 1);
  assert.deepEqual([payments[0].kind, payments[0].amountKRW, payments[0].channel], ['deposit', 300000, 'soomgo']);
  assert.match(payments[0].evidence, /고객이 결제한 금액/);
  assert.equal(ledger.listQuotes({ threadId: thread.id, status: 'accepted' }).length, 1);
  assert.equal(job.status, 'ordered');
  // The confirmation settles that payment instead of writing a second one.
  await recordMoney({ ...args, notices: [...notices, { text: NOTICE.confirmed, at: '2026-10-20T12:00:00+09:00' }] });
  assert.equal(ledger.jobPayments(job.id).length, 1);
  assert.equal(ledger.listMoneyEvents({ event: 'confirmed' })[0].paymentId, payments[0].id);
});

test('money older than the lookback is history: recorded, no payment and no hire', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'old', kind: 'message' });
  const r = await recordMoney({ ledger, instance, platform: 'soomgo', descriptor: loadDescriptor('soomgo'), thread, threadRef: { status: 'hired', notice: '고객과 거래가 만족스러웠다면 다음에 또 숨고페이를 이용해보세요.\n정산금액: 30,000원', at: '2025-05-01T10:00:00+09:00' }, now: NOW, notify: quietNotify });
  assert.equal(r.length, 2);
  assert.ok(r.every((e) => e.applied === false));
  assert.equal(ledger.counts().payments, 0);
  assert.equal(ledger.counts().jobs, 0);
});

test('an unread chat whose row carries a money notice is recorded from the row and never opened', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const calls = [];
  const adapter = { async readThread(id) { calls.push(id); return { id, messages: [] }; } };
  const [row] = parseChats([{ id: 77, customer: '고객', service: '웹 개발', updatedAt: '2026-10-20T11:30:00.123456', lastMessage: NOTICE.paid, lastType: 'SYSTEM', newMessages: 1, status: 'hired', hireStatus: 'hired' }]);
  assert.equal(row.at, '2026-10-20T11:30:00.123+09:00');
  const r = await processThread({ platform: 'soomgo', threadRef: row, adapter, ledger, instance, descriptor: loadDescriptor('soomgo'), mode: 'auto', now: NOW, decide: async () => { throw new Error('no decision for a notice'); } });
  assert.equal(r.action, 'system');
  assert.deepEqual(calls, []);
  assert.equal(ledger.counts().payments, 1);
});

test('the soomgo thread parser keeps platform lines as notices with redacted evidence', () => {
  const t = parseChatThread({
    id: '5',
    items: [
      { date: '2026년 10월 20일 화요일' },
      { kind: 'text', outbound: false, text: '네 결제할게요', time: '오전 11:20' },
      { kind: 'system', type: 'SP_ST_002', text: NOTICE.remitted + '\n입금자명: 예시', time: '오전 11:30' },
    ],
  });
  assert.equal(t.messages.length, 1);
  assert.deepEqual(t.notices.map((n) => [n.type, n.at]), [['SP_ST_002', '2026-10-20T11:30:00+09:00']]);
  assert.doesNotMatch(t.notices[0].text, /정산계좌|입금자명|0000/);
  assert.equal(classifyNotice(t.notices[0]).amountKRW, 300000);
});

test('after a hire an auto reply goes to the operator until orders.watched is set', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'kmong', externalId: 'k1', kind: 'message' });
  ledger.addQuote({ threadId: thread.id, platform: 'kmong', service: 'landing_page_web', amountKRW: 500000, scope: ['page'], deliveryDays: 5, costKRW: 0, status: 'accepted' });
  const adapter = { async readThread(id) { return { id, stage: 'pre_order', messages: [{ direction: 'in', text: '진행 일정이 궁금합니다', externalId: 'm1' }] }; }, async send() { throw new Error('must not send'); } };
  const decide = async () => ({ action: 'reply', modelCalls: 1, decision: { intent: 'order_detail', service: 'landing_page_web', language: 'ko', reply: '다음 주 화요일에 시안을 드리겠습니다.', quote: null, needsOperator: false, operatorReason: null, confidence: 0.95, claimsUsed: [] }, item: { kind: 'message' }, gate: { ok: true, violations: [], warnings: [] } });
  const r = await processThread({ platform: 'kmong', threadRef: { id: 'k1', unread: false, at: '2026-10-20T11:00:00+09:00' }, adapter, ledger, instance, descriptor: loadDescriptor('kmong'), mode: 'auto', now: NOW, decide });
  assert.equal(r.action, 'queued');
  assert.match(listApprovals(instance)[0].reason, /order stage quote_accepted/);
});

test('a rise in a kmong order counter notifies the operator once and records the order event', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const sent = [];
  const notify = async (_i, n) => sent.push(n);
  const zero = { counts: { ongoing: 0, delivered: 0, completed: 0 }, total: 0, orders: [] };
  assert.equal((await recordOrderCounters({ ledger, instance, platform: 'kmong', orders: zero, notify })).changed, false);
  const one = { counts: { ongoing: 1, delivered: 0, completed: 0 }, total: 1, orders: null, gap: 'order rows present' };
  const r = await recordOrderCounters({ ledger, instance, platform: 'kmong', orders: one, notify });
  assert.deepEqual(r.rises, [{ counter: 'ongoing', from: 0, to: 1 }]);
  assert.equal((await recordOrderCounters({ ledger, instance, platform: 'kmong', orders: one, notify })).changed, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /ongoing 0 to 1/);
  assert.equal(ledger.db.prepare("SELECT count(*) n FROM events WHERE kind = 'orders.changed'").get().n, 1);
});

