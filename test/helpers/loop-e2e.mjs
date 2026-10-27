// The D1 scenario of 030 section 7.11, shared by test/loop.e2e.test.mjs (replayed surfaces) and the
// fixture recorder (scripted driver sessions under recordSession): one kmong inquiry answered and one soomgo
// request carried from its quote to a closed job, through the real ledger, decide, triage, authorize, outbox,
// deal, work runner and loop. Only the model turns and the job process are stubbed; Date is held at each
// tick's Seoul time so ledger stamps, the soomgo cash history and the money lookback read one clock.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mock } from 'node:test';
import { exampleDir, loadInstance } from '../../src/core/instance.mjs';
import { openLedger } from '../../src/core/ledger.mjs';
import { loadDescriptor } from '../../src/platforms/registry.mjs';
import { resolve } from '../../src/outbox/index.mjs';
import { advance } from '../../src/deal/index.mjs';
import { applyEffects, runJobWithDeal, step } from '../../src/loop/index.mjs';
import { loadRecipe } from '../../src/work/index.mjs';
import { rankPortfolio } from '../../src/portfolio/rank.mjs';
import { loadItems } from '../../src/portfolio/store.mjs';
import { tempDir } from '../tmp.mjs';

const seoul = (hm) => '2026-10-20T' + hm + ':00+09:00';
export const TICKS = [
  { n: 1, platform: 'kmong', at: seoul('10:00') },
  { n: 2, platform: 'soomgo', at: seoul('10:05') },
  { n: 3, platform: 'soomgo', at: seoul('11:00') },
  { n: 4, platform: 'soomgo', at: seoul('11:05') },
  { n: 5, platform: 'soomgo', at: seoul('12:00') },
  { n: 6, platform: 'soomgo', at: seoul('12:05') },
  { n: 7, platform: 'soomgo', at: seoul('12:10') },
  { n: 8, platform: 'soomgo', at: seoul('14:00') },
  { n: 9, platform: 'soomgo', at: seoul('15:00') },
  { n: 10, platform: 'soomgo', at: seoul('15:05') },
];
export const fixturePath = (root, platform, n) => join(root, 'test', 'fixtures', 'loop-e2e', platform + '-t' + n + '.jsonl');

export const KMONG_REPLY = '안녕하세요. 랜딩 페이지 제작 가능합니다. 원하시는 구성과 일정을 알려 주시면 범위를 정리해 드리겠습니다.';
export const QUOTE_REPLY = '요청하신 회사 소개 랜딩 페이지를 한 페이지로 만들어 드립니다. 휴대폰과 컴퓨터 화면에 맞춰 만들고 올리는 방법도 함께 안내해 드립니다. 착수금과 잔금으로 나누어 결제하시면 됩니다.';
const base = { language: 'ko', needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null, service: 'landing_page_web' };
const KMONG_DECISION = { ...base, intent: 'inquiry', reply: KMONG_REPLY, quote: null };
const SOOMGO_DECISION = { ...base, intent: 'quote_request', reply: QUOTE_REPLY, quote: { amountKRW: 1, scope: ['회사 소개 랜딩 페이지 1개', '휴대폰과 컴퓨터 화면 대응', '올리는 방법 안내'], deliveryDays: 7, priceType: 'fixed', complexity: 1 } };

export const PRICE_TABLE = [
  { platform: 'soomgo', service: 'landing_page_web', category: '웹 개발', baseKRW: 300000, floorKRW: 100000, ceilingKRW: 1000000, costFloorKRW: 50000, viable: true, basis: { source: 'price-guide', median: 300000, p25: 100000, high: 1000000 } },
  { platform: 'kmong', service: 'landing_page_web', baseKRW: 300000, floorKRW: 150000, ceilingKRW: 900000, viable: true, basis: { source: 'listing-quantiles' } },
];

export const SITE_HTML = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>회사 소개</title></head><body><h1>회사 소개</h1><p>작은 공방이 만드는 제품과 찾아오는 길을 한 페이지에 담았습니다.</p></body></html>\n';
export const HOSTING_MD = '# 올리는 방법\n\nindex.html 파일 하나를 정적 호스팅 서비스에 올리면 바로 열립니다.\n';

function makeInstance() {
  const dir = tempDir('fsw-e2e-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  for (const id of Object.keys(config.platforms)) config.platforms[id] = { ...config.platforms[id], enabled: false };
  config.platforms.kmong = { ...config.platforms.kmong, enabled: true, mode: 'auto' };
  config.platforms.soomgo = { ...config.platforms.soomgo, enabled: true, mode: 'auto', maxQuotesPerDay: 5, maxCashPerDay: 5000 };
  config.notify = { toast: false, webhookUrl: null };
  config.jobs = { ...config.jobs, maxParallel: 1 };
  config.activeHours = { outbound: ['08:00', '23:00'] };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

// The landing page recipe with acceptance cut to files and sloplint and no skill files, so no browser or
// plugin is needed.
function recipeDir() {
  const dir = tempDir('fsw-e2e-recipes-');
  const recipe = loadRecipe('landing_page_web');
  writeFileSync(join(dir, 'landing_page_web.json'), JSON.stringify({ ...recipe, steps: recipe.steps.map(({ skill, ...s }) => s), acceptance: [{ check: 'files' }, { check: 'sloplint' }] }));
  return dir;
}

const decideCodex = async ({ prompt }) => ({ data: structuredClone(/This is a buyer request/.test(prompt) ? SOOMGO_DECISION : KMONG_DECISION), durationMs: 1 });
const jobCodex = async ({ cwd }) => {
  for (const [rel, body] of [['site/index.html', SITE_HTML], ['site/HOSTING.md', HOSTING_MD]]) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), body);
  }
  return { data: { summary: 'one landing page and its hosting guide', files: ['site/index.html', 'site/HOSTING.md'], openQuestions: [] }, durationMs: 1 };
};

// open(platform, n) -> the surface tick n reads through. Returns the instance, the ledger, each tick's step
// result with its surface, and the ranked portfolio before the permission signal.
export async function driveLoop({ open }) {
  const instance = makeInstance();
  const ledger = openLedger(instance.paths.ledger);
  const recipes = recipeDir();
  const load = (service) => loadRecipe(service, { dir: recipes });
  const pending = [];
  const spawnJob = (_instance, id) => {
    pending.push(() => runJobWithDeal(id, { instance, ledger, executors: { runCodex: jobCodex }, recipeDir: recipes }));
    return { pid: process.pid, log: 'runner.log' };
  };
  const ticks = [];
  const awaiting = (kind) => ledger.listOutbox({ statuses: ['awaiting_operator'], kinds: [kind] });
  mock.timers.enable({ apis: ['Date'], now: Date.parse(TICKS[0].at) });
  try {
    for (const t of TICKS) {
      mock.timers.setTime(Date.parse(t.at));
      let surface = null;
      const result = await step(t.platform, { instance, ledger, now: new Date(), priceTable: PRICE_TABLE, runCodex: decideCodex, spawnJob, loadRecipe: load, openSurface: async (p) => (surface = await open(p, t.n)) });
      ticks.push({ ...t, result, surface });
      if (t.n === 3) for (const r of awaiting('pay_request')) resolve(ledger, r.approvalId, { approve: true });
      if (t.n === 5) for (const run of pending.splice(0)) await run();
      // The jobs build on the fresh-instance model, so the review records error (same family) and the operator
      // approves the delivery with a reason (src/outbox/resolve.mjs).
      if (t.n === 6) for (const r of [...awaiting('delivery'), ...awaiting('pay_request')]) resolve(ledger, r.approvalId, { approve: true, ...(r.kind === 'delivery' ? { reason: 'files read by hand' } : {}) });
    }
    const portfolioBefore = rankPortfolio(loadItems(instance)).map((i) => i.id);
    const now = new Date();
    const granted = advance(ledger, { type: 'permission_granted', platform: 'soomgo', jobId: 'soomgo-r100', at: now.toISOString(), evidence: { source: 'operator' } }, { instance, descriptor: loadDescriptor('soomgo'), now });
    await applyEffects(granted.effects, { instance, ledger });
    return { instance, ledger, ticks, portfolioBefore };
  } finally {
    mock.timers.reset();
  }
}
