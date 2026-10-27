// Reviews from platform evidence. A count rise on the seller profile is an event the operator must see
// until the platform's review rows parse; a parsed row becomes one review signal for the job it belongs
// to, keyed so a row read twice acts once (the money-key rule of src/deal/advance.mjs moneyKey).
import { dayKey } from '../core/clock.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { MONEY_LOOKBACK_DAYS, advance, fresh, jobsOfThread, minuteKey } from '../deal/index.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { writeSellerState } from '../economics/price-table.mjs';
import { hasSurface, openSurface as defaultOpenSurface } from '../surface/index.mjs';
import { applyEffects } from './effects.mjs';

export async function recordReviewCounts({ ledger, instance, platform, reviews, notify = notifyOperator }) {
  const counts = reviews?.counts;
  if (!counts || !Number.isInteger(counts.reviews)) return { changed: false, rise: null };
  const prev = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'reviews.read' AND platform = ? ORDER BY id DESC LIMIT 1").get(platform);
  const before = prev ? JSON.parse(prev.payload)?.counts ?? null : null;
  ledger.addEvent({ kind: 'reviews.read', platform, payload: { counts, gap: reviews.gap ?? null } });
  if (!before || !Number.isInteger(before.reviews) || counts.reviews <= before.reviews) return { changed: false, rise: null };
  const rise = { from: before.reviews, to: counts.reviews, rating: counts.rating ?? null };
  ledger.addEvent({ kind: 'reviews.changed', platform, payload: { rise, gap: reviews.gap ?? null } });
  if (reviews.rows === null) {
    await notify(instance, {
      kind: 'order',
      title: platform + ' reviews rose: ' + rise.from + ' to ' + rise.to,
      body: 'fsw does not read ' + platform + ' review rows yet, so no review was recorded. Record it with: fsw deal <jobId> review --rating <1-5> --text "<review>"',
      dedupeKey: 'reviews:' + platform + ':' + counts.reviews,
    });
  }
  return { changed: true, rise };
}

// The job a review belongs to: same platform, delivered or closed, its thread's customer is the review
// author, newest delivery first. null when none or more than one job fits equally.
export function matchReview(row, jobs, threadOf) {
  const fits = jobs
    .filter((j) => j.platform === row.platform && ['delivered', 'closed'].includes(j.status))
    .filter((j) => (threadOf(j.threadId)?.customer ?? null) === row.author)
    .sort((a, b) => String(b.deliveredAt ?? '').localeCompare(String(a.deliveredAt ?? '')));
  if (!fits.length) return null;
  if (fits.length > 1 && fits[0].deliveredAt === fits[1].deliveredAt) return null;
  return fits[0];
}

// The chat notice that a client posted a review (src/core/notices.mjs, event review) names no job and
// carries no rating or text, so it is no review signal: the deal refuses a review without a job id. It is
// recorded once under its own key, keyed like the money notices by thread and minute so every later poll
// of the same row does nothing, and the operator is told once which job to record it on: the delivered or
// closed jobs of the thread that have no review yet. A notice older than the money lookback (an old chat
// opened for the first time) is recorded as stale and told to nobody, as money() keeps history. An
// undated notice has no minute to key on, so nothing lasting is recorded for it: the notice's dedupe key
// holds only while its operator entry is open (notifyOperator), and a later undated review notice on the
// thread reaches the operator once that entry is resolved. An undated notice is skipped only when no
// candidate is left, every delivered or closed job of the thread already holding a review: then the notice
// still on the page has been answered, while a second job delivered later still gets its ask.
// Returns the notify effects for the loop.
export function reviewPosted(ledger, { platform, thread, signal, now = new Date() }) {
  const minute = minuteKey(signal.at);
  const key = platform + ':' + thread.externalId + ':review_posted:' + (minute ?? 'undated');
  if (minute && ledger.db.prepare("SELECT 1 FROM events WHERE kind = 'review.posted' AND ref = ?").get(key)) return [];
  const delivered = jobsOfThread(ledger, platform, thread.id).filter((j) => ['delivered', 'closed'].includes(j.status));
  const candidates = delivered.filter((j) => !ledger.jobReviews(j.id).length);
  if (!minute && delivered.length && !candidates.length) return [];
  if (minute) {
    const stale = !fresh(signal.at, now);
    ledger.addEvent({ kind: 'review.posted', platform, ref: key, payload: { thread: thread.externalId, at: signal.at, candidates: candidates.map((j) => j.id), ...(stale ? { stale: true, note: 'older than ' + MONEY_LOOKBACK_DAYS + ' days; recorded, not told' } : {}) } });
    if (stale) return [];
  }
  const verb = (id) => 'fsw deal ' + id + ' review --rating <1-5> --text "..."';
  const where = 'a client posted a review on ' + thread.externalId;
  const [one] = candidates;
  const note = candidates.length === 1
    ? { title: platform + ': ' + where + ' for job ' + one.id, body: where + ' for job ' + one.id + '; record it with ' + verb(one.id) + '\nThe notice carries no rating or text, so no review was recorded.' }
    : candidates.length
      ? { title: platform + ': ' + where + '; ' + candidates.length + ' jobs could be the one reviewed', body: where + '. Read the review on the platform and record it on the job it rates:\n' + candidates.map((j) => '- ' + verb(j.id) + ' (' + j.status + ', delivered ' + (j.deliveredAt ?? 'unknown') + ')').join('\n') }
      : { title: platform + ': ' + where + '; no delivered job there lacks a review', body: where + ', and no delivered or closed job of that thread is without a review. Read it on the platform; if it rates a job fsw knows, record it with ' + verb('<jobId>') + '.' };
  return [{ type: 'notify', note: { kind: 'order', ...note, dedupeKey: key } }];
}

// ReviewRow[] -> review signals for advance, plus the rows no job matched.
export function reviewSignals(rows, { jobs, threadOf, at = new Date().toISOString() }) {
  const signals = [];
  const unmatched = [];
  for (const row of rows ?? []) {
    const job = matchReview(row, jobs, threadOf);
    if (!job) {
      unmatched.push(row.key);
      continue;
    }
    signals.push({ type: 'review', platform: row.platform, threadId: job.threadId, jobId: job.id, at: row.at ?? at, evidence: { key: row.key, rating: row.rating ?? null, text: row.text ?? null, liked: null, source: 'review-row' } });
  }
  return { signals, unmatched };
}

// A platform whose counts have not been read for this long makes the hourly job partial and tells the
// operator once a Seoul day, since the read share is a rolling hour that busy polls can spend before every
// hourly mark, which would leave the counts deferred for good.
export const REVIEWS_STALE_MS = 24 * 3_600_000;

// {lastRead} when the platform's newest reviews.read is older than REVIEWS_STALE_MS, or when it was never
// read and its first deferral is that old; null otherwise.
export function staleReviews(ledger, platform, now) {
  const lastRead = ledger.db.prepare("SELECT at FROM events WHERE kind = 'reviews.read' AND platform = ? ORDER BY id DESC LIMIT 1").get(platform)?.at ?? null;
  const since = lastRead ?? ledger.db.prepare("SELECT at FROM events WHERE kind = 'reviews.deferred' AND platform = ? ORDER BY id LIMIT 1").get(platform)?.at ?? null;
  return since && now.getTime() - Date.parse(since) >= REVIEWS_STALE_MS ? { lastRead } : null;
}

// The hourly job's review pass: one surface session per enabled platform whose surface has reviews?().
// reviews() is its own sign-in check (a signed-out account reads no counts), so the pass loads no login
// page. The read counts toward the session's hourly read share (descriptor pacing.readActionsPerHour) and
// waits for the next hour when the share is spent, so it never takes the room the hour keeps for sends.
// Entries: ok; deferred (share spent, written as a reviews.deferred event); unread (no count, with the
// surface's gap, so a parser that broke for good is seen); failed (a throw). A stop that fails is kept on
// the entry instead of ending the job. An entry other than ok on a platform unread for REVIEWS_STALE_MS
// carries stale. Parsed rows (U6.6) become review signals.
export async function recordReviews({ instance, ledger, now = new Date(), openSurface = defaultOpenSurface, notify = notifyOperator }) {
  const out = [];
  for (const [platform, cfg] of Object.entries(instance.config.platforms ?? {})) {
    if (!cfg?.enabled || !hasSurface(platform)) continue;
    let surface;
    let entry = null;
    try {
      surface = await openSurface(platform);
      if (typeof surface.reviews !== 'function') continue;
      const guard = surface.session?.guard;
      if (typeof guard?.readRoom === 'function' && guard.readRoom() <= 0) {
        entry = { platform, status: 'deferred', reason: "the hour's read share is spent; the next hourly pass reads the counts" };
        ledger.addEvent({ kind: 'reviews.deferred', platform, payload: { reason: entry.reason } });
        continue;
      }
      const reviews = typeof guard?.reading === 'function' ? await guard.reading(() => surface.reviews()) : await surface.reviews();
      if (!Number.isInteger(reviews?.counts?.reviews)) {
        entry = { platform, status: 'unread', gap: reviews?.gap ?? 'the review count did not parse' };
        continue;
      }
      const counted = await recordReviewCounts({ ledger, instance, platform, reviews, notify });
      // A surface that reports its seller state (freelancer) has it written for the price table each pass.
      if (reviews.state) writeSellerState(instance.paths.platforms, platform, reviews.state, now);
      let signals = 0;
      if (Array.isArray(reviews.rows)) {
        const r = reviewSignals(reviews.rows, { jobs: ledger.listJobs({ platform }), threadOf: (id) => ledger.getThread(id), at: now.toISOString() });
        for (const key of r.unmatched) ledger.addEvent({ kind: 'review.unmatched', platform, payload: { key } });
        for (const s of r.signals) {
          const res = advance(ledger, s, { instance, descriptor: loadDescriptor(platform), now });
          await applyEffects(res.effects, { instance, ledger, notify });
          signals += 1;
        }
      }
      entry = { platform, status: 'ok', changed: counted.changed, signals };
    } catch (err) {
      entry = { platform, status: 'failed', reason: (err.code ? err.code + ' ' : '') + err.message };
    } finally {
      if (surface?.stop) {
        await surface.stop().catch((err) => {
          entry = { ...(entry ?? { platform, status: 'failed' }), stop: (err.code ? err.code + ' ' : '') + err.message };
        });
      }
      const stale = entry && entry.status !== 'ok' ? staleReviews(ledger, platform, now) : null;
      if (stale) {
        entry = { ...entry, stale };
        await notify(instance, {
          kind: 'operator',
          title: platform + ' review counts were not read for 24 hours',
          body: (stale.lastRead ? 'The last ' + platform + ' review count was read at ' + stale.lastRead + '.' : platform + ' review counts were never read.') + ' The hourly review pass ' + (entry.status === 'deferred' ? 'waited each hour because the polls spent the hour\'s read share (descriptor pacing.readActionsPerHour)' : 'ended ' + entry.status + ': ' + (entry.gap ?? entry.reason ?? entry.stop)) + ', so a new review would go unseen. Check the platform\'s reviews by hand and record one with fsw deal <jobId> review --rating <1-5>.',
          dedupeKey: 'reviews-stale:' + platform + ':' + dayKey(now),
        });
      }
      if (entry) out.push(entry);
    }
  }
  return out;
}
