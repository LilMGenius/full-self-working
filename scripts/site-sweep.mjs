#!/usr/bin/env node
// Checks every HTML page of a built site in two passes and fails on any problem:
//  - at the nine fixed viewports of src/render/viewports.mjs, with a capture each: horizontal overflow, a key element
//    below its floor (data-min-size for a drawn box, data-min-font for a text mark's font-size, each only while its
//    data-min-media matches), a text node drawn in a fallback font (CDP CSS.getPlatformFontsForNode) and a broken image;
//  - at every width from 320 to 1920 px in 1 px steps, at heights 568, 800 and 1080, with no capture: horizontal
//    overflow and key elements below their minimum size (src/render/checks.mjs, checkWidths).
// The folder is served over http on 127.0.0.1, since the pages load /assets, /media and /favicon.svg by root-relative
// URLs as the deployed origin serves them. Captures are written beside the report, long side 1600, JPEG (AGENTS.md
// transcriptReplay).
//   node scripts/site-sweep.mjs --dist <dir> [--out <dir>]
import { createReadStream, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINE_HEIGHTS, FINE_RANGE, HARNESS_PATH, WIDTH_STEP, checkPage, checkWidths, harnessHtml } from '../src/render/checks.mjs';
import { openRenderer } from '../src/render/html2png.mjs';
import { VIEWPORTS, viewportName } from '../src/render/viewports.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };

// The face the built pages name (site/templates/page.mjs). The renderer reports the family of the font file, and
// the subset keeps Pretendard's name table, so this is the name a node drawn in the site font reports.
export const SITE_FAMILY = 'Pretendard';

// The built folder as a static host: a directory serves its index.html, a missing file answers 404 (which the
// broken-image check reports), and no path outside the folder is served, by name or through a link inside it.
// open is the seam the tests fail a read through; it defaults to a file stream. page(url) may answer a path the
// folder does not hold with generated HTML (the fine pass's harness); it returns null for every other path.
export function serveDir(root, { open = createReadStream, page = () => null } = {}) {
  const base = resolve(root);
  const realBase = realpathSync(base);
  const inside = (path, top) => path === top || path.startsWith(top + sep);
  const server = createServer((req, res) => {
    let file;
    try {
      const url = new URL(req.url, 'http://local');
      const generated = page(url);
      if (generated != null) return void res.writeHead(200, { 'content-type': TYPES['.html'] }).end(generated);
      file = resolve(base, '.' + decodeURIComponent(url.pathname));
    } catch {
      return void res.writeHead(400).end();
    }
    if (!inside(file, base)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404).end();
    // A junction or symlink inside the folder may point anywhere; the file it resolves to must lie inside too.
    if (!inside(realpathSync(file), realBase)) return void res.writeHead(403).end();
    // A file removed or locked between the checks above and the read answers 404 instead of ending the sweep.
    const stream = open(file);
    stream.once('error', () => (res.headersSent ? res.destroy() : res.writeHead(404).end()));
    stream.once('open', () => {
      res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' });
      stream.pipe(res);
    });
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok({ origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((done) => server.close(done)) }));
  });
}

const pagesOf = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? pagesOf(join(dir, n)).map((f) => n + '/' + f) : [n])).filter((f) => f.endsWith('.html'));
// index.html is served as /, en/index.html as /en/, 404.html as /404.html.
const pathOf = (page) => '/' + page.replace(/\\/g, '/').replace(/(^|\/)index\.html$/, '$1');

const harness = (url) => (url.pathname === HARNESS_PATH ? harnessHtml(url.searchParams.get('page') ?? '/', url.searchParams.get('h') ?? 800) : null);

// fine names the width pass ({ range, step, heights }), or false to run the fixed viewports alone.
export async function sweep({ dist, out, family = SITE_FAMILY, viewports = VIEWPORTS, fine = { range: FINE_RANGE, step: WIDTH_STEP, heights: FINE_HEIGHTS }, openRenderer: open = openRenderer }) {
  const root = resolve(dist);
  mkdirSync(out, { recursive: true });
  const problems = [];
  const captures = [];
  const host = await serveDir(root, { page: harness });
  const scratch = join(out, '.fine-pass.jpg');
  let renderer = null;
  try {
    renderer = await open();
    for (const page of pagesOf(root)) {
      for (const vp of viewports) {
        const name = page.replace(/[\\/]/g, '_').replace(/\.html$/, '') + '-' + viewportName(vp) + '.jpg';
        problems.push(...(await checkPage(renderer, { url: host.origin + pathOf(page), viewport: vp, family, label: page, out: join(out, name) })));
        captures.push(name);
      }
      if (fine) for (const height of fine.heights) problems.push(...(await checkWidths(renderer, { origin: host.origin, path: pathOf(page), height, label: page, scratch, range: fine.range, step: fine.step })));
    }
  } finally {
    await renderer?.close();
    await host.close();
    rmSync(scratch, { force: true });
  }
  const widths = fine ? { from: fine.range.from, to: fine.range.to, step: fine.step, heights: [...fine.heights] } : null;
  const report = { dist: root, viewports: viewports.map(viewportName), widths, captures, problems };
  writeFileSync(join(out, 'sweep.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

// Called through a link (a junction or a symlinked checkout), argv[1] names the link while import.meta.url names
// the real file, so both are compared as real paths (AGENTS.md skillCreator).
const isMain = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  const args = process.argv.slice(2);
  const get = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const dist = get('--dist');
  if (!dist) {
    console.error('usage: node scripts/site-sweep.mjs --dist <dir> [--out <dir>]');
    process.exit(2);
  }
  const out = get('--out') ?? join(dist, '..', 'site-sweep');
  const report = await sweep({ dist, out });
  for (const p of report.problems) console.error('site-sweep: ' + p);
  const w = report.widths;
  console.log('site-sweep: ' + report.captures.length + ' captures at ' + report.viewports.length + ' viewports, widths ' + w.from + '-' + w.to + ' every ' + w.step + ' px at heights ' + w.heights.join(', ') + ', ' + report.problems.length + ' problems, report ' + relative(process.cwd(), join(out, 'sweep.json')));
  process.exit(report.problems.length ? 1 : 0);
}

