import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { plan } from '../src/outbox/index.mjs';
import { advance, jobOfThread, moneyToSignals, stageOf, sweep } from '../src/deal/index.mjs';
import { itemFromJob } from '../src/portfolio/store.mjs';
import { rankPortfolio } from '../src/portfolio/rank.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-deal-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}
const LESSONS = (c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, services: ['landing_page_web', 'lesson_tutoring'] } } });
const NOTICE = {
  hired: '숨고 알리미\n고용이 확정됐어요\n10월 24일 (금) 오전 10:00분까지\n고용을 취소할 수 있습니다.',
  paid: (n) => '숨고페이\n고객이 결제한 금액을 숨고가\n안전하게 보관하고 있어요\n협의한 날짜와 금액이 맞는지 확인해 주세요.\n\n서비스명: 웹 개발\n서비스 금액: ' + n + '원',
  confirmed: (n) => '숨고페이\n거래가 확정됐어요\n정산정보가 올바른지 확인해 주세요. 고수 인증 후, 1시간 이내에 ' + n + '원이 고수님 계좌로 안전하게 입금됩니다.',
};
const NOW = new Date('2026-10-20T15:00:00+09:00');
const at = (hm) => '2026-10-20T' + hm + ':00+09:00';

function setup({ platform = 'soomgo', edit } = {}) {
  const instance = makeInstance(edit);
  const ledger = openLedger(':memory:');
  const descriptor = loadDescriptor(platform);
  const ctx = { instance, descriptor, now: NOW };
  const step = (signal) => advance(ledger, signal, ctx);
  const thread = (ref, kind = 'message', extra = {}) => ledger.upsertThread({ platform, externalId: ref, kind, ...extra });
  const quoteSignal = (t, amountKRW = 300000, service = 'landing_page_web') => ({ type: 'quote_observed', platform, threadId: t.id, at: at('10:05'), amountKRW, evidence: { outboxId: 1, service, scope: ['한 페이지'], deliveryDays: 7, split: { parts: [{ amountKRW: amountKRW / 2 }, { amountKRW: amountKRW / 2 }] }, costKRW: 990, cashSpentKRW: 990 } });
  const notices = (t, list, inbound = {}) => moneyToSignals({ platform, threadId: t.id, inbound, notices: list, now: NOW });
  const events = (kind) => ledger.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind).map((e) => JSON.parse(e.payload));
  return { instance, ledger, descriptor, ctx, step, thread, quoteSignal, notices, events, platform };
}
const effectTypes = (r) => r.effects.map((e) => e.type + (e.item ? ':' + e.item.kind : '') + (e.case ? ':' + e.case.kind : ''));

test('the job of a thread is the one opened last, not the first its id sorts to', () => {
  const s = setup();
  const t = s.thread('c9');
  s.ledger.upsertJob({ id: 'soomgo-a-old', threadId: t.id, platform: 'soomgo', service: 'landing_page_web', status: 'closed', deliveredAt: at('09:00') });
  s.ledger.upsertJob({ id: 'soomgo-b-new', threadId: t.id, platform: 'soomgo', service: 'landing_page_web', status: 'quoted' });
  assert.equal(jobOfThread(s.ledger, 'soomgo', t.id).id, 'soomgo-b-new');
  assert.equal(stageOf({ page: null, kind: 'message' }, s.ledger, 'soomgo', t.id), 'pre_order');
  assert.equal(jobOfThread(s.ledger, 'soomgo', s.thread('none').id), null);
  assert.equal(jobOfThread(s.ledger, 'kmong', t.id), null);
});

test('a paid notice writes one payment; every repeat read leaves one; the confirmation links it', () => {
  const s = setup();
  const t = s.thread('c1');
  s.step(s.quoteSignal(t));
  for (const sig of s.notices(t, [{ text: NOTICE.hired, at: at('10:58') }])) s.step(sig);
  for (let i = 0; i < 3; i++) for (const sig of s.notices(t, [{ text: NOTICE.paid('150,000'), at: at('11:58') }])) s.step(sig);
  const job = s.ledger.listJobs()[0];
  assert.equal(s.ledger.jobPayments(job.id).length, 1);
  for (const sig of s.notices(t, [{ text: NOTICE.confirmed('150,000'), at: at('12:30') }])) s.step(sig);
  const conf = s.ledger.listMoneyEvents({ event: 'confirmed' });
  assert.equal(conf[0].paymentId, s.ledger.jobPayments(job.id)[0].id);
});

test('money older than the lookback is recorded as history and changes nothing', () => {
  const s = setup();
  const t = s.thread('c1');
  s.step(s.quoteSignal(t));
  for (const sig of s.notices(t, [{ text: NOTICE.paid('150,000'), at: '2026-10-12T10:00:00+09:00' }])) s.step(sig);
  const [ev] = s.ledger.listMoneyEvents();
  assert.deepEqual([ev.applied, /history/.test(ev.note)], [false, true]);
  assert.equal(s.ledger.listJobs()[0].status, 'quoted');
});

test('a chat row still showing status hired after its hire was recorded adds no money event', () => {
  const s = setup();
  const t = s.thread('c1');
  s.step(s.quoteSignal(t));
  for (const sig of s.notices(t, [], { notice: NOTICE.hired, at: at('10:58'), status: 'hired' })) s.step(sig);
  // The next read: the row's newest line is the payment, the status still hired.
  for (const sig of s.notices(t, [], { notice: NOTICE.paid('150,000'), at: at('11:58'), status: 'hired' })) s.step(sig);
  assert.deepEqual(s.ledger.listMoneyEvents().map((e) => [e.event, e.applied]), [['hired', true], ['paid', true]]);
});

test('quote, hire, pay, run, deliver and two confirmations move the job through the table with its effects', () => {
  const s = setup();
  const t = s.thread('c1');
  const q = s.step(s.quoteSignal(t));
  assert.deepEqual([q.transitions, q.effects], [[{ jobId: 'soomgo-c1', from: null, to: 'quoted' }], []]);
  const hire = s.step(s.notices(t, [{ text: NOTICE.hired, at: at('10:58') }])[0]);
  assert.deepEqual(hire.transitions.map((x) => x.to), ['ordered']);
  assert.deepEqual(effectTypes(hire), ['plan_outbox:pay_request', 'notify']);
  assert.equal(hire.effects[0].item.payload.amountKRW, 150000);
  assert.match(hire.effects[0].item.payload.text, /Deposit$/);
  assert.equal(s.ledger.listQuotes({ status: 'accepted' }).length, 1);
  const paid = s.step(s.notices(t, [{ text: NOTICE.paid('150,000'), at: at('11:58') }])[0]);
  assert.deepEqual(effectTypes(paid), ['start_run', 'notify']);
  assert.equal(s.ledger.jobPayments('soomgo-c1')[0].kind, 'deposit');
  assert.equal(s.step({ type: 'run_started', platform: 'soomgo', jobId: 'soomgo-c1', at: at('12:00'), evidence: {} }).transitions[0].to, 'in_progress');
  const acc = s.step({ type: 'run_accepted', platform: 'soomgo', jobId: 'soomgo-c1', at: at('12:01'), evidence: { lastRun: { ok: true, at: at('12:01') }, minutes: 12, files: ['C:/w/site/index.html'], captures: [] } });
  assert.deepEqual(effectTypes(acc), ['plan_outbox:delivery', 'plan_outbox:pay_request']);
  assert.match(acc.effects[1].item.payload.text, /Balance$/);
  s.step(s.notices(t, [{ text: NOTICE.paid('150,000'), at: at('13:58') }])[0]);
  const del = s.step({ type: 'delivery_observed', platform: 'soomgo', jobId: 'soomgo-c1', threadId: t.id, at: at('14:00'), evidence: { outboxId: 4, files: 1 } });
  assert.deepEqual(del.transitions.map((x) => x.to), ['delivered']);
  const c1 = s.step(s.notices(t, [{ text: NOTICE.confirmed('300,000'), at: at('14:58') }])[0]);
  assert.deepEqual(c1.transitions, []);
  const c2 = s.step(s.notices(t, [{ text: NOTICE.confirmed('300,000'), at: at('15:03') }])[0]);
  assert.deepEqual(c2.transitions.map((x) => x.to), ['closed']);
  assert.deepEqual(effectTypes(c2), ['record_case:job_closed', 'sync_portfolio', 'notify']);
  assert.deepEqual(s.ledger.jobPayments('soomgo-c1').map((p) => p.kind), ['deposit', 'balance']);
  assert.equal(s.events('deal.refused').length, 0);
});

test('a hire on an outside quote, a row-status hire never quoted, and a hire cancelled unpaid or paid', () => {
  const s = setup();
  const t = s.thread('c2');
  s.step({ type: 'hired', platform: 'soomgo', threadId: t.id, at: at('10:00'), evidence: { text: NOTICE.hired, source: 'thread', rowQuote: { unit: 'total', priceKRW: 200000 } } });
  const job = s.ledger.listJobs()[0];
  assert.deepEqual([job.status, job.priceKRW, s.ledger.listQuotes({ status: 'accepted' }).length], ['ordered', 200000, 1]);
  const t3 = s.thread('c3');
  s.step({ type: 'hired', platform: 'soomgo', threadId: t3.id, at: at('10:00'), evidence: { text: 'chat status hired', source: 'row-status', freshHireInBatch: false } });
  const [hist] = s.ledger.listMoneyEvents({ threadId: t3.id });
  assert.deepEqual([hist.key.endsWith(':history'), hist.applied, s.ledger.listJobs().length], [true, false, 1]);
  const lost = s.step({ type: 'hire_cancelled', platform: 'soomgo', threadId: t.id, at: at('11:00'), evidence: { text: 'cancelled', source: 'thread' } });
  assert.deepEqual([lost.transitions[0].to, effectTypes(lost)[0]], ['lost', 'record_case:lead_lost']);
  const t4 = s.thread('c4');
  s.step(s.quoteSignal(t4));
  s.step(s.notices(t4, [{ text: NOTICE.hired, at: at('10:58') }])[0]);
  s.step(s.notices(t4, [{ text: NOTICE.paid('150,000'), at: at('11:58') }])[0]);
  const kept = s.step({ type: 'hire_cancelled', platform: 'soomgo', threadId: t4.id, at: at('12:30'), evidence: { text: 'cancelled', source: 'thread' } });
  assert.deepEqual(kept.transitions, []);
  assert.match(s.ledger.listMoneyEvents({ threadId: t4.id, event: 'hire_cancelled' })[0].note, /keeps its payments/);
});

test('a kmong order with an amount writes a full escrow payment and starts the run; an unpaid order cancelled is lost', () => {
  const s = setup({ platform: 'kmong' });
  const t = s.thread('k1');
  s.step(s.quoteSignal(t));
  const r = s.step({ type: 'ordered', platform: 'kmong', threadId: t.id, at: at('11:00'), amountKRW: 300000, evidence: { text: '주문이 접수되었습니다', source: 'thread' } });
  assert.deepEqual([r.transitions[0].to, effectTypes(r)[0]], ['ordered', 'start_run']);
  const [p] = s.ledger.jobPayments('kmong-k1');
  assert.deepEqual([p.kind, p.amountKRW, p.channel], ['full', 300000, 'kmong']);
  const t2 = s.thread('k2');
  s.step(s.quoteSignal(t2));
  s.step({ type: 'ordered', platform: 'kmong', threadId: t2.id, at: at('11:00'), evidence: { text: '주문이 접수되었습니다', source: 'thread' } });
  const c = s.step({ type: 'order_cancelled', platform: 'kmong', threadId: t2.id, at: at('11:30'), evidence: { text: '주문이 취소되었습니다', source: 'thread' } });
  assert.equal(c.transitions[0].to, 'lost');
});

test('expired on a quoted job is lost with lead_lost; expired on an ordered job is refused', () => {
  const s = setup();
  const t = s.thread('r1', 'request');
  s.step(s.quoteSignal(t));
  const r = s.step({ type: 'expired', platform: 'soomgo', threadId: t.id, at: at('12:00'), evidence: {} });
  assert.deepEqual([r.transitions[0].to, effectTypes(r)], ['lost', ['record_case:lead_lost']]);
  assert.equal(s.ledger.listQuotes()[0].status, 'expired');
  const t2 = s.thread('c9');
  s.step({ type: 'hired', platform: 'soomgo', threadId: t2.id, at: at('10:00'), evidence: { text: NOTICE.hired, source: 'thread', rowQuote: { unit: 'total', priceKRW: 100000 } } });
  assert.deepEqual(s.step({ type: 'expired', platform: 'soomgo', threadId: t2.id, at: at('12:00'), evidence: {} }).transitions, []);
  assert.equal(s.events('deal.refused').at(-1).reason, 'only a quoted job expires');
});

function delivered(s) {
  const t = s.thread('c1');
  s.step(s.quoteSignal(t));
  s.step(s.notices(t, [{ text: NOTICE.hired, at: at('10:58') }])[0]);
  s.step(s.notices(t, [{ text: NOTICE.paid('150,000'), at: at('11:58') }])[0]);
  s.step({ type: 'run_started', platform: 'soomgo', jobId: 'soomgo-c1', at: at('12:00'), evidence: {} });
  s.step({ type: 'delivery_observed', platform: 'soomgo', jobId: 'soomgo-c1', at: at('13:00'), evidence: {} });
  return t;
}

test('revision round 1 reopens with start_run and a case; a duplicate changes nothing; an extra round goes to the operator', () => {
  const s = setup();
  const t = delivered(s);
  const r1 = s.step({ type: 'revision_requested', platform: 'soomgo', threadId: t.id, jobId: 'soomgo-c1', at: at('14:00'), evidence: { text: '색을 바꿔 주세요' } });
  assert.deepEqual([r1.transitions[0].to, effectTypes(r1)], ['revision', ['record_case:revision_request', 'start_run']]);
  s.step({ type: 'run_started', platform: 'soomgo', jobId: 'soomgo-c1', at: at('14:10'), evidence: {} });
  s.step({ type: 'delivery_observed', platform: 'soomgo', jobId: 'soomgo-c1', at: at('14:30'), evidence: {} });
  const dup = s.step({ type: 'revision_requested', platform: 'soomgo', threadId: t.id, jobId: 'soomgo-c1', at: at('14:40'), evidence: { text: '색을 바꿔 주세요' } });
  assert.deepEqual([dup.transitions, dup.effects], [[], []]);
  assert.equal(s.events('deal.revision_duplicate').length, 1);
  const extra = s.step({ type: 'revision_requested', platform: 'soomgo', threadId: t.id, jobId: 'soomgo-c1', at: at('14:50'), evidence: { text: '글꼴도 바꿔 주세요' } });
  assert.deepEqual([extra.transitions, effectTypes(extra)], [[], ['record_case:revision_request', 'notify']]);
});

test('a parsed review read on two ticks is one review, keyed by its evidence key; an operator entry keeps the minute key', () => {
  const s = setup();
  delivered(s);
  const parsed = (hm) => s.step({ type: 'review', platform: 'soomgo', jobId: 'soomgo-c1', at: at(hm), evidence: { key: 'soomgo:review:r1', rating: 5, text: '좋았어요', liked: null, source: 'review-row' } });
  assert.deepEqual(effectTypes(parsed('14:00')), ['sync_portfolio', 'record_case:review', 'notify']);
  assert.deepEqual(parsed('14:05').effects, []);
  const reviews = () => s.ledger.db.prepare("SELECT count(*) AS n FROM reviews WHERE job_id = 'soomgo-c1'").get().n;
  assert.equal(reviews(), 1);
  assert.deepEqual(s.ledger.listMoneyEvents({ event: 'review' }).map((e) => e.key), ['soomgo:review:r1']);
  s.step({ type: 'review', platform: 'soomgo', jobId: 'soomgo-c1', at: at('14:10'), evidence: { source: 'operator', rating: 4, text: 'operator recorded a 4 star review', liked: null } });
  assert.equal(reviews(), 2);
  assert.match(s.ledger.listMoneyEvents({ event: 'review' }).at(-1).key, /^soomgo:c1:review:\d{4}-/);
});

test('permission granted on a delivered job syncs the portfolio; a refusal on a job never delivered is refused', () => {
  const s = setup();
  delivered(s);
  const g = s.step({ type: 'permission_granted', platform: 'soomgo', jobId: 'soomgo-c1', at: at('15:00'), evidence: { source: 'operator' } });
  assert.deepEqual(effectTypes(g), ['sync_portfolio']);
  assert.equal(s.ledger.getJob('soomgo-c1').meta.portfolio.permission, 'granted');
  const t2 = s.thread('c2');
  s.step({ type: 'hired', platform: 'soomgo', threadId: t2.id, at: at('10:00'), evidence: { text: NOTICE.hired, source: 'thread', rowQuote: { unit: 'total', priceKRW: 100000 } } });
  const refused = s.step({ type: 'permission_refused', platform: 'soomgo', threadId: t2.id, at: at('15:00'), evidence: {} });
  assert.deepEqual(refused.effects, []);
  assert.equal(s.events('deal.refused').at(-1).reason, 'a portfolio refusal needs a job that was delivered');
});

test('a grant keeps the customer quote and its source on the portfolio meta; a refusal is denied and ranks no item', () => {
  const s = setup();
  delivered(s);
  s.step({ type: 'permission_granted', platform: 'soomgo', jobId: 'soomgo-c1', at: at('15:00'), evidence: { quote: '네, 올리셔도 됩니다.', quoteAt: at('14:30'), source: 'brain' } });
  const granted = s.ledger.getJob('soomgo-c1');
  assert.deepEqual(granted.meta.portfolio, { ...granted.meta.portfolio, permission: 'granted', quote: '네, 올리셔도 됩니다.', quoteAt: at('14:30'), source: 'brain', answeredAt: at('15:00') });
  const item = (job) => itemFromJob({ job, payments: s.ledger.jobPayments(job.id) });
  assert.equal(rankPortfolio([item(granted)]).length, 1);
  s.step({ type: 'permission_refused', platform: 'soomgo', jobId: 'soomgo-c1', at: at('15:10'), evidence: { quote: null, source: 'brain' } });
  const refused = s.ledger.getJob('soomgo-c1');
  assert.deepEqual([refused.meta.portfolio.permission, refused.meta.portfolio.quote, refused.meta.portfolio.source], ['denied', null, 'brain']);
  assert.deepEqual(rankPortfolio([item(refused)]), []);
});

test('a delivery tells the operator which fsw deal verbs record the client portfolio answer and review', () => {
  const s = setup();
  const t = s.thread('c1');
  s.step(s.quoteSignal(t));
  s.step(s.notices(t, [{ text: NOTICE.hired, at: at('10:58') }])[0]);
  s.step(s.notices(t, [{ text: NOTICE.paid('150,000'), at: at('11:58') }])[0]);
  s.step({ type: 'run_started', platform: 'soomgo', jobId: 'soomgo-c1', at: at('12:00'), evidence: {} });
  const del = s.step({ type: 'delivery_observed', platform: 'soomgo', jobId: 'soomgo-c1', at: at('13:00'), evidence: {} });
  const notes = del.effects.filter((e) => e.type === 'notify').map((e) => e.note);
  assert.deepEqual(notes.map((n) => n.dedupeKey), ['portfolio-answer:soomgo-c1']);
  assert.match(notes[0].body, /fsw deal soomgo-c1 permission granted \(or denied\)/);
  assert.match(notes[0].body, /fsw deal soomgo-c1 review --rating <1-5>/);
});

test('delivery_observed on an ordered job is refused with a deal.refused event, and an unknown signal throws', () => {
  const s = setup();
  const t = s.thread('c2');
  s.step({ type: 'hired', platform: 'soomgo', threadId: t.id, at: at('10:00'), evidence: { text: NOTICE.hired, source: 'thread', rowQuote: { unit: 'total', priceKRW: 100000 } } });
  const r = s.step({ type: 'delivery_observed', platform: 'soomgo', threadId: t.id, at: at('11:00'), evidence: {} });
  assert.deepEqual([r.transitions, r.effects], [[], []]);
  assert.equal(s.events('deal.refused').length, 1);
  assert.throws(() => s.step({ type: 'teleported', platform: 'soomgo', threadId: t.id }), { code: 'FSW_DEAL_SIGNAL' });
  assert.throws(() => s.step({ type: 'paid', threadId: t.id }), { code: 'FSW_DEAL_SIGNAL' });
});

test('sweep re-derives a lost deposit request and a lost delivery, and planning them twice inserts once', () => {
  const s = setup();
  const t = s.thread('c1');
  s.step(s.quoteSignal(t));
  s.step(s.notices(t, [{ text: NOTICE.hired, at: at('10:58') }])[0]);
  const first = sweep(s.ledger, { instance: s.instance });
  assert.deepEqual(first.map((e) => e.item.kind), ['pay_request']);
  assert.equal(plan(s.ledger, first[0].item).inserted, true);
  assert.equal(plan(s.ledger, sweep(s.ledger, { instance: s.instance })[0].item).inserted, false);
  s.step(s.notices(t, [{ text: NOTICE.paid('150,000'), at: at('11:58') }])[0]);
  s.step({ type: 'run_started', platform: 'soomgo', jobId: 'soomgo-c1', at: at('12:00'), evidence: {} });
  s.step({ type: 'run_accepted', platform: 'soomgo', jobId: 'soomgo-c1', at: at('12:01'), evidence: { lastRun: { ok: true, at: at('12:01') }, files: ['C:/w/site/index.html'] } });
  const again = sweep(s.ledger, { instance: s.instance });
  assert.deepEqual(again.map((e) => e.item.kind), ['delivery', 'pay_request']);
  assert.deepEqual(again.map((e) => plan(s.ledger, e.item).inserted), [true, true]);
  assert.deepEqual(sweep(s.ledger, { instance: s.instance }).map((e) => plan(s.ledger, e.item).inserted), [false, false]);
});

test('a throw inside a rule rolls the whole signal back', () => {
  const s = setup();
  const t = s.thread('c1');
  const real = s.ledger.addQuote;
  s.ledger.addQuote = () => {
    throw new Error('disk full');
  };
  assert.throws(() => s.step({ type: 'hired', platform: 'soomgo', threadId: t.id, at: at('10:00'), evidence: { text: NOTICE.hired, source: 'thread' } }), /disk full/);
  s.ledger.addQuote = real;
  assert.deepEqual([s.ledger.listJobs().length, s.ledger.listMoneyEvents().length, s.events('deal.transition').length], [0, 0, 0]);
});

test('a paid job the operator delivers starts no run: the deposit hands it over with close_outbox before the balance item', () => {
  const s = setup({ edit: LESSONS });
  const t = s.thread('l1');
  s.step(s.quoteSignal(t, 100000, 'lesson_tutoring'));
  s.step(s.notices(t, [{ text: NOTICE.hired, at: at('10:58') }], { service: '프로그래밍/코딩 레슨' })[0]);
  const r = s.step(s.notices(t, [{ text: NOTICE.paid('50,000'), at: at('11:58') }])[0]);
  assert.deepEqual(r.transitions.map((x) => x.to), ['in_progress']);
  assert.deepEqual(effectTypes(r), ['close_outbox', 'plan_outbox:pay_request', 'notify']);
  assert.deepEqual([r.effects[0].kind, r.effects[0].jobId], ['pay_request', 'soomgo-l1']);
  assert.match(r.effects[1].item.payload.reason, /schedule the sessions/);
  assert.equal(r.effects[1].item.payload.rest, true);
  assert.ok(s.ledger.getJob('soomgo-l1').meta.operator.handedOverAt);
  assert.equal(sweep(s.ledger, { instance: s.instance }).filter((e) => /schedule the sessions/.test(e.item.payload.reason)).length, 1);
  s.step(s.notices(t, [{ text: NOTICE.paid('50,000'), at: at('13:58') }])[0]);
  s.step(s.notices(t, [{ text: NOTICE.confirmed('50,000'), at: at('14:00') }])[0]);
  const c = s.step(s.notices(t, [{ text: NOTICE.confirmed('50,000'), at: at('14:10') }])[0]);
  assert.deepEqual(c.transitions.map((x) => [x.from, x.to]), [['in_progress', 'closed']]);
  const job = s.ledger.getJob('soomgo-l1');
  assert.equal(job.deliveredAt, job.closedAt);
  assert.ok(effectTypes(c).includes('record_case:job_closed'));
});

test('where no balance request applies, the handover is a plain notice to the operator', () => {
  const s = setup({ platform: 'kmong', edit: (c) => ({ ...c, platforms: { ...c.platforms, kmong: { ...c.platforms.kmong, services: ['lesson_tutoring'] } } }) });
  const t = s.thread('k7');
  s.step(s.quoteSignal(t, 100000, 'lesson_tutoring'));
  s.step({ type: 'ordered', platform: 'kmong', threadId: t.id, at: at('10:00'), evidence: { text: '주문이 접수되었습니다', source: 'thread' } });
  const r = s.step({ type: 'paid', platform: 'kmong', threadId: t.id, at: at('11:00'), amountKRW: 100000, evidence: { text: 'paid', source: 'thread' } });
  assert.deepEqual(effectTypes(r), ['close_outbox', 'notify', 'notify']);
  assert.equal(r.effects[1].note.dedupeKey, 'handover:kmong-k7');
  assert.ok(!effectTypes(r).some((e) => e.startsWith('plan_outbox')));
});

test('a lesson hire on an instance that does not answer lessons stays the operator own deal', () => {
  const s = setup();
  const t = s.thread('l2');
  const r = s.step(s.notices(t, [{ text: NOTICE.hired, at: at('10:00') }], { service: '프로그래밍/코딩 레슨' })[0]);
  const [job] = s.ledger.listJobs();
  assert.equal(job.service, 'lesson_tutoring');
  assert.match(job.meta.manual, /lesson_tutoring is not answered on soomgo/);
  assert.ok(!effectTypes(r).some((e) => e.startsWith('plan_outbox')));
});
