// The site sweep against real pages: three planted defects, a clean page, the static host's refusals, the CLI exit
// codes, and the fixture site built by buildSite, swept over http clean while its file URLs fall back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSite } from '../site/build.mjs';
import { checkPage } from '../src/render/checks.mjs';
import { PRETENDARD } from '../src/render/fonts.mjs';
import { DEFAULT_CHROME, openRenderer } from '../src/render/html2png.mjs';
import { serveDir, sweep } from '../scripts/site-sweep.mjs';
import { writeSiteFixture } from './fixtures/site-instance.mjs';
import { tempDir } from './tmp.mjs';

const chrome = { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed' };
const PHONE = [{ width: 320, height: 568 }];

// A one-page site that loads its font by a root-relative URL, as the built site does.
function site(body, extraHead = '') {
  const dir = tempDir('fsw-sweep-');
  mkdirSync(join(dir, 'assets'), { recursive: true });
  copyFileSync(PRETENDARD, join(dir, 'assets', 'sans.woff2'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:"Site Sans";src:url("/assets/sans.woff2") format("woff2");font-weight:100 900}body{margin:0;font-family:"Site Sans"}</style>' + extraHead + '</head><body>' + body + '</body></html>');
  return dir;
}

const get = (origin, path) => new Promise((ok, fail) => {
  const req = request(origin + path, (res) => {
    res.resume();
    res.on('end', () => ok(res.statusCode));
  });
  req.on('error', fail);
  req.end();
});

test('the static host serves the folder, answers 404 for a missing file and 403 for a path outside it', async () => {
  const dir = site('<p>안녕하세요</p>');
  const host = await serveDir(dir);
  try {
    assert.equal(await get(host.origin, '/'), 200);
    assert.equal(await get(host.origin, '/assets/sans.woff2'), 200);
    assert.equal(await get(host.origin, '/media/missing.png'), 404);
    assert.equal(await get(host.origin, '/..%2f..%2fsecret.txt'), 403);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overflow, a fallback font and a broken image each name their problem; a clean page has none', chrome, async () => {
  const cases = [
    ['<p>깔끔한 페이지입니다.</p>', []],
    ['<p>넓은 블록</p><div style="width:2000px;height:10px"></div>', [/^index\.html@320x568: horizontal overflow 2000 > 320 \(div\)$/]],
    ['<p style="font-family:Arial">Fallback text</p>', [/^index\.html@320x568: fallback font .+ drew \d+ glyphs$/]],
    ['<p>이미지</p><img src="/media/missing.png" alt="">', [/^index\.html@320x568: broken image .*\/media\/missing\.png$/]],
  ];
  for (const [body, expected] of cases) {
    const dir = site(body);
    try {
      const report = await sweep({ dist: dir, out: join(dir, '..', 'sweep-' + Date.now()), family: 'Pretendard', viewports: PHONE });
      assert.equal(report.problems.length, expected.length, body + ': ' + report.problems.join(' | '));
      expected.forEach((re, k) => assert.match(report.problems[k], re));
      assert.deepEqual(report.captures, ['index-320x568.jpg']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the CLI exits 1 on a problem and 0 on a clean site', chrome, () => {
  const run = (dir) => {
    try {
      execFileSync(process.execPath, ['scripts/site-sweep.mjs', '--dist', dir, '--out', join(dir, '..', 'cli-' + Date.now())], { stdio: 'pipe' });
      return 0;
    } catch (err) {
      return err.status;
    }
  };
  const bad = site('<div style="width:2000px">넓은 블록</div>');
  const good = site('<p>깔끔한 페이지입니다.</p>');
  try {
    assert.equal(run(bad), 1);
    assert.equal(run(good), 0);
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  }
});

test('the fixture site built by buildSite sweeps clean over http, while its pages rendered by file URL fall back', chrome, async (t) => {
  const dir = writeSiteFixture(tempDir('fsw-sweep-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const built = await buildSite({ instance: dir, out: join(dir, 'dist') });
  const report = await sweep({ dist: built.out, out: join(dir, 'sweep') });
  assert.deepEqual(report.problems, []);
  assert.equal(report.captures.length, 3 * 9);
  const renderer = await openRenderer();
  try {
    const problems = await checkPage(renderer, { url: pathToFileURL(join(built.out, 'index.html')).href, viewport: { width: 1440, height: 900 }, family: 'Pretendard', label: 'index.html', out: join(dir, 'file-url.jpg') });
    assert.ok(problems.some((p) => /fallback font|reported no fonts/.test(p)), problems.join(' | '));
  } finally {
    await renderer.close();
  }
});

