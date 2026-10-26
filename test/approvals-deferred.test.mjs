// Quotes the 2c77326 pipeline deferred only for the day's cash caps: imported as planned quote rows the
// drain holds under budget.cash and sends when the caps allow (main src/pipeline/thread.mjs:102, :270-300).
// Synthetic approval files in the shape of the live ones; no value comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { importApprovals } from '../src/core/approvals-import.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { authorize } from '../src/policy/authorize.mjs';
import { drain } from '../src/outbox/index.mjs';
import { scriptedSurface } from './helpers/surface.mjs';
import { tempDir } from './tmp.mjs';

const NOON = new Date('2026-10-27T12:00:00+09:00');
const TEXT = '요청하신 상세페이지 구성으로 진행 가능합니다. 자료를 보내 주시면 작업 일정을 확정하겠습니다.';
const ROW = (service, base) => ({ platform: 'soomgo', service, category: '상세페이지 제작', baseKRW: base, floorKRW: 45000, ceilingKRW: 1500000, costFloorKRW: 45000, viable: true, adapter: true });

function setup(soomgo = {}) {
  const dir = tempDir('fsw-deferred-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.platforms = { soomgo: { ...config.platforms.soomgo, enabled: true, mode: 'auto', maxQuotesPerDay: 5, maxCashPerDay: 10000, services: null, ...soomgo } };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const instance = loadInstance({ dir });
  mkdirSync(instance.paths.approvals, { recursive: true });
  const ledger = openLedger(':memory:');
  const notes = [];
  const descriptor = loadDescriptor('soomgo');
  // A deferred quote file as the 2c77326 pipeline wrote it (20261026-soomgo-* on the live instance).
  const deferredFile = (hex, { ref, service = 'detail_page_design', costKRW = 4490, createdAt = '2026-10-26T00:05:55.900Z', amountKRW = 300000 } = {}) => {
    const t = ledger.upsertThread({ platform: 'soomgo', externalId: ref, kind: 'request', customer: 'buyer-' + hex });
    const id = '20261026-soomgo-' + hex;
    writeFileSync(join(instance.paths.approvals, id + '.json'), JSON.stringify({
      id, status: 'open', createdAt, platform: 'soomgo', threadRef: ref, threadId: t.id, threadKind: 'request', kind: 'quote',
      reason: 'cash quote refused: daily cash budget spent (12000 + ' + costKRW + ' over 10000)', draft: TEXT,
      quote: { amountKRW, scope: ['기본형 상세페이지 1페이지', '수정 1회 포함'], deliveryDays: 7, priceType: 'fixed', split: { mechanism: 'multi_pay', parts: [{ label_ko: '선금', amountKRW: amountKRW / 2 }, { label_ko: '잔금', amountKRW: amountKRW / 2 }] } },
      service, intent: 'quote_request', violations: [], warnings: [],
      item: { platform: 'soomgo', kind: 'quote', text: TEXT, amountKRW, thread: { stage: 'pre_order', lastInboundText: '상세페이지 제작 견적 부탁드립니다', language: null, recentOutbound: [] } },
      priceRow: ROW(service, amountKRW), title: 'soomgo quote', costKRW,
    }, null, 2));
    return { id, thread: t };
  };
  const run = (surface, now = NOON) => drain(ledger, { platform: 'soomgo', surface, authorize, ctx: { descriptor, instance, mode: 'auto', now, notify: async (_i, n) => (notes.push(n), {}) } });
  const spend = (costKRW, at = NOON) => ledger.addQuote({ platform: 'soomgo', amountKRW: 100000, costKRW, at: at.toISOString() });
  return { instance, ledger, notes, deferredFile, run, spend, imp: () => importApprovals(ledger, instance.paths.approvals) };
}
const quoteSurface = () => scriptedSurface({ methods: [], receipts: { quote: (ref) => ({ observed: true, snippet: 'sent ' + ref }) } });

test('an open quote deferred only for the day cash caps imports as a planned quote with what the drain reads', () => {
  const s = setup();
  const { id, thread } = s.deferredFile('076f83fd', { ref: 'R1' });
  assert.deepEqual(s.imp().imported, 1);
  const row = s.ledger.outboxByApproval(id);
  assert.equal(row.status, 'planned');
  assert.deepEqual([row.threadId, row.kind, row.payload.costKRW, row.payload.service, row.payload.thread.kind, row.payload.thread.stage, row.payload.customer], [thread.id, 'quote', 4490, 'detail_page_design', 'request', 'pre_order', 'buyer-076f83fd']);
  assert.deepEqual([row.payload.decision.service, row.payload.decision.intent, row.payload.priceRow.viable, row.payload.deliveryDays, row.payload.split.parts.length], ['detail_page_design', 'quote_request', true, 7, 2]);
  assert.equal(s.imp().already, 1, 'a second start imports nothing');
});

test('with the day caps spent the drain holds the imported quote and asks nobody', async () => {
  const s = setup();
  s.deferredFile('076f83fd', { ref: 'R1' });
  s.imp();
  s.spend(8000);
  const surface = quoteSurface();
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => x.action), ['held']);
  assert.match(out[0].reason, /daily cash budget spent/);
  assert.deepEqual([surface.count('quote'), s.notes.length, s.ledger.listOutbox({ kinds: ['quote'] })[0].status], [0, 0, 'planned']);
});

test('with room the drain sends the oldest deferred quote once with the cash check applied, and holds the next', async () => {
  const s = setup();
  const older = s.deferredFile('1f3d6cfc', { ref: 'R1', costKRW: 5890, createdAt: '2026-10-25T23:45:56.565Z' });
  const newer = s.deferredFile('076f83fd', { ref: 'R2', costKRW: 4490 });
  s.imp();
  const surface = quoteSurface();
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.action, x.kind]), [['observed', 'quote'], ['held', 'quote']]);
  const call = surface.calls.find((c) => c.name === 'quote');
  assert.deepEqual([surface.count('quote'), call.ref, call.args.amountKRW, call.args.allowSpendCash, call.args.customer, call.args.text], [1, 'R1', 300000, true, 'buyer-1f3d6cfc', TEXT]);
  assert.deepEqual([s.ledger.outboxByApproval(older.id).status, s.ledger.outboxByApproval(newer.id).status], ['observed', 'planned']);
  assert.equal(out[0].signal.type, 'quote_observed');
  await s.run(quoteSurface());
  assert.equal(s.ledger.outboxByApproval(older.id).status, 'observed', 'never sent twice');
});

test('a deferred quote whose service is no longer answered goes to the operator under its file id', async () => {
  const s = setup({ services: ['landing_page_web'] });
  const { id } = s.deferredFile('fcecf9c3', { ref: 'R3', service: 'game_dev', costKRW: 2090, amountKRW: 1200000 });
  s.imp();
  const surface = quoteSurface();
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => [x.action, x.approvalId]), [['awaiting_operator', id]]);
  assert.match(out[0].reason, /no longer answered/);
  assert.deepEqual([s.ledger.outboxByApproval(id).status, surface.count('quote'), s.notes.filter((n) => n.kind === 'approval').length], ['awaiting_operator', 0, 1]);
});

test('a deferred quote costing more than a whole day of cash goes to the operator', async () => {
  const s = setup();
  const { id } = s.deferredFile('076f83fd', { ref: 'R1', costKRW: 20000 });
  s.imp();
  const surface = quoteSurface();
  const out = await s.run(surface);
  assert.deepEqual(out.map((x) => x.action), ['awaiting_operator']);
  assert.match(out[0].reason, /cash quote refused/);
  assert.deepEqual([s.ledger.outboxByApproval(id).status, surface.count('quote')], ['awaiting_operator', 0]);
});

test('an open quote not deferred for the budget, or one the old code could not observe, keeps its mapping', () => {
  const s = setup();
  const { id } = s.deferredFile('076f83fd', { ref: 'R1' });
  const file = join(s.instance.paths.approvals, id + '.json');
  const a = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...a, reason: 'draft mode' }));
  const b = s.deferredFile('1f3d6cfc', { ref: 'R2' });
  const fb = join(s.instance.paths.approvals, b.id + '.json');
  writeFileSync(fb, JSON.stringify({ ...JSON.parse(readFileSync(fb, 'utf8')), unobserved: true }));
  s.imp();
  assert.deepEqual([s.ledger.outboxByApproval(id).status, s.ledger.outboxByApproval(b.id).status], ['awaiting_operator', 'unobserved']);
});
