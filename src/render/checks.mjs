// The per-page checks of a rendered page, shared by the site sweep (scripts/site-sweep.mjs) and the portfolio
// quality score (U7.8): horizontal overflow, key elements drawn below their minimum size, broken images and, when a
// family is given, text drawn in a fallback face. label names the page in a problem line (the sweep passes the file,
// so a port never shows).
import { platformFontProblems } from './fonts.mjs';
import { viewportName } from './viewports.mjs';

// A template marks an element that must stay legible at every width (the wordmark, the primary button, an icon) with
// data-min-size="<px>": its rendered box must be at least that many CSS pixels wide and tall. Overflow alone misses a
// wordmark shrunk to a line or icons collapsed to specks, since neither overflows.
export const MIN_SIZE_ATTR = 'data-min-size';

// Shared page-side helpers: an element's short name, and the key elements below their minimum size.
const PAGE_HELPERS = 'const name = (e) => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.split(" ")[0] : "");' +
  ' const small = (d) => [...d.querySelectorAll("[' + MIN_SIZE_ATTR + ']")].map((e) => { const r = e.getBoundingClientRect(); return { name: name(e), min: Number(e.getAttribute("' + MIN_SIZE_ATTR + '")), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((k) => !(k.w >= k.min && k.h >= k.min));';

// The layout viewport width (clientWidth), not innerWidth: under mobile emulation a page wider than the screen is
// zoomed out, and innerWidth grows with it, so a phone overflow would measure against its own width.
export const OVERFLOW_PROBE = '(() => { ' + PAGE_HELPERS + ' const iw = document.documentElement.clientWidth; const sw = document.documentElement.scrollWidth;' +
  ' const wide = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > iw + 1).slice(0, 5).map(name);' +
  ' return { iw, sw, wide, small: small(document) }; })()';

const smallLine = (k) => k.name + ' drawn ' + k.w + 'x' + k.h + ', under its minimum size ' + k.min + ' px';

export async function checkPage(renderer, { url, viewport, family = null, label = url, out }) {
  const r = await renderer.render({ url, ...viewport, fullPage: true, maxSide: 1600, format: 'jpeg', quality: 80, fontReport: family != null, probe: OVERFLOW_PROBE, out });
  const at = label + '@' + viewportName(viewport);
  const problems = [];
  if (!r.probe) problems.push(at + ': overflow probe returned nothing');
  else {
    if (r.probe.sw > r.probe.iw) problems.push(at + ': horizontal overflow ' + r.probe.sw + ' > ' + r.probe.iw + (r.probe.wide.length ? ' (' + r.probe.wide.join(', ') + ')' : ''));
    for (const k of r.probe.small ?? []) problems.push(at + ': ' + smallLine(k));
  }
  if (family != null) for (const p of platformFontProblems(r.platformFonts, family)) problems.push(at + ': ' + p);
  for (const b of r.brokenImages) problems.push(at + ': broken image ' + b);
  return problems;
}

// The fine pass: overflow and minimum sizes at every WIDTH_STEP px from 320 to 1920 at each FINE_HEIGHTS height,
// with no capture. A layout bug can live between the fixed viewports (one lived between 414 and 768 px on
// 2026-10-01), and a CSS breakpoint is a whole pixel, so the step is 1 px: every width is checked, and the pass still
// costs one page load per height, since the page sits in a same-origin iframe the probe resizes in place.
export const FINE_RANGE = Object.freeze({ from: 320, to: 1920 });
export const WIDTH_STEP = 1;
export const FINE_HEIGHTS = Object.freeze([568, 800, 1080]);
export const HARNESS_PATH = '/__sweep/harness.html';

const attr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const harnessHtml = (path, height) => '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}</style></head>' +
  '<body><iframe id="f" src="' + attr(path) + '" style="border:0;display:block;width:' + FINE_RANGE.to + 'px;height:' + Number(height) + 'px"></iframe></body></html>';

// Runs inside the harness: waits for the framed page's load, fonts and images, hides its scrollbar as phones overlay
// theirs, then sets the frame to each width and reads the layout the browser recomputes for it.
const widthProbe = ({ from, to, step }) => '(async () => { ' + PAGE_HELPERS +
  ' const f = document.getElementById("f");' +
  ' if (f.contentDocument?.readyState !== "complete" || f.contentDocument.location.href === "about:blank") await new Promise((r) => f.addEventListener("load", r, { once: true }));' +
  ' const d = f.contentDocument; const st = d.createElement("style"); st.textContent = "html{scrollbar-width:none}"; d.head.append(st);' +
  ' await d.fonts.ready;' +
  ' for (const i of d.images) if (i.loading === "lazy") i.loading = "eager";' +
  ' await Promise.all([...d.images].map((i) => i.complete ? null : new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); setTimeout(r, 15000); })));' +
  ' const rows = [];' +
  ' for (let w = ' + from + '; w <= ' + to + '; w += ' + step + ') {' +
  '   f.style.width = w + "px"; const de = d.documentElement; const iw = de.clientWidth; const sw = de.scrollWidth; const issues = [];' +
  '   if (sw > iw) { const wide = [...d.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > iw + 1).slice(0, 3).map(name); issues.push("horizontal overflow" + (wide.length ? " (" + wide.join(", ") + ")" : "")); }' +
  '   for (const k of small(d)) issues.push(k.name + " under its minimum size " + k.min + " px");' +
  '   rows.push([w, issues]); }' +
  ' return rows; })()';

// One problem line per issue and run of consecutive widths, so a band of failing widths reads as one range.
export function widthRanges(rows, { label, height, step }) {
  const runs = new Map();
  for (const [w, issues] of rows) {
    for (const issue of issues) {
      const list = runs.get(issue) ?? [];
      const last = list.at(-1);
      if (last && w - last[1] === step) last[1] = w;
      else list.push([w, w]);
      runs.set(issue, list);
    }
  }
  return [...runs].flatMap(([issue, list]) => list.map(([a, b]) => label + '@' + (a === b ? a : a + '-' + b) + 'x' + height + ' (every ' + step + ' px): ' + issue));
}

export async function checkWidths(renderer, { origin, path, height, label = path, scratch, range = FINE_RANGE, step = WIDTH_STEP }) {
  const url = origin + HARNESS_PATH + '?page=' + encodeURIComponent(path) + '&h=' + height;
  const r = await renderer.render({ url, width: 1280, height: 720, clip: { x: 0, y: 0, width: 16, height: 16 }, format: 'jpeg', probe: widthProbe({ ...range, step }), out: scratch });
  if (!Array.isArray(r.probe)) return [label + '@x' + height + ' (every ' + step + ' px): the width probe returned nothing'];
  return widthRanges(r.probe, { label, height, step });
}

