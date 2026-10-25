// Deterministic acceptance checks over jobs/<id>/work (docs/DESIGN.md, Jobs). Each recipe acceptance
// entry yields one result {check, ok, detail}; a check that cannot run (no Chrome, a command that will not
// start, no file to look at) is a failure carrying its cause, never a pass.
import { spawn } from 'node:child_process';
import { existsSync, globSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lintText } from '../policy/slop.mjs';
import { openRenderer as defaultOpenRenderer } from '../render/html2png.mjs';
import { IMAGE_FORMATS, LINT_FORMATS } from './recipe.mjs';

export const DEFAULT_WIDTHS = [390, 768, 1440];
const VIEWPORT_HEIGHT = { 390: 844, 768: 1024 };
const CAPTURE_MAX_SIDE = 1600;

// Files under work/ matching a recipe glob, as forward-slash paths relative to work/.
export function matchFiles(workDir, pattern) {
  return globSync(pattern, { cwd: workDir })
    .map((p) => p.split('\\').join('/'))
    .filter((p) => statSync(join(workDir, p)).isFile())
    .sort();
}

const EXTENSIONS = {
  html: ['.html', '.htm'], png: ['.png'], jpeg: ['.jpg', '.jpeg'], image: ['.png', '.jpg', '.jpeg'], svg: ['.svg'], pdf: ['.pdf'],
  md: ['.md'], txt: ['.txt'], csv: ['.csv'], srt: ['.srt'], json: ['.json'], js: ['.js', '.mjs', '.cjs'], py: ['.py'], bas: ['.bas'],
  xlsx: ['.xlsx'], xlsm: ['.xlsm'], pptx: ['.pptx'], docx: ['.docx'], zip: ['.zip'], mp4: ['.mp4', '.m4v'],
};
const ZIP_FORMATS = ['xlsx', 'xlsm', 'pptx', 'docx', 'zip'];

export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Walks JPEG segments to the first start-of-frame marker (C0 to CF except DHT C4, JPG C8 and DAC CC).
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { type: 'jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + length;
  }
  return null;
}

export const imageSize = (buf) => pngSize(buf) ?? jpegSize(buf);

// Returns null when the file is what its format says, or the reason it is not.
function formatProblem(file, format) {
  const ext = extname(file).toLowerCase();
  if (!EXTENSIONS[format].includes(ext)) return 'extension ' + (ext || 'none') + ' is not ' + format;
  const buf = readFileSync(file);
  if (!buf.length) return 'empty file';
  if (format === 'png' && !pngSize(buf)) return 'not a PNG';
  if (format === 'jpeg' && !jpegSize(buf)) return 'not a JPEG';
  if (format === 'image' && !imageSize(buf)) return 'neither PNG nor JPEG';
  if (format === 'pdf' && buf.toString('latin1', 0, 5) !== '%PDF-') return 'not a PDF';
  if (ZIP_FORMATS.includes(format) && buf.readUInt32LE(0) !== 0x04034b50) return 'not a zip container';
  if (format === 'mp4' && buf.toString('latin1', 4, 8) !== 'ftyp') return 'not an MP4';
  if (format === 'svg' && !/<svg[\s>]/i.test(buf.toString('utf8'))) return 'no <svg> element';
  if (format === 'html' && !/<html[\s>]|<body[\s>]|<!doctype html/i.test(buf.toString('utf8'))) return 'no html document';
  if (format === 'json') {
    try {
      JSON.parse(buf.toString('utf8'));
    } catch (e) {
      return 'invalid JSON: ' + e.message;
    }
  }
  return null;
}

function checkFiles(workDir, recipe) {
  const problems = [];
  let count = 0;
  for (const d of recipe.deliverables) {
    const files = matchFiles(workDir, d.path);
    if (!files.length) problems.push(d.path + ': no file');
    for (const f of files) {
      count++;
      const p = formatProblem(join(workDir, f), d.format);
      if (p) problems.push(f + ': ' + p);
    }
  }
  return { ok: !problems.length, detail: problems.length ? problems.join('; ') : count + ' files match ' + recipe.deliverables.length + ' deliverables' };
}

function sizeProblem(size, c) {
  const out = [];
  if (c.width != null && size.width !== c.width) out.push('width ' + size.width + ' is not ' + c.width);
  if (c.height != null && size.height !== c.height) out.push('height ' + size.height + ' is not ' + c.height);
  if (c.minWidth != null && size.width < c.minWidth) out.push('width ' + size.width + ' below ' + c.minWidth);
  if (c.maxWidth != null && size.width > c.maxWidth) out.push('width ' + size.width + ' above ' + c.maxWidth);
  if (c.minHeight != null && size.height < c.minHeight) out.push('height ' + size.height + ' below ' + c.minHeight);
  if (c.maxHeight != null && size.height > c.maxHeight) out.push('height ' + size.height + ' above ' + c.maxHeight);
  return out.join(', ');
}

function checkImages(workDir, recipe) {
  const problems = [];
  const seen = [];
  for (const d of recipe.deliverables.filter((x) => x.constraints && IMAGE_FORMATS.includes(x.format))) {
    const files = matchFiles(workDir, d.path);
    if (!files.length) problems.push(d.path + ': no image to measure');
    for (const f of files) {
      const size = imageSize(readFileSync(join(workDir, f)));
      if (!size) {
        problems.push(f + ': no PNG or JPEG header');
        continue;
      }
      seen.push(f + ' ' + size.width + 'x' + size.height);
      const p = sizeProblem(size, d.constraints);
      if (p) problems.push(f + ': ' + p);
    }
  }
  return { ok: !problems.length, detail: problems.length ? problems.join('; ') : seen.join(', ') };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', middot: '\u00b7', hellip: '\u2026', horbar: '\u2015' };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? m;
});

// The text a reader of the page meets: element text plus alt, title, aria-label, placeholder and meta
// content values, with entities decoded so &mdash; is linted like the character it draws.
export function visibleText(html) {
  const attrs = [];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, (tag) => {
      for (const m of tag.matchAll(/\s(?:alt|title|aria-label|placeholder|content)\s*=\s*("([^"]*)"|'([^']*)')/gi)) attrs.push(m[2] ?? m[3]);
      return ' ';
    });
  return decodeEntities(body + '\n' + attrs.join('\n')).replace(/[ \t]+/g, ' ');
}

function lintFiles(workDir, recipe, c, lang) {
  const files = c.paths
    ? [...new Set(c.paths.flatMap((p) => matchFiles(workDir, p)))]
    : [...new Set(recipe.deliverables.filter((d) => LINT_FORMATS.includes(d.format)).flatMap((d) => matchFiles(workDir, d.path)))];
  if (!files.length) return { ok: false, detail: 'no file to lint' };
  const floor = [];
  let reflex = 0;
  for (const f of files) {
    const raw = readFileSync(join(workDir, f), 'utf8');
    const text = /\.html?$/i.test(f) ? visibleText(raw) : raw;
    for (const finding of lintText(text, { lang: c.lang ?? lang })) {
      if (finding.tier === 'floor') floor.push(f + ' ' + finding.rule + ' "' + finding.excerpt.trim() + '"');
      else reflex++;
    }
  }
  return { ok: !floor.length, detail: (floor.length ? floor.join('; ') : files.length + ' files clean at floor tier') + (reflex ? '; ' + reflex + ' reflex warnings' : '') };
}

// Runs inside the rendered page after fonts and images settle. The width is the emulated viewport width:
// mobile emulation zooms an overflowing page out to fit, which widens innerWidth to the content and would
// hide the very overflow this check exists to catch.
const viewportProbe = (width) => '(() => {' +
  'const iw = ' + Number(width) + '; const sw = document.documentElement.scrollWidth;' +
  'const wide = [...document.body.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > iw + 1)' +
  '.slice(0, 5).map((e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.classList.length ? "." + [...e.classList].join(".") : ""));' +
  'const failedFonts = [...document.fonts].filter((f) => f.status === "error").map((f) => f.family);' +
  // A word without spaces, up to 20 characters, laid out on more than one line was split mid-word
  // (a Korean label such as 영업시간 breaking after its third syllable in a narrow column).
  'const split = []; const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);' +
  'for (let n = walk.nextNode(); n && split.length < 5; n = walk.nextNode()) {' +
  'const t = n.textContent.trim(); if (t.length < 2 || t.length > 20 || /\\s/.test(t)) continue;' +
  'const p = n.parentElement; if (!p || p.closest("script,style,svg") || getComputedStyle(p).visibility === "hidden") continue;' +
  'const range = document.createRange(); range.selectNodeContents(n);' +
  'const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));' +
  'if (lines.size > 1) split.push(t); }' +
  'return { iw, sw, wide, failedFonts, fontStatus: document.fonts.status, split };' +
  '})()';

async function checkViewports(workDir, recipe, c, { qaDir, openRenderer }) {
  const files = [...new Set(recipe.deliverables.filter((d) => d.format === 'html').flatMap((d) => matchFiles(workDir, d.path)))];
  if (!files.length) return { ok: false, detail: 'no html deliverable to render' };
  const widths = c.widths ?? DEFAULT_WIDTHS;
  let renderer;
  try {
    renderer = await openRenderer();
  } catch (err) {
    return { ok: false, detail: 'renderer did not start: ' + (err.code ? err.code + ' ' : '') + err.message };
  }
  const problems = [];
  const captures = [];
  try {
    mkdirSync(qaDir, { recursive: true });
    for (const f of files) {
      const stem = f.replace(/\.html?$/i, '').replace(/[\\/]/g, '_');
      for (const width of widths) {
        const height = VIEWPORT_HEIGHT[width] ?? 900;
        const url = pathToFileURL(resolve(workDir, f)).href;
        try {
          const first = await renderer.render({ url, width, height, out: join(qaDir, stem + '-' + width + '.jpg'), format: 'jpeg', maxSide: CAPTURE_MAX_SIDE, probe: viewportProbe(width) });
          const full = await renderer.render({ url, width, height, fullPage: true, out: join(qaDir, stem + '-' + width + '-full.jpg'), format: 'jpeg', maxSide: CAPTURE_MAX_SIDE });
          captures.push(relative(join(qaDir, '..'), first.out).split('\\').join('/'), relative(join(qaDir, '..'), full.out).split('\\').join('/'));
          const p = first.probe;
          if (!p) problems.push(f + '@' + width + ': probe returned nothing');
          else {
            if (p.sw > p.iw) problems.push(f + '@' + width + ': horizontal overflow ' + p.sw + ' > ' + p.iw + (p.wide.length ? ' (' + p.wide.join(', ') + ')' : ''));
            if (p.failedFonts.length || p.fontStatus !== 'loaded') problems.push(f + '@' + width + ': fonts not loaded ' + (p.failedFonts.join(', ') || p.fontStatus));
            if (p.split.length) problems.push(f + '@' + width + ': words split across lines ' + p.split.join(', '));
          }
          if (first.brokenImages.length) problems.push(f + '@' + width + ': broken images ' + first.brokenImages.join(', '));
        } catch (err) {
          problems.push(f + '@' + width + ': render failed: ' + (err.code ? err.code + ' ' : '') + err.message);
        }
      }
    }
  } finally {
    await renderer.close();
  }
  return { ok: !problems.length, detail: problems.length ? problems.join('; ') : files.length + ' pages clean at ' + widths.join(', ') + ' px', captures };
}

const tail = (s, n = 1500) => (s.length > n ? s.slice(-n) : s);

export function runCommand(command, { cwd, timeoutMs = 300_000 }) {
  return new Promise((resolveRun) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (out = tail(out + d, 8000)));
    child.stderr.on('data', (d) => (out = tail(out + d, 8000)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveRun({ exitCode: null, timedOut, output: 'could not start: ' + err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ exitCode: code, timedOut, output: out });
    });
  });
}

async function checkCommand(workDir, c) {
  const cwd = join(workDir, c.cwd ?? '.');
  if (!existsSync(cwd)) return { ok: false, detail: 'directory ' + (c.cwd ?? '.') + ' does not exist' };
  const r = await runCommand(c.run, { cwd, timeoutMs: c.timeoutMs ?? 300_000 });
  if (r.timedOut) return { ok: false, detail: c.run + ' timed out after ' + (c.timeoutMs ?? 300_000) + ' ms: ' + tail(r.output, 600) };
  return { ok: r.exitCode === 0, detail: c.run + ' exited ' + r.exitCode + (r.output.trim() ? ': ' + tail(r.output.trim(), 600) : '') };
}

// runAcceptance(workDir, recipe, {qaDir, lang, openRenderer}) returns {ok, results}.
export async function runAcceptance(workDir, recipe, { qaDir = join(workDir, '..', 'qa'), lang, openRenderer = defaultOpenRenderer } = {}) {
  if (!existsSync(workDir)) return { ok: false, results: [{ check: 'files', ok: false, detail: 'work directory ' + workDir + ' does not exist' }] };
  const results = [];
  for (const c of recipe.acceptance) {
    let r;
    try {
      if (c.check === 'files') r = checkFiles(workDir, recipe);
      else if (c.check === 'image') r = checkImages(workDir, recipe);
      else if (c.check === 'sloplint') r = lintFiles(workDir, recipe, c, lang);
      else if (c.check === 'viewports') r = await checkViewports(workDir, recipe, c, { qaDir, openRenderer });
      else if (c.check === 'command') r = await checkCommand(workDir, c);
      else r = { ok: false, detail: 'unknown check ' + c.check };
    } catch (err) {
      r = { ok: false, detail: 'check could not run: ' + (err.code ? err.code + ' ' : '') + err.message };
    }
    results.push({ check: c.check, ...r });
  }
  return { ok: results.every((r) => r.ok), results };
}
