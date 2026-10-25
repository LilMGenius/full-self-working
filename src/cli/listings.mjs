// fsw listings: build <service> writes a 크몽 gig spec and its images under the instance for review;
// publish <service> checks the written spec again and submits it through the adapter, then records
// what /my-gigs showed. Proof images follow the ranked portfolio (src/listings/proofs.mjs): the page
// captures are instance data (listings/proofs.json: the pages to capture, and the main card shots per
// service, a matter of taste), job media come from the portfolio, and work samples the agent made for
// a service sit in listings/_samples/<service>/samples.json. The supervisor runs listingsWatch hourly
// (review results) and listingsRefresh daily (portfolio changes).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { logEvent } from '../core/log.mjs';
import { dayKey } from '../core/clock.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { latestTable } from './price.mjs';
import { buildListing, checkListing, ListingError, listingTexts } from '../listings/kmong.mjs';
import { checkImages, renderListingImages } from '../listings/images.mjs';
import { basisChanged, proofPlan } from '../listings/proofs.mjs';
import { addedText, gigStatus, nextReviewAction, parseReviewNotice, readReview, rejectionKey, reviewViolation, writeReview } from '../listings/review.mjs';
import { itemsFromProfile, loadItems } from '../portfolio/store.mjs';
import { recordOutcome } from '../learning/outcomes.mjs';
import { loadGateRules } from '../brain/respond.mjs';

export const listingsDir = (instance) => join(instance.dir, 'listings');
export const specFile = (instance, service) => join(listingsDir(instance), service, 'spec.json');
// The gig a service is listed under once a draft exists: {gigId, rootCategoryId, subCategoryId, thirdCategoryId}.
const gigFile = (instance, service) => join(listingsDir(instance), service, 'gig.json');

const writeJson = (file, value) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  renameSync(file + '.tmp', file);
};
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

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
  const { gallery, basis } = proofPlan({ service, items: portfolioItems(instance), profile: instance.profile, proofs: cfg.proofs ?? [], samples });
  const card = (cfg.services?.[service]?.card ?? []).map((ref) => {
    if (!String(ref).startsWith('sample:')) return { kind: 'capture', id: ref };
    const s = samples.find((x) => 'sample:' + x.id === ref);
    if (!s) throw new ListingError('FSW_LISTING_NO_SAMPLE', service + ' card names ' + ref + ', which is not in its samples.json');
    return { kind: 'sample', file: s.file };
  });
  return { card, gallery: gallery.map((s) => shotRef(instance, s)), captions: gallery.map((s) => (s.kind === 'sample' ? { project: '작업 예시', note: s.note, sample: true } : { project: s.project, note: s.note })), basis };
}

// The studio name drawn on the images: the company name without its romanised form in brackets.
export const studioName = (instance) => instance.config.listings?.studio ?? String(instance.business?.company ?? '').replace(/\s*\(.*\)\s*$/, '').trim();

// Renders the images of a listing into its folder and returns the spec image fields.
async function renderFor(instance, service, listing, plan, { refreshProofs = false } = {}) {
  const cfg = loadProofs(instance);
  const outDir = join(listingsDir(instance), service);
  const images = await renderListingImages({ listing, studio: studioName(instance), outDir, proofs: cfg.proofs ?? [], plan, proofDir: join(listingsDir(instance), '_proofs'), refreshProofs });
  if (images.violations.length) throw new ListingError('FSW_LISTING_IMAGES', 'rendered images break the slot rules', { violations: images.violations });
  return { main: relative(outDir, images.main), detail: images.detail.map((f) => relative(outDir, f)), preview190: relative(outDir, images.preview) };
}

// Re-renders the images of a written spec without asking the brain again (a template change). A spec
// built before plans were recorded renders from the proofs.json service entry it was built from.
export async function render(service, { instance, log = console.log, refreshProofs = false } = {}) {
  const file = specFile(instance, service);
  if (!existsSync(file)) throw new ListingError('FSW_LISTING_NO_SPEC', 'no spec for ' + service + '; run fsw listings build ' + service);
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const plan = spec.proofPlan ?? loadProofs(instance).services?.[service] ?? { card: [], gallery: [] };
  log('listings: rendering ' + service + ' images from its spec');
  const images = await renderFor(instance, service, spec, plan, { refreshProofs });
  writeJson(file, { ...spec, images, renderedAt: new Date().toISOString() });
  return { spec: { ...spec, images }, file };
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
  const spec = { ...listing, images, proofPlan: proofPlanRefs, portfolioBasis: plan.basis, builtAt: new Date().toISOString(), priceTable: table.file, modelCalls, retried };
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

// The category ids a gig's edit URL needs, from gig.json.
const categoryIdsOf = (gig) => (gig?.rootCategoryId && gig?.subCategoryId ? { root: gig.rootCategoryId, sub: gig.subCategoryId, third: gig.thirdCategoryId ?? null } : null);

export async function publish(service, { instance, adapter, log = console.log, ledger, submit = true, replaceImages = [] } = {}) {
  const { spec, violations } = readSpec(instance, service);
  if (violations.length) throw new ListingError('FSW_LISTING_BLOCKED', 'the ' + service + ' spec fails its checks', { violations });
  const own = !adapter;
  const a = adapter ?? (await (await import('../platforms/kmong/adapter.mjs')).openKmong());
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

const openAdapter = async (ctx) => (ctx.openKmong ?? (await import('../platforms/kmong/adapter.mjs')).openKmong)();
const notify = (ctx, msg) => (ctx.notify ?? notifyOperator)(ctx.instance, msg);

// One rejected gig: the case is recorded once per rejection, then the listing is rebuilt with kmong's
// notice as a violation and resubmitted, or the operator is asked. Returns the row the job reports.
async function handleRejection(ctx, { p, gig, state, act, observed, adapter }) {
  const { instance, ledger } = ctx;
  const dir = listingsDir(instance);
  const spec = readJson(specFile(instance, p.service));
  if (state.recordedRejection !== observed.key) {
    const text = spec ? listingTexts(spec).map(([field, t]) => field + ': ' + t).join('\n') : 'gig ' + p.gigId;
    recordOutcome(instance, ledger, { kind: 'approval_rejected', platform: 'kmong', service: p.service, threadRef: 'gig:' + p.gigId, text, note: 'kmong review notice: ' + (observed.notice ?? '(none found)') });
    state.recordedRejection = observed.key;
  }
  const at = new Date().toISOString();
  if (act.action === 'escalate' || ctx.forceMode === 'observe') {
    const why = act.action === 'escalate' ? act.detail : 'FSW_FORCE_MODE=observe keeps the agent from resubmitting: ' + observed.notice;
    await notify(ctx, { kind: 'listing', title: 'kmong gig ' + p.gigId + ' (' + p.service + ') needs a person', body: why, url: 'https://kmong.com/my-gigs?statusType=REJECTED', dedupeKey: 'listing-rejected-' + p.gigId + '-' + observed.key });
    if (act.action === 'escalate') Object.assign(state, { handledRejection: observed.key, lastStatus: 'rejected', escalatedAt: at });
    return { action: act.action === 'escalate' ? 'escalated' : 'observed', detail: why };
  }
  try {
    await (ctx.build ?? build)(p.service, { instance, runCodex: ctx.runCodex, log: ctx.log ?? (() => {}), violations: [reviewViolation(observed.notice)], previous: spec });
    const r = await (ctx.publish ?? publish)(p.service, { instance, adapter, ledger, log: ctx.log ?? (() => {}), replaceImages: ['main', 'detail'] });
    state.resubmits = [...(state.resubmits ?? []), { at, key: observed.key, notice: observed.notice, ok: r.observed === true && r.submitted === true, status: r.status ?? null, reason: r.reason ?? null }];
    if (r.observed && r.submitted) {
      Object.assign(state, { handledRejection: observed.key, lastStatus: gigStatus(r.status) });
      return { action: 'resubmitted', status: r.status };
    }
    return { action: 'resubmit_failed', detail: r.reason };
  } catch (err) {
    state.resubmits = [...(state.resubmits ?? []), { at, key: observed.key, notice: observed.notice, ok: false, error: (err.code ? err.code + ' ' : '') + err.message }];
    return { action: 'resubmit_failed', detail: err.message };
  }
}

// The supervisor's hourly listings job (minute 0 Seoul): reads /my-gigs for every published gig and
// acts on its review status through src/listings/review.mjs. A forced observe pass reads, records and
// notifies but never resubmits.
export async function listingsWatch(ctx) {
  const { instance } = ctx;
  const dir = listingsDir(instance);
  const published = readPublished(instance);
  if (!published.length) return { status: 'skipped', detail: 'no published kmong listing yet' };
  const a = await openAdapter(ctx);
  const rows = [];
  try {
    const { gigs } = await a.listings();
    for (const p of published) {
      const gig = gigs.find((g) => g.gigId === p.gigId) ?? null;
      const state = readReview(dir, p.service);
      const observed = { status: gigStatus(gig?.status), key: rejectionKey(gig) };
      let act = nextReviewAction(state, observed);
      if (act.action === 'read_notice') {
        const n = await a.gigNotice(p.gigId);
        observed.notice = n.toggle ? parseReviewNotice(addedText(n.before, n.after)) : null;
        act = nextReviewAction(state, observed);
      }
      const row = { service: p.service, gigId: p.gigId, status: gig?.status ?? null, action: act.action };
      if (act.action === 'notify_selling') {
        await notify(ctx, { kind: 'listing', title: 'kmong gig ' + p.gigId + ' is on sale', body: p.service + ': ' + (gig.title ?? '') + ' passed the kmong review and is listed.', url: gig.url, dedupeKey: 'listing-selling-' + p.gigId });
        state.sellingNotifiedAt = new Date().toISOString();
        ctx.ledger?.addEvent({ kind: 'listing.selling', platform: 'kmong', ref: String(p.gigId), payload: { service: p.service } });
      } else if (act.action === 'resubmit' || act.action === 'escalate') {
        Object.assign(row, await handleRejection(ctx, { p, gig, state, act, observed, adapter: a }));
      }
      if (!['resubmitted', 'escalated'].includes(row.action) && observed.status !== 'unknown') state.lastStatus = observed.status;
      state.lastSeen = { at: new Date().toISOString(), status: gig?.status ?? null };
      writeReview(dir, p.service, state);
      rows.push(row);
    }
    ctx.ledger?.addEvent({ kind: 'listing.status', platform: 'kmong', payload: { rows } });
    const bad = rows.filter((r) => !r.status || r.action === 'resubmit_failed');
    return { status: bad.length ? 'partial' : 'ok', rows };
  } finally {
    await a.stop();
  }
}

// kmong re-reviews an edited gig that is on sale (편집승인: an edited gig's
// edit approval notice came 6 days later) and keeps showing it as 판매중, so a refresh only ever
// touches a gig on sale, at most once per REFRESH_MIN_DAYS, which covers kmong's review window of 7
// business days. A gig waiting for review cannot be edited at all.
export const REFRESH_MIN_DAYS = 14;

// The basis a gig built before plans were recorded was rendered from: the portfolio items whose
// captures its proofs.json gallery used.
export function legacyBasis(cfg, service, items) {
  const byProof = Object.fromEntries((cfg.proofs ?? []).map((p) => [p.id, p.project]));
  const ids = [];
  for (const id of cfg.services?.[service]?.gallery ?? []) {
    const item = items.find((i) => i.source === 'background' && i.title_en === byProof[id]);
    if (item && !ids.includes(item.id)) ids.push(item.id);
  }
  return ids;
}

// Pure: whether one gig is rebuilt today. last is the newest refresh time or null.
export function refreshDecision({ status, before, now, last, today = new Date(), minDays = REFRESH_MIN_DAYS }) {
  if (!basisChanged(before, now)) return { refresh: false, reason: 'top portfolio items unchanged' };
  if (gigStatus(status) !== 'selling') return { refresh: false, reason: 'the gig is ' + (status ?? 'not listed') + ', not on sale' };
  if (last && today.getTime() - Date.parse(last) < minDays * 86_400_000) return { refresh: false, reason: 'refreshed within ' + minDays + ' days' };
  return { refresh: true, reason: 'top items moved from ' + (before ?? []).join(', ') + ' to ' + now.join(', ') };
}

// The supervisor's daily listings job (00:00 Seoul, after the portfolio job): compares the ranked
// portfolio each published gig was built from with the current one, and rebuilds and updates a gig only
// when its top items changed and refreshDecision allows it.
export async function listingsRefresh(ctx) {
  const { instance } = ctx;
  const published = readPublished(instance);
  if (!published.length) return { status: 'skipped', detail: 'no published kmong listing yet' };
  const cfg = loadProofs(instance);
  const items = portfolioItems(instance);
  const candidates = published.map((p) => {
    const spec = readJson(specFile(instance, p.service));
    const before = spec?.portfolioBasis ?? legacyBasis(cfg, p.service, items);
    return { p, spec, before, now: planFor(instance, p.service).basis };
  }).filter((c) => basisChanged(c.before, c.now));
  if (!candidates.length) return { status: 'ok', rows: [], detail: 'no gig shows a changed top item' };
  if (ctx.forceMode === 'observe') return { status: 'skipped', detail: 'observe mode', keepDue: true };
  const a = await openAdapter(ctx);
  const rows = [];
  try {
    const { gigs } = await a.listings();
    for (const c of candidates) {
      const gig = gigs.find((g) => g.gigId === c.p.gigId);
      const state = readReview(listingsDir(instance), c.p.service);
      const d = refreshDecision({ status: gig?.status, before: c.before, now: c.now, last: state.refreshedAt ?? null });
      const row = { service: c.p.service, gigId: c.p.gigId, refresh: d.refresh, reason: d.reason };
      if (d.refresh) {
        try {
          await (ctx.build ?? build)(c.p.service, { instance, runCodex: ctx.runCodex, log: ctx.log ?? (() => {}) });
          const r = await (ctx.publish ?? publish)(c.p.service, { instance, adapter: a, ledger: ctx.ledger, log: ctx.log ?? (() => {}), replaceImages: ['detail'] });
          row.result = { observed: r.observed, submitted: r.submitted, status: r.status ?? null, reason: r.reason ?? null };
          if (r.observed && r.submitted) writeReview(listingsDir(instance), c.p.service, { ...state, refreshedAt: new Date().toISOString() });
        } catch (err) {
          row.result = { error: (err.code ? err.code + ' ' : '') + err.message };
        }
      }
      rows.push(row);
    }
    ctx.ledger?.addEvent({ kind: 'listing.refresh', platform: 'kmong', payload: { rows } });
    return { status: rows.some((r) => r.result && !r.result.submitted) ? 'partial' : 'ok', rows };
  } finally {
    await a.stop();
  }
}

const USAGE = 'usage: fsw listings build|render <service> [--refresh-proofs] | check <service> | publish <service> [--no-submit] [--replace-images]';

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
      const r = await publish(service, { instance, log, ledger, adapter: ctx.adapter, submit: !rest.includes('--no-submit'), replaceImages: rest.includes('--replace-images') ? ['main', 'detail'] : [] });
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

