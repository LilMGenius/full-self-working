// Synthetic fixtures only: no value here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rankPortfolio } from '../src/portfolio/rank.mjs';
import { itemFromJob, itemsFromProfile, loadItems, syncPortfolio } from '../src/portfolio/store.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { tempDir } from './tmp.mjs';

const job = (id, extra = {}) => ({ id, source: 'job', paidAt: '2026-01-01T00:00:00Z', permission: 'granted', ...extra });
const ids = (items) => items.map((i) => i.id);

test('eligibility: background always, jobs only when paid with permission, never rated under 4 or disliked', () => {
  const ranked = rankPortfolio([
    { id: 'bg', source: 'background' },
    job('ok'),
    job('unpaid', { paidAt: null }),
    job('pending', { permission: 'pending' }),
    job('denied', { permission: 'denied' }),
    job('low', { satisfaction: { rating: 3.9 } }),
    job('disliked', { satisfaction: { rating: 5, liked: false } }),
    job('four', { satisfaction: { rating: 4 } }),
  ]);
  assert.deepEqual(ids(ranked).sort(), ['bg', 'four', 'ok']);
});

test('tier A (liked or 4.5+) comes first, ordered by liked, fame, quality, volume', () => {
  const ranked = rankPortfolio([
    job('b-top-quality', { quality: 1, satisfaction: { rating: 4.4 } }),
    job('a-rated', { satisfaction: { rating: 4.5 }, client: { fame: 0.9 }, quality: 0.1 }),
    job('a-liked-low-fame', { satisfaction: { liked: true }, client: { fame: 0.1 } }),
    job('a-liked-famous', { satisfaction: { liked: true }, client: { fame: 0.8 } }),
    job('a-liked-famous-better', { satisfaction: { liked: true }, client: { fame: 0.8 }, quality: 0.9 }),
    job('a-liked-famous-bigger', { satisfaction: { liked: true }, client: { fame: 0.8 }, quality: 0.9, volume: { priceKRW: 900000 } }),
  ]);
  assert.deepEqual(ids(ranked), ['a-liked-famous-bigger', 'a-liked-famous-better', 'a-liked-famous', 'a-liked-low-fame', 'a-rated', 'b-top-quality']);
  assert.deepEqual(ranked.map((i) => i.tier), ['A', 'A', 'A', 'A', 'A', 'B']);
});

test('tier B orders by quality then volume; ties fall to newest paidAt then id; missing values last', () => {
  const ranked = rankPortfolio([
    job('no-quality', { volume: { priceKRW: 9000000 } }),
    job('q5-small', { quality: 0.5, volume: { priceKRW: 100000 } }),
    job('q5-big', { quality: 0.5, volume: { priceKRW: 500000 } }),
    job('q5-nosize', { quality: 0.5 }),
    job('q8-old', { quality: 0.8, paidAt: '2026-01-01T00:00:00Z' }),
    job('q8-new', { quality: 0.8, paidAt: '2026-03-01T00:00:00Z' }),
    job('q8-b-same', { quality: 0.8, paidAt: '2025-01-01T00:00:00Z' }),
    job('q8-a-same', { quality: 0.8, paidAt: '2025-01-01T00:00:00Z' }),
    { id: 'bg', source: 'background', quality: 0.8 },
  ]);
  assert.deepEqual(ids(ranked), ['q8-new', 'q8-old', 'q8-a-same', 'q8-b-same', 'bg', 'q5-big', 'q5-small', 'q5-nosize', 'no-quality']);
});

test('rankPortfolio does not mutate its input', () => {
  const items = [job('x', { quality: 0.1 }), job('y', { quality: 0.9 })];
  const before = JSON.stringify(items);
  rankPortfolio(items);
  assert.equal(JSON.stringify(items), before);
});

const profile = {
  serviceFit: { web: { evidence: ['Site A'], strength: 'strong' } },
  projects: [{ name: 'Site A', what: 'A static site.', url: 'https://example.com/a' }, { name: 'Tool B', what: 'A CLI.' }],
};

test('itemsFromProfile keeps profile wording and invents no quality', () => {
  const [a, b] = itemsFromProfile(profile);
  assert.equal(a.id, 'bg-site-a');
  assert.equal(a.title_en, 'Site A');
  assert.equal(a.summary_en, 'A static site.');
  assert.equal(a.service, 'web');
  assert.equal(a.quality, null);
  assert.equal(b.service, null);
});

test('itemFromJob derives paidAt, volume and satisfaction and defaults permission to pending', () => {
  const item = itemFromJob({
    job: { id: 'j1', service: 'web', title: '랜딩', agentMinutes: 300, humanMinutes: 60, meta: {} },
    payments: [{ amountKRW: 100000, receivedAt: '2026-01-02T00:00:00Z' }, { amountKRW: 50000, receivedAt: '2026-01-05T00:00:00Z' }],
    review: { rating: 5, liked: true, text: 'good' },
  });
  assert.equal(item.paidAt, '2026-01-05T00:00:00Z');
  assert.deepEqual(item.volume, { priceKRW: 150000, hours: 6 });
  assert.deepEqual(item.satisfaction, { rating: 5, liked: true, quote: 'good' });
  assert.equal(item.permission, 'pending');
  assert.deepEqual(rankPortfolio([item]), []);
});

test('syncPortfolio merges background and paid jobs without duplicates and keeps hand-added fields', () => {
  const dir = tempDir('fsw-portfolio-');
  const file = join(dir, 'portfolio', 'items.json');
  const instance = { profile, paths: { portfolio: join(dir, 'portfolio') } };
  const ledger = openLedger(':memory:');
  ledger.upsertJob({ id: 'paid', service: 'web', title: 'Paid', status: 'closed', meta: { portfolio: { permission: 'granted' } } });
  ledger.addPayment({ jobId: 'paid', kind: 'full', amountKRW: 300000, receivedAt: '2026-02-01T00:00:00Z', evidence: 'order state' });
  ledger.addReview({ jobId: 'paid', rating: 5, liked: true });
  ledger.upsertJob({ id: 'unpaid', service: 'web', title: 'Unpaid', status: 'in_progress' });
  assert.deepEqual(ids(syncPortfolio(instance, ledger)), ['job-paid', 'bg-site-a', 'bg-tool-b']);
  const saved = loadItems(instance);
  assert.equal(saved.length, 3);
  saved.find((i) => i.id === 'bg-site-a').quality = 0.9;
  writeFileSync(file, JSON.stringify(saved, null, 2) + '\n');
  const mtime = statSync(file).mtimeMs;
  const second = syncPortfolio(instance, ledger);
  assert.equal(second.length, 3);
  assert.equal(second.find((i) => i.id === 'bg-site-a').quality, 0.9);
  assert.equal(statSync(file).mtimeMs, mtime, 'unchanged items are not rewritten');
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
  ledger.close();
});

// U7.8: tier B orders by fame first, read from the item's public reach when no client names one.
test('in tier B a famous background item outranks a better-scored one without fame, and a client fame wins over reach', () => {
  const ranked = rankPortfolio([
    { id: 'scored', source: 'background', quality: 0.9 },
    { id: 'famous', source: 'background', quality: null, reach: { fame: 0.8 } },
    { id: 'quiet', source: 'background', quality: 0.5, reach: { fame: null } },
  ]);
  assert.deepEqual(ids(ranked), ['famous', 'scored', 'quiet']);
  const a = rankPortfolio([
    job('reach-only', { satisfaction: { liked: true }, client: { fame: 0.2 }, reach: { fame: 0.9 } }),
    job('client', { satisfaction: { liked: true }, client: { fame: 0.5 } }),
    job('reach', { satisfaction: { liked: true }, reach: { fame: 0.3 } }),
  ]);
  assert.deepEqual(ids(a), ['client', 'reach', 'reach-only']);
});
