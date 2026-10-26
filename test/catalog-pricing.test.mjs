// The soomgo guides the mobile and ERP services are sampled on give each a viable price row, so a
// request quote is computed instead of going to the operator. Guide figures are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir } from '../src/core/instance.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { catalog, targetsFor } from '../src/economics/catalog.mjs';
import { buildPriceTable } from '../src/economics/pricing.mjs';
import { summarizeDay } from '../src/economics/market.mjs';

const guide = (avgKRW, minKRW, maxKRW) => ({ avgKRW, minKRW, maxKRW, unit: '건', quoteRequests: 1000, activePros: 1000 });

test('the Android and ERP guides are sampled and price mobile_app_dev and erp_dev', () => {
  const sampled = targetsFor('soomgo').map((t) => t.category);
  assert.ok(sampled.includes('안드로이드 개발') && sampled.includes('ERP 개발'));
  assert.ok(targetsFor('kmong').some((t) => t.category === '모바일 앱' && t.def === catalog.mobile_app_dev));
  const at = '2026-10-26T00:00:00.000Z';
  const rows = [['안드로이드 개발', guide(1500000, 300000, 10000000)], ['ERP 개발', guide(2000000, 300000, 15000000)]];
  const summary = { observedAt: '2026-10-26', entries: summarizeDay(rows.map(([category, g]) => ({ platform: 'soomgo', category, url: 'https://soomgo.com/prices/x', guide: g, observedAt: at }))) };
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  const table = buildPriceTable({ summary, services: catalog, profile: {}, sellerStats: { soomgo: { reviews: 0 } }, config, descriptors: { soomgo: loadDescriptor('soomgo') } });
  const priced = Object.fromEntries(table.map((r) => [r.service, r]));
  assert.deepEqual(Object.keys(priced).sort(), ['erp_dev', 'mobile_app_dev']);
  assert.ok(priced.mobile_app_dev.viable && priced.erp_dev.viable);
  assert.ok(priced.mobile_app_dev.baseKRW >= priced.mobile_app_dev.costFloorKRW);
});
