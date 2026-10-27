// Which proof images a gig shows in its detail images (docs/DESIGN.md, Listings). Portfolio items come
// in the order rankPortfolio gives them (src/portfolio/rank.mjs, the only ordering): items that belong
// to the service first, then work samples the agent made for the service, then the rest of the
// ranked portfolio. A paid job the client allowed and that ranks into the top therefore replaces a
// background project in the images. The plan names the item ids it was built from (basis), so a daily
// check can tell whether the top items changed since the gig was rendered.
import { rankPortfolio } from '../portfolio/rank.mjs';

export const GALLERY_ITEMS = 3;
// The detail images hold the first shot on page 1 and the rest on one page of at most 3000 px.
export const GALLERY_SHOTS = 3;

function belongs(item, service, profile) {
  if (item.service === service) return true;
  if (item.source !== 'background') return false;
  return (profile?.serviceFit?.[service]?.evidence ?? []).includes(item.title_en);
}

// The shots one portfolio item can show: a background project's captured pages (proofs.json entries
// whose project names it), else the item's media files (src relative to the portfolio folder).
function shotsOf(item, proofs) {
  const captures = item.source === 'background' ? proofs.filter((p) => p.project === item.title_en) : [];
  if (captures.length) return captures.map((p) => ({ kind: 'capture', id: p.id, project: p.project, note: p.note, itemId: item.id }));
  return (item.media ?? [])
    .filter((m) => m?.src && (m.kind ?? 'image') === 'image' && m.width > 0 && m.height > 0)
    .map((m, i) => ({ kind: 'media', id: item.id + '#' + i, src: m.src, width: m.width, height: m.height, project: item.title_ko ?? item.id, note: m.alt || item.summary_ko || '', itemId: item.id }));
}

// items: portfolio items (unranked); proofs: capture definitions; samples: [{id, file, note}] the
// agent made for this service (file relative to the samples folder). Returns {gallery, basis}: gallery
// is the ordered shot list, basis the ranked item ids the gallery shows.
export function proofPlan({ service, items = [], profile = null, proofs = [], samples = [], maxItems = GALLERY_ITEMS, maxShots = GALLERY_SHOTS }) {
  const ranked = rankPortfolio(items).filter((i) => shotsOf(i, proofs).length);
  const own = ranked.filter((i) => belongs(i, service, profile)).slice(0, maxItems);
  const gallery = [];
  const basis = [];
  const take = (item) => {
    if (gallery.length >= maxShots) return;
    basis.push(item.id);
    for (const s of shotsOf(item, proofs)) if (gallery.length < maxShots) gallery.push(s);
  };
  own.forEach(take);
  for (const s of samples) if (gallery.length < maxShots) gallery.push({ kind: 'sample', id: 'sample:' + s.id, file: s.file, project: null, note: s.note, sample: true });
  if (!gallery.length) ranked.slice(0, maxItems).forEach(take);
  return { gallery, basis };
}

// True when the ranked items a gig was built from are no longer the ones it would show now. The ranking stays exact
// (src/portfolio/rank.mjs); here a run of items in now whose fame each differs by less than gap from the first item of
// the run (both known) is read in its before order, so a chain of small gaps never hides a larger lead change, so a one-star change that swaps two close items does not send the gig to kmong
// review again. An item that enters or leaves the basis, or a swap on any other key, still counts.
export function basisChanged(before, now, { fame = {}, gap = 0 } = {}) {
  const b = before ?? [];
  const n = now ?? [];
  if (JSON.stringify(b) === JSON.stringify(n)) return false;
  if (!(gap > 0) || b.length !== n.length || [...b].sort().join('\n') !== [...n].sort().join('\n')) return true;
  const close = (x, y) => fame[x] != null && fame[y] != null && Math.abs(fame[x] - fame[y]) < gap;
  const runs = [];
  for (const id of n) {
    if (runs.length && close(runs.at(-1)[0], id)) runs.at(-1).push(id);
    else runs.push([id]);
  }
  const at = new Map(b.map((id, i) => [id, i]));
  return JSON.stringify(runs.flatMap((r) => [...r].sort((x, y) => at.get(x) - at.get(y)))) !== JSON.stringify(b);
}
