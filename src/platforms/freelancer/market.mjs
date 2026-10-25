// Freelancer.com market sampling through its public projects API, which needs no login: the active
// fixed-price projects of each service's freelancerJob, newest first. Freelancer is a bidding platform,
// so the signal is the client's budget: each project becomes a sample whose priceKRW is the midpoint of
// its budget range, converted to KRW at the day's reference rates (src/economics/fx.mjs) with the rate
// kept beside it. Hourly projects are left out by the query (project_types[]=fixed); one that slips
// through, a project without a budget range and one in a currency the rates lack are skipped and counted
// by name. Job ids are read by name from the jobs endpoint on every run instead of being kept here.
// The endpoints are those of the public API documented at https://developers.freelancer.com.
import { fxNote, toKRW } from '../../economics/fx.mjs';
import { ChallengeError, challengeOf, sampleEach } from '../kit.mjs';

const BASE = 'https://www.freelancer.com';
const API = BASE + '/api/projects/0.1';

export const jobsUrl = (names) => API + '/jobs/?' + names.map((n) => 'job_names[]=' + encodeURIComponent(n)).join('&');
export const projectsUrl = (jobId, limit) => API + '/projects/active/?jobs[]=' + jobId + '&project_types[]=fixed&limit=' + limit + '&sort_field=time_updated';

// Chrome shows a JSON answer as text in a <pre>; anything else comes back as its title and text.
function pageBody() {
  const raw = document.querySelector('pre')?.textContent ?? document.body?.innerText ?? '';
  try {
    return { json: JSON.parse(raw) };
  } catch {
    return { title: document.title, text: raw.slice(0, 2000) };
  }
}

export function apiResult(body, url) {
  if (body?.json?.status === 'success') return body.json.result;
  const challenge = challengeOf(body ?? {});
  if (challenge) throw new ChallengeError(challenge, url);
  throw new Error('no success answer from ' + url + ': ' + (body?.json?.message ?? body?.title ?? 'not JSON'));
}

export const parseJobs = (result) => new Map((Array.isArray(result) ? result : []).filter((j) => j?.name && Number.isInteger(j.id)).map((j) => [j.name, j.id]));

export function parseProjects(result, fx) {
  const skipped = { notFixed: 0, noBudget: 0, currency: 0 };
  const projects = [];
  for (const p of result?.projects ?? []) {
    if (p.type !== 'fixed') {
      skipped.notFixed += 1;
      continue;
    }
    const { minimum: min, maximum: max } = p.budget ?? {};
    if (!(min > 0) || !(max >= min)) {
      skipped.noBudget += 1;
      continue;
    }
    const currency = p.currency?.code;
    let note;
    try {
      note = fxNote(currency, fx);
    } catch (err) {
      if (err.code !== 'FSW_FX_MISSING') throw err;
      skipped.currency += 1;
      continue;
    }
    projects.push({
      url: BASE + '/projects/' + p.seo_url,
      title: p.title?.trim() || null,
      priceKRW: toKRW((min + max) / 2, currency, fx),
      budget: { min, max, currency },
      bids: p.bid_stats?.bid_count ?? null,
      bidAvgKRW: p.bid_stats?.bid_avg > 0 ? toKRW(p.bid_stats.bid_avg, currency, fx) : null,
      postedAt: Number.isFinite(p.time_submitted) ? new Date(p.time_submitted * 1000).toISOString() : null,
      fx: note,
    });
  }
  return { total: result?.total_count ?? null, projects, skipped };
}

const SKIP_REASON = { notFixed: 'not fixed price', noBudget: 'no budget range', currency: 'currency without a rate' };

// One row per kept project. A job with no priced project fails its category by name, and a bot
// challenge ends the run's reads.
export async function sample(session, targets, { now = () => new Date(), fx, limit = 30 } = {}) {
  const jobsAt = jobsUrl(targets.map((t) => t.category));
  await session.navigate(jobsAt, { settle: 500 });
  const ids = parseJobs(apiResult(await session.evaluate(pageBody), jobsAt));
  const rows = [];
  const skipped = [];
  const errors = await sampleEach(targets, async ({ category }) => {
    const id = ids.get(category);
    if (!id) throw new Error('no Freelancer job named ' + category);
    const url = projectsUrl(id, limit);
    await session.navigate(url, { settle: 500 });
    const { total, projects, skipped: counts } = parseProjects(apiResult(await session.evaluate(pageBody), url), fx);
    for (const [reason, count] of Object.entries(counts)) if (count) skipped.push({ category, reason: SKIP_REASON[reason], count });
    if (!projects.length) throw new Error('no fixed-price project with a budget range on ' + url);
    const observedAt = now().toISOString();
    projects.forEach((p, i) => rows.push({ platform: 'freelancer', category, query: url, rank: i + 1, ...p, listingTotal: total, observedAt }));
  });
  return { rows, errors, skipped };
}
