#!/usr/bin/env node
// Renders every HTML page of a built site at every viewport (src/render/viewports.mjs) and fails on horizontal
// overflow, a text node drawn in a fallback font (CDP CSS.getPlatformFontsForNode) or a broken image. The folder is
// served over http on 127.0.0.1, since the pages load /assets, /media and /favicon.svg by root-relative URLs as the
// deployed origin serves them. Captures are written beside the report, long side 1600, JPEG (AGENTS.md
// transcriptReplay).
//   node scripts/site-sweep.mjs --dist <dir> [--out <dir>]
import { createReadStream, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPage } from '../src/render/checks.mjs';
import { openRenderer } from '../src/render/html2png.mjs';
import { VIEWPORTS, viewportName } from '../src/render/viewports.mjs';

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };

// The face the built pages name (site/templates/page.mjs). The renderer reports the family of the font file, and
// the subset keeps Pretendard's name table, so this is the name a node drawn in the site font reports.
export const SITE_FAMILY = 'Pretendard';

// The built folder as a static host: a directory serves its index.html, a missing file answers 404 (which the
// broken-image check reports), and no path outside the folder is served.
export function serveDir(root) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    let file;
    try {
      file = resolve(base, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname));
    } catch {
      return void res.writeHead(400).end();
    }
    if (file !== base && !file.startsWith(base + sep)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok({ origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((done) => server.close(done)) }));
  });
}

const pagesOf = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? pagesOf(join(dir, n)).map((f) => n + '/' + f) : [n])).filter((f) => f.endsWith('.html'));
// index.html is served as /, en/index.html as /en/, 404.html as /404.html.
const pathOf = (page) => '/' + page.replace(/\\/g, '/').replace(/(^|\/)index\.html$/, '$1');

export async function sweep({ dist, out, family = SITE_FAMILY, viewports = VIEWPORTS, openRenderer: open = openRenderer }) {
  const root = resolve(dist);
  mkdirSync(out, { recursive: true });
  const problems = [];
  const captures = [];
  const host = await serveDir(root);
  let renderer = null;
  try {
    renderer = await open();
    for (const page of pagesOf(root)) {
      for (const vp of viewports) {
        const name = page.replace(/[\\/]/g, '_').replace(/\.html$/, '') + '-' + viewportName(vp) + '.jpg';
        problems.push(...(await checkPage(renderer, { url: host.origin + pathOf(page), viewport: vp, family, label: page, out: join(out, name) })));
        captures.push(name);
      }
    }
  } finally {
    await renderer?.close();
    await host.close();
  }
  const report = { dist: root, viewports: viewports.map(viewportName), captures, problems };
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
  console.log('site-sweep: ' + report.captures.length + ' captures, ' + report.problems.length + ' problems, report ' + relative(process.cwd(), join(out, 'sweep.json')));
  process.exit(report.problems.length ? 1 : 0);
}

