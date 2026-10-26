import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { armWeight, latestAllocation, prioritize } from '../src/economics/priority.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { tempDir } from './tmp.mjs';

const soomgo = loadDescriptor('soomgo');
const allocation = { weights: [
  { platform: 'soomgo', service: 'ai_automation_chatbot', weight: 0.19 },
  { platform: 'soomgo', service: 'landing_page_web', weight: 0.17 },
  { platform: 'soomgo', service: 'logo_brand', weight: 0.05 },
  { platform: 'soomgo', service: 'photo_editing', weight: 0 },
] };

test('the newest allocation file is read, and none means no allocation', () => {
  const dir = tempDir('fsw-prio-');
  const instance = { paths: { pricing: join(dir, 'pricing') } };
  assert.equal(latestAllocation(instance), null);
  mkdirSync(instance.paths.pricing);
  writeFileSync(join(instance.paths.pricing, 'allocation-20261024.json'), JSON.stringify({ weights: [{ platform: 'kmong', service: 'x', weight: 1 }] }));
  writeFileSync(join(instance.paths.pricing, 'allocation-20261025.json'), JSON.stringify(allocation));
  const a = latestAllocation(instance);
  assert.equal(a.day, '20261025');
  assert.deepEqual([armWeight(a, 'soomgo', 'landing_page_web'), armWeight(a, 'soomgo', 'unknown'), armWeight(null, 'soomgo', 'x')], [0.17, 0, null]);
});

test('conversations come first, then requests by the weight of the service their label allows', () => {
  const items = [
    { id: 'r-logo', kind: 'request', service: '로고 디자인' },
    { id: 'r-photo', kind: 'request', service: '사진 편집 및 보정' },
    { id: 'c-1', kind: 'message', service: '웹 개발' },
    { id: 'r-nolabel', kind: 'request' },
    { id: 'r-web', kind: 'request', service: '웹 개발' },
    { id: 'r-ai', kind: 'request', service: '챗봇 개발' },
    { id: 'c-2', kind: 'message' },
  ];
  assert.deepEqual(prioritize(items, { allocation, descriptor: soomgo }).map((i) => i.id), ['c-1', 'c-2', 'r-ai', 'r-web', 'r-logo', 'r-nolabel', 'r-photo']);
});

test('without an allocation the list order stands', () => {
  const items = [{ id: 'a', kind: 'request', service: '로고 디자인' }, { id: 'b', kind: 'request', service: '챗봇 개발' }, { id: 'c', kind: 'message' }];
  assert.deepEqual(prioritize(items, { allocation: null, descriptor: soomgo }).map((i) => i.id), ['c', 'a', 'b']);
});

test('the supervisor opens the highest-weight requests first when the per-tick cap binds', async () => {
  const { runTick, MAX_THREADS_PER_PLATFORM } = await import('../src/supervisor/run.mjs');
  const { exampleDir, loadInstance } = await import('../src/core/instance.mjs');
  const { openLedger } = await import('../src/core/ledger.mjs');
  const { scriptedSurface } = await import('./helpers/surface.mjs');
  const { copyFileSync, readFileSync } = await import('node:fs');
  const dir = tempDir('fsw-prio-sup-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.activeHours = { outbound: ['00:00', '00:00'] };
  config.platforms = { soomgo: { ...config.platforms.soomgo, enabled: true, mode: 'auto', maxQuotesPerDay: 50, maxCashPerDay: 100000 } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const instance = loadInstance({ dir });
  mkdirSync(instance.paths.pricing, { recursive: true });
  writeFileSync(join(instance.paths.pricing, 'allocation-20261025.json'), JSON.stringify(allocation));
  const now = new Date('2026-10-25T03:00:00Z');
  const at = '2026-10-25T02:00:00Z';
  const request = (ref, service) => ({ platform: 'soomgo', ref, kind: 'request', at, unread: true, service, preview: null, notice: null, status: null, hired: null, quotable: true, expiresAt: null, quoteCostKRW: 1990, requestId: ref, customer: null, quote: null });
  const low = Array.from({ length: MAX_THREADS_PER_PLATFORM }, (_, i) => request('logo' + i, '로고 디자인'));
  const surface = scriptedSurface({ sense: [...low, request('ai', '챗봇 개발')], threads: (ref) => ({ ref, kind: 'request', messages: [{ direction: 'in', text: 'y', at, externalId: ref + ':1' }], notices: [] }) });
  const decide = async () => ({ modelCalls: 1, item: null, decision: { intent: 'spam', service: null, language: 'ko', reply: null, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [] } });
  await runTick({ instance, ledger: openLedger(':memory:'), now, state: { lastRuns: {} }, only: ['poll'], openSurface: async () => surface, decide, notify: async () => ({ written: false }), persist: false });
  const opened = surface.calls.filter((c) => c.name === 'read').map((c) => c.ref);
  assert.equal(opened[0], 'ai');
  assert.equal(opened.length, MAX_THREADS_PER_PLATFORM);
});
