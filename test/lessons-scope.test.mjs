// Lessons apply only on the platforms they were learned on (070 U7.6): the compiled gate rule keeps its
// lesson's appliesTo, the outbound gate skips a rule scoped elsewhere, and the decision prompt lists only the
// lessons of its platform. A rule written before appliesTo existed fires everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { authorize } from '../src/policy/authorize.mjs';
import { checkListing } from '../src/listings/kmong.mjs';
import { compileGateRules } from '../src/learning/playbook.mjs';
import { loadLessons } from '../src/brain/prompts.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance(lessons = []) {
  const dir = tempDir('fsw-lessons-scope-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const instance = loadInstance({ dir });
  mkdirSync(instance.paths.lessons, { recursive: true });
  writeFileSync(join(instance.paths.lessons, 'lessons.jsonl'), lessons.map((l) => JSON.stringify(l)).join('\n') + (lessons.length ? '\n' : ''));
  return instance;
}
const TEXT = '요청하신 구성으로 당일 완성 가능합니다. 원하시는 일정을 알려 주세요.';
const decision = { intent: 'inquiry', service: 'landing_page_web', language: 'ko', reply: TEXT, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null };
const message = (platform) => ({ platform, kind: 'message', text: TEXT, costKRW: 0, attachments: [], thread: { kind: 'message', stage: 'pre_order', lastInboundText: '랜딩 페이지 가능한가요?', recentOutbound: [] }, decision });
const rule = (over = {}) => ({ id: 'no_rush', pattern: '당일\\s*완성', flags: 'iu', reason: 'same-day promises led to revisions', tier: 'floor', ...over });
const verdict = (platform, lessonsRules) => authorize(message(platform), { descriptor: loadDescriptor(platform), instance: makeInstance(), mode: 'auto', now: new Date('2026-10-20T12:00:00+09:00'), lessonsRules });
const learned = (v) => v.violations.filter((x) => x.rule.startsWith('learned.')).map((x) => x.rule);

test('a rule scoped to one platform fires through authorize only on that platform', () => {
  const scoped = [rule({ appliesTo: ['wishket'] })];
  const kmong = verdict('kmong', scoped);
  assert.deepEqual([kmong.verdict, learned(kmong)], ['send', []]);
  const wishket = verdict('wishket', scoped);
  assert.deepEqual([wishket.verdict, learned(wishket)], ['operator', ['learned.no_rush']]);
});

test('a rule written before appliesTo, or scoped to all, fires on every platform', () => {
  for (const r of [rule(), rule({ appliesTo: ['all'] })]) {
    assert.deepEqual(learned(verdict('kmong', [r])), ['learned.no_rush']);
    assert.deepEqual(learned(verdict('soomgo', [r])), ['learned.no_rush']);
  }
});

test('the listing gate skips a rule scoped to another platform', () => {
  const listing = { title: '랜딩 페이지 제작', description: TEXT, process: TEXT, preparation: TEXT, revision: TEXT };
  const fired = (lessonsRules) => checkListing(listing, { instance: makeInstance(), lessonsRules }).filter((v) => v.rule.startsWith('learned.')).map((v) => v.rule);
  assert.deepEqual(fired([rule({ appliesTo: ['soomgo'] })]), []);
  assert.ok(fired([rule({ appliesTo: ['kmong'] })]).includes('learned.no_rush'));
});

test('loadLessons lists only the lessons of the platform it is asked for', () => {
  const at = (n) => '2026-10-2' + n + 'T00:00:00.000Z';
  const instance = makeInstance([
    { class: 'paid_lead_budget_fit', rule: 'r1', appliesTo: ['soomgo'], updatedAt: at(1) },
    { class: 'reply_language', rule: 'r2', appliesTo: ['all'], updatedAt: at(2) },
    { class: 'gig_terms', rule: 'r3', appliesTo: ['kmong'], updatedAt: at(3) },
    { class: 'legacy', rule: 'r4', updatedAt: at(4) },
  ]);
  const classes = (opts) => loadLessons(instance, opts).map((l) => l.class);
  assert.deepEqual(classes({ platform: 'kmong' }), ['legacy', 'gig_terms', 'reply_language']);
  assert.deepEqual(classes({ platform: 'soomgo' }), ['legacy', 'reply_language', 'paid_lead_budget_fit']);
  assert.deepEqual(classes({}), ['legacy', 'gig_terms', 'reply_language', 'paid_lead_budget_fit']);
  assert.deepEqual(classes({ platform: 'kmong', limit: 1 }), ['legacy']);
});

test('every compiled rule carries its lesson scope and evidence, and still matches one of its evidence cases', () => {
  const cases = [
    { id: 'c1', kind: 'approval_rejected', text: '텔레그램 방으로 오시면 바로 상담해 드립니다' },
    { id: 'c2', kind: 'operator_correction', text: 'x', before: '최저가 보장해 드립니다', after: '견적은 범위를 보고 드립니다' },
  ];
  const lessons = [
    { class: 'chat_link_lure', rule: 'Never invite the customer to an outside chat.', evidence: ['c1'], gate: 'regex', pattern: '텔레그램\\s*방', appliesTo: ['soomgo'] },
    { class: 'price_guarantee', rule: 'Never promise the lowest price.', evidence: ['c2'], gate: 'regex', pattern: '최저가\\s*보장', appliesTo: [] },
  ];
  const { rules } = compileGateRules(lessons, cases);
  assert.deepEqual(rules.map((r) => [r.id, r.appliesTo, r.evidence]), [['chat_link_lure', ['soomgo'], ['c1']], ['price_guarantee', ['all'], ['c2']]]);
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const r of rules) assert.ok(r.evidence.some((id) => new RegExp(r.pattern, r.flags).test(byId.get(id).before ?? byId.get(id).text)), r.id);
});
