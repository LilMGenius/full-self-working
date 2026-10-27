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
import { authorize } from '../src/policy/authorize.mjs';
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
  const i = makeInstance((c) => ({ ...c, platforms: { ...c.platforms, upwork: { ...c.platforms.upwork, enabled: true, mode: 'auto' } } }));
  const real = loadDescriptor('upwork');
  assert.deepEqual(real.automation.sendRequiresOperator, ['proposal', 'message']);
  const upwork = structuredClone(real);
  upwork.forms.proposal = { mapped: true, mappedAt: '2026-10-28T00:00:00Z', recording: 'test fixture', readBack: true };
  const asked = authorize(itemOf(proposalRow('upwork')), ctx(i, upwork, { priceRow: ROW }));
  assert.equal(asked.verdict, 'operator');
  assert.ok(rules(asked).includes('automation.operator'), rules(asked).join(', '));
  const approved = authorize(itemOf(proposalRow('upwork')), ctx(i, upwork, { approved: true, priceRow: ROW }));
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
