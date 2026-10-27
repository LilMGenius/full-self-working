// wp8: which outbound kinds a platform's surface has mapped (descriptor forms), the kinds a person confirms
// before every send (automation.sendRequiresOperator), and the rules triage and authorize read from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { pipelineSettings } from '../src/core/settings.mjs';
import { answeredServices, parkKey } from '../src/economics/catalog.mjs';
import { itemOf } from '../src/outbox/drain.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { BID_BUDGET_DEFAULT, authorize, bidBudgetCheck } from '../src/policy/authorize.mjs';
import { triage } from '../src/triage/index.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-forms-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms.soomgo = { ...config.platforms.soomgo, mode: 'auto', maxQuotesPerDay: 5, maxCashPerDay: 5000 };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}
const NOON = new Date('2026-10-20T12:00:00+09:00');
const KO = '요청하신 구성으로 진행 가능합니다. 원하시는 일정을 알려 주세요.';
const EN = 'I can build this with the layout you described. Let me know the schedule you have in mind.';
const decision = (over = {}) => ({ intent: 'quote_request', service: 'landing_page_web', language: 'ko', reply: KO, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null, ...over });
const ROW = { service: 'landing_page_web', baseKRW: 300000, floorKRW: 100000, ceilingKRW: 1000000, costFloorKRW: 50000, viable: true };
const rules = (v) => v.reasons.map((r) => r.rule);
const ctx = (instance, descriptor, over = {}) => ({ descriptor, instance, mode: 'auto', now: NOON, ...over });

// The item the drain builds from an outbox row (itemOf), so these verdicts are the ones the drain sees.
const proposalRow = (platform, payload = {}) => ({ platform, kind: 'proposal', payload: { text: EN, amountKRW: 300000, thread: { kind: 'request', stage: 'pre_order' }, decision: decision({ language: 'en', reply: EN }), ...payload } });
// kmong's enterprise proposal as planProposal plans it (src/projects/job.mjs): no costKRW, a project thread,
// a decision with no quote, auto when needsOperator is false.
const kmongProposal = () => ({ platform: 'kmong', kind: 'proposal', payload: { text: KO, amountKRW: 1500000, service: 'landing_page_web', thread: { kind: 'project', stage: 'pre_order' }, decision: { intent: 'quote_request', service: 'landing_page_web', language: 'ko', reply: KO, quote: null, needsOperator: false, operatorReason: null, confidence: 1, claimsUsed: [] }, proposal: { totalKRW: 1500000, phases: [], floorKRW: 1000000 } } });

test('a request on a board whose proposal form is unmapped is observed with reason form unmapped, and a mapped quote form still opens', () => {
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  const req = { kind: 'request', ref: 'p1', unread: true, at: new Date(NOON.getTime() - 3_600_000).toISOString(), service: null };
  for (const id of ['freelancer', 'upwork', 'wishket']) {
    const descriptor = loadDescriptor(id);
    const t = triage(req, null, { mode: 'auto', now: NOON, descriptor, settings: { ...pipelineSettings(config), answered: answeredServices(config, id) }, parkKey: parkKey(config, descriptor) });
    assert.deepEqual(t, { action: 'observe', reason: 'form unmapped' }, id);
  }
  const soomgo = loadDescriptor('soomgo');
  const open = triage(req, null, { mode: 'auto', now: NOON, descriptor: soomgo, settings: { ...pipelineSettings(config), answered: answeredServices(config, 'soomgo') }, parkKey: parkKey(config, soomgo) });
  assert.equal(open.action, 'open');
  // A chat on a board is not a request: its form decides nothing in triage.
  const chat = triage({ ...req, kind: 'message' }, null, { mode: 'auto', now: NOON, descriptor: loadDescriptor('freelancer'), settings: { ...pipelineSettings(config), answered: answeredServices(config, 'freelancer') }, parkKey: parkKey(config, loadDescriptor('freelancer')) });
  assert.notEqual(chat.reason, 'form unmapped');
});

test('a kind listed unmapped is refused by form.unmapped, approved or not', () => {
  const i = makeInstance();
  for (const approved of [false, true]) {
    const v = authorize(itemOf(proposalRow('freelancer')), ctx(i, loadDescriptor('freelancer'), { approved, priceRow: ROW }));
    assert.equal(v.verdict, 'refuse');
    assert.deepEqual(v.violations.map((x) => x.rule), ['form.unmapped']);
    assert.deepEqual(rules(v), ['form.unmapped']);
  }
  const msg = authorize({ ...itemOf(proposalRow('wishket')), kind: 'message', thread: { kind: 'message', stage: 'pre_order' } }, ctx(i, loadDescriptor('wishket'), { approved: true }));
  assert.deepEqual([msg.verdict, rules(msg)], ['refuse', ['form.unmapped']]);
});

test('upwork asks a person before every proposal once its form is mapped, and an approval answers it', () => {
  // A Connects budget with room, so the bid budget lets the proposal through and only the operator rule speaks.
  const i = makeInstance((c) => ({ ...c, platforms: { ...c.platforms, upwork: { ...c.platforms.upwork, enabled: true, mode: 'auto', bidBudget: { monthlyKRW: 10000, stopAfterUnanswered: 20 } } } }));
  const usage = { bidMonthKRW: 0, bidUnanswered: 0 };
  const real = loadDescriptor('upwork');
  assert.deepEqual(real.automation.sendRequiresOperator, ['proposal', 'message']);
  const upwork = structuredClone(real);
  upwork.forms.proposal = { mapped: true, mappedAt: '2026-10-28T00:00:00Z', recording: 'test fixture', readBack: true };
  const asked = authorize(itemOf(proposalRow('upwork', { costKRW: 2160 })), ctx(i, upwork, { priceRow: ROW, usage }));
  assert.equal(asked.verdict, 'operator');
  assert.ok(rules(asked).includes('automation.operator'), rules(asked).join(', '));
  const approved = authorize(itemOf(proposalRow('upwork', { costKRW: 2160 })), ctx(i, upwork, { approved: true, priceRow: ROW, usage }));
  assert.ok(!rules(approved).includes('automation.operator'));
});

test('the kinds the live line sends keep verdict send: a kmong proposal, a soomgo quote and a clean kmong message', () => {
  const i = makeInstance();
  const kmong = loadDescriptor('kmong');
  const soomgo = loadDescriptor('soomgo');
  for (const approved of [true, false]) {
    const p = authorize(itemOf(kmongProposal()), ctx(i, kmong, { approved }));
    assert.deepEqual([p.verdict, rules(p)], ['send', []], 'kmong proposal approved=' + approved);
  }
  const quote = { platform: 'soomgo', kind: 'quote', text: KO, amountKRW: 300000, costKRW: 990, serviceLabel: '웹 개발', attachments: [], thread: { kind: 'request', stage: 'pre_order', lastInboundText: '웹 개발 견적 부탁드립니다', recentOutbound: [] }, decision: decision() };
  const q = authorize(quote, ctx(i, soomgo, { approved: true, priceRow: { ...ROW, platform: 'soomgo' }, usage: { quotes: 0, cashKRW: 0 } }));
  assert.deepEqual([q.verdict, rules(q)], ['send', []]);
  const message = { platform: 'kmong', kind: 'message', text: KO, costKRW: 0, serviceLabel: null, attachments: [], thread: { kind: 'message', stage: 'pre_order', lastInboundText: '랜딩 페이지 가능한가요?', recentOutbound: [] }, decision: decision({ intent: 'inquiry' }) };
  const m = authorize(message, ctx(i, kmong));
  assert.deepEqual([m.verdict, rules(m)], ['send', []]);
});

// freelancer with its proposal form mapped, as order 5 of wp8 maps it from the bid form's recording.
const mappedFreelancer = () => {
  const d = structuredClone(loadDescriptor('freelancer'));
  d.forms.proposal = { mapped: true, mappedAt: '2026-10-28T00:00:00Z', recording: 'test fixture', readBack: true };
  return d;
};
const withBidBudget = (bidBudget) => makeInstance((c) => ({ ...c, platforms: { ...c.platforms, freelancer: { ...c.platforms.freelancer, enabled: true, mode: 'auto', ...(bidBudget ? { bidBudget } : {}) } } }));
const bidItem = (costKRW) => itemOf(proposalRow('freelancer', { costKRW }));

test('the default bid budget refuses a priced bid and passes a free one; the month and unanswered limits hold', () => {
  assert.deepEqual(BID_BUDGET_DEFAULT, { monthlyKRW: 0, stopAfterUnanswered: 20 });
  const fresh = { bidMonthKRW: 0, bidUnanswered: 0 };
  const priced = authorize(bidItem(2700), ctx(withBidBudget(), mappedFreelancer(), { usage: fresh, approved: true }));
  assert.deepEqual([priced.verdict, rules(priced)], ['refuse', ['budget.bid']]);
  assert.match(priced.violations[0].detail, /spends bids: the month's bid budget is spent \(0 \+ 2700 over 0 KRW\)/);
  const free = authorize(bidItem(0), ctx(withBidBudget(), mappedFreelancer(), { usage: fresh, approved: true }));
  assert.ok(!rules(free).includes('budget.bid'), rules(free).join(', '));
  const budget = { monthlyKRW: 5000, stopAfterUnanswered: 3 };
  assert.deepEqual(bidBudgetCheck({ budget, usage: { bidMonthKRW: 2300, bidUnanswered: 0 }, costKRW: 2700 }), { ok: true });
  assert.match(bidBudgetCheck({ budget, usage: { bidMonthKRW: 2301, bidUnanswered: 0 }, costKRW: 2700 }).reason, /bid budget is spent \(2301 \+ 2700 over 5000 KRW\)/);
  assert.deepEqual(bidBudgetCheck({ budget, usage: { bidMonthKRW: 0, bidUnanswered: 2 }, costKRW: 0 }), { ok: true });
  assert.match(bidBudgetCheck({ budget, usage: { bidMonthKRW: 0, bidUnanswered: 3 }, costKRW: 0 }).reason, /3 sent proposals have no reply; bids stop at 3/);
  const capped = authorize(bidItem(1000), ctx(withBidBudget(budget), mappedFreelancer(), { usage: { bidMonthKRW: 0, bidUnanswered: 3 }, approved: true }));
  assert.deepEqual([capped.verdict, rules(capped)], ['refuse', ['budget.bid']]);
});

test('an unknown bid cost or uncounted bid usage refuses the bid, and a platform with free proposals is never counted', () => {
  const i = withBidBudget({ monthlyKRW: 100000, stopAfterUnanswered: 20 });
  const unknown = authorize(bidItem(null), ctx(i, mappedFreelancer(), { usage: { bidMonthKRW: 0, bidUnanswered: 0 }, approved: true }));
  assert.deepEqual([unknown.verdict, unknown.reasons[0].detail], ['refuse', 'the bid cost in KRW is unknown']);
  const uncounted = authorize(bidItem(0), ctx(i, mappedFreelancer(), { approved: true }));
  assert.deepEqual([uncounted.verdict, uncounted.reasons[0].detail], ['refuse', 'the bid usage was not counted']);
  // kmong's bidCost.unit is none: its proposals carry no costKRW and never meet the bid budget.
  const k = authorize(itemOf(kmongProposal()), ctx(makeInstance(), loadDescriptor('kmong'), { approved: true }));
  assert.deepEqual([k.verdict, rules(k)], ['send', []]);
});

// U8.11 of wp8: a proposal answering a buyer request is priced by code, so it meets the price rules a quote meets.
const pricedProposal = (over = {}) => itemOf(proposalRow('freelancer', { costKRW: 0, amount: 343, currency: 'USD', decision: decision({ language: 'en', reply: EN, quote: { amountKRW: 480000, scope: ['landing page'], deliveryDays: 7, priceType: 'fixed', complexity: 1.2 }, ...over }) }));
const FREE_BIDS = { bidMonthKRW: 0, bidUnanswered: 0 };

test('a code-priced freelancer proposal meets price.row and budget.below_floor, and kmong enterprise proposals keep send', () => {
  const i = withBidBudget();
  const noRow = authorize(pricedProposal(), ctx(i, mappedFreelancer(), { usage: FREE_BIDS, priceRow: null }));
  assert.equal(noRow.verdict, 'operator');
  assert.deepEqual(noRow.reasons.find((r) => r.rule === 'price.row').detail, 'proposal without a viable price row for landing_page_web');
  assert.ok(rules(authorize(pricedProposal(), ctx(i, mappedFreelancer(), { usage: FREE_BIDS, priceRow: { ...ROW, viable: false } }))).includes('price.row'));
  const low = authorize(pricedProposal({ statedBudgetKRW: 30000 }), ctx(i, mappedFreelancer(), { usage: FREE_BIDS, priceRow: { ...ROW, costFloorKRW: 300000 } }));
  assert.equal(low.verdict, 'operator');
  assert.ok(rules(low).includes('budget.below_floor'), rules(low).join(', '));
  const clean = authorize(pricedProposal(), ctx(i, mappedFreelancer(), { usage: FREE_BIDS, priceRow: ROW }));
  assert.deepEqual([clean.verdict, rules(clean)], ['send', []]);
  // A request proposal the model left without a quote has no code-set amount and goes to the operator.
  const unpriced = authorize(itemOf(proposalRow('freelancer', { costKRW: 0, amountKRW: null })), ctx(i, mappedFreelancer(), { usage: FREE_BIDS, priceRow: ROW }));
  assert.ok(unpriced.reasons.some((r) => r.rule === 'price.row' && r.detail === 'proposal without a code-set amount'));
  // kmong's planner sets decision.quote null on a project thread: no price row is asked of it, in auto mode.
  const k = authorize(itemOf(kmongProposal()), ctx(makeInstance(), loadDescriptor('kmong'), { priceRow: null }));
  assert.deepEqual([k.verdict, rules(k)], ['send', []]);
});
test('a bid usage or cost that is not a finite amount of 0 or more refuses the bid', () => {
  const budget = { monthlyKRW: 5000, stopAfterUnanswered: 20 };
  for (const usage of [{ bidMonthKRW: NaN, bidUnanswered: NaN }, { bidMonthKRW: Infinity, bidUnanswered: 0 }, { bidMonthKRW: -1, bidUnanswered: 0 }, { bidMonthKRW: 0, bidUnanswered: 1.5 }, { bidMonthKRW: null, bidUnanswered: 0 }]) {
    assert.deepEqual(bidBudgetCheck({ budget, usage, costKRW: 2000 }), { ok: false, reason: 'the bid usage was not counted' }, JSON.stringify(usage));
  }
  for (const costKRW of [NaN, -1, Infinity]) assert.deepEqual(bidBudgetCheck({ budget, usage: { bidMonthKRW: 0, bidUnanswered: 0 }, costKRW }), { ok: false, reason: 'the bid cost in KRW is unknown' });
  assert.equal(bidBudgetCheck({ budget: { monthlyKRW: NaN, stopAfterUnanswered: 20 }, usage: { bidMonthKRW: 0, bidUnanswered: 0 }, costKRW: 0 }).ok, false);
});