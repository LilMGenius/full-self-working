import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { appendedDetail } from '../src/platforms/soomgo/edits.mjs';
import { run } from '../src/cli/edits.mjs';
import { tempDir } from './tmp.mjs';

test('the detail paragraph is appended after a blank line once and never twice', () => {
  assert.equal(appendedDetail('기존 소개입니다.\n', '외주도 맡습니다.'), '기존 소개입니다.\n\n외주도 맡습니다.');
  assert.equal(appendedDetail('기존 소개입니다.\n\n외주도 맡습니다.', '외주도 맡습니다.'), null);
  assert.equal(appendedDetail('', '외주도 맡습니다.'), '외주도 맡습니다.');
  assert.throws(() => appendedDetail('기존', '  '), RangeError);
});

function setup(edits) {
  const dir = tempDir('fsw-edits-');
  for (const f of ['profile.json', 'business.json', 'config.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const instance = loadInstance({ dir });
  mkdirSync(instance.paths.platforms, { recursive: true });
  writeFileSync(join(instance.paths.platforms, 'soomgo-edits.json'), JSON.stringify(edits));
  mkdirSync(instance.paths.pricing, { recursive: true });
  writeFileSync(join(instance.paths.pricing, 'price-table-20261025.json'), JSON.stringify({ rows: [{ platform: 'soomgo', service: 'landing_page_web', baseKRW: 575000 }] }));
  const calls = [];
  const writers = {
    setIntro: async (s, text, o) => (calls.push(['intro', text, o.dryRun]), { changed: true, saved: !o.dryRun }),
    appendServiceDetail: async (s, text, o) => (calls.push(['detail', text, o.dryRun]), { changed: true, saved: !o.dryRun }),
    addQuoteTemplate: async (s, t, o) => (calls.push(['template', t.title, t.costKRW, o.dryRun]), { changed: true, saved: !o.dryRun }),
    addService: async (s, name, o) => (calls.push(['service', name, o.dryRun]), { changed: true, saved: !o.dryRun }),
  };
  const events = [];
  const ctx = { instance, writers, session: {}, ledger: { addEvent: (e) => events.push(e) }, log: () => {} };
  return { ctx, calls, events };
}

const EDITS = {
  approved: { intro: true, detail: false, templates: true, services: false },
  intro: '전 스타트업 리드 개발자 | 웹과 자동화를 끝까지 만드는 개발자',
  detailAppend: '레슨 외에 외주 제작도 맡습니다.',
  templates: [
    { title: '랜딩 페이지 제작', service: 'landing_page_web', priceType: 'total', description: '랜딩 페이지를 기획부터 배포까지 진행합니다.' },
    { title: '없는 서비스', service: 'no_such_service', priceType: 'total', description: '가격 행이 없는 서비스입니다.' },
  ],
  addServices: ['데이터 크롤링'],
};

test('a dry run types every part, approved or not, and saves nothing', async () => {
  const { ctx, calls, events } = setup(EDITS);
  assert.equal(await run(['soomgo'], ctx), 1);
  assert.deepEqual(calls, [['intro', EDITS.intro, true], ['detail', EDITS.detailAppend, true], ['template', '랜딩 페이지 제작', 575000, true], ['service', '데이터 크롤링', true]]);
  assert.equal(events.length, 0);
});

test('--apply saves only approved parts, prices a template from the newest price table and fails one with no row', async () => {
  const { ctx, calls, events } = setup(EDITS);
  assert.equal(await run(['soomgo', '--apply'], ctx), 1);
  assert.deepEqual(calls, [['intro', EDITS.intro, false], ['template', '랜딩 페이지 제작', 575000, false]]);
  assert.deepEqual(events.map((e) => e.ref), ['intro', 'templates']);
});

test('a part the outbound gate refuses is never typed', async () => {
  const { ctx, calls } = setup({ ...EDITS, intro: '문의는 010-1234-5678 로 주세요', templates: [] });
  assert.equal(await run(['soomgo', '--apply', '--only', 'intro'], ctx), 1);
  assert.deepEqual(calls, []);
});


// The profile editors open by a button found through a DOM query; a whole-page snapshot throws here.
test('the intro editor opens by its button through a DOM query, and a dry run saves nothing', async () => {
  const { setIntro, pageMarkButton } = await import('../src/platforms/soomgo/edits.mjs');
  const state = { value: '이전 소개', clicked: [], pressed: [] };
  const button = (label) => { const b = { innerText: label, disabled: false, attrs: {}, getBoundingClientRect: () => ({ width: 40, height: 20 }), setAttribute: (k, v) => { b.attrs[k] = v; }, click: () => state.pressed.push(label) }; return b; };
  const buttons = [button('내 소개 편집'), button('저장')];
  const s = {
    navigate: async () => {},
    snapshot: async () => { throw new Error('a soomgo read took a whole-page snapshot'); },
    click: async (ref) => state.clicked.push([ref, buttons.find((b) => b.attrs['data-fsw'] === 'edit-open')?.innerText]),
    fill: async (_sel, v) => { state.value = v; },
    evaluate: async (fn, arg) => {
      globalThis.document = { querySelectorAll: (sel) => (sel === 'button' ? buttons : []), querySelector: () => ({ value: state.value }) };
      try { return fn(arg); } finally { delete globalThis.document; }
    },
  };
  const r = await setIntro(s, '새 소개', { dryRun: true, wait: async () => {} });
  assert.deepEqual(r, { part: 'intro', changed: true, saved: false, dryRun: true, before: '이전 소개' });
  assert.deepEqual(state.clicked, [['[data-fsw="edit-open"]', '내 소개 편집']]);
  assert.deepEqual(state.pressed, []);
  globalThis.document = { querySelectorAll: () => [] };
  try { assert.equal(pageMarkButton('추가하기'), null); } finally { delete globalThis.document; }
});