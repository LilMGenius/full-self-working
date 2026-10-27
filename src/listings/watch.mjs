// The supervisor's two listings jobs (moved from src/cli/listings.mjs at main): listingsWatch hourly
// (review results of published gigs) and listingsRefresh daily (gigs whose top portfolio items changed or
// whose images were rendered with an older images version).
import { dayKey } from '../core/clock.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { latestTable } from '../economics/price-table.mjs';
import { priceRowFor } from '../economics/pricing.mjs';
import { IMAGES_VERSION } from './images.mjs';
import { listingTexts } from './kmong.mjs';
import { basisChanged } from './proofs.mjs';
import { addedText, gigStatus, nextReviewAction, parseReviewNotice, readReview, rejectionKey, reviewViolation, writeReview } from './review.mjs';
import { recordOutcome } from '../learning/outcomes.mjs';
import { careerLabel, careerMonths } from '../core/profile.mjs';
import { build, listingsDir, loadProofs, openListings, planFor, portfolioItems, publish, readJson, readPublished, render, specFile } from './gig.mjs';

const openAdapter = async (ctx) => (ctx.openKmong ?? openListings)();
const notify = (ctx, msg) => (ctx.notify ?? notifyOperator)(ctx.instance, msg);

// Whether a publish call may have sent the gig to kmong review: a returned record says so in submitted
// (true also when /my-gigs did not show the gig afterwards); a throw is unknown unless it is the spec check
// publish makes before it opens the form (FSW_LISTING_BLOCKED), so it counts as sent.
export const maybeSent = (r, err) => (err ? err.code !== 'FSW_LISTING_BLOCKED' : r?.submitted === true);

// Sends to kmong review a gig's review state shows on a Seoul day: a refresh whose time is that day, and
// each resubmit after a rejection that may have been sent that day (sent, or ok for records written before
// sent was kept).
export function sendsOn(state, day) {
  const on = (at) => Boolean(at) && dayKey(new Date(at)) === day;
  return (on(state.refreshedAt) ? 1 : 0) + (state.resubmits ?? []).filter((r) => (r.sent ?? r.ok === true) && on(r.at)).length;
}

// What is left of listings.refreshPerDay on a Seoul day, shared by the daily refresh and the watch's
// resubmits. An absent setting leaves no room: it gates kmong review, so it fails closed. current is the
// in-memory state of the gig being handled, read in place of its file.
export function roomOn(instance, day, current = null) {
  const dir = listingsDir(instance);
  const used = readPublished(instance).reduce((n, p) => n + sendsOn(current?.service === p.service ? current.state : readReview(dir, p.service), day), 0);
  return (instance.config?.listings?.refreshPerDay ?? 0) - used;
}

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
    // Each rejection with its time, so the redesign stop reads rejections after a redesign even once
    // lastStatus moved on (listingsWatch overwrites it within the hour).
    state.rejections = [...(state.rejections ?? []), { at: (ctx.now ?? new Date()).toISOString(), key: observed.key }];
  }
  const at = (ctx.now ?? new Date()).toISOString();
  if (act.action === 'escalate' || ctx.forceMode === 'observe') {
    const why = act.action === 'escalate' ? act.detail : 'FSW_FORCE_MODE=observe keeps the agent from resubmitting: ' + observed.notice;
    await notify(ctx, { kind: 'listing', title: 'kmong gig ' + p.gigId + ' (' + p.service + ') needs a person', body: why, url: 'https://kmong.com/my-gigs?statusType=REJECTED', dedupeKey: 'listing-rejected-' + p.gigId + '-' + observed.key });
    if (act.action === 'escalate') Object.assign(state, { handledRejection: observed.key, lastStatus: 'rejected', escalatedAt: at });
    return { action: act.action === 'escalate' ? 'escalated' : 'observed', detail: why };
  }
  // A resubmit goes to kmong review like a refresh, so it waits for the next Seoul day once the day's
  // listings.refreshPerDay sends are spent; the rejection stays unhandled and the next hourly pass tries again.
  if (roomOn(instance, dayKey(ctx.now ?? new Date()), { service: p.service, state }) <= 0) {
    return { action: 'waiting', detail: "the day's listings.refreshPerDay sends to kmong review are spent; the resubmit waits for the next Seoul day" };
  }
  let reached = false;
  try {
    await (ctx.build ?? build)(p.service, { instance, runCodex: ctx.runCodex, log: ctx.log ?? (() => {}), violations: [reviewViolation(observed.notice)], previous: spec });
    reached = true;
    const r = await (ctx.publish ?? publish)(p.service, { instance, adapter, ledger, log: ctx.log ?? (() => {}), replaceImages: ['main', 'detail'] });
    state.resubmits = [...(state.resubmits ?? []), { at, key: observed.key, notice: observed.notice, ok: r.observed === true && r.submitted === true, sent: maybeSent(r), status: r.status ?? null, reason: r.reason ?? null }];
    if (r.observed && r.submitted) {
      Object.assign(state, { handledRejection: observed.key, lastStatus: gigStatus(r.status) });
      return { action: 'resubmitted', status: r.status };
    }
    return { action: 'resubmit_failed', detail: r.reason };
  } catch (err) {
    state.resubmits = [...(state.resubmits ?? []), { at, key: observed.key, notice: observed.notice, ok: false, sent: reached && maybeSent(null, err), error: (err.code ? err.code + ' ' : '') + err.message }];
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

// Pure: whether one gig is rebuilt today. last is the newest refresh time or null; room is how many gigs may
// still go to kmong review this Seoul day (listings.refreshPerDay less those refreshed today);
// redesignRejected says a gig rendered with the current images version was rejected after its redesign, so
// the rest of a redesign waits for the operator instead of following it into review.
export function refreshDecision({ status, before, now, last, imagesVersion = IMAGES_VERSION, room = 1, redesignRejected = false, today = new Date(), minDays = REFRESH_MIN_DAYS }) {
  const moved = basisChanged(before, now);
  if (!moved && imagesVersion === IMAGES_VERSION) return { refresh: false, reason: 'top portfolio items unchanged' };
  if (gigStatus(status) !== 'selling') return { refresh: false, reason: 'the gig is ' + (status ?? 'not listed') + ', not on sale' };
  if (last && today.getTime() - Date.parse(last) < minDays * 86_400_000) return { refresh: false, reason: 'refreshed within ' + minDays + ' days' };
  if (!moved && redesignRejected) return { refresh: false, reason: 'a gig rendered with images version ' + IMAGES_VERSION + ' was rejected; the redesign waits' };
  if (room <= 0) return { refresh: false, reason: "the day's listings.refreshPerDay gigs already went to review" };
  return { refresh: true, reason: moved ? 'top items moved from ' + (before ?? []).join(', ') + ' to ' + now.join(', ') : 'images rendered with version ' + imagesVersion + ', now ' + IMAGES_VERSION };
}

// The spec's package prices equal the price row's (standard, deluxe, premium), the comparison checkListing makes.
export const samePrices = (spec, row) => Boolean(row?.packages) && (spec?.packages ?? []).map((p) => p.priceKRW).join() === [row.packages.standard, row.packages.deluxe, row.packages.premium].join();

// The supervisor's daily listings job (00:00 Seoul, after the portfolio job): compares the ranked
// portfolio each published gig was built from with the current one and the images version its spec was
// rendered with, and refreshes a gig only when one of them changed and refreshDecision allows it. It also
// records the before and after case of each redesign whose window has passed.
export async function listingsRefresh(ctx) {
  const career = await careerStep(ctx);
  const r = await refreshGigs(ctx);
  return { ...r, career, changes: ctx.ledger ? changeCases(ctx) : { recorded: 0, detail: 'no ledger' } };
}

async function refreshGigs(ctx) {
  const { instance } = ctx;
  const published = readPublished(instance);
  if (!published.length) return { status: 'skipped', detail: 'no published kmong listing yet' };
  const cfg = loadProofs(instance);
  const items = portfolioItems(instance);
  const candidates = published.map((p) => {
    const spec = readJson(specFile(instance, p.service));
    const before = spec?.portfolioBasis ?? legacyBasis(cfg, p.service, items);
    // A spec written before wp7 has no images version and reads as 1.
    return { p, spec, before, now: planFor(instance, p.service).basis, imagesVersion: spec?.imagesVersion ?? 1 };
  }).filter((c) => basisChanged(c.before, c.now) || c.imagesVersion !== IMAGES_VERSION);
  if (!candidates.length) return { status: 'ok', rows: [], detail: 'no gig shows a changed top item or an older images version' };
  if (ctx.forceMode === 'observe') return { status: 'skipped', detail: 'observe mode', keepDue: true };
  const dir = listingsDir(instance);
  // Basis refreshes, version refreshes and the watch's resubmits share one room; D sets the setting with
  // fsw settings reset after the handover.
  let room = roomOn(instance, dayKey(ctx.now ?? new Date()));
  // A redesign stops while a gig rendered with the current version was rejected after its redesign landed.
  const redesignRejected = published.some((p) => {
    const s = readReview(dir, p.service);
    return readJson(specFile(instance, p.service))?.imagesVersion === IMAGES_VERSION && s.redesignedAt && (s.rejections ?? []).some((r) => r.at > s.redesignedAt);
  });
  const priceRows = latestTable(instance.paths.pricing)?.table.rows ?? [];
  const a = await openAdapter(ctx);
  const rows = [];
  try {
    const { gigs } = await a.listings();
    for (const c of candidates) {
      const gig = gigs.find((g) => g.gigId === c.p.gigId);
      const state = readReview(dir, c.p.service);
      const d = refreshDecision({ status: gig?.status, before: c.before, now: c.now, last: state.refreshedAt ?? null, imagesVersion: c.imagesVersion, room, redesignRejected, today: ctx.now ?? new Date() });
      const row = { service: c.p.service, gigId: c.p.gigId, refresh: d.refresh, reason: d.reason };
      if (d.refresh) {
        const moved = basisChanged(c.before, c.now);
        const redesign = c.imagesVersion !== IMAGES_VERSION;
        let reached = false;
        let r = null;
        let failure = null;
        try {
          // A render keeps the spec's packages, and publish's checkListing refuses a package price off the
          // table (src/listings/kmong.mjs), so a spec priced from an older table is drafted again.
          const redraft = moved || !samePrices(c.spec, priceRowFor(priceRows, 'kmong', c.p.service));
          if (redraft) await (ctx.build ?? build)(c.p.service, { instance, runCodex: ctx.runCodex, log: ctx.log ?? (() => {}) });
          else await (ctx.render ?? render)(c.p.service, { instance, log: ctx.log ?? (() => {}) });
          // A new design changes the main card too; a moved basis alone changes only the detail images.
          reached = true;
          r = await (ctx.publish ?? publish)(c.p.service, { instance, adapter: a, ledger: ctx.ledger, log: ctx.log ?? (() => {}), replaceImages: redesign ? ['main', 'detail'] : ['detail'] });
          row.result = { observed: r.observed, submitted: r.submitted, status: r.status ?? null, reason: r.reason ?? null };
        } catch (err) {
          failure = err;
          row.result = { error: (err.code ? err.code + ' ' : '') + err.message };
        }
        // Every send kmong may have taken uses the day's room and records its time, read back or not, so the
        // next candidate waits for tomorrow and the 14-day rule keeps this gig from going to review twice.
        if (reached && maybeSent(r, failure)) {
          room -= 1;
          const at = (ctx.now ?? new Date()).toISOString();
          writeReview(dir, c.p.service, { ...state, refreshedAt: at, refreshConfirmed: Boolean(r?.observed && r?.submitted), ...(redesign ? { redesignedAt: at, redesignVersion: IMAGES_VERSION } : {}) });
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

// Buyer chats a kmong gig drew: kmong message threads filed under the gig's service, first seen in [from,
// to). The ledger keeps no gig id on a thread, so one gig per service (gig.json) is what keeps the count to
// that gig. Views are not counted: no page fsw reads holds them.
export function inquiryCount(ledger, service, { from, to }) {
  return ledger.listThreads({ platform: 'kmong' }).filter((t) => t.kind === 'message' && t.service === service && t.createdAt >= from && t.createdAt < to).length;
}

// Once listings.changeWindowDays passed after a redesign landed, one listing_change case per gig: the chats
// of the same span before and after it, so the next design pass learns whether the last one moved buyers.
export function changeCases(ctx) {
  const days = ctx.instance.config?.listings?.changeWindowDays;
  if (!(days > 0)) return { recorded: 0, detail: 'listings.changeWindowDays is not set' };
  const dir = listingsDir(ctx.instance);
  const now = (ctx.now ?? new Date()).getTime();
  const span = days * 86_400_000;
  const iso = (t) => new Date(t).toISOString();
  let recorded = 0;
  for (const p of readPublished(ctx.instance)) {
    const state = readReview(dir, p.service);
    if (!state.redesignedAt || state.changeCase === state.redesignedAt) continue;
    const at = Date.parse(state.redesignedAt);
    if (now < at + span) continue;
    const before = inquiryCount(ctx.ledger, p.service, { from: iso(at - span), to: iso(at) });
    const after = inquiryCount(ctx.ledger, p.service, { from: iso(at), to: iso(at + span) });
    recordOutcome(ctx.instance, ctx.ledger, { kind: 'listing_change', platform: 'kmong', service: p.service, threadRef: 'gig:' + p.gigId, text: 'buyer chats in the ' + days + ' days before images version ' + state.redesignVersion + ': ' + before + '; in the ' + days + ' days after: ' + after, note: 'gig views are not read; no page fsw reads holds them' });
    writeReview(dir, p.service, { ...state, changeCase: state.redesignedAt });
    recorded += 1;
  }
  return { recorded };
}
// The kmong seller-profile career, derived from the profile's dated roles (003 Decisions of 20:30, kmong
// career row): written only when the page shows another figure, and read back after the write. A forced
// observe pass writes no profile, so it skips before any page opens. ctx.careerPage is the page pair
// {read(), set(label)} from src/platforms/kmong/profile-page.mjs; until a signed-in recording of the
// seller-profile editor maps it, the step writes nothing and tells the operator the derived figure once.
export async function careerStep(ctx) {
  if (ctx.forceMode === 'observe') return { status: 'skipped', detail: 'FSW_FORCE_MODE=observe skips the career write' };
  const to = careerLabel(careerMonths(ctx.instance.profile, ctx.now ?? new Date()));
  if (to == null) return { changed: false, detail: 'career hidden: a role has no parseable period' };
  const page = ctx.careerPage ?? null;
  if (!page) {
    await notify(ctx, { kind: 'listing', title: 'kmong career should read ' + to, body: 'The kmong seller-profile career field is not mapped yet, so fsw does not write it. Your profile roles give ' + to + '; set it on kmong if the profile shows another figure.', dedupeKey: 'career:kmong' });
    return { changed: false, to, detail: 'the kmong career field is not mapped; the operator was told the derived figure' };
  }
  const from = await page.read();
  if (from === to) return { changed: false, from, to };
  const w = await page.set(to);
  const shown = await page.read();
  if (!w?.observed || shown !== to) return { changed: false, from, to, detail: 'the page shows ' + shown + ' after the write' };
  ctx.ledger?.addEvent({ kind: 'platform.profile_edit', platform: 'kmong', ref: 'career', payload: { from, to } });
  return { changed: true, from, to };
}
