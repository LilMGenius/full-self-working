// Synthetic rates only: no figure here is a real exchange rate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FX_SOURCE, fxNote, loadFx, toKRW } from '../src/economics/fx.mjs';
import { tempDir } from './tmp.mjs';

const answer = { amount: 1, base: 'USD', date: '2026-10-23', rates: { EUR: 0.8, KRW: 1300 } };
const instanceIn = () => ({ paths: { market: join(tempDir('fsw-fx-'), 'market') } });
const fakeFetch = (reply) => {
  const calls = [];
  const get = async (url) => (calls.push(url), typeof reply === 'function' ? reply() : { ok: true, status: 200, json: async () => reply });
  return { calls, get };
};

test('rates are read once per Seoul day and cached with their source and publication date', async () => {
  const instance = instanceIn();
  const { calls, get } = fakeFetch(answer);
  const fx = await loadFx(instance, { fetch: get, now: () => new Date('2026-10-24T15:00:00Z') });
  assert.deepEqual(fx, { day: '20261025', source: FX_SOURCE, date: '2026-10-23', base: 'USD', rates: { EUR: 0.8, KRW: 1300, USD: 1 } });
  assert.ok(existsSync(join(instance.paths.market, 'fx-20261025.json')));
  await loadFx(instance, { fetch: get, now: () => new Date('2026-10-25T14:59:59Z') });
  assert.equal(calls.length, 1);
  const next = await loadFx(instance, { fetch: get, now: () => new Date('2026-10-25T15:00:00Z') });
  assert.equal(next.day, '20261026');
  assert.deepEqual(calls, [FX_SOURCE, FX_SOURCE]);
});

test('amounts convert to whole won through the dollar cross rate, and a missing currency fails by name', () => {
  const fx = { date: '2026-10-23', source: FX_SOURCE, rates: { EUR: 0.8, KRW: 1300, USD: 1 } };
  assert.equal(toKRW(100, 'USD', fx), 130000);
  assert.equal(toKRW(100, 'EUR', fx), 162500);
  assert.equal(toKRW(5000, 'KRW', fx), 5000);
  assert.deepEqual(fxNote('EUR', fx), { currency: 'EUR', krwPerUnit: 1625, date: '2026-10-23', source: FX_SOURCE });
  assert.throws(() => toKRW(1, 'GBP', fx), { code: 'FSW_FX_MISSING' });
});

test('a failed or malformed answer throws by name and caches nothing', async () => {
  for (const reply of [() => Promise.reject(new Error('getaddrinfo ENOTFOUND')), () => ({ ok: false, status: 503 }), { base: 'EUR', date: '2026-10-23', rates: { KRW: 1500 } }, { base: 'USD', date: '2026-10-23', rates: { EUR: 0.8 } }]) {
    const instance = instanceIn();
    await assert.rejects(loadFx(instance, { fetch: fakeFetch(reply).get, now: () => new Date('2026-10-25T03:00:00Z') }), { code: 'FSW_FX_UNAVAILABLE' });
    assert.deepEqual(readdirSync(instance.paths.market), []);
  }
});
