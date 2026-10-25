import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { listApprovals } from '../src/brain/approvals.mjs';
import { parkKey, processThread } from '../src/pipeline/thread.mjs';
import { catalogIds, loadCatalog } from '../src/brain/prompts.mjs';
import { needsWork } from '../src/supervisor/run.mjs';
import { digestNumbers } from '../src/supervisor/digest.mjs';
import { tempDir } from './tmp.mjs';

const NOW = new Date('2026-10-25T03:00:00Z');

function makeInstance(edit = (c) => c) {
  const dir = tempDir('fsw-triage-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(edit(config)));
  return loadInstance({ dir });
}

function spyAdapter() {
  const calls = { readThread: 0, readRequest: 0, send: 0, quote: 0 };
  return {
    calls,
    async readThread(id) {
      calls.readThread += 1;
      return { id, messages: [{ direction: 'in', text: '랜딩 페이지 제작 문의드립니다.', externalId: 'm1' }] };
    },
    async readRequest(id) {
      calls.readRequest += 1;
      return { id, title: '웹 개발', text: '회사 소개 사이트가 필요합니다.', quoteCostKRW: 1990 };
    },
    async send(id, { text }) {
      calls.send += 1;
      return { observed: true, text };
    },
    async quote(id, q) {
      calls.quote += 1;
      return { observed: true, text: q.text, cashSpentKRW: 1990 };
    },
  };
}

function decideWith(over) {
  const fn = async () => {
    fn.calls += 1;
    return {
      action: 'reply',
      modelCalls: 1,
      decision: { intent: 'inquiry', service: 'landing_page_web', language: 'ko', reply: '안녕하세요. 원하시는 구성과 일정을 알려 주세요.', quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], ...over },
      item: { kind: 'message' },
      gate: { ok: true, violations: [], warnings: [] },
      priceRow: null,
    };
  };
  fn.calls = 0;
  return fn;
}

const setup = (platform, edit) => ({ instance: makeInstance(edit), ledger: openLedger(':memory:'), descriptor: loadDescriptor(platform), platform, now: NOW });

test('a thread past the reply window is parked unopened until a newer message arrives', async () => {
  const s = setup('kmong');
  const adapter = spyAdapter();
  const decide = decideWith({});
  const ref = { id: 't1', unread: true, at: '2026-10-16T08:37:00+09:00', preview: '문의드립니다' };
  const r = await processThread({ ...s, threadRef: ref, adapter, mode: 'auto', decide });
  assert.equal(r.action, 'skipped');
  assert.match(r.reason, /stale/);
  assert.deepEqual([adapter.calls.readThread, decide.calls, adapter.calls.send], [0, 0, 0]);
  const [row] = s.ledger.listThreads({ platform: 'kmong' });
  const key = parkKey(s.instance.config, s.descriptor);
  assert.equal(needsWork(ref, row, key), false);
  assert.equal(needsWork({ ...ref, at: '2026-10-25T11:00:00+09:00' }, row, key), true);
});

test('an expired request is parked without opening its detail', async () => {
  const s = setup('soomgo');
  const adapter = spyAdapter();
  const ref = { id: 'r1', kind: 'request', unread: true, at: '2026-10-25T01:00:00Z', expiresAt: '2026-10-25T02:00:00Z', service: '웹 개발' };
  const r = await processThread({ ...s, threadRef: ref, adapter, mode: 'auto', decide: decideWith({}) });
  assert.deepEqual([r.action, r.reason, adapter.calls.readRequest, adapter.calls.quote], ['skipped', 'expired', 0, 0]);
});

test('an unread platform notice is parked once and returns only with a newer message', async () => {
  const s = setup('soomgo');
  const adapter = spyAdapter();
  const ref = { id: 'n1', unread: true, at: '2026-10-25T01:00:00Z', service: '웹 개발', preview: '고객이 견적을 읽었어요. 11월 15일에 캐시를 지급해 드려요.' };
  const r = await processThread({ ...s, threadRef: ref, adapter, mode: 'auto', decide: decideWith({}) });
  assert.deepEqual([r.action, adapter.calls.readThread], ['system', 0]);
  const [row] = s.ledger.listThreads({ platform: 'soomgo' });
  const key = parkKey(s.instance.config, s.descriptor);
  assert.equal(needsWork(ref, row, key), false);
  assert.equal(needsWork({ ...ref, at: '2026-10-25T02:00:00Z', preview: '혹시 다음 주에 시작 가능할까요?' }, row, key), true);
});

test('items settled from the list do not use up the per-tick slots', async () => {
  const { runPlatform, MAX_THREADS_PER_PLATFORM } = await import('../src/supervisor/run.mjs');
  const s = setup('kmong', (c) => {
    c.activeHours = { outbound: ['00:00', '00:00'] };
    return c;
  });
  const notices = Array.from({ length: MAX_THREADS_PER_PLATFORM + 2 }, (_, i) => ({ id: 'n' + i, unread: true, at: '2026-10-25T02:00:00Z', preview: '고객이 견적을 읽었어요.' }));
  const live = { id: 'live', unread: true, at: '2026-10-25T02:30:00Z', preview: '랜딩 페이지 문의드립니다' };
  const adapter = { ...spyAdapter(), login: async () => ({ loggedIn: true }), inbox: async () => [...notices, live], stop: async () => {} };
  const decide = decideWith({});
  const r = await runPlatform('kmong', { instance: s.instance, ledger: s.ledger, now: NOW, priceTable: [], loadAdapter: async () => async () => adapter, decide });
  assert.deepEqual([r.threads.system, r.threads.sent, r.deferred, adapter.calls.readThread], [MAX_THREADS_PER_PLATFORM + 2, 1, 0, 1]);
});

test('a request outside the catalog stays unread for the operator, costs no model call and is counted', async () => {
  const s = setup('soomgo');
  const adapter = spyAdapter();
  const decide = decideWith({});
  const ref = { id: 'r2', kind: 'request', unread: true, at: '2026-10-25T02:00:00Z', service: '게임 개발', customer: '고객' };
  const r = await processThread({ ...s, threadRef: ref, adapter, mode: 'draft', decide });
  assert.equal(r.action, 'operator');
  assert.deepEqual([adapter.calls.readRequest, decide.calls, listApprovals(s.instance).length], [0, 0, 0]);
  const n = digestNumbers({ instance: s.instance, ledger: s.ledger, now: new Date(Date.now() + 86_400_000) });
  assert.deepEqual(n.leftForOperator, { total: 1, byPlatform: { soomgo: 1 } });
});

test('a decision must name a service the platform label allows, and a coarse label allows several', async () => {
  const s = setup('soomgo');
  const adapter = spyAdapter();
  const ref = { id: 'c1', unread: true, at: '2026-10-25T02:00:00Z', service: '웹 개발' };
  const r = await processThread({ ...s, threadRef: ref, adapter, mode: 'auto', decide: decideWith({ service: 'logo_brand' }) });
  assert.equal(r.action, 'queued');
  assert.match(r.reason, /labels this 웹 개발 \(web_app_dev, landing_page_web\)/);
  assert.equal(adapter.calls.send, 0);
  const cafe = spyAdapter();
  const ok = await processThread({ ...s, threadRef: { ...ref, id: 'c2' }, adapter: cafe, mode: 'auto', decide: decideWith({ service: 'landing_page_web' }) });
  assert.deepEqual([ok.action, cafe.calls.send], ['sent', 1]);
});

test('every service a descriptor label adds is a catalog service', () => {
  const ids = new Set(catalogIds(loadCatalog()));
  for (const [label, services] of Object.entries(loadDescriptor('soomgo').serviceLabels)) {
    for (const id of services) assert.ok(ids.has(id), label + ' names ' + id + ', which the catalog does not hold');
  }
});

test('auto mode sends a confident decision and asks the operator about an unsure one', async () => {
  const s = setup('kmong');
  const sure = spyAdapter();
  const r1 = await processThread({ ...s, threadRef: { id: 't2', unread: true, at: '2026-10-25T02:30:00Z' }, adapter: sure, mode: 'auto', decide: decideWith({ confidence: 0.9 }) });
  assert.deepEqual([r1.action, sure.calls.send], ['sent', 1]);
  const unsure = spyAdapter();
  const r2 = await processThread({ ...s, threadRef: { id: 't3', unread: true, at: '2026-10-25T02:30:00Z' }, adapter: unsure, mode: 'auto', decide: decideWith({ confidence: 0.4 }) });
  assert.equal(r2.action, 'queued');
  assert.match(r2.reason, /confidence 0.4 is below 0.7/);
  assert.equal(unsure.calls.send, 0);
});

test('a config without pipeline settings refuses before anything is opened, and observe still reads', async () => {
  const s = setup('kmong', (c) => {
    delete c.pipeline;
    return c;
  });
  const adapter = spyAdapter();
  await assert.rejects(processThread({ ...s, threadRef: { id: 't4', unread: false }, adapter, mode: 'auto', decide: decideWith({}) }), { code: 'FSW_CONFIG_MISSING' });
  assert.deepEqual([adapter.calls.readThread, s.ledger.listThreads().length], [0, 0]);
  const r = await processThread({ ...s, threadRef: { id: 't4', unread: true }, adapter, mode: 'observe', decide: decideWith({}) });
  assert.equal(r.action, 'observed');
});
