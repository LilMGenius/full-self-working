// The per-page checks of a rendered page, shared by the site sweep (scripts/site-sweep.mjs) and the portfolio
// quality score (U7.8): horizontal overflow, broken images and, when a family is given, text drawn in a fallback
// face. label names the page in a problem line (the sweep passes the file, so a port never shows).
import { platformFontProblems } from './fonts.mjs';
import { viewportName } from './viewports.mjs';

// The layout viewport width (clientWidth), not innerWidth: under mobile emulation a page wider than the screen is
// zoomed out, and innerWidth grows with it, so a phone overflow would measure against its own width.
export const OVERFLOW_PROBE = '(() => { const iw = document.documentElement.clientWidth; const sw = document.documentElement.scrollWidth;' +
  ' const wide = [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > iw + 1).slice(0, 5).map((e) => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.split(" ")[0] : ""));' +
  ' return { iw, sw, wide }; })()';

export async function checkPage(renderer, { url, viewport, family = null, label = url, out }) {
  const r = await renderer.render({ url, ...viewport, fullPage: true, maxSide: 1600, format: 'jpeg', quality: 80, fontReport: family != null, probe: OVERFLOW_PROBE, out });
  const at = label + '@' + viewportName(viewport);
  const problems = [];
  if (!r.probe) problems.push(at + ': overflow probe returned nothing');
  else if (r.probe.sw > r.probe.iw) problems.push(at + ': horizontal overflow ' + r.probe.sw + ' > ' + r.probe.iw + (r.probe.wide.length ? ' (' + r.probe.wide.join(', ') + ')' : ''));
  if (family != null) for (const p of platformFontProblems(r.platformFonts, family)) problems.push(at + ': ' + p);
  for (const b of r.brokenImages) problems.push(at + ': broken image ' + b);
  return problems;
}

