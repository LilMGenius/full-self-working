import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { authorize, budgetSpent, cashBudgetCheck, isHeld, operatingMode } from '../src/policy/authorize.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-authz-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms.soomgo = { ...config.platforms.soomgo, mode: 'auto', maxQuotesPerDay: 5, maxCashPerDay: 5000 };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}
const kmong = loadDescriptor('kmong');
const soomgo = loadDescriptor('soomgo');
const NOON = new Date('2026-10-20T12:00:00+09:00');
const TEXT = '요청하신 구성으로 진행 가능합니다. 원하시는 일정을 알려 주세요.';
const decision = (over = {}) => ({ intent: 'inquiry', service: 'landing_page_web', language: 'ko', reply: TEXT, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null, ...over });
const message = (over = {}) => ({ platform: 'kmong', kind: 'message', text: TEXT, amountKRW: undefined, costKRW: 0, serviceLabel: null, attachments: [], thread: { kind: 'message', stage: 'pre_order', lastInboundText: '랜딩 페이지 가능한가요?', recentOutbound: [] }, decision: decision(), ...over });
const ROW = { platform: 'soomgo', service: 'landing_page_web', baseKRW: 300000, floorKRW: 100000, ceilingKRW: 1000000, costFloorKRW: 50000, viable: true };
const quote = (over = {}) => message({ platform: 'soomgo', kind: 'quote', amountKRW: 300000, costKRW: 990, serviceLabel: '웹 개발', thread: { kind: 'request', stage: 'pre_order', lastInboundText: '웹 개발 견적 부탁드립니다', recentOutbound: [] }, decision: decision({ intent: 'quote_request' }), ...over });
const ctx = (instance, over = {}) => ({ descriptor: kmong, instance, mode: 'auto', now: NOON, ...over });
const sctx = (instance, over = {}) => ctx(instance, { descriptor: soomgo, priceRow: ROW, ...over });
const rules = (v) => v.reasons.map((r) => r.rule);

test('a clean auto message is sent with no reason', () => {
  const v = authorize(message(), ctx(makeInstance()));
  assert.deepEqual([v.verdict, v.reasons], ['send', []]);
});

test('each operator rule sends the item to the operator and names its rule', () => {
  const i = makeInstance();
  const cases = [
    ['mode.draft', message(), { mode: 'draft' }],
    ['decision.operator', message({ decision: decision({ needsOperator: true, operatorReason: 'refund question' }) }), {}],
    ['decision.unsupported', message({ decision: decision({ intent: 'unsupported' }) }), {}],
    ['decision.label', quote({ decision: decision({ intent: 'quote_request', service: 'logo_brand' }) }), { descriptor: soomgo, priceRow: ROW }],
    ['decision.stage', message({ thread: { kind: 'message', stage: 'quote_accepted', lastInboundText: '네 진행할게요', recentOutbound: [] } }), {}],
    ['decision.confidence', message({ decision: decision({ confidence: 0.5 }) }), {}],
    ['price.row', quote(), { descriptor: soomgo, priceRow: null }],
    ['price.row', quote(), { descriptor: soomgo, priceRow: { ...ROW, viable: false } }],
    ['kind.operator_only', message({ kind: 'pay_request', text: '', amountKRW: 150000 }), {}],
    ['kind.operator_only', message({ kind: 'delivery', attachments: ['index.html'] }), {}],
    ['gate.blocked', message({ text: '편하게 010-1234-5678 로 전화 주세요.' }), {}],
  ];
  for (const [name, item, over] of cases) {
    const v = authorize(item, ctx(i, over));
    assert.equal(v.verdict, 'operator', name);
    assert.ok(rules(v).includes(name), name + ' not in ' + rules(v).join(', '));
  }
  const big = authorize(message({ kind: 'delivery', attachments: Array.from({ length: 11 }, (_, n) => 'f' + n + '.png') }), ctx(i));
  assert.ok(big.violations.some((v) => v.rule === 'shape.attachments'));
});

test('the confidence floor is minAutoConfidence: 0.69 asks the operator and 0.7 passes', () => {
  const i = makeInstance();
  assert.ok(rules(authorize(message({ decision: decision({ confidence: 0.69 }) }), ctx(i))).includes('decision.confidence'));
  assert.equal(authorize(message({ decision: decision({ confidence: 0.7 }) }), ctx(i)).verdict, 'send');
});

test('an approved text that fails the gate is refused, and an approval answers the decision rules', () => {
  const i = makeInstance();
  const v = authorize(message({ text: '편하게 010-1234-5678 로 전화 주세요.' }), ctx(i, { approved: true }));
  assert.equal(v.verdict, 'refuse');
  assert.ok(v.violations.some((x) => x.rule === 'contact.phone'));
  assert.equal(authorize(message({ decision: decision({ needsOperator: true, confidence: 0.1 }) }), ctx(i, { approved: true, mode: 'draft' })).verdict, 'send');
});

test('a missing pipeline config throws before anything is sent', () => {
  const i = makeInstance((c) => ({ ...c, pipeline: undefined }));
  assert.throws(() => authorize(message(), ctx(i)), { code: 'FSW_CONFIG_MISSING' });
});

test('cash caps: an approved quote over budget waits, one inside it sends, an unknown cost or no budget asks the operator', () => {
  const i = makeInstance();
  const over = { quotes: 1, cashKRW: 4500 };
  const approved = authorize(quote(), sctx(i, { approved: true, usage: over }));
  assert.equal(approved.verdict, 'send');
  assert.ok(isHeld(approved));
  assert.ok(rules(approved).includes('budget.cash'));
  assert.equal(authorize(quote(), sctx(i, { usage: { quotes: 1, cashKRW: 1000 } })).verdict, 'send');
  const unknown = authorize(quote({ costKRW: null }), sctx(i));
  assert.equal(unknown.verdict, 'operator');
  assert.match(unknown.reasons.find((r) => r.rule === 'budget.unpayable').detail, /the quote cost was not read from the page/);
  // An approval does not make an unknown cost payable.
  assert.equal(authorize(quote({ costKRW: null }), sctx(i, { approved: true })).verdict, 'operator');
  const none = makeInstance((c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, maxCashPerDay: undefined } } }));
  const nob = authorize(quote(), sctx(none));
  assert.equal(nob.verdict, 'operator');
  assert.match(nob.reasons.find((r) => r.rule === 'budget.unpayable').detail, /no cash budget configured/);
});

test('a quote refused only by the daily caps is held for a later day with nobody asked, and one no day can pay asks the operator', () => {
  const i = makeInstance();
  const spent = authorize(quote(), sctx(i, { usage: { quotes: 1, cashKRW: 4500 } }));
  assert.equal(spent.verdict, 'send');
  assert.ok(isHeld(spent));
  assert.deepEqual(rules(spent), ['budget.cash']);
  assert.equal(authorize(quote(), sctx(i, { usage: { quotes: 5, cashKRW: 0 } })).verdict, 'send');
  const tooDear = authorize(quote({ costKRW: 6000 }), sctx(i));
  assert.equal(tooDear.verdict, 'operator');
  assert.deepEqual([budgetSpent({ maxQuotesPerDay: 5, maxCashPerDay: 5000 }, { quotes: 5, cashKRW: 0 }), budgetSpent({ maxQuotesPerDay: 5, maxCashPerDay: 5000 }, { quotes: 1, cashKRW: 4999 }), budgetSpent({}, { quotes: 9, cashKRW: 9 })], [true, false, false]);
  assert.equal(cashBudgetCheck({ budget: { maxQuotesPerDay: 5, maxCashPerDay: 5000 }, usage: { quotes: 0, cashKRW: 4500 }, costKRW: 990 }).spent, true);
});

test('a quote for a service the instance stopped answering waits for the operator, and an approved one still goes', () => {
  const off = makeInstance((c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, services: ['web_app_dev'] } } }));
  const v = authorize(quote(), sctx(off));
  assert.equal(v.verdict, 'operator');
  assert.ok(rules(v).includes('decision.answered'));
  assert.equal(authorize(quote(), sctx(off, { approved: true })).verdict, 'send');
});

test('a stated budget under the cost floor asks the operator; at the floor or approved it does not', () => {
  const i = makeInstance();
  const low = authorize(quote({ decision: decision({ intent: 'quote_request', statedBudgetKRW: 30000 }) }), sctx(i, { priceRow: { ...ROW, costFloorKRW: 300000 } }));
  assert.equal(low.verdict, 'operator');
  assert.ok(rules(low).includes('budget.below_floor'));
  assert.ok(!rules(authorize(quote({ decision: decision({ intent: 'quote_request', statedBudgetKRW: 300000 }) }), sctx(i, { priceRow: { ...ROW, costFloorKRW: 300000 } }))).includes('budget.below_floor'));
  assert.ok(!rules(authorize(quote({ decision: decision({ intent: 'quote_request', statedBudgetKRW: 30000 }) }), sctx(i, { priceRow: { ...ROW, costFloorKRW: 300000 }, approved: true }))).includes('budget.below_floor'));
});

test('observe mode and closed hours hold a send without asking the operator', () => {
  const i = makeInstance();
  const obs = authorize(message(), ctx(i, { mode: 'observe' }));
  assert.ok(isHeld(obs));
  assert.ok(rules(obs).includes('mode.observe'));
  const early = authorize(message(), ctx(i, { approved: true, now: new Date('2026-10-20T07:30:00+09:00') }));
  assert.ok(isHeld(early));
  assert.ok(rules(early).includes('hours.closed'));
});

test('operatingMode lowers auto to observe outside the outbound hours and authorize reads the same predicate', () => {
  const i = makeInstance();
  const before = new Date('2026-10-20T07:59:00+09:00');
  const at = new Date('2026-10-20T08:00:00+09:00');
  assert.deepEqual(operatingMode('auto', { now: before, instance: i }), { mode: 'observe', hoursOpen: false });
  assert.deepEqual(operatingMode('auto', { now: at, instance: i }), { mode: 'auto', hoursOpen: true });
  assert.deepEqual(operatingMode('draft', { now: before, instance: i }), { mode: 'draft', hoursOpen: false });
  assert.equal(operatingMode('auto', { forceMode: 'observe', now: at, instance: i }).mode, 'observe');
  assert.equal(operatingMode('draft', { forceMode: 'observe', now: at, instance: i }).mode, 'observe');
  assert.equal(operatingMode('draft', { forceMode: 'auto', now: at, instance: i }).mode, 'draft');
  assert.throws(() => operatingMode('auto', { forceMode: 'loud', now: at, instance: i }), RangeError);
  for (const now of [before, at]) {
    const held = rules(authorize(message(), ctx(i, { approved: true, now }))).includes('hours.closed');
    assert.equal(held, !operatingMode('auto', { now, instance: i }).hoursOpen);
  }
});
