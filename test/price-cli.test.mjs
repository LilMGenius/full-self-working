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

test('price covers every sampled platform, marks rows without an adapter and skips an unpriceable one by name', async () => {
  const dir = fixture();
  writeFileSync(join(dir, 'market', 'summary-20260102.json'), JSON.stringify([
    { platform: 'kmong', category: '로고 디자인', n: 30, p25: 30000, median: 59000, p75: 85000 },
    { platform: 'freelancer', category: 'Logo Design', n: 30, p25: 66000, median: 185000, p75: 330000 },
    { platform: 'fiverr', category: 'logo design', n: 30, p25: 20000, median: 40000, p75: 80000 },
  ]));
  const lines = [];
  const loadAdapter = async (id) => (['kmong', 'soomgo'].includes(id) ? async () => ({}) : null);
  const result = await run([], { instanceDir: dir, log: (l) => lines.push(l), day: '20260102', loadAdapter });
  const table = JSON.parse(readFileSync(result.file, 'utf8'));
  const freelancer = table.rows.find((r) => r.platform === 'freelancer' && r.service === 'logo_brand');
  assert.equal(freelancer.adapter, false);
  assert.equal(freelancer.basis.reviews, 0);
  assert.equal(table.sellerStats.freelancer.reviews, 0);
  assert.ok(table.rows.filter((r) => r.platform === 'kmong').every((r) => r.adapter === true));
  assert.deepEqual(table.skipped.map((s) => [s.platform, s.code]), [['fiverr', 'FSW_FEES_MISSING']]);
  assert.ok(!table.rows.some((r) => r.platform === 'fiverr'));
  assert.ok(lines.some((l) => /^price fiverr skipped: /.test(l)));
});
