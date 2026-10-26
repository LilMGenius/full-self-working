// fsw market and fsw price: thin verbs over sampleMarket and refreshPriceTable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { run as market } from '../src/cli/market.mjs';
import { run as price } from '../src/cli/price.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance() {
  const dir = tempDir('fsw-econ-cli-');
  for (const f of ['profile.json', 'business.json', 'config.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  return loadInstance({ dir });
}
const at = () => new Date('2026-10-25T03:00:00Z');
const fake = { kmong: async () => ({ sample: async (_s, targets, { now }) => ({ rows: targets.map((t) => ({ platform: 'kmong', category: t.category, priceKRW: 50000, reviews: 3, observedAt: now().toISOString() })), errors: [] }) }) };

test('fsw market writes the day summary through the page a stub withPage serves, and refuses a platform without a sampler', async () => {
  const instance = makeInstance();
  const pages = [];
  const r = await market(['kmong'], { instance, samplers: fake, withPage: async (platform, fn, opts) => (pages.push([platform, opts.engine]), fn({})), log: () => {}, now: at });
  assert.equal(r.exitCode, 0);
  assert.ok(existsSync(r.summaryFile));
  assert.deepEqual(pages, [['kmong', 'owned']]);
  await assert.rejects(market(['upwork'], { instance, samplers: fake, withPage: async () => assert.fail('no page'), log: () => {} }), { code: 'FSW_MARKET_NO_SAMPLER' });
});

test('fsw price writes rows whose adapter flag says whether this build has a surface', async () => {
  const instance = makeInstance();
  mkdirSync(instance.paths.market, { recursive: true });
  mkdirSync(instance.paths.platforms, { recursive: true });
  writeFileSync(join(instance.paths.market, 'summary-20261025.json'), JSON.stringify([
    { platform: 'kmong', category: '로고 디자인', n: 30, p25: 30000, median: 59000, p75: 85000 },
    { platform: 'soomgo', category: '로고 디자인', n: 100, minKRW: 50000, maxKRW: 300000, avgKRW: 100000, unit: '건' },
    { platform: 'wishket', category: '랜딩ㆍ소개 페이지', n: 10, p25: 3000000, median: 5000000, p75: 8000000 },
  ]));
  writeFileSync(join(instance.paths.platforms, 'kmong-state.json'), JSON.stringify({ account: { totalJobs: 0 } }));
  writeFileSync(join(instance.paths.platforms, 'soomgo-state.json'), JSON.stringify({ reviews: { count: 0 } }));
  const r = await price([], { instance, log: () => {} });
  assert.equal(r.exitCode, 0);
  const flags = Object.fromEntries(r.rows.map((x) => [x.platform, x.adapter]));
  assert.deepEqual([flags.kmong, flags.soomgo, flags.wishket], [true, true, false]);
  assert.match(readFileSync(r.file, 'utf8'), /"adapter": true/);
});
