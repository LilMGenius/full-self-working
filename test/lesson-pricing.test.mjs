import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir } from '../src/core/instance.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { buildPriceTable, guideOf, quoteForRequest } from '../src/economics/pricing.mjs';
import { summarizeDay } from '../src/economics/market.mjs';
import { parseGuide } from '../src/platforms/soomgo/market.mjs';
import catalog from '../src/economics/services.json' with { type: 'json' };

const LESSON = '프로그래밍/코딩 레슨';
// The lesson guide as its page printed it on 2026-10-25: only the hourly average, no 최저 or 최고.
const LESSON_GUIDE = '프로그래밍/코딩 레슨\n종합 가격 정보\n평균\n월\n누적 견적요청\n99,042건\n활동고수\n21,516명\n프로그래밍/코딩 레슨은 시간당 비용이 달라져요. 숨고 내에서 거래되는 프로그래밍/코딩 레슨의 평균 비용은 시간당 35,000원이에요.';

test('a guide that prints only its average parses, and one that names a minimum it cannot read still fails', () => {
  assert.deepEqual(parseGuide(LESSON_GUIDE), { avgKRW: 35000, minKRW: null, maxKRW: null, unit: '시간', quoteRequests: 99042, activePros: 21516 });
  assert.throws(() => parseGuide('평균\n7만\n최저\n?\n평균 비용은 건당 79,000원이에요.'), /price guide figures not found/);
});

test('an average-only guide gives the lesson service a price row whose request quote lands on the average', () => {
  const soomgo = loadDescriptor('soomgo');
  const at = '2026-10-25T00:00:00.000Z';
  const summary = { observedAt: '2026-10-25', entries: summarizeDay([{ platform: 'soomgo', category: LESSON, url: 'https://soomgo.com/prices/x', guide: parseGuide(LESSON_GUIDE), observedAt: at }]) };
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  const [row] = buildPriceTable({ summary, services: { lesson_tutoring: catalog.lesson_tutoring }, profile: {}, sellerStats: { soomgo: { reviews: 0 } }, config, descriptors: { soomgo } });
  assert.deepEqual([row.service, row.viable, row.costFloorKRW, row.basis.high], ['lesson_tutoring', true, 30000, 35000]);
  const quote = quoteForRequest({ guide: guideOf(row), complexity: 1.4, row, descriptor: soomgo, config, quoteCostKRW: 1990 });
  assert.equal(quote.amountKRW, 35000);
});
