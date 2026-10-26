// Listing images for 크몽 gigs, rendered from HTML with the owned headless Chrome (src/render/html2png.mjs).
// One visual series for every gig so the storefront reads as one studio: warm paper, espresso ink, one
// burnt-orange accent, Pretendard inlined from assets/fonts (no network font), and real screenshots
// of the operator's own public work as the only imagery. All words come from the gated listing copy and
// the fixed labels below; no URL, domain, contact detail, badge or invented number is drawn.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../core/instance.mjs';
import { openRenderer } from '../render/html2png.mjs';

export const MAIN_SIZE = { width: 652, height: 488 };
export const DETAIL_WIDTH = 860;
export const DETAIL_SCALE = 2;
// The 상세 이미지 slot takes width 652 to 2000 px and height up to 3000 px.
export const DETAIL_LIMITS = { minWidth: 652, maxWidth: 2000, maxHeight: 3000 };
export const DETAIL_COUNT = { min: 3, max: 5 };

// Fixed labels drawn on the images; they pass the same slop rules as the copy (tested).
export const LABELS = {
  aiBadge: 'AI 제작 + 사람 검수',
  audience: '이런 분께 맞습니다',
  included: '받으시는 것',
  process: '진행 순서',
  ai: 'AI 활용과 검수',
  packages: '패키지 안내',
  packagesNote: '금액은 VAT 포함입니다. 범위 밖 요청은 메시지로 맞춤 견적을 드립니다.',
  days: '작업일',
  revisions: '수정',
  proof: '직접 만든 작업',
  proofNote: '실제 운영 중인 화면을 그대로 캡처했습니다.',
  sample: '작업 예시',
  sampleNote: '예시 의뢰로 만든 샘플입니다. 고객 작업물이 아닙니다.',
  mixedNote: '작업 예시 표시가 있는 이미지는 예시 의뢰로 만든 샘플입니다.',
};

const FONT = join(repoRoot, 'assets', 'fonts', 'PretendardVariable.woff2');
let fontCss = null;
function fontFace() {
  fontCss ??= '@font-face{font-family:"Pretendard";font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,' + readFileSync(FONT).toString('base64') + ') format("woff2");}';
  return fontCss;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const won = (n) => Number(n).toLocaleString('ko-KR') + '원';
const two = (i) => String(i + 1).padStart(2, '0');
const dataUrl = (file) => 'data:image/' + (file.endsWith('.png') ? 'png' : 'jpeg') + ';base64,' + readFileSync(file).toString('base64');

const BASE_CSS = ':root{--paper:#F4F1EB;--paper-2:#ECE7DE;--ink:#1B1915;--ink-2:#2A2722;--muted:#6B665D;--line:rgba(27,25,21,.12);--accent:#D4572A;--on-ink:#F4F1EB;--on-ink-muted:#A9A397}' +
  '*{box-sizing:border-box;margin:0;padding:0}' +
  'html,body{background:var(--paper)}' +
  'body{font-family:"Pretendard",sans-serif;color:var(--ink);word-break:keep-all;overflow-wrap:break-word;-webkit-font-smoothing:antialiased;font-feature-settings:"tnum" 1}' +
  // Paper grain: a fixed SVG turbulence at very low opacity, drawn locally.
  '.grain{position:absolute;inset:0;pointer-events:none;opacity:.05;background-image:url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%27160%27 height=%27160%27><filter id=%27n%27><feTurbulence type=%27fractalNoise%27 baseFrequency=%27.9%27 numOctaves=%272%27 stitchTiles=%27stitch%27/></filter><rect width=%27100%25%27 height=%27100%25%27 filter=%27url(%23n)%27/></svg>")}' +
  '.mark{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:-.01em}' +
  '.mark i{display:block;width:10px;height:10px;background:var(--accent);border-radius:2px}' +
  '.badge{font-weight:550;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:5px 12px;white-space:nowrap}' +
  '.shot{border-radius:12px;overflow:hidden;background:#111;box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 24px 60px -24px rgba(27,25,21,.45),0 2px 6px rgba(27,25,21,.12)}' +
  '.shot img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center}';

const page = (body, css, { width, height }) => '<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>' + fontFace() + BASE_CSS + css + '</style></head><body style="width:' + width + 'px' + (height ? ';height:' + height + 'px;overflow:hidden' : '') + '">' + body + '</body></html>';

// ---- main card 652x488 ----

export function mainHtml({ listing, studio, cardShots = [] }) {
  const c = listing.imageCopy.card;
  const panel = cardShots.length
    ? cardShots[0].sample
      // A work sample is shown whole, inside the card, since cropping it would hide what was made.
      ? '<div class="sample-shot shot" style="aspect-ratio:' + cardShots[0].width + '/' + cardShots[0].height + '"><img src="' + cardShots[0].src + '" alt=""></div>'
      : '<div class="stage">' + cardShots.slice(0, 2).map((s, i) => '<div class="shot ' + (s.width < 600 ? 'phone' : 'desk') + ' s' + i + '"><img src="' + s.src + '" alt=""></div>').join('') + '</div>'
    : '<div class="spec"><div class="spec-h">' + esc(LABELS.included) + '</div>' + listing.imageCopy.included.slice(0, 3).map((t, i) => '<div class="spec-r"><span>' + two(i) + '</span>' + esc(t) + '</div>').join('') + '</div>';
  const css = '.card{position:relative;width:652px;height:488px;overflow:hidden;background:var(--paper);padding:34px 40px}' +
    '.top{display:flex;justify-content:space-between;align-items:center;font-size:15px}.top .badge{font-size:13px}' +
    'h1{margin-top:44px;font-size:60px;line-height:1.16;font-weight:720;letter-spacing:-.035em}' +
    '.sub{margin-top:16px;font-size:20px;line-height:1.4;color:var(--muted);font-weight:500;letter-spacing:-.01em}' +
    '.tags{position:absolute;left:40px;bottom:34px;display:flex;flex-direction:column;gap:9px}' +
    '.tags div{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:600;letter-spacing:-.01em}.tags div:before{content:"";width:6px;height:6px;background:var(--accent);border-radius:1px}' +
    '.stage{position:absolute;right:-30px;bottom:-26px;width:330px;height:196px}' +
    '.stage .desk{position:absolute;right:0;bottom:0;width:330px;height:206px}' +
    '.stage .phone{position:absolute;left:-40px;bottom:-14px;width:112px;aspect-ratio:390/600;border-radius:14px;border:3px solid var(--ink)}' +
    '.sample-shot{position:absolute;right:40px;bottom:34px;width:300px;max-height:250px;border-radius:12px}.sample-shot img{object-fit:contain;background:#fff}' +
    '.spec{position:absolute;right:-12px;bottom:-12px;width:318px;padding:18px 24px 26px;background:var(--ink);color:var(--on-ink);border-radius:14px 0 0 0}' +
    '.spec-h{font-size:12px;color:var(--on-ink-muted);font-weight:600;margin-bottom:8px;letter-spacing:.02em}' +
    '.spec-r{display:flex;gap:12px;font-size:15px;line-height:1.35;font-weight:560;padding:6px 0;border-top:1px solid rgba(244,241,235,.12)}.spec-r span{color:var(--accent);font-weight:700}';
  const body = '<div class="card"><div class="grain"></div><div class="top"><div class="mark"><i></i>' + esc(studio) + '</div><div class="badge">' + esc(LABELS.aiBadge) + '</div></div>' +
    '<h1>' + c.headline.map(esc).join('<br>') + '</h1><p class="sub">' + esc(c.subline) + '</p>' +
    '<div class="tags">' + c.tags.map((t) => '<div>' + esc(t) + '</div>').join('') + '</div>' + panel + '</div>';
  return page(body, css, MAIN_SIZE);
}

// ---- detail images, 860 css px wide at 2x ----

const DETAIL_CSS = '.d{position:relative;width:' + DETAIL_WIDTH + 'px;padding:72px 64px 80px;background:var(--paper);overflow:hidden}' +
  '.d.ink{background:var(--ink);color:var(--on-ink)}' +
  '.head{display:flex;justify-content:space-between;align-items:center;font-size:16px}.head .badge{font-size:14px}.ink .badge{color:var(--on-ink-muted);border-color:rgba(244,241,235,.18)}' +
  '.eyebrow{margin-top:64px;font-size:16px;font-weight:650;color:var(--accent);letter-spacing:.02em}' +
  'h2{margin-top:14px;font-size:46px;line-height:1.24;font-weight:700;letter-spacing:-.03em}' +
  '.lead{margin-top:22px;font-size:20px;line-height:1.7;color:var(--muted);font-weight:450}.ink .lead{color:var(--on-ink-muted)}' +
  '.rows{margin-top:36px;border-top:1px solid var(--line)}.ink .rows{border-color:rgba(244,241,235,.14)}' +
  '.row{display:grid;grid-template-columns:64px 1fr;gap:8px;padding:22px 0;border-bottom:1px solid var(--line);font-size:21px;line-height:1.5;font-weight:560;letter-spacing:-.01em}.ink .row{border-color:rgba(244,241,235,.14)}' +
  '.row b{font-weight:700;color:var(--accent);font-size:17px;padding-top:3px}' +
  '.step{display:grid;grid-template-columns:64px 1fr;gap:8px;padding:24px 0;border-bottom:1px solid var(--line)}' +
  '.step b{font-size:17px;color:var(--accent);font-weight:700;padding-top:4px}.step h3{font-size:22px;font-weight:680;letter-spacing:-.015em}.step p{margin-top:6px;font-size:18px;line-height:1.6;color:var(--muted)}' +
  '.note{margin-top:44px;padding:30px 32px;background:var(--ink);color:var(--on-ink);border-radius:16px}.note h4{font-size:15px;color:var(--accent);font-weight:700;letter-spacing:.02em}.note p{margin-top:10px;font-size:19px;line-height:1.65;font-weight:500}' +
  '.figure{margin-top:44px}.figure .shot{width:100%}.cap{margin-top:14px;display:flex;gap:10px;font-size:16px;color:var(--muted);line-height:1.5}.cap:before{content:"";flex:none;margin-top:8px;width:6px;height:6px;background:var(--accent);border-radius:1px}' +
  '.tag{flex:none;font-size:13px;font-weight:650;color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:1px 9px;margin-right:2px;line-height:1.5}' +
  '.pair{display:grid;grid-template-columns:1fr 240px;gap:32px;align-items:center}' +
  '.tiers{margin-top:40px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}' +
  '.tier{border:1px solid var(--line);border-radius:16px;padding:26px 22px 24px;background:rgba(255,255,255,.35);display:flex;flex-direction:column}' +
  '.tier.mid{background:var(--ink);color:var(--on-ink);border-color:var(--ink)}' +
  '.tier .t{font-size:13px;font-weight:700;letter-spacing:.08em;color:var(--accent)}.tier h3{margin-top:12px;font-size:21px;line-height:1.35;font-weight:680;letter-spacing:-.015em;min-height:56px}' +
  '.tier p{margin-top:10px;font-size:16px;line-height:1.6;color:var(--muted);min-height:102px}.tier.mid p{color:var(--on-ink-muted)}' +
  '.tier .price{margin-top:18px;font-size:27px;font-weight:720;letter-spacing:-.02em}' +
  '.tier dl{margin-top:16px;border-top:1px solid var(--line);padding-top:12px;display:grid;grid-template-columns:1fr auto;row-gap:6px;font-size:15px}.tier.mid dl{border-color:rgba(244,241,235,.16)}.tier dt{color:var(--muted)}.tier.mid dt{color:var(--on-ink-muted)}.tier dd{font-weight:650}' +
  '.small{margin-top:22px;font-size:15px;color:var(--muted)}';

const head = (studio, dark = false) => '<div class="grain"' + (dark ? ' style="opacity:.08"' : '') + '></div><div class="head"><div class="mark"><i></i>' + esc(studio) + '</div><div class="badge">' + esc(LABELS.aiBadge) + '</div></div>';
// A sample (work the agent made for an imagined brief) carries a 작업 예시 tag so it never reads as client work.
const tag = (shot) => (shot.sample ? '<span class="tag">' + esc(LABELS.sample) + '</span>' : '');
const figure = (shot, caption) => '<div class="figure"><div class="shot" style="aspect-ratio:' + shot.width + '/' + shot.height + '"><img src="' + shot.src + '" alt=""></div>' + (caption || shot.sample ? '<p class="cap">' + tag(shot) + esc(caption ?? '') + '</p>' : '') + '</div>';
const detail = (studio, inner, dark = false) => page('<div class="d' + (dark ? ' ink' : '') + '">' + head(studio, dark) + inner + '</div>', DETAIL_CSS, { width: DETAIL_WIDTH });

export function detailHtmls({ listing, studio, gallery = [] }) {
  const c = listing.imageCopy;
  const captions = c.proofCaptions ?? [];
  const out = [];
  const rows = (list) => '<div class="rows">' + list.map((t, i) => '<div class="row"><b>' + two(i) + '</b><span>' + esc(t) + '</span></div>').join('') + '</div>';
  // 1. what this is and the first proof
  out.push(detail(studio,
    '<p class="eyebrow">' + esc(listing.title) + '</p><h2>' + c.intro.headline.map(esc).join('<br>') + '</h2><p class="lead">' + esc(c.intro.body) + '</p>' +
    (gallery[0] ? figure(gallery[0], captions[0]) : '')));
  // 2. who it suits and what is delivered
  out.push(detail(studio, '<p class="eyebrow">' + esc(LABELS.audience) + '</p>' + rows(c.audience) + '<p class="eyebrow">' + esc(LABELS.included) + '</p>' + rows(c.included)));
  // 3. process and the AI note
  out.push(detail(studio,
    '<p class="eyebrow">' + esc(LABELS.process) + '</p><div class="rows">' + c.steps.map((s, i) => '<div class="step"><b>' + two(i) + '</b><div><h3>' + esc(s.title) + '</h3><p>' + esc(s.detail) + '</p></div></div>').join('') + '</div>' +
    '<div class="note"><h4>' + esc(LABELS.ai) + '</h4><p>' + esc(c.aiNote) + '</p></div>'));
  // 4. packages from the price table
  out.push(detail(studio,
    '<p class="eyebrow">' + esc(LABELS.packages) + '</p><h2>' + c.card.headline.map(esc).join(' ') + '</h2>' +
    '<div class="tiers">' + listing.packages.map((p, i) => '<div class="tier' + (i === 1 ? ' mid' : '') + '"><div class="t">' + esc(p.tier) + '</div><h3>' + esc(p.title) + '</h3><p>' + esc(p.description) + '</p><div class="price">' + won(p.priceKRW) + '</div><dl><dt>' + esc(LABELS.days) + '</dt><dd>' + p.days + '일</dd><dt>' + esc(LABELS.revisions) + '</dt><dd>' + p.revisions + '회</dd></dl></div>').join('') + '</div>' +
    '<p class="small">' + esc(LABELS.packagesNote) + '</p>'));
  // 5. the rest of the proof gallery, when there is more than the first shot
  const rest = gallery.slice(1);
  if (rest.length) {
    const phones = rest.filter((s) => s.width < 600);
    const desks = rest.filter((s) => s.width >= 600);
    const samples = rest.filter((s) => s.sample).length;
    const [eyebrow, note] = samples === rest.length ? [LABELS.sample, LABELS.sampleNote] : samples ? [LABELS.proof, LABELS.mixedNote] : [LABELS.proof, LABELS.proofNote];
    let inner = '<p class="eyebrow">' + esc(eyebrow) + '</p><h2>' + esc(note) + '</h2>';
    desks.forEach((s) => (inner += figure(s, captions[gallery.indexOf(s)])));
    phones.forEach((s) => (inner += '<div class="figure pair"><p class="cap">' + tag(s) + esc(captions[gallery.indexOf(s)]) + '</p><div class="shot" style="aspect-ratio:' + s.width + '/' + s.height + ';border-radius:22px;border:4px solid #3a362f"><img src="' + s.src + '" alt=""></div></div>'));
    out.push(detail(studio, inner, true));
  }
  return out;
}

// Reads width and height from a PNG (IHDR) or JPEG (SOFn) header.
export function imageSize(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      const marker = buf[i + 1];
      const size = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + size;
    }
  }
  throw new Error('not a PNG or JPEG');
}

// The slot rules the gig form states, checked on the files actually written.
export function checkImages({ main, detail = [] }) {
  const v = [];
  const m = imageSize(readFileSync(main));
  if (m.width !== MAIN_SIZE.width || m.height !== MAIN_SIZE.height) v.push({ field: 'images.main', rule: 'image.size', detail: 'main is ' + m.width + 'x' + m.height + ', needs ' + MAIN_SIZE.width + 'x' + MAIN_SIZE.height });
  if (detail.length < DETAIL_COUNT.min || detail.length > DETAIL_COUNT.max) v.push({ field: 'images.detail', rule: 'image.count', detail: detail.length + ' detail images; allowed ' + DETAIL_COUNT.min + ' to ' + DETAIL_COUNT.max });
  detail.forEach((file, i) => {
    const d = imageSize(readFileSync(file));
    if (d.width < DETAIL_LIMITS.minWidth || d.width > DETAIL_LIMITS.maxWidth || d.height > DETAIL_LIMITS.maxHeight) v.push({ field: 'images.detail.' + i, rule: 'image.size', detail: 'detail ' + (i + 1) + ' is ' + d.width + 'x' + d.height });
  });
  return v;
}

const shotOf = (file, proof) => ({ src: dataUrl(file), width: proof.clip?.width ?? proof.width, height: proof.clip?.height ?? proof.height });

// A plan entry is a proof id (a page capture), or a shot from src/listings/proofs.mjs proofPlan: a
// capture {kind: 'capture', id} or a file {kind: 'media' | 'sample', file} with an absolute path.
const refOf = (x) => (typeof x === 'string' ? { kind: 'capture', id: x } : x);

// Captures each proof page once into dir (a capture is kept until refresh), scrolling first for pages
// whose sections appear on scroll. Returns {id: file}.
export async function captureProofs(proofs, dir, { renderer, refresh = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const files = {};
  for (const p of proofs) {
    const out = join(dir, p.id + '.png');
    files[p.id] = out;
    if (!refresh && existsSync(out) && statSync(out).size > 0) continue;
    const y = p.scrollTo ?? 0;
    const probe = y ? '(async () => { for (let s = 0; s <= ' + y + '; s += 300) { scrollTo(0, s); await new Promise((ok) => setTimeout(ok, 120)); } scrollTo(0, ' + y + '); await new Promise((ok) => setTimeout(ok, 2500)); return scrollY; })()' : 'new Promise((ok) => setTimeout(() => ok(0), 1500))';
    await renderer.render({ url: p.url, width: p.width, height: p.height, clip: p.clip, out, format: 'png', probe, scale: 2 });
  }
  return files;
}

// Renders main.png and detail-N.jpg into outDir and returns their paths plus a 190 px preview of the
// main card, the width a search grid shows it at.
export async function renderListingImages({ listing, studio, outDir, proofs = [], plan = { card: [], gallery: [] }, proofDir, refreshProofs = false }) {
  mkdirSync(outDir, { recursive: true });
  const renderer = await openRenderer();
  try {
    const byId = Object.fromEntries(proofs.map((p) => [p.id, p]));
    const refs = [...plan.card, ...plan.gallery].map(refOf);
    const need = [...new Set(refs.filter((r) => r.kind === 'capture').map((r) => r.id))].map((id) => byId[id]).filter(Boolean);
    const files = proofDir ? await captureProofs(need, proofDir, { renderer, refresh: refreshProofs }) : {};
    const shot = (r) => (r.kind === 'capture' ? (files[r.id] ? shotOf(files[r.id], byId[r.id]) : null) : { src: dataUrl(r.file), ...imageSize(readFileSync(r.file)), sample: r.kind === 'sample' });
    const shots = (list) => list.map(refOf).map(shot).filter(Boolean);
    const main = join(outDir, 'main.png');
    await renderer.render({ html: mainHtml({ listing, studio, cardShots: shots(plan.card) }), ...MAIN_SIZE, out: main, format: 'png' });
    const preview = join(outDir, 'main-190.png');
    await renderer.render({ html: mainHtml({ listing, studio, cardShots: shots(plan.card) }), ...MAIN_SIZE, out: preview, format: 'png', maxSide: 190 });
    const detail = [];
    const htmls = detailHtmls({ listing, studio, gallery: shots(plan.gallery) });
    for (const [i, html] of htmls.entries()) {
      const out = join(outDir, 'detail-' + (i + 1) + '.jpg');
      // A short viewport lets the full-page capture end where the content ends.
      await renderer.render({ html, width: DETAIL_WIDTH, height: 200, fullPage: true, out, format: 'jpeg', quality: 90, scale: DETAIL_SCALE });
      detail.push(out);
    }
    return { main, detail, preview, violations: checkImages({ main, detail }) };
  } finally {
    await renderer.close();
  }
}

