// fsw listings: build <service> writes a 크몽 gig spec and its images under the instance for review;
// publish <service> checks the written spec again and submits it through the adapter, then records
// what /my-gigs showed. The proof screenshots each gig shows are instance data (listings/proofs.json:
// the pages to capture and which ones each service uses), since they name the operator's own sites.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { logEvent } from '../core/log.mjs';
import { dayKey } from '../core/clock.mjs';
import { latestTable } from './price.mjs';
import { buildListing, checkListing, ListingError } from '../listings/kmong.mjs';
import { checkImages, renderListingImages } from '../listings/images.mjs';
import { loadGateRules } from '../brain/respond.mjs';

export const listingsDir = (instance) => join(instance.dir, 'listings');
export const specFile = (instance, service) => join(listingsDir(instance), service, 'spec.json');
// The gig a service is listed under once a draft exists: {gigId, rootCategoryId, subCategoryId}.
const gigFile = (instance, service) => join(listingsDir(instance), service, 'gig.json');

const writeJson = (file, value) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  renameSync(file + '.tmp', file);
};

export function loadProofs(instance) {
  const file = join(listingsDir(instance), 'proofs.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { proofs: [], services: {} };
}

// The studio name drawn on the images: the company name without its romanised form in brackets.
export const studioName = (instance) => instance.config.listings?.studio ?? String(instance.business?.company ?? '').replace(/\s*\(.*\)\s*$/, '').trim();

// Renders the images of a listing into its folder and returns the spec image fields.
async function renderFor(instance, service, listing, { refreshProofs = false } = {}) {
  const cfg = loadProofs(instance);
  const plan = cfg.services?.[service] ?? { card: [], gallery: [] };
  const outDir = join(listingsDir(instance), service);
  const images = await renderListingImages({ listing, studio: studioName(instance), outDir, proofs: cfg.proofs ?? [], plan, proofDir: join(listingsDir(instance), '_proofs'), refreshProofs });
  if (images.violations.length) throw new ListingError('FSW_LISTING_IMAGES', 'rendered images break the slot rules', { violations: images.violations });
  return { main: relative(outDir, images.main), detail: images.detail.map((f) => relative(outDir, f)), preview190: relative(outDir, images.preview) };
}

// Re-renders the images of a written spec without asking the brain again (a template change).
export async function render(service, { instance, log = console.log, refreshProofs = false } = {}) {
  const file = specFile(instance, service);
  if (!existsSync(file)) throw new ListingError('FSW_LISTING_NO_SPEC', 'no spec for ' + service + '; run fsw listings build ' + service);
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  log('listings: rendering ' + service + ' images from its spec');
  const images = await renderFor(instance, service, spec, { refreshProofs });
  writeJson(file, { ...spec, images, renderedAt: new Date().toISOString() });
  return { spec: { ...spec, images }, file };
}

export async function build(service, { instance, runCodex, log = console.log, refreshProofs = false } = {}) {
  const table = latestTable(instance.paths.pricing);
  if (!table) throw new ListingError('FSW_LISTING_NO_PRICE', 'no price table; run fsw price first');
  const cfg = loadProofs(instance);
  const plan = cfg.services?.[service] ?? { card: [], gallery: [] };
  const byId = Object.fromEntries((cfg.proofs ?? []).map((p) => [p.id, p]));
  const proofs = plan.gallery.map((id) => byId[id]).filter(Boolean).map((p) => ({ project: p.project, note: p.note }));
  log('listings: drafting ' + service + ' through the brain');
  const { listing, modelCalls, retried } = await buildListing(service, { instance, priceTable: table.table.rows, proofs, ...(runCodex ? { runCodex } : {}) });
  log('listings: rendering images');
  const images = await renderFor(instance, service, listing, { refreshProofs });
  const spec = { ...listing, images, builtAt: new Date().toISOString(), priceTable: table.file, modelCalls, retried };
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
  const images = { main: join(dir, spec.images.main), detail: spec.images.detail.map((f) => join(dir, f)) };
  const table = latestTable(instance.paths.pricing);
  const priceRow = table?.table.rows.find((r) => r.platform === 'kmong' && r.service === service) ?? null;
  const violations = [...checkListing(spec, { instance, lessonsRules: loadGateRules(instance), priceRow }), ...checkImages(images)];
  return { spec: { ...spec, images }, violations };
}

export async function publish(service, { instance, adapter, log = console.log, ledger, submit = true } = {}) {
  const { spec, violations } = readSpec(instance, service);
  if (violations.length) throw new ListingError('FSW_LISTING_BLOCKED', 'the ' + service + ' spec fails its checks', { violations });
  const own = !adapter;
  const a = adapter ?? (await (await import('../platforms/kmong/adapter.mjs')).openKmong());
  const gig = existsSync(gigFile(instance, service)) ? JSON.parse(readFileSync(gigFile(instance, service), 'utf8')) : null;
  const target = gig?.gigId ? { ...spec, gigId: gig.gigId, categoryIds: { root: gig.rootCategoryId, sub: gig.subCategoryId } } : spec;
  try {
    log('listings: submitting ' + service + ' on kmong');
    const result = await a.upsertListing(target, { submit });
    const record = { service, at: new Date().toISOString(), ...result };
    if (result.gigId && result.gigId !== gig?.gigId) writeJson(gigFile(instance, service), { gigId: result.gigId, rootCategoryId: gig?.rootCategoryId ?? null, subCategoryId: gig?.subCategoryId ?? null });
    writeJson(join(listingsDir(instance), service, 'publish-' + dayKey(new Date()) + '.json'), record);
    ledger?.addEvent({ kind: 'listing.publish', platform: 'kmong', ref: result.gigId ? String(result.gigId) : service, payload: { service, observed: result.observed, status: result.status ?? null, gigId: result.gigId ?? null, reason: result.reason ?? null } });
    logEvent(instance, 'listing.publish', { platform: 'kmong', service, observed: result.observed, status: result.status ?? null, gigId: result.gigId ?? null });
    return record;
  } finally {
    if (own) await a.stop();
  }
}

// The supervisor's weekly listings job: re-reads /my-gigs and records the status of every published
// gig, so a rejection (비승인) surfaces in the digest. Building or submitting new gigs stays a command.
export async function listingsJob(ctx) {
  const { instance } = ctx;
  const dir = listingsDir(instance);
  const published = existsSync(dir) ? readPublished(instance) : [];
  if (!published.length) return { status: 'skipped', detail: 'no published kmong listing yet' };
  if (ctx.forceMode === 'observe') return { status: 'skipped', detail: 'observe mode', keepDue: true };
  const a = await (ctx.openKmong ?? (await import('../platforms/kmong/adapter.mjs')).openKmong)();
  try {
    const { gigs } = await a.listings();
    const rows = published.map((p) => ({ service: p.service, gigId: p.gigId, status: gigs.find((g) => g.gigId === p.gigId)?.status ?? null }));
    ctx.ledger?.addEvent({ kind: 'listing.status', platform: 'kmong', payload: { rows } });
    const missing = rows.filter((r) => !r.status);
    return { status: missing.length ? 'partial' : 'ok', rows };
  } finally {
    await a.stop();
  }
}

function readPublished(instance) {
  const dir = listingsDir(instance);
    return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => {
      const files = readdirSync(join(dir, d.name)).filter((f) => /^publish-\d{8}\.json$/.test(f)).sort();
      return files.length ? JSON.parse(readFileSync(join(dir, d.name, files.at(-1)), 'utf8')) : null;
    })
    .filter((r) => r?.gigId);
}

const USAGE = 'usage: fsw listings build|render <service> [--refresh-proofs] | check <service> | publish <service> [--no-submit]';

export async function run(argv, ctx = {}) {
  const [cmd, service, ...rest] = argv;
  const log = ctx.log ?? console.log;
  if (!['build', 'render', 'publish', 'check'].includes(cmd) || !service) {
    console.error(USAGE);
    return { exitCode: 2 };
  }
  const instance = ctx.instance ?? loadInstance();
  try {
    if (cmd === 'build' || cmd === 'render') {
      const opts = { instance, log, runCodex: ctx.runCodex, refreshProofs: rest.includes('--refresh-proofs') };
      const r = cmd === 'build' ? await build(service, opts) : await render(service, opts);
      log('listings: wrote ' + r.file);
      log('  title  ' + r.spec.title);
      log('  prices ' + r.spec.packages.map((p) => p.tier + ' ' + p.priceKRW).join(', '));
      log('  images ' + [r.spec.images.main, ...r.spec.images.detail].join(', '));
      return { exitCode: 0, ...r };
    }
    if (cmd === 'check') {
      const { violations } = readSpec(instance, service);
      for (const v of violations) log('  ' + v.field + ' [' + v.rule + '] ' + v.detail);
      log('listings: ' + service + ' ' + (violations.length ? violations.length + ' violations' : 'passes every check'));
      return { exitCode: violations.length ? 1 : 0, violations };
    }
    const ledger = openLedger(instance.paths.ledger);
    try {
      const r = await publish(service, { instance, log, ledger, adapter: ctx.adapter, submit: !rest.includes('--no-submit') });
      log('listings: ' + JSON.stringify(r));
      return { exitCode: r.observed ? 0 : 1, ...r };
    } finally {
      ledger.close();
    }
  } catch (err) {
    log('listings: ' + (err.code ?? 'error') + ' ' + err.message);
    for (const v of err.violations ?? []) log('  ' + v.field + ' [' + v.rule + '] ' + v.detail);
    return { exitCode: 1, error: err.message, code: err.code ?? null, violations: err.violations ?? [] };
  }
}

