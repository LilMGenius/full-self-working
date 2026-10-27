// The shared render primitives: one viewport list, one inline font-face builder, and a capture that can
// prove which face drew its text (the per-node report from CDP CSS.getPlatformFontsForNode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CHROME, openRenderer } from '../src/render/html2png.mjs';
import { inlineFontFace, platformFontProblems, PRETENDARD, pretendardFontFace } from '../src/render/fonts.mjs';
import { VIEWPORTS, viewportName } from '../src/render/viewports.mjs';
import { tempDir } from './tmp.mjs';

test('the viewport list runs from a 320 px phone to a 1920 px desktop at several heights', () => {
  const widths = VIEWPORTS.map((v) => v.width);
  assert.equal(Math.min(...widths), 320);
  assert.equal(Math.max(...widths), 1920);
  assert.ok(new Set(VIEWPORTS.map((v) => v.height)).size >= 3);
  assert.ok(Object.isFrozen(VIEWPORTS));
  assert.equal(viewportName({ width: 390, height: 844 }), '390x844');
});

test('inlineFontFace builds one cached data-URL rule per file and family, and pretendardFontFace is that rule', () => {
  const rule = inlineFontFace(PRETENDARD, 'Pretendard');
  assert.ok(rule.startsWith('@font-face{font-family:"Pretendard";'));
  assert.ok(rule.includes('src:url(data:font/woff2;base64,' + readFileSync(PRETENDARD).toString('base64') + ') format("woff2")'));
  assert.equal(inlineFontFace(PRETENDARD, 'Pretendard'), rule);
  assert.equal(pretendardFontFace(), rule);
  const other = inlineFontFace(PRETENDARD, 'Brand');
  assert.ok(other.startsWith('@font-face{font-family:"Brand";'));
  assert.notEqual(other, rule);
});

test('inlineFontFace reads a replaced font file again', () => {
  const file = join(tempDir('fsw-render-font-'), 'face.woff2');
  copyFileSync(PRETENDARD, file);
  const first = inlineFontFace(file, 'Swap');
  assert.ok(first.includes(readFileSync(PRETENDARD).toString('base64')));
  writeFileSync(file, Buffer.from('another font'));
  // A replacement can keep the old modification time; the size alone still tells them apart.
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  const second = inlineFontFace(file, 'Swap');
  assert.ok(second.includes(Buffer.from('another font').toString('base64')), 'the rule still carries the old bytes');
  assert.equal(inlineFontFace(file, 'Swap'), second);
});

test('render with fontReport proves the inlined face and catches a fallback', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed', timeout: 120000 }, async () => {
  const dir = tempDir('fsw-render-test-');
  const page = (css) => '<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>' + css + '</style></head><body><h1>오늘의 빵</h1><p>Fresh bread every morning</p></body></html>';
  const renderer = await openRenderer();
  try {
    const inlined = await renderer.render({ html: page(pretendardFontFace() + 'body{font-family:"Pretendard"}'), width: 390, height: 300, out: join(dir, 'inlined.jpg'), fontReport: true });
    assert.ok(Array.isArray(inlined.platformFonts) && inlined.platformFonts.length, JSON.stringify(inlined.platformFonts));
    assert.deepEqual(platformFontProblems(inlined.platformFonts, 'Pretendard'), []);
    const serif = await renderer.render({ html: page('body{font-family:serif}'), width: 390, height: 300, out: join(dir, 'serif.jpg'), fontReport: true });
    assert.ok(platformFontProblems(serif.platformFonts, 'Pretendard').some((p) => p.startsWith('fallback font ')), JSON.stringify(serif.platformFonts));
    // Without the option the capture skips the per-node walk.
    const plain = await renderer.render({ html: page('body{font-family:serif}'), width: 390, height: 300, out: join(dir, 'plain.jpg') });
    assert.equal(plain.platformFonts, null);
  } finally {
    await renderer.close();
  }
});

// Text no element child holds: generated content, a placeholder (drawn in the input's user-agent shadow
// root) and an open shadow root. Each is drawn in Georgia on an otherwise Pretendard page.
test('the font report reaches pseudo-element content, placeholders and shadow roots', { skip: !existsSync(process.env.FSW_CHROME ?? DEFAULT_CHROME) && 'Chrome not installed', timeout: 120000 }, async () => {
  const dir = tempDir('fsw-render-test-');
  const page = (css, body) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>' + pretendardFontFace() + 'body{font-family:"Pretendard"}' + css + '</style></head><body><p>Pretendard text</p>' + body + '</body></html>';
  const cases = {
    pseudo: page('.tag::before{content:"Generated words";font-family:Georgia}', '<span class="tag"></span>'),
    placeholder: page('input{font-family:Georgia;width:300px}', '<input placeholder="Placeholder words">'),
    shadow: page('', '<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = \'<span style="font-family:Georgia">Shadow words</span>\';</script>'),
  };
  const renderer = await openRenderer();
  const missed = [];
  try {
    for (const [name, html] of Object.entries(cases)) {
      const shot = await renderer.render({ html, width: 390, height: 300, out: join(dir, name + '.jpg'), fontReport: true });
      if (!platformFontProblems(shot.platformFonts, 'Pretendard').some((p) => p.startsWith('fallback font '))) missed.push(name + ' ' + JSON.stringify(shot.platformFonts));
    }
  } finally {
    await renderer.close();
  }
  assert.deepEqual(missed, [], 'a Georgia run the report did not see');
});

