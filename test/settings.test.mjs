import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../src/core/ledger.mjs';
import { chromeName, effectiveMode, ordersWatched, pipelineSettings } from '../src/core/settings.mjs';
import { transaction } from '../src/core/tx.mjs';

test('pipelineSettings fails closed on a missing window or confidence floor', () => {
  const ok = { pipeline: { replyWindowHours: { message: 72, request: 48 }, minAutoConfidence: 0.7 } };
  assert.deepEqual(pipelineSettings(ok), { replyWindowHours: { message: 72, request: 48 }, minAutoConfidence: 0.7 });
  assert.throws(() => pipelineSettings({ pipeline: { replyWindowHours: { message: 72 }, minAutoConfidence: 0.7 } }), { code: 'FSW_CONFIG_MISSING' });
  assert.throws(() => pipelineSettings({}), { code: 'FSW_CONFIG_MISSING' });
});

test('a forced mode only lowers the configured mode, and an unknown one is refused', () => {
  assert.equal(effectiveMode('auto', null), 'auto');
  assert.equal(effectiveMode('auto', 'observe'), 'observe');
  assert.equal(effectiveMode('draft', 'auto'), 'draft');
  assert.throws(() => effectiveMode('auto', 'loud'), RangeError);
});

test('the browser a notice names comes from the browser.chromeProfile setting', () => {
  assert.equal(chromeName({ browser: { chromeProfile: null } }), 'Chrome');
  assert.equal(chromeName({ browser: { chromeProfile: 'X' } }), 'Chrome (profile X)');
  assert.equal(ordersWatched({ orders: { watched: true } }), true);
  assert.equal(ordersWatched({}), false);
});

test('a transaction commits once, a nested call joins it, and a throw rolls every write back', () => {
  const ledger = openLedger(':memory:');
  transaction(ledger, () => {
    ledger.upsertThread({ platform: 'kmong', externalId: 'a', kind: 'message' });
    transaction(ledger, () => ledger.upsertThread({ platform: 'kmong', externalId: 'b', kind: 'message' }));
  });
  assert.equal(ledger.listThreads().length, 2);
  assert.throws(() => transaction(ledger, () => {
    ledger.upsertThread({ platform: 'kmong', externalId: 'c', kind: 'message' });
    transaction(ledger, () => ledger.upsertThread({ platform: 'kmong', externalId: 'd', kind: 'message' }));
    throw new Error('boom');
  }), /boom/);
  assert.equal(ledger.listThreads().length, 2);
  assert.throws(() => transaction(ledger, () => Promise.resolve()), TypeError);
  assert.equal(ledger.db.isTransaction, false);
});
