// Reviews from platform evidence. A count rise on the seller profile is an event the operator must see
// until the platform's review rows parse; a parsed row becomes one review signal for the job it belongs
// to, keyed so a row read twice acts once (the money-key rule of src/deal/advance.mjs moneyKey).
import { notifyOperator } from '../core/notify.mjs';
import { advance } from '../deal/index.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
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

// The hourly job's review pass: one surface session per enabled platform whose surface has reviews?()
// and whose login holds. Counts are recorded every hour; parsed rows (U6.6) become review signals.
export async function recordReviews({ instance, ledger, now = new Date(), openSurface = defaultOpenSurface, notify = notifyOperator }) {
  const out = [];
  for (const [platform, cfg] of Object.entries(instance.config.platforms ?? {})) {
    if (!cfg?.enabled || !hasSurface(platform)) continue;
    let surface;
    try {
      surface = await openSurface(platform);
      if (typeof surface.reviews !== 'function') continue;
      if (!(await surface.login())?.loggedIn) {
        out.push({ platform, status: 'skipped', reason: 'not logged in' });
        continue;
      }
      const reviews = await surface.reviews();
      const counted = await recordReviewCounts({ ledger, instance, platform, reviews, notify });
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
      out.push({ platform, status: 'ok', changed: counted.changed, signals });
    } catch (err) {
      out.push({ platform, status: 'failed', reason: (err.code ? err.code + ' ' : '') + err.message });
    } finally {
      if (surface?.stop) await surface.stop();
    }
  }
  return out;
}
