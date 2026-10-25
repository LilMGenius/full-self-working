// Fonts the renderer embeds, and the checks that a print used only them. Pretendard (SIL OFL 1.1,
// assets/fonts/OFL.txt) is inlined as a data URL, so a print or a capture never races a font
// download and silently falls back to an OS face (AGENTS.md webfontRace).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../core/instance.mjs';

export const PRETENDARD = join(repoRoot, 'assets', 'fonts', 'PretendardVariable.woff2');

let pretendardCss = null;
export function pretendardFontFace() {
  pretendardCss ??= '@font-face{font-family:"Pretendard";font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,' + readFileSync(PRETENDARD).toString('base64') + ') format("woff2");}';
  return pretendardCss;
}

// Embedded fonts of a PDF Chrome printed. Named fonts come from their /BaseFont entries without the
// six-letter subset tag; Chrome's PDF writer keeps font dictionaries outside compressed object streams,
// so the raw bytes hold them. A variable face such as Pretendard is drawn as Type3 glyph procedures,
// which carry no name, so those are counted instead.
export function pdfFonts(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const named = [...new Set([...text.matchAll(/\/BaseFont\s*\/([^\s/\[\]<>()]+)/g)].map((m) => m[1].replace(/^[A-Z]{6}\+/, '')))];
  const type3 = (text.match(/\/Subtype\s*\/Type3(?![A-Za-z0-9])/g) ?? []).length;
  return { named, type3 };
}

// Pages of a PDF: its /Type /Page objects, never the /Pages tree nodes.
export const pdfPageCount = (bytes) => (Buffer.from(bytes).toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;

const sameFamily = (name, family) => String(name).replace(/[\s-]+/g, '').toLowerCase().startsWith(family.replace(/[\s-]+/g, '').toLowerCase());

// Every named font in the PDF must belong to the family the page asked for; a named font outside it is
// an OS fallback. Type3 fonts are the inlined variable face. A PDF with neither embedded nothing.
export function fontProblems({ named = [], type3 = 0 } = {}, family) {
  if (!named.length && !type3) return ['the PDF embeds no font'];
  return named.filter((n) => !sameFamily(n, family)).map((n) => 'fallback font ' + n + ' in the PDF');
}

// The renderer's own account of which font drew the text (CDP CSS.getPlatformFontsForNode, summed over
// every text node): anything that is not the inlined family is a fallback. A missing report fails too,
// since then nothing proved the face.
export function platformFontProblems(report, family) {
  if (!Array.isArray(report) || !report.length) return ['the renderer reported no fonts for the text'];
  return report.filter((f) => !f.isCustomFont || !sameFamily(f.familyName, family)).map((f) => 'fallback font ' + f.familyName + ' drew ' + f.glyphCount + ' glyphs');
}

