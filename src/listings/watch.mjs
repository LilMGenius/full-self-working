// The supervisor's two listings jobs (moved from src/cli/listings.mjs at main): listingsWatch hourly
// (review results of published gigs) and listingsRefresh daily (gigs whose top portfolio items changed).
import { notifyOperator } from '../core/notify.mjs';
import { listingTexts } from './kmong.mjs';
import { basisChanged } from './proofs.mjs';
import { addedText, gigStatus, nextReviewAction, parseReviewNotice, readReview, rejectionKey, reviewViolation, writeReview } from './review.mjs';
import { recordOutcome } from '../learning/outcomes.mjs';
import { careerLabel, careerMonths } from '../core/profile.mjs';
import { build, listingsDir, loadProofs, openListings, planFor, portfolioItems, publish, readJson, readPublished, specFile } from './gig.mjs';

const openAdapter = async (ctx) => (ctx.openKmong ?? openListings)();
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
  const career = await careerStep(ctx);
  const r = await refreshGigs(ctx);
  return { ...r, career };
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
