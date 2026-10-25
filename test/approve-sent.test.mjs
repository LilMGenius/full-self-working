import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { getApproval, queueApproval } from '../src/brain/approvals.mjs';
import { settleSent } from '../src/cli/approvals.mjs';
import { quotaUsage } from '../src/pipeline/thread.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance() {
  const dir = tempDir('fsw-approve-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

const quote = { amountKRW: 300000, deliveryDays: 7, scope: ['상세페이지 1개'] };
const unobservedQuote = (instance, threadId, extra = {}) => queueApproval(instance, {
  platform: 'soomgo', threadRef: 'r1', threadId, threadKind: 'request', kind: 'quote', reason: 'the adapter did not observe the sent quote',
  draft: '견적 드립니다.', quote, service: 'detail_page_design', unobserved: true, ...extra,
});

test('a pressed quote the operator saw go out is settled as sent once and counted once', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const now = new Date();
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  const a = await unobservedQuote(instance, thread.id, { pressed: { at: now.toISOString(), costKRW: 5890 } });
  assert.deepEqual(quotaUsage(ledger, 'soomgo', now, instance), { quotes: 1, cashKRW: 5890 });
  settleSent(instance, a.id, {}, { ledger });
  assert.equal(getApproval(instance, a.id).status, 'sent');
  assert.deepEqual(ledger.listQuotes({ threadId: thread.id }).map((q) => [q.status, q.costKRW]), [['sent', 5890]]);
  assert.deepEqual(quotaUsage(ledger, 'soomgo', now, instance), { quotes: 1, cashKRW: 5890 });
  assert.equal(ledger.threadMessages(thread.id).filter((m) => m.direction === 'out').length, 1);
  assert.throws(() => settleSent(instance, a.id, {}, { ledger }), /--sent settles only/);
});

test('a quote unobserved before presses were recorded is settled at the cost the operator read', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  const a = await unobservedQuote(instance, thread.id);
  assert.throws(() => settleSent(instance, a.id, { cost: '5,890' }, { ledger }), /whole KRW/);
  settleSent(instance, a.id, { cost: '5890' }, { ledger });
  assert.deepEqual(ledger.listQuotes({ threadId: thread.id }).map((q) => [q.status, q.amountKRW, q.costKRW]), [['sent', 300000, 5890]]);
});

test('--sent refuses an approval that is not a send the adapter could not observe', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  const a = await queueApproval(instance, { platform: 'soomgo', threadRef: 'r1', threadId: thread.id, kind: 'quote', reason: 'operator needed', draft: '견적 드립니다.', quote });
  assert.throws(() => settleSent(instance, a.id, {}, { ledger }), /--sent settles only/);
  assert.deepEqual(ledger.listQuotes({ threadId: thread.id }), []);
});
