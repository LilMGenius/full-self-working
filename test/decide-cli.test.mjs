import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { run } from '../src/cli/decide.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-decide-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const instance = loadInstance({ dir });
  const row = { platform: 'soomgo', service: 'landing_page_web', baseKRW: 500000, floorKRW: 100000, ceilingKRW: 2500000, costFloorKRW: 48000, viable: true, basis: { source: 'price-guide', p25: 100000, median: 500000, high: 2500000 } };
  mkdirSync(instance.paths.pricing, { recursive: true });
  writeFileSync(join(instance.paths.pricing, 'price-table-20261025.json'), JSON.stringify({ observedAt: '2026-10-25', rows: [row] }));
  const thread = join(dir, 'thread.json');
  writeFileSync(thread, JSON.stringify({ kind: 'request', quoteCostKRW: 1990, messages: [{ direction: 'in', text: '웹 디자인\n랜딩 페이지 5개 섹션과 문의 폼이 필요합니다.' }] }));
  return { instance, dir, thread };
}

const codex = () => async () => ({
  data: { intent: 'quote_request', service: 'landing_page_web', language: 'ko', reply: '요청하신 5개 섹션과 문의 폼을 포함해 진행합니다. 결제는 착수금과 잔금으로 나누어 받습니다.', quote: { amountKRW: 9999999, scope: ['5개 섹션', '문의 폼'], deliveryDays: 10, priceType: 'fixed', complexity: 1.2 }, needsOperator: false, operatorReason: null, confidence: 0.8, claimsUsed: [] },
  durationMs: 1,
});

test('fsw decide quotes from the newest price table in the instance, the one the supervisor uses', async () => {
  const { instance, thread } = setup();
  const out = [];
  await run(['soomgo', thread], { instance, runCodex: codex(), log: (s) => out.push(s) });
  const r = JSON.parse(out[0]);
  assert.equal(r.action, 'reply');
  assert.equal(r.decision.quote.amountKRW, 600000);
});

test('--price-table accepts a table file as fsw price writes it', async () => {
  const { instance, dir, thread } = setup();
  const out = [];
  await run(['soomgo', thread, '--price-table', join(instance.paths.pricing, 'price-table-20261025.json')], { instance, runCodex: codex(), log: (s) => out.push(s) });
  assert.equal(JSON.parse(out[0]).decision.quote.amountKRW, 600000);
});

