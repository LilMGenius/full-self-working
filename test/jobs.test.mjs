import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { imageSize, runAcceptance } from '../src/jobs/accept.mjs';

// A real PNG of the given size (white, 8-bit grey), so the header parser reads what a renderer writes.
function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function workDir(files) {
  const job = mkdtempSync(join(tmpdir(), 'fsw-accept-'));
  const work = join(job, 'work');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), body);
  }
  return { job, work };
}

const recipe = (deliverables, acceptance) => ({ deliverables, acceptance });
const page = (body, css = '') => '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font-family:system-ui,sans-serif}' + css + '</style></head><body>' + body + '</body></html>';

test('the image check fails a PNG of the wrong size and passes the right one', async () => {
  const { work } = workDir({ 'logo/a.png': png(800, 600), 'logo/b.png': png(1024, 1024) });
  const r = await runAcceptance(work, recipe([{ path: 'logo/*.png', format: 'png', constraints: { width: 1024, height: 1024 } }], [{ check: 'files' }, { check: 'image' }]));
  assert.equal(r.ok, false);
  const image = r.results.find((x) => x.check === 'image');
  assert.equal(image.ok, false);
  assert.match(image.detail, /logo\/a\.png: width 800 is not 1024, height 600 is not 1024/);
  assert.doesNotMatch(image.detail, /logo\/b\.png/);
  assert.equal(r.results.find((x) => x.check === 'files').ok, true);
  assert.deepEqual(imageSize(png(3, 2)), { type: 'png', width: 3, height: 2 });
});

test('the files check fails a missing deliverable and a file whose bytes are not its format', async () => {
  const { work } = workDir({ 'export/a.png': 'not really a png' });
  const r = await runAcceptance(work, recipe([{ path: 'export/*.png', format: 'png' }, { path: 'site/index.html', format: 'html' }], [{ check: 'files' }]));
  assert.equal(r.ok, false);
  assert.match(r.results[0].detail, /export\/a\.png: not a PNG/);
  assert.match(r.results[0].detail, /site\/index\.html: no file/);
});

test('sloplint fails a floor phrase in HTML text, including one written as an entity', async () => {
  const { work } = workDir({ 'site/index.html': page('<h1>빵집 &mdash; 매일 아침</h1><p>갓 구운 빵을 드립니다.</p>') });
  const r = await runAcceptance(work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'sloplint' }]));
  assert.equal(r.ok, false);
  assert.match(r.results[0].detail, /site\/index\.html em_dash/);
  const clean = workDir({ 'site/index.html': page('<h1>빵집, 매일 아침</h1><style>p::before{content:"\\2014"}</style>') });
  assert.equal((await runAcceptance(clean.work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'sloplint' }]))).ok, true);
});

test('viewports fails a page that overflows at phone width and writes JPEG captures under qa/', { timeout: 120000 }, async () => {
  const wide = page('<main><h1>오늘의 빵</h1><div class="strip">가로로 넘치는 띠</div></main>', '.strip{width:900px;background:#eee}');
  const { job, work } = workDir({ 'site/index.html': wide });
  const r = await runAcceptance(work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'viewports', widths: [390, 1440] }]));
  const v = r.results[0];
  assert.equal(v.ok, false, v.detail);
  assert.match(v.detail, /site\/index\.html@390: horizontal overflow 900 > 390 \(div\.strip\)/);
  assert.doesNotMatch(v.detail, /@1440/);
  for (const name of ['site_index-390.jpg', 'site_index-1440.jpg', 'site_index-390-full.jpg']) {
    const file = join(job, 'qa', name);
    assert.ok(existsSync(file), name);
  }
});

test('a check that cannot run is a failure with its cause', async () => {
  const { work } = workDir({ 'site/index.html': page('<p>안녕하세요</p>') });
  const noChrome = async () => {
    throw Object.assign(new Error('Chrome not found at nowhere'), { code: 'FSW_RENDER_NO_CHROME' });
  };
  const r = await runAcceptance(work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'viewports' }, { check: 'command', run: 'node -e "process.exit(3)"' }, { check: 'command', run: 'node -e ""', cwd: 'missing' }]), { openRenderer: noChrome });
  assert.equal(r.ok, false);
  assert.match(r.results[0].detail, /renderer did not start: FSW_RENDER_NO_CHROME/);
  assert.match(r.results[1].detail, /exited 3/);
  assert.match(r.results[2].detail, /directory missing does not exist/);
});
