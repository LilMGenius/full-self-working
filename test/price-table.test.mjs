// Synthetic instance only: no value here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { plan, setStatus } from '../src/outbox/index.mjs';
import { latestTable, refreshPriceTable, sellerStatsFrom, writeSellerState } from '../src/economics/price-table.mjs';
import { tempDir } from './tmp.mjs';

function fixture() {
  const dir = tempDir('fsw-price-');
  for (const f of ['profile.json', 'business.json', 'config.json']) copyFileSync(join('examples', 'instance', f), join(dir, f));
  mkdirSync(join(dir, 'market'));
  mkdirSync(join(dir, 'platforms'));
  writeFileSync(join(dir, 'market', 'summary-20260101.json'), JSON.stringify([
    { platform: 'kmong', category: '로고 디자인', n: 30, p25: 30000, median: 59000, p75: 85000 },
  ]));
  writeFileSync(join(dir, 'platforms', 'kmong-state.json'), JSON.stringify({ account: { totalJobs: 0 } }));
  writeFileSync(join(dir, 'platforms', 'soomgo-state.json'), JSON.stringify({ reviews: { count: 12 } }));
  return loadInstance({ dir });
}
const surfaces = async (id) => ['kmong', 'soomgo'].includes(id);

test('seller stats come from a review count, or from zero completed jobs, and fail by name otherwise', () => {
  assert.equal(sellerStatsFrom({ reviews: { count: 12 } }, 'x').reviews, 12);
  assert.equal(sellerStatsFrom({ account: { totalJobs: 0 } }, 'x').reviews, 0);
  assert.throws(() => sellerStatsFrom({ account: { totalJobs: 3 } }, 'x'), { code: 'FSW_SELLER_STATS_MISSING' });
  assert.throws(() => sellerStatsFrom({}, 'x'), { code: 'FSW_SELLER_STATS_MISSING' });
});

test('the table is written once and left untouched when no row changed', async () => {
  const instance = fixture();
  const first = await refreshPriceTable(instance, { adapterFor: surfaces, day: '20260101' });
  assert.equal(first.written, true);
  const file = join(instance.paths.pricing, 'price-table-20260101.json');
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).rows.some((r) => r.platform === 'kmong' && r.service === 'logo_brand'));
  const before = statSync(file).mtimeMs;
  const second = await refreshPriceTable(instance, { adapterFor: surfaces, day: '20260102' });
  assert.equal(second.written, false);
  assert.deepEqual(readdirSync(instance.paths.pricing), ['price-table-20260101.json']);
  assert.equal(statSync(file).mtimeMs, before);
  assert.equal(latestTable(instance.paths.pricing).file, file);
  assert.equal(latestTable(join(instance.dir, 'nowhere')), null);
});

test('every sampled platform is priced, rows without a surface are marked and an unpriceable one is skipped by name', async () => {
  const instance = fixture();
  writeFileSync(join(instance.paths.market, 'summary-20260102.json'), JSON.stringify([
    { platform: 'kmong', category: '로고 디자인', n: 30, p25: 30000, median: 59000, p75: 85000 },
    { platform: 'freelancer', category: 'Logo Design', n: 30, p25: 66000, median: 185000, p75: 330000 },
    { platform: 'fiverr', category: 'logo design', n: 30, p25: 20000, median: 40000, p75: 80000 },
  ]));
  const lines = [];
  const result = await refreshPriceTable(instance, { adapterFor: surfaces, day: '20260102', log: (l) => lines.push(l) });
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

test('a service with five reviews tied to its jobs leaves the first tier; the rest of the platform total ties to none', async () => {
  const instance = fixture();
  writeFileSync(join(instance.paths.market, 'summary-20260102.json'), JSON.stringify([
    { platform: 'soomgo', category: '로고 디자인', n: 30, avgKRW: 100000, minKRW: 40000, maxKRW: 300000 },
    { platform: 'soomgo', category: '썸네일 제작', n: 30, avgKRW: 60000, minKRW: 20000, maxKRW: 200000 },
  ]));
  writeFileSync(join(instance.paths.platforms, 'soomgo-state.json'), JSON.stringify({ reviews: { count: 20 } }));
  const ledger = openLedger(':memory:');
  const t = ledger.upsertThread({ platform: 'soomgo', externalId: 'c', kind: 'message' });
  for (let i = 0; i < 5; i++) {
    ledger.upsertJob({ id: 'soomgo-j' + i, threadId: t.id, platform: 'soomgo', service: 'logo_brand', status: 'closed' });
    ledger.addReview({ jobId: 'soomgo-j' + i, platform: 'soomgo', rating: 5, text: 'ok', at: '2026-01-01T00:00:00Z' });
  }
  ledger.addReview({ jobId: null, platform: 'soomgo', rating: 5, text: 'no job', at: '2026-01-01T00:00:00Z' });
  const byService = (rows) => Object.fromEntries(rows.filter((r) => r.platform === 'soomgo').map((r) => [r.service, r]));
  const tied = byService((await refreshPriceTable(instance, { adapterFor: surfaces, ledger, day: '20260102' })).rows);
  assert.deepEqual([tied.logo_brand.basis.reviews, tied.thumbnail_banner.basis.reviews], [5, 0]);
  assert.equal(tied.logo_brand.basis.median, 100000);
  assert.equal(tied.logo_brand.marketBaseKRW, 90000, 'five reviews of the service price at the median, at fit none');
  assert.equal(tied.thumbnail_banner.marketBaseKRW, Math.round((20000 + 0.35 * 40000) * 0.9 / 1000) * 1000, 'none of the 20 names the banner service');
  const none = byService((await refreshPriceTable(fixture2(instance), { adapterFor: surfaces, day: '20260103' })).rows);
  assert.equal(none.logo_brand.basis.reviews, 0, 'without a ledger no review is tied to a service');
});
const fixture2 = (instance) => loadInstance({ dir: instance.dir });

test('the table cannot be built without a surface lookup', async () => {
  await assert.rejects(refreshPriceTable(fixture(), {}), TypeError);
});

// A ledger holding quotes on kmong/logo_brand that went out at the row base an hour apart and ended as
// given; each has the observed outbox row it was read back from, with its pricing basis. reverse inserts the
// same rows, with the same times, last first.
function quoteLedger(base, statuses, { reverse = false } = {}) {
  const ledger = openLedger(':memory:');
  const entries = statuses.map((status, i) => ({ status, i }));
  for (const { status, i } of reverse ? entries.reverse() : entries) {
    const t = ledger.upsertThread({ platform: 'kmong', externalId: 'k' + i, kind: 'message' });
    const at = new Date(Date.parse('2026-01-10T03:00:00Z') + i * 3_600_000).toISOString();
    const row = plan(ledger, { platform: 'kmong', threadId: t.id, kind: 'quote', payload: { text: 'q' + i, amountKRW: base, service: 'logo_brand', decision: { quote: { amountKRW: base, pricing: { source: 'price-row', base, reference: base, complexity: 1 } } } } });
    setStatus(ledger, row.id, { from: 'planned', to: 'sending' });
    setStatus(ledger, row.id, { from: 'sending', to: 'observed', receipt: { observed: true } });
    ledger.db.prepare('UPDATE outbox SET updated_at = ? WHERE id = ?').run(at, row.id);
    const q = ledger.addQuote({ threadId: t.id, platform: 'kmong', service: 'logo_brand', amountKRW: base, costKRW: 0, status, at });
    // The deal names the quote beside the row it came from (src/deal/advance.mjs).
    ledger.addEvent({ kind: 'deal.quote_observed', platform: 'kmong', ref: 'k' + i, payload: { outboxId: row.id, quoteId: q.id } });
  }
  return ledger;
}
const logo = (rows) => rows.find((r) => r.platform === 'kmong' && r.service === 'logo_brand');
// A market well above the row's cost floor, so a learned move has room below the market base.
function wideFixture() {
  const instance = fixture();
  writeFileSync(join(instance.paths.market, 'summary-20260102.json'), JSON.stringify([{ platform: 'kmong', category: '로고 디자인', n: 30, p25: 100000, median: 200000, p75: 300000 }]));
  return instance;
}

test('five lost quotes at the market base move the row down; a rerun the same day writes nothing', async () => {
  const market = logo((await refreshPriceTable(wideFixture(), { adapterFor: surfaces, day: '20260201' })).rows);
  const instance = wideFixture();
  const ledger = quoteLedger(market.baseKRW, ['declined', 'declined', 'declined', 'expired', 'declined']);
  const first = await refreshPriceTable(instance, { adapterFor: surfaces, ledger, day: '20260201' });
  const learned = logo(first.rows);
  assert.equal(learned.learned.factor, 0.8655);
  assert.ok(learned.baseKRW < market.baseKRW && learned.baseKRW >= learned.costFloorKRW);
  assert.deepEqual([learned.learned.cases, learned.learned.priced, learned.learned.fromKRW], [5, 5, market.baseKRW]);
  assert.deepEqual(learned.packages, market.packages, 'kmong packages stay on the market base');
  const again = await refreshPriceTable(instance, { adapterFor: surfaces, ledger, day: '20260201' });
  assert.equal(again.written, false);
  assert.deepEqual(readdirSync(instance.paths.pricing), ['price-table-20260201.json']);
});

test('the same quotes inserted in another order give the same rows', async () => {
  const market = logo((await refreshPriceTable(wideFixture(), { adapterFor: surfaces, day: '20260201' })).rows);
  const order = ['declined', 'accepted', 'expired', 'declined', 'declined', 'accepted'];
  const a = await refreshPriceTable(wideFixture(), { adapterFor: surfaces, ledger: quoteLedger(market.baseKRW, order), day: '20260201' });
  const b = await refreshPriceTable(wideFixture(), { adapterFor: surfaces, ledger: quoteLedger(market.baseKRW, order, { reverse: true }), day: '20260201' });
  assert.deepEqual([logo(a.rows).learned.cases, logo(a.rows).learned.won], [6, 2]);
  assert.deepEqual(a.rows, b.rows);
});

test('without priceLearning in config the rows equal the market-only table', async () => {
  const market = (await refreshPriceTable(wideFixture(), { adapterFor: surfaces, day: '20260201' })).rows;
  const instance = wideFixture();
  delete instance.config.priceLearning;
  const off = await refreshPriceTable(instance, { adapterFor: surfaces, ledger: quoteLedger(logo(market).baseKRW, ['declined', 'declined', 'declined', 'declined', 'declined']), day: '20260201' });
  assert.deepEqual(off.rows, market.map(({ learned, ...r }) => r));
  assert.equal(logo(off.rows).learned, undefined);
});


// 080 re-audit item 1: enabling freelancer without its seller state failed the daily price job for every
// platform; the state its caller writes from the surface's reviews() lets it price.
test('an enabled freelancer without its seller state fails the table, and with the state its caller wrote it prices', async () => {
  const instance = fixture();
  instance.config.platforms.freelancer = { ...instance.config.platforms.freelancer, enabled: true };
  writeFileSync(join(instance.dir, 'market', 'summary-20260101.json'), JSON.stringify([
    { platform: 'kmong', category: '로고 디자인', n: 30, p25: 30000, median: 59000, p75: 85000 },
    { platform: 'freelancer', category: 'Web Scraping', n: 30, p25: 150000, median: 300000, p75: 600000 },
  ]));
  await assert.rejects(refreshPriceTable(instance, { adapterFor: surfaces, day: '20260101' }), { code: 'FSW_SELLER_STATS_MISSING' });
  assert.equal(writeSellerState(instance.paths.platforms, 'freelancer', { reviews: { count: 0 }, account: { totalJobs: 0 } }).written, true);
  await refreshPriceTable(instance, { adapterFor: surfaces, day: '20260101' });
  const rows = latestTable(instance.paths.pricing).table.rows.filter((r) => r.platform === 'freelancer');
  assert.ok(rows.length > 0, 'freelancer rows are priced');
});
