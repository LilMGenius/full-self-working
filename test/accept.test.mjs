// Job acceptance renders a responsive deliverable at every viewport of the shared sweep (src/render/viewports.mjs,
// 320 to 1920 px), and a fixed-width one only at the widths its recipe states with a reason (wp9 U9.1).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runAcceptance, viewportsFor } from '../src/work/accept.mjs';
import { loadRecipe, validateRecipe } from '../src/work/recipe.mjs';
import { DEFAULT_CHROME, openRenderer } from '../src/render/html2png.mjs';
import { VIEWPORTS } from '../src/render/viewports.mjs';
import { tempDir } from './tmp.mjs';

const page = (body, css = '') => '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font-family:system-ui,sans-serif}' + css + '</style></head><body>' + body + '</body></html>';
const html = [{ path: 'site/index.html', format: 'html' }];

function workDir(files) {
  const job = tempDir('fsw-accept-');
  const work = join(job, 'work');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), body);
  }
  return { job, work };
}

// A renderer that records each render call and answers a clean probe, so the sweep is read without Chrome.
const stubRenderer = (calls) => async () => ({
  render: async (opts) => (calls.push(opts), { out: opts.out, probe: opts.probe ? { iw: opts.width, sw: opts.width, wide: [], failedFonts: [], fontStatus: 'loaded', split: [] } : null, brokenImages: [] }),
  close: async () => {},
});

test('viewportsFor sweeps the nine shared viewports without widths, and a stated width at 900 px tall', () => {
  assert.deepEqual(viewportsFor({ check: 'viewports' }), VIEWPORTS);
  assert.equal(VIEWPORTS.length, 9);
  assert.deepEqual(viewportsFor({ check: 'viewports', widths: [860], widthsReason: 'detail images' }), [{ width: 860, height: 900 }]);
});

test('a responsive page renders once per viewport in VIEWPORTS order, and a fixed-width one only at its width', async () => {
  const calls = [];
  const { job, work } = workDir({ 'site/index.html': page('<h1>빵</h1>') });
  const r = await runAcceptance(work, { deliverables: html, acceptance: [{ check: 'viewports' }] }, { openRenderer: stubRenderer(calls) });
  assert.equal(r.ok, true, r.results[0].detail);
  const firsts = calls.filter((c) => !c.fullPage);
  assert.deepEqual(firsts.map((c) => [c.width, c.height]), VIEWPORTS.map((v) => [v.width, v.height]));
  assert.equal(calls.length, 18, 'one viewport capture and one full-page capture per viewport');
  assert.deepEqual(firsts.map((c) => c.out), VIEWPORTS.map((v) => join(job, 'qa', 'site_index-' + v.width + 'x' + v.height + '.jpg')));
  assert.match(r.results[0].detail, /^1 pages clean at 320x568, 360x740, .*1920x1080$/);
  const fixed = [];
  await runAcceptance(work, { deliverables: html, acceptance: [{ check: 'viewports', widths: [860], widthsReason: 'r' }] }, { openRenderer: stubRenderer(fixed) });
  assert.deepEqual(fixed.map((c) => [c.width, c.height, Boolean(c.fullPage)]), [[860, 900, false], [860, 900, true]]);
});

test('a recipe that states widths without widthsReason is invalid, and the shipped recipes validate', () => {
  const recipe = structuredClone(loadRecipe('detail_page_design'));
  const v = recipe.acceptance.find((c) => c.check === 'viewports');
  assert.match(v.widthsReason, /860/);
  assert.deepEqual(validateRecipe(recipe), []);
  delete v.widthsReason;
  assert.ok(validateRecipe(recipe).some((e) => /acceptance\[\d+\]\.widthsReason: a fixed-width check states why/.test(e)));
  for (const id of ['landing_page_web', 'logo_brand']) assert.equal(loadRecipe(id).acceptance.find((c) => c.check === 'viewports').widths, undefined, id + ' gets the full sweep');
});

let renderer = null;
after(async () => {
  if (renderer) await (await renderer).close();
});
const hasChrome = existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME);

test('a page with a 340 px element fails at 320 under the sweep, which the old 390, 768 and 1440 list passed', { skip: !hasChrome && 'Chrome not installed', timeout: 180000 }, async () => {
  renderer ??= openRenderer();
  const shared = async () => ({ ...(await renderer), close: async () => {} });
  const { job, work } = workDir({ 'site/index.html': page('<main><h1>오늘의 빵</h1><div class="box">고정 폭 상자</div></main>', '.box{width:340px;background:#eee}') });
  const swept = await runAcceptance(work, { deliverables: html, acceptance: [{ check: 'viewports' }] }, { openRenderer: shared });
  assert.equal(swept.ok, false);
  assert.match(swept.results[0].detail, /site\/index\.html@320: horizontal overflow 340 > 320 \(div\.box\)/);
  assert.doesNotMatch(swept.results[0].detail, /@360/);
  assert.ok(existsSync(join(job, 'qa', 'site_index-320x568.jpg')));
  const old = await runAcceptance(work, { deliverables: html, acceptance: [{ check: 'viewports', widths: [390, 768, 1440], widthsReason: 'the list before wp9' }] }, { openRenderer: shared });
  assert.equal(old.ok, true, old.results[0].detail);
});
