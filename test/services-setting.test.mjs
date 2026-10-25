import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { listApprovals } from '../src/brain/approvals.mjs';
import { decide } from '../src/brain/respond.mjs';
import { catalogServicesFor, processThread } from '../src/pipeline/thread.mjs';
import { answeredServices } from '../src/economics/catalog.mjs';
import { targetsFor } from '../src/cli/market.mjs';
import { recordMoney } from '../src/orders/money.mjs';
import { tempDir } from './tmp.mjs';

const LESSON = '프로그래밍/코딩 레슨';
const LESSONS_ON_SOOMGO = (c) => ({ ...c, platforms: { ...c.platforms, soomgo: { ...c.platforms.soomgo, mode: 'auto', maxCashPerDay: 10000, services: [...answeredServices(c, 'soomgo'), 'lesson_tutoring'] } } });
const NOW = new Date('2026-10-25T03:00:00Z');

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-lessons-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}

const lessonRequest = { id: 'r9', kind: 'request', unread: true, at: '2026-10-25T02:00:00Z', service: LESSON };

function requestAdapter() {
  const calls = { readRequest: 0, quote: 0 };
  return {
    calls,
    async readRequest(id) {
      calls.readRequest += 1;
      return { id, title: LESSON, text: '파이썬 기초를 배우고 싶습니다.', quoteCostKRW: 1990 };
    },
    async quote() {
      calls.quote += 1;
      return { observed: true };
    },
  };
}

// A model stand-in that answers one lesson decision with a quote and keeps the prompt and schema it saw.
function lessonCodex() {
  const fn = async ({ prompt, schema }) => {
    fn.prompts.push(prompt);
    fn.schemas.push(schema);
    return {
      durationMs: 1,
      data: {
        intent: 'quote_request', service: 'lesson_tutoring', language: 'ko', reply: '파이썬 기초 수업 문의 감사합니다. 원하시는 요일과 시간, 온라인 또는 대면 중 어느 쪽이 편하신지 알려 주세요.',
        quote: { amountKRW: 35000, scope: ['60분 수업 1회'], deliveryDays: 7, priceType: 'fixed', complexity: 1 }, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [],
      },
    };
  };
  fn.prompts = [];
  fn.schemas = [];
  return fn;
}

test('a lesson request stays parked for the operator by default and is answered once config lists the lesson service', async () => {
  const parked = requestAdapter();
  const r1 = await processThread({ platform: 'soomgo', threadRef: lessonRequest, adapter: parked, ledger: openLedger(':memory:'), instance: makeInstance(), descriptor: loadDescriptor('soomgo'), mode: 'auto', now: NOW, runCodex: async () => { throw new Error('no model call for a parked lesson'); } });
  assert.equal(r1.action, 'operator');
  assert.match(r1.reason, /lesson_tutoring, which config platforms\.soomgo\.services does not answer/);
  assert.equal(parked.calls.readRequest, 0);

  // With the setting the request is opened and decided. Without a price row for lessons the quote goes to
  // the operator as an approval, the path every service without a price row takes.
  const instance = makeInstance(LESSONS_ON_SOOMGO);
  const adapter = requestAdapter();
  const runCodex = lessonCodex();
  const r2 = await processThread({ platform: 'soomgo', threadRef: lessonRequest, adapter, ledger: openLedger(':memory:'), instance, descriptor: loadDescriptor('soomgo'), mode: 'auto', now: NOW, priceTable: [], runCodex });
  assert.deepEqual([r2.action, adapter.calls.readRequest, adapter.calls.quote], ['queued', 1, 0]);
  assert.match(r2.reason, /quote without a viable price row for lesson_tutoring/);
  assert.equal(listApprovals(instance)[0].service, 'lesson_tutoring');
  assert.match(runCodex.prompts[0], /# Services I deliver myself\n[^]*- lesson_tutoring \(과외 및 레슨\): 60-minute sessions; ask the subject/);
});

test('the model sees only the services and price rows the instance answers on the platform', async () => {
  const row = (service) => ({ platform: 'soomgo', service, packages: { standard: 40000, deluxe: 88000, premium: 160000 }, floorKRW: 35000, ceilingKRW: 160000, viable: true });
  const priceTable = [row('landing_page_web'), row('lesson_tutoring')];
  const thread = { platform: 'soomgo', externalId: 'c1', kind: 'message', stage: 'pre_order', messages: [{ direction: 'in', text: '문의드립니다' }] };
  const ctx = (instance, runCodex) => ({ instance, descriptor: loadDescriptor('soomgo'), priceTable, runCodex, playbook: '', lessons: [], lessonsRules: [] });
  const off = lessonCodex();
  await decide(thread, ctx(makeInstance(), off)).catch(() => {});
  assert.doesNotMatch(off.prompts[0], /lesson_tutoring/);
  assert.ok(!off.schemas[0].properties.service.enum.includes('lesson_tutoring'));
  const on = lessonCodex();
  await decide(thread, ctx(makeInstance(LESSONS_ON_SOOMGO), on));
  assert.match(on.prompts[0], /- lesson_tutoring \(과외 및 레슨\): standard 40000/);
  assert.ok(on.schemas[0].properties.service.enum.includes('lesson_tutoring'));
});

test('a setting naming a service the catalog does not hold is a config error', () => {
  assert.throws(() => answeredServices({ platforms: { soomgo: { services: ['lessons'] } } }, 'soomgo'), { code: 'FSW_CONFIG_INVALID', message: /lessons, which the catalog does not hold/ });
  assert.throws(() => answeredServices({ platforms: { soomgo: { services: 'lesson_tutoring' } } }, 'soomgo'), { code: 'FSW_CONFIG_INVALID' });
  assert.deepEqual(answeredServices({ platforms: { soomgo: { services: ['lesson_tutoring', 'logo_brand'] } } }, 'soomgo'), ['logo_brand', 'lesson_tutoring']);
});

test('soomgo files lessons under 프로그래밍/코딩 레슨, which maps to the lesson service and is sampled with the other guides', () => {
  assert.deepEqual(catalogServicesFor(loadDescriptor('soomgo'), LESSON), ['lesson_tutoring']);
  assert.ok(targetsFor('soomgo').some((t) => t.category === LESSON));
});

test('a lesson hire on an instance that does not answer lessons stays the operator own deal', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'l1', kind: 'message' });
  const hired = '숨고 알리미\n고용이 확정됐어요\n10월 28일 (화) 오전 10:00분까지\n고용을 취소할 수 있습니다.';
  await recordMoney({ ledger, instance, platform: 'soomgo', descriptor: loadDescriptor('soomgo'), thread, threadRef: { service: LESSON }, notices: [{ text: hired, at: '2026-10-25T10:00:00+09:00' }], now: new Date('2026-10-25T12:00:00+09:00'), notify: async () => ({}) });
  const [job] = ledger.listJobs();
  assert.equal(job.service, 'lesson_tutoring');
  assert.match(job.meta.manual, /lesson_tutoring is not answered on soomgo/);
  assert.equal(listApprovals(instance).length, 0);
});
