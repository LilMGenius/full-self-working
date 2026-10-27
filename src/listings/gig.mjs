// The kmong gig writer (moved from src/cli/listings.mjs at main, so the supervisor's listings jobs and fsw
// listings share it without the supervisor importing the CLI): build <service> writes a gig spec and its
// images under the instance for review; publish checks the written spec again and submits it through the
// listing surface, then records what /my-gigs showed. Proof images follow the ranked portfolio
// (src/listings/proofs.mjs): the page captures are instance data (listings/proofs.json: the pages to
// capture, and the main card shots per service, a matter of taste), job media come from the portfolio, and
// work samples the agent made for a service sit in listings/_samples/<service>/samples.json.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { logEvent } from '../core/log.mjs';
import { dayKey } from '../core/clock.mjs';
import { latestTable } from '../economics/price-table.mjs';
import { buildListing, checkListing, ListingError } from './kmong.mjs';
import { checkImages, IMAGES_VERSION, renderListingImages } from './images.mjs';
import { proofPlan } from './proofs.mjs';
import { itemsFromProfile, loadItems } from '../portfolio/store.mjs';
import { loadGateRules } from '../brain/respond.mjs';
import { openListingSurface } from '../surface/index.mjs';

// The kmong listing surface (020's split of src/platforms/kmong/adapter.mjs along its two jobs, D7 amended):
// 003's ListingSurface {listings(), gigNotice(gigId), upsertListing(spec, {submit, replaceImages}), stop()}.
export const openListings = () => openListingSurface('kmong');

export const listingsDir = (instance) => join(instance.dir, 'listings');
export const specFile = (instance, service) => join(listingsDir(instance), service, 'spec.json');
// The gig a service is listed under once a draft exists: {gigId, rootCategoryId, subCategoryId, thirdCategoryId}.
export const gigFile = (instance, service) => join(listingsDir(instance), service, 'gig.json');

export const writeJson = (file, value) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  renameSync(file + '.tmp', file);
};
export const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

export function loadProofs(instance) {
  const file = join(listingsDir(instance), 'proofs.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { proofs: [], services: {} };
}

// Work samples for one service: [{id, file, note}] with file relative to the samples folder.
export function loadSamples(instance, service) {
  const dir = join(listingsDir(instance), '_samples', service);
  const list = readJson(join(dir, 'samples.json')) ?? [];
  return list.map((s) => ({ ...s, file: isAbsolute(s.file) ? s.file : join(dir, s.file) }));
}

// The portfolio as saved by the daily portfolio job, or the profile's projects before its first run.
export function portfolioItems(instance) {
  const items = loadItems(instance);
  return items.length ? items : itemsFromProfile(instance.profile);
}

const shotRef = (instance, s) => {
  if (s.kind === 'capture') return { kind: 'capture', id: s.id };
  if (s.kind === 'media') return { kind: 'media', file: join(instance.paths.portfolio, s.src) };
  return { kind: 'sample', file: s.file };
};

// What a service's images show now: the card shots named in proofs.json (a capture id, or sample:<id>),
// and the gallery and its basis from the ranked portfolio.
export function planFor(instance, service) {
  const cfg = loadProofs(instance);
  const samples = loadSamples(instance, service);
  // Only still images go into the detail images; a video sample fills the 동영상 slot (renderFor).
  const stills = samples.filter((s) => /\.(?:png|jpe?g)$/i.test(s.file));
  const { gallery, basis } = proofPlan({ service, items: portfolioItems(instance), profile: instance.profile, proofs: cfg.proofs ?? [], samples: stills });
  return { card: cardFor(instance, service, { cfg, samples }), gallery: gallery.map((s) => shotRef(instance, s)), captions: gallery.map((s) => (s.kind === 'sample' ? { project: '작업 예시', note: s.note, sample: true } : { project: s.project, note: s.note })), basis };
}

// The main card's shots as proofs.json names them for a service now (a matter of taste, not of the ranked
// portfolio): a capture id, or sample:<id> from the service's samples.json.
export function cardFor(instance, service, { cfg = loadProofs(instance), samples = loadSamples(instance, service) } = {}) {
  return (cfg.services?.[service]?.card ?? []).map((ref) => {
    if (!String(ref).startsWith('sample:')) return { kind: 'capture', id: ref };
    const s = samples.find((x) => 'sample:' + x.id === ref);
    if (!s) throw new ListingError('FSW_LISTING_NO_SAMPLE', service + ' card names ' + ref + ', which is not in its samples.json');
    return { kind: 'sample', file: s.file };
  });
}

// The studio name drawn on the images: the company name without its romanised form in brackets.
export const studioName = (instance) => instance.config.listings?.studio ?? String(instance.business?.company ?? '').replace(/\s*\(.*\)\s*$/, '').trim();

// Renders the images of a listing into its folder and returns the spec image fields.
async function renderFor(instance, service, listing, plan, { refreshProofs = false } = {}) {
  const cfg = loadProofs(instance);
  const outDir = join(listingsDir(instance), service);
  const images = await renderListingImages({ listing, studio: studioName(instance), outDir, proofs: cfg.proofs ?? [], plan, proofDir: join(listingsDir(instance), '_proofs'), refreshProofs });
  if (images.violations.length) throw new ListingError('FSW_LISTING_IMAGES', 'rendered images break the slot rules', { violations: images.violations });
  // A video category requires one file in 동영상: proofs.json services[service].video names a sample
  // (sample:<id>), copied beside the images.
  const ref = cfg.services?.[service]?.video;
  let video;
  if (ref) {
    const s = loadSamples(instance, service).find((x) => 'sample:' + x.id === ref);
    if (!s) throw new ListingError('FSW_LISTING_NO_SAMPLE', service + ' video names ' + ref + ', which is not in its samples.json');
    copyFileSync(s.file, join(outDir, 'video-1.mp4'));
    video = ['video-1.mp4'];
  }
  return { main: relative(outDir, images.main), detail: images.detail.map((f) => relative(outDir, f)), preview190: relative(outDir, images.preview), ...(video ? { video } : {}) };
}

// Re-renders the images of a written spec without asking the brain again (a template change). The gallery
// stays the one the spec was built from (its basis); the main card takes the shots proofs.json names now,
// so a redesign that names new cover shots reaches gigs re-rendered on the images-version path. A spec built
// before plans were recorded renders its gallery from the proofs.json service entry it was built from.
export async function render(service, { instance, log = console.log, refreshProofs = false } = {}) {
  const file = specFile(instance, service);
  if (!existsSync(file)) throw new ListingError('FSW_LISTING_NO_SPEC', 'no spec for ' + service + '; run fsw listings build ' + service);
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const plan = { card: cardFor(instance, service), gallery: (spec.proofPlan ?? loadProofs(instance).services?.[service])?.gallery ?? [] };
  log('listings: rendering ' + service + ' images from its spec');
  const images = await renderFor(instance, service, spec, plan, { refreshProofs });
  writeJson(file, { ...spec, images, proofPlan: plan, imagesVersion: IMAGES_VERSION, renderedAt: new Date().toISOString() });
  return { spec: { ...spec, images, proofPlan: plan }, file };
}

// violations and previous carry a review result from outside the gate (kmong's rejection notice) into
// the first draft.
export async function build(service, { instance, runCodex, log = console.log, refreshProofs = false, violations = [], previous = null } = {}) {
  const table = latestTable(instance.paths.pricing);
  if (!table) throw new ListingError('FSW_LISTING_NO_PRICE', 'no price table; run fsw price first');
  const plan = planFor(instance, service);
  log('listings: drafting ' + service + ' through the brain');
  const { listing, modelCalls, retried } = await buildListing(service, { instance, priceTable: table.table.rows, proofs: plan.captions, violations, previous, ...(runCodex ? { runCodex } : {}) });
  log('listings: rendering images');
  const proofPlanRefs = { card: plan.card, gallery: plan.gallery };
  const images = await renderFor(instance, service, listing, proofPlanRefs, { refreshProofs });
  const spec = { ...listing, images, imagesVersion: IMAGES_VERSION, proofPlan: proofPlanRefs, portfolioBasis: plan.basis, builtAt: new Date().toISOString(), priceTable: table.file, modelCalls, retried };
  writeJson(specFile(instance, service), spec);
  return { spec, file: specFile(instance, service) };
}

// Reads a written spec back with absolute image paths, and checks it again: a spec edited by hand
// after the build passes the same rules before it is submitted.
export function readSpec(instance, service) {
  const file = specFile(instance, service);
  if (!existsSync(file)) throw new ListingError('FSW_LISTING_NO_SPEC', 'no spec for ' + service + '; run fsw listings build ' + service);
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const dir = join(listingsDir(instance), service);
  const images = { main: join(dir, spec.images.main), detail: spec.images.detail.map((f) => join(dir, f)), ...(spec.images.video ? { video: spec.images.video.map((f) => join(dir, f)) } : {}) };
  const table = latestTable(instance.paths.pricing);
  const priceRow = table?.table.rows.find((r) => r.platform === 'kmong' && r.service === service) ?? null;
  const violations = [...checkListing(spec, { instance, lessonsRules: loadGateRules(instance), priceRow }), ...checkImages(images)];
  return { spec: { ...spec, images }, violations };
}

// The category ids a gig's edit URL needs, from gig.json.
const categoryIdsOf = (gig) => (gig?.rootCategoryId && gig?.subCategoryId ? { root: gig.rootCategoryId, sub: gig.subCategoryId, third: gig.thirdCategoryId ?? null } : null);

export async function publish(service, { instance, adapter, log = console.log, ledger, submit = true, replaceImages = [] } = {}) {
  const { spec, violations } = readSpec(instance, service);
  if (violations.length) throw new ListingError('FSW_LISTING_BLOCKED', 'the ' + service + ' spec fails its checks', { violations });
  const own = !adapter;
  const a = adapter ?? (await openListings());
  const gig = readJson(gigFile(instance, service));
  const target = gig?.gigId ? { ...spec, gigId: gig.gigId, categoryIds: categoryIdsOf(gig) } : spec;
  try {
    log('listings: submitting ' + service + ' on kmong');
    const result = await a.upsertListing(target, { submit, replaceImages });
    const record = { service, at: new Date().toISOString(), ...result };
    const ids = result.categoryIds ?? categoryIdsOf(gig);
    if (result.gigId) writeJson(gigFile(instance, service), { gigId: result.gigId, rootCategoryId: ids?.root ?? null, subCategoryId: ids?.sub ?? null, thirdCategoryId: ids?.third ?? null });
    writeJson(join(listingsDir(instance), service, 'publish-' + dayKey(new Date()) + '.json'), record);
    ledger?.addEvent({ kind: 'listing.publish', platform: 'kmong', ref: result.gigId ? String(result.gigId) : service, payload: { service, observed: result.observed, status: result.status ?? null, gigId: result.gigId ?? null, reason: result.reason ?? null } });
    logEvent(instance, 'listing.publish', { platform: 'kmong', service, observed: result.observed, status: result.status ?? null, gigId: result.gigId ?? null });
    return record;
  } finally {
    if (own) await a.stop();
  }
}

// The services with a submitted gig: the newest publish record of each.
export function readPublished(instance) {
  const dir = listingsDir(instance);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => {
      const files = readdirSync(join(dir, d.name)).filter((f) => /^publish-\d{8}\.json$/.test(f)).sort();
      return files.length ? JSON.parse(readFileSync(join(dir, d.name, files.at(-1)), 'utf8')) : null;
    })
    .filter((r) => r?.gigId && r.submitted !== false);
}
