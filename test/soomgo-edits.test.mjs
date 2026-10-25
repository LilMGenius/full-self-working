import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { appendedDetail } from '../src/platforms/soomgo/edits.mjs';
import { run } from '../src/cli/edits.mjs';

test('the detail paragraph is appended after a blank line once and never twice', () => {
  assert.equal(appendedDetail('기존 소개입니다.\n', '외주도 맡습니다.'), '기존 소개입니다.\n\n외주도 맡습니다.');
  assert.equal(appendedDetail('기존 소개입니다.\n\n외주도 맡습니다.', '외주도 맡습니다.'), null);
  assert.equal(appendedDetail('', '외주도 맡습니다.'), '외주도 맡습니다.');
  assert.throws(() => appendedDetail('기존', '  '), RangeError);
});

function setup(edits) {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-edits-'));
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
  };
  const events = [];
  const ctx = { instance, writers, session: {}, ledger: { addEvent: (e) => events.push(e) }, log: () => {} };
  return { ctx, calls, events };
}

const EDITS = {
  approved: { intro: true, detail: false, templates: true },
  intro: '전 스타트업 리드 개발자 | 웹과 자동화를 끝까지 만드는 개발자',
  detailAppend: '레슨 외에 외주 제작도 맡습니다.',
  templates: [
    { title: '랜딩 페이지 제작', service: 'landing_page_web', priceType: 'total', description: '랜딩 페이지를 기획부터 배포까지 진행합니다.' },
    { title: '없는 서비스', service: 'no_such_service', priceType: 'total', description: '가격 행이 없는 서비스입니다.' },
  ],
};

test('a dry run types every part, approved or not, and saves nothing', async () => {
  const { ctx, calls, events } = setup(EDITS);
  assert.equal(await run(['soomgo'], ctx), 1);
  assert.deepEqual(calls, [['intro', EDITS.intro, true], ['detail', EDITS.detailAppend, true], ['template', '랜딩 페이지 제작', 575000, true]]);
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

