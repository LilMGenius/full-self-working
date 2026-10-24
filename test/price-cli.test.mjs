// Synthetic instance only: no value here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, sellerStatsFrom } from '../src/cli/price.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-price-'));
  for (const f of ['profile.json', 'business.json', 'config.json']) copyFileSync(join('examples', 'instance', f), join(dir, f));
  mkdirSync(join(dir, 'market'));
  mkdirSync(join(dir, 'platforms'));
  writeFileSync(join(dir, 'market', 'summary-20260101.json'), JSON.stringify([
    { platform: 'kmong', category: '로고 디자인', n: 30, p25: 30000, median: 59000, p75: 85000 },
  ]));
  writeFileSync(join(dir, 'platforms', 'kmong-state.json'), JSON.stringify({ account: { totalJobs: 0 } }));
  writeFileSync(join(dir, 'platforms', 'soomgo-state.json'), JSON.stringify({ reviews: { count: 12 } }));
  return dir;
}

test('seller stats come from a review count, or from zero completed jobs, and fail by name otherwise', () => {
  assert.equal(sellerStatsFrom({ reviews: { count: 12 } }, 'x').reviews, 12);
  assert.equal(sellerStatsFrom({ account: { totalJobs: 0 } }, 'x').reviews, 0);
  assert.throws(() => sellerStatsFrom({ account: { totalJobs: 3 } }, 'x'), { code: 'FSW_SELLER_STATS_MISSING' });
  assert.throws(() => sellerStatsFrom({}, 'x'), { code: 'FSW_SELLER_STATS_MISSING' });
});

test('price writes the table once and leaves it untouched when no row changed', async () => {
  const dir = fixture();
  const lines = [];
  const first = await run([], { instanceDir: dir, log: (l) => lines.push(l), day: '20260101' });
  assert.equal(first.written, true);
  const file = join(dir, 'pricing', 'price-table-20260101.json');
  const rows = JSON.parse(readFileSync(file, 'utf8')).rows;
  assert.ok(rows.some((r) => r.platform === 'kmong' && r.service === 'logo_brand'));
  const before = statSync(file).mtimeMs;
  const second = await run([], { instanceDir: dir, log: (l) => lines.push(l), day: '20260102' });
  assert.equal(second.written, false);
  assert.deepEqual(readdirSync(join(dir, 'pricing')), ['price-table-20260101.json']);
  assert.equal(statSync(file).mtimeMs, before);
});
