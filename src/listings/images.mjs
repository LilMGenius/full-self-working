// Listing images for 크몽 gigs, rendered from HTML with the owned headless Chrome (src/render/html2png.mjs).
// One series for every gig, on the design tokens site/DESIGN.md records (src/render/tokens.mjs): an ink
// main card that carries one oversized Korean claim and a real screen of shipped work, and detail images in
// alternating paper and ink sections. Pretendard is inlined (src/render/fonts.mjs) and every render proves
// it drew the text. All words come from the gated listing copy and the fixed labels below; no URL, domain,
// contact detail, badge or invented number is drawn.
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { platformFontProblems, pretendardFontFace } from '../render/fonts.mjs';
import { openRenderer } from '../render/html2png.mjs';
import { tokensCss } from '../render/tokens.mjs';

// The design the images are rendered with. A spec rendered with an older version is re-rendered by the
// daily refresh (src/listings/watch.mjs); version 1 is the warm paper series of 2c77326.
export const IMAGES_VERSION = 2;

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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const won = (n) => Number(n).toLocaleString('ko-KR') + '원';
const two = (i) => String(i + 1).padStart(2, '0');
const dataUrl = (file) => 'data:image/' + (file.endsWith('.png') ? 'png' : 'jpeg') + ';base64,' + readFileSync(file).toString('base64');

const BASE_CSS = '*{box-sizing:border-box;margin:0;padding:0}' +
  'html,body{background:var(--color-paper)}' +
  'body{font-family:var(--font-family);font-weight:var(--font-body);color:var(--color-text);word-break:keep-all;overflow-wrap:break-word;-webkit-font-smoothing:antialiased;font-feature-settings:"tnum" 1}' +
  '.frame{overflow:hidden;background:var(--color-ink-raised);border:1px solid var(--color-line-on-ink)}' +
  '.frame img{display:block;width:100%;height:100%;object-fit:cover;object-position:top left}' +
  '.frame.whole img{object-fit:contain}' +
  '.tag{display:inline-block;font-size:var(--type-1);font-weight:var(--font-strong);line-height:1;color:var(--color-on-accent);background:var(--color-accent);border-radius:var(--radius-sm);padding:6px 9px}';

// Sets each [data-fit] block to the largest size up to data-max at which it fits its box, wide and (when the
// box has a height) tall, once the inlined face has loaded, so a short claim is set huge and a long one
// still fits on its lines.
// The overflow test the fit and its probe share: wider than its box, or taller when the box has a height.
const OVER = '(el) => el.scrollWidth > el.parentElement.clientWidth || (el.parentElement.clientHeight > 0 && el.offsetHeight > el.parentElement.clientHeight)';
export const FIT_FLOOR_PX = 28;
const FIT = '<script>const over = ' + OVER + '; document.fonts.ready.then(() => { for (const el of document.querySelectorAll("[data-fit]")) {' +
  ' let size = Number(el.dataset.max); el.style.fontSize = size + "px";' +
  ' while (over(el) && size > ' + FIT_FLOOR_PX + ') { size -= 2; el.style.fontSize = size + "px"; } } });</script>';
// Run after the page settled: the text of every fitted block that still overflows at the floor size.
const FIT_PROBE = '(() => { const over = ' + OVER + '; return [...document.querySelectorAll("[data-fit]")].filter(over).map((el) => el.innerText.replace(/\\s+/g, " ")); })()';

// fontFace is the inlined @font-face rule; an empty one (a face that failed to inline) makes every text node
// fall back, which the font proof in renderListingImages reports.
const page = (body, css, { width, height }, fontFace = pretendardFontFace()) => '<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>' + fontFace + tokensCss() + BASE_CSS + css + '</style></head><body style="width:' + width + 'px' + (height ? ';height:' + height + 'px;overflow:hidden' : '') + '">' + body + FIT + '</body></html>';

// ---- main card 652x488 ----

const MAIN_CSS = '.card{position:relative;width:652px;height:488px;overflow:hidden;background:var(--color-ink);color:var(--color-on-ink)}' +
  '.claim{position:absolute;left:40px;right:40px;top:36px;height:200px}' +
  'h1{display:inline-block;white-space:nowrap;font-weight:var(--font-display);line-height:1.04;letter-spacing:-.045em;font-size:var(--type-10)}' +
  // The second line of the claim carries the one accent, so the claim reads in two beats at grid size.
  'h1 em{font-style:normal;color:var(--color-accent-on-ink)}' +
  '.foot{position:absolute;left:40px;bottom:36px;width:180px}' +
  '.rule{width:56px;height:6px;background:var(--color-accent-on-ink)}' +
  '.sub{margin-top:14px;font-size:var(--type-3);line-height:1.4;font-weight:var(--font-strong);color:var(--color-on-ink-muted);letter-spacing:-.01em}' +
  // The gig's scope, two or three concrete items, as the leading covers name theirs.
  '.scope{margin-top:14px;display:flex;flex-direction:column;gap:7px}' +
  '.scope li{list-style:none;display:flex;align-items:center;gap:9px;font-size:var(--type-4);line-height:1.2;font-weight:var(--font-display);letter-spacing:-.02em;white-space:nowrap}' +
  '.scope li:before{content:"";flex:none;width:7px;height:7px;background:var(--color-accent-on-ink)}' +
  // The proof sits on a paper stage that bleeds off the card's right and bottom edges, so a dark screen
  // still stands apart from the ink field and the card reads in two tones at grid size.
  '.stage{position:absolute;left:244px;top:256px;right:0;bottom:0;background:var(--color-paper);border-radius:var(--radius-lg) 0 0 0;overflow:hidden}' +
  // One real screen, cropped by the stage's right and bottom edges, never tilted.
  '.screen{position:absolute;left:22px;top:22px;width:460px;height:288px;border-radius:var(--radius-md);border-color:var(--color-line)}' +
  '.screen.with-phone{left:100px}' +
  '.screen.phone{left:20px;top:40px;width:112px;height:184px;border:3px solid var(--color-ink);z-index:1}' +
  // A sample is shown whole, since cropping it would hide what was made.
  '.sample{position:absolute;left:20px;top:20px;border-radius:var(--radius-md);border-color:var(--color-line)}' +
  '.sample .tag{position:absolute;left:8px;top:8px}' +
  // Without a screen, the deliverables take its place as a file list.
  '.files{padding:26px 30px;color:var(--color-text)}' +
  '.files h2{font-size:var(--type-2);font-weight:var(--font-strong);color:var(--color-muted)}' +
  '.files div{display:flex;gap:14px;align-items:baseline;margin-top:12px;font-size:var(--type-4);font-weight:var(--font-strong);letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  '.files b{font-size:var(--type-2);color:var(--color-accent)}';

// The box a whole sample may take on the stage, and its size at the sample's aspect ratio.
const SAMPLE_BOX = { width: 368, height: 192 };
const fitBox = ({ width, height }) => {
  const k = Math.min(SAMPLE_BOX.width / width, SAMPLE_BOX.height / height);
  return { width: Math.round(width * k), height: Math.round(height * k) };
};

export function mainHtml({ listing, cardShots = [], fontFace }) {
  const c = listing.imageCopy.card;
  const [first, second] = cardShots;
  let visual;
  if (first?.sample) {
    const box = fitBox(first);
    visual = '<div class="stage"><div class="sample frame whole" style="width:' + box.width + 'px;height:' + box.height + 'px"><img src="' + first.src + '" alt=""><span class="tag">' + esc(LABELS.sample) + '</span></div></div>';
  } else if (first) {
    const phone = [first, second].find((s) => s && s.width < 600);
    const desk = [first, second].find((s) => s && s.width >= 600);
    visual = '<div class="stage">' + (desk ? '<div class="screen frame' + (phone ? ' with-phone' : '') + '"><img src="' + desk.src + '" alt=""></div>' : '') +
      (phone ? '<div class="screen phone frame"><img src="' + phone.src + '" alt=""></div>' : '') + '</div>';
  } else {
    visual = '<div class="stage files"><h2>' + esc(LABELS.included) + '</h2>' + listing.imageCopy.included.slice(0, 3).map((t, i) => '<div><b>' + two(i) + '</b>' + esc(t) + '</div>').join('') + '</div>';
  }
  const claim = c.headline.map((line, i) => (i === c.headline.length - 1 && i > 0 ? '<em>' + esc(line) + '</em>' : esc(line))).join('<br>');
  const body = '<div class="card"><div class="claim"><h1 data-fit data-max="112">' + claim + '</h1></div>' +
    '<div class="foot"><div class="rule"></div><p class="sub">' + esc(c.subline) + '</p><ul class="scope">' + (c.tags ?? []).slice(0, 3).map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul></div>' + visual + '</div>';
  return page(body, MAIN_CSS, MAIN_SIZE, fontFace);
}

// ---- detail images, 860 css px wide at 2x ----

const DETAIL_CSS = '.d{position:relative;width:' + DETAIL_WIDTH + 'px;padding:64px 64px 80px;background:var(--color-paper);overflow:hidden}' +
  '.d.ink{background:var(--color-ink);color:var(--color-on-ink)}' +
  '.head{display:flex;justify-content:space-between;align-items:center;font-size:var(--type-2);font-weight:var(--font-strong)}' +
  '.mark{display:flex;align-items:center;gap:10px}.mark i{display:block;width:10px;height:10px;background:var(--color-accent)}.ink .mark i{background:var(--color-accent-on-ink)}' +
  '.badge{font-size:var(--type-1);color:var(--color-muted);border:1px solid var(--color-line);border-radius:var(--radius-pill);padding:5px 12px;white-space:nowrap}' +
  '.ink .badge{color:var(--color-on-ink-muted);border-color:var(--color-line-on-ink)}' +
  '.h{margin-top:56px;width:100%}' +
  'h2{display:inline-block;white-space:nowrap;font-weight:var(--font-display);line-height:1.12;letter-spacing:-.04em;font-size:var(--type-8)}' +
  'h3.sec{margin-top:64px;font-size:var(--type-7);font-weight:var(--font-display);line-height:1.2;letter-spacing:-.035em}' +
  '.rule{margin-top:24px;width:56px;height:6px;background:var(--color-accent)}.ink .rule{background:var(--color-accent-on-ink)}' +
  '.lead{margin-top:24px;font-size:var(--type-4);line-height:1.7;color:var(--color-muted)}.ink .lead{color:var(--color-on-ink-muted)}' +
  '.rows{margin-top:28px;border-top:1px solid var(--color-line)}.ink .rows{border-color:var(--color-line-on-ink)}' +
  '.row{display:grid;grid-template-columns:56px 1fr;gap:8px;padding:20px 0;border-bottom:1px solid var(--color-line);font-size:21px;line-height:1.5;font-weight:var(--font-strong);letter-spacing:-.01em}' +
  '.ink .row{border-color:var(--color-line-on-ink)}' +
  '.row b,.step b{font-size:var(--type-3);font-weight:var(--font-display);color:var(--color-accent);padding-top:3px}.ink .row b,.ink .step b{color:var(--color-accent-on-ink)}' +
  '.step{display:grid;grid-template-columns:56px 1fr;gap:8px;padding:22px 0;border-bottom:1px solid var(--color-line-on-ink)}' +
  '.step h4{font-size:22px;font-weight:var(--font-strong);letter-spacing:-.015em}.step p{margin-top:6px;font-size:18px;line-height:1.6;color:var(--color-on-ink-muted)}' +
  '.note{margin-top:40px;padding:28px 32px;background:var(--color-ink-raised);border:1px solid var(--color-line-on-ink);border-radius:var(--radius-lg)}' +
  '.note h4{font-size:var(--type-3);font-weight:var(--font-display);color:var(--color-accent-on-ink)}.note p{margin-top:10px;font-size:19px;line-height:1.65}' +
  '.figure{margin-top:40px}.figure .frame{width:100%;border-radius:var(--radius-lg)}.d:not(.ink) .figure .frame{border-color:var(--color-line)}' +
  '.cap{margin-top:14px;display:flex;align-items:center;gap:10px;font-size:var(--type-3);line-height:1.5;color:var(--color-muted)}.ink .cap{color:var(--color-on-ink-muted)}' +
  '.pair{display:grid;grid-template-columns:1fr 220px;gap:32px;align-items:center}.pair .frame{border-radius:22px;border:4px solid var(--color-ink-raised)}' +
  '.tiers{margin-top:36px;display:grid;grid-template-columns:repeat(3,1fr);gap:14px}' +
  '.tier{border:1px solid var(--color-line);border-radius:var(--radius-lg);padding:26px 22px 24px;background:var(--color-sheet);display:flex;flex-direction:column}' +
  '.tier.mid{background:var(--color-ink);color:var(--color-on-ink);border-color:var(--color-ink)}' +
  '.tier .t{font-size:var(--type-1);font-weight:var(--font-display);letter-spacing:.08em;color:var(--color-accent)}.tier.mid .t{color:var(--color-accent-on-ink)}' +
  '.tier h4{margin-top:12px;font-size:21px;line-height:1.35;font-weight:var(--font-strong);letter-spacing:-.015em;min-height:56px}' +
  '.tier p{margin-top:10px;font-size:16px;line-height:1.6;color:var(--color-muted);min-height:102px}.tier.mid p{color:var(--color-on-ink-muted)}' +
  '.tier .price{margin-top:18px;font-size:28px;font-weight:var(--font-display);letter-spacing:-.02em}' +
  '.tier dl{margin-top:16px;border-top:1px solid var(--color-line);padding-top:12px;display:grid;grid-template-columns:1fr auto;row-gap:6px;font-size:15px}' +
  '.tier.mid dl{border-color:var(--color-line-on-ink)}.tier dt{color:var(--color-muted)}.tier.mid dt{color:var(--color-on-ink-muted)}.tier dd{font-weight:var(--font-strong)}' +
  '.small{margin-top:22px;font-size:15px;color:var(--color-muted)}';

const head = (studio) => '<div class="head"><div class="mark"><i></i>' + esc(studio) + '</div><div class="badge">' + esc(LABELS.aiBadge) + '</div></div>';
// A section heading set as large as its longest line allows (FIT), with the accent rule under it.
const heading = (lines, max = 60) => '<div class="h"><h2 data-fit data-max="' + max + '">' + lines.map(esc).join('<br>') + '</h2></div><div class="rule"></div>';
// A sample (work the agent made for an imagined brief) carries a 작업 예시 tag so it never reads as client work.
const tag = (shot) => (shot.sample ? '<span class="tag">' + esc(LABELS.sample) + '</span>' : '');
const figure = (shot, caption) => '<div class="figure"><div class="frame" style="aspect-ratio:' + shot.width + '/' + shot.height + '"><img src="' + shot.src + '" alt=""></div>' + (caption || shot.sample ? '<p class="cap">' + tag(shot) + esc(caption ?? '') + '</p>' : '') + '</div>';
const detailPage = (studio, inner, dark = false, fontFace) => page('<div class="d' + (dark ? ' ink' : '') + '">' + head(studio) + inner + '</div>', DETAIL_CSS, { width: DETAIL_WIDTH }, fontFace);

export function detailHtmls({ listing, studio, gallery = [], fontFace }) {
  const c = listing.imageCopy;
  const captions = c.proofCaptions ?? [];
  const out = [];
  const detail = (name, inner, dark = false) => detailPage(name, inner, dark, fontFace);
  const rows = (list) => '<div class="rows">' + list.map((t, i) => '<div class="row"><b>' + two(i) + '</b><span>' + esc(t) + '</span></div>').join('') + '</div>';
  // 1. what this is and the first proof
  out.push(detail(studio, heading(c.intro.headline) + '<p class="lead">' + esc(c.intro.body) + '</p>' + (gallery[0] ? figure(gallery[0], captions[0]) : '')));
  // 2. who it suits and what is delivered
  out.push(detail(studio, heading([LABELS.audience], 52) + rows(c.audience) + '<h3 class="sec">' + esc(LABELS.included) + '</h3>' + rows(c.included)));
  // 3. process and the AI note, on ink
  out.push(detail(studio,
    heading([LABELS.process], 52) + '<div class="rows">' + c.steps.map((s, i) => '<div class="step"><b>' + two(i) + '</b><div><h4>' + esc(s.title) + '</h4><p>' + esc(s.detail) + '</p></div></div>').join('') + '</div>' +
    '<div class="note"><h4>' + esc(LABELS.ai) + '</h4><p>' + esc(c.aiNote) + '</p></div>', true));
  // 4. packages from the price table
  out.push(detail(studio,
    heading([LABELS.packages], 52) +
    '<div class="tiers">' + listing.packages.map((p, i) => '<div class="tier' + (i === 1 ? ' mid' : '') + '"><div class="t">' + esc(p.tier) + '</div><h4>' + esc(p.title) + '</h4><p>' + esc(p.description) + '</p><div class="price">' + won(p.priceKRW) + '</div><dl><dt>' + esc(LABELS.days) + '</dt><dd>' + p.days + '일</dd><dt>' + esc(LABELS.revisions) + '</dt><dd>' + p.revisions + '회</dd></dl></div>').join('') + '</div>' +
    '<p class="small">' + esc(LABELS.packagesNote) + '</p>'));
  // 5. the rest of the proof gallery, when there is more than the first shot, on ink
  const rest = gallery.slice(1);
  if (rest.length) {
    const phones = rest.filter((s) => s.width < 600);
    const desks = rest.filter((s) => s.width >= 600);
    const samples = rest.filter((s) => s.sample).length;
    const [title, note] = samples === rest.length ? [LABELS.sample, LABELS.sampleNote] : samples ? [LABELS.proof, LABELS.mixedNote] : [LABELS.proof, LABELS.proofNote];
    let inner = heading([title], 52) + '<p class="lead">' + esc(note) + '</p>';
    desks.forEach((s) => (inner += figure(s, captions[gallery.indexOf(s)])));
    phones.forEach((s) => (inner += '<div class="figure pair"><p class="cap">' + tag(s) + esc(captions[gallery.indexOf(s)]) + '</p><div class="frame" style="aspect-ratio:' + s.width + '/' + s.height + '"><img src="' + s.src + '" alt=""></div></div>'));
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

// Renders main.png and detail-N.jpg into outDir and returns their paths, a 190 px preview of the main card
// (the width a search grid shows it at), the images version, and the slot and font violations. Every render
// asks the renderer which face drew each text node, so a fallback face fails the images.
export async function renderListingImages({ listing, studio, outDir, proofs = [], plan = { card: [], gallery: [] }, proofDir, refreshProofs = false, fontFace }) {
  mkdirSync(outDir, { recursive: true });
  const renderer = await openRenderer();
  try {
    const byId = Object.fromEntries(proofs.map((p) => [p.id, p]));
    const refs = [...plan.card, ...plan.gallery].map(refOf);
    const need = [...new Set(refs.filter((r) => r.kind === 'capture').map((r) => r.id))].map((id) => byId[id]).filter(Boolean);
    const files = proofDir ? await captureProofs(need, proofDir, { renderer, refresh: refreshProofs }) : {};
    const shot = (r) => (r.kind === 'capture' ? (files[r.id] ? shotOf(files[r.id], byId[r.id]) : null) : { src: dataUrl(r.file), ...imageSize(readFileSync(r.file)), sample: r.kind === 'sample' });
    const shots = (list) => list.map(refOf).map(shot).filter(Boolean);
    const fonts = [];
    // A fallback face, and a fitted heading that overflows even at the floor size (it would be clipped by the
    // image edge), are each a violation of the image they were drawn in.
    const proved = (name, r) => {
      for (const detail of platformFontProblems(r.platformFonts, 'Pretendard')) fonts.push({ field: 'images.' + name, rule: 'image.font', detail });
      for (const text of r.probe ?? []) fonts.push({ field: 'images.' + name, rule: 'image.text_fit', detail: 'the heading does not fit its box even at ' + FIT_FLOOR_PX + ' px: ' + text });
      return r;
    };
    const mainPage = mainHtml({ listing, studio, cardShots: shots(plan.card), fontFace });
    const main = join(outDir, 'main.png');
    proved('main', await renderer.render({ html: mainPage, ...MAIN_SIZE, out: main, format: 'png', fontReport: true, probe: FIT_PROBE }));
    const preview = join(outDir, 'main-190.png');
    await renderer.render({ html: mainPage, ...MAIN_SIZE, out: preview, format: 'png', maxSide: 190 });
    const detail = [];
    for (const [i, html] of detailHtmls({ listing, studio, gallery: shots(plan.gallery), fontFace }).entries()) {
      const out = join(outDir, 'detail-' + (i + 1) + '.jpg');
      // A short viewport lets the full-page capture end where the content ends.
      proved('detail.' + i, await renderer.render({ html, width: DETAIL_WIDTH, height: 200, fullPage: true, out, format: 'jpeg', quality: 90, scale: DETAIL_SCALE, fontReport: true, probe: FIT_PROBE }));
      detail.push(out);
    }
    return { main, detail, preview, version: IMAGES_VERSION, violations: [...checkImages({ main, detail }), ...fonts] };
  } finally {
    await renderer.close();
  }
}
