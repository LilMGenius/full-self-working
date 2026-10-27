// Freelancer.com projects through the public projects API (https://developers.freelancer.com), the page
// knowledge the surface maps: the active fixed-price projects under the catalog's freelancerJob names and
// one project's full description. These reads need no login, so they go through Node's fetch and never load
// a page in the operator's Chrome; the sign-in check reads the API's self endpoint in his signed-in session,
// whose cookies Node's fetch does not carry.
import { googleSignIn, pathOf, SIGN_IN_PATH } from '../onboarding.mjs';
import { apiResult, jobsUrl, pageBody } from './market.mjs';

const BASE = 'https://www.freelancer.com';
const API = BASE + '/api/projects/0.1';
export const SELF_URL = BASE + '/api/users/0.1/self/';
export const LOGIN_URL = BASE + '/login';

export const activeUrl = (jobIds, limit) => API + '/projects/active/?' + jobIds.map((id) => 'jobs[]=' + id).join('&') + '&project_types[]=fixed&job_details=true&limit=' + limit + '&sort_field=time_updated';
export const projectUrl = (id) => API + '/projects/' + id + '/?full_description=true&job_details=true';

// The answer of one public API GET, as the market reader reads a page: the result of a success answer, a
// bot wall named by vendor, or an error naming the URL.
export async function fetchApi(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  const raw = await res.text();
  let body;
  try {
    body = { json: JSON.parse(raw) };
  } catch {
    body = { title: '', text: raw.slice(0, 2000) };
  }
  return apiResult(body, url);
}

const iso = (seconds) => (Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null);

// One project as the surface needs it. A project that is not fixed price or has no budget range is null,
// as the market reader skips it; the bid period is counted from the submit time.
export function projectOf(p) {
  if (p?.type !== 'fixed' || !Number.isInteger(p.id)) return null;
  const { minimum: min, maximum: max } = p.budget ?? {};
  if (!(min > 0) || !(max >= min)) return null;
  return {
    id: p.id,
    title: p.title?.trim() || null,
    description: (p.description ?? p.preview_description ?? '').trim() || null,
    currency: p.currency?.code ?? null,
    budget: { min, max, currency: p.currency?.code ?? null },
    jobs: (p.jobs ?? []).map((j) => j?.name).filter(Boolean),
    submitDate: iso(p.time_submitted),
    open: p.status === 'active' && p.frontend_project_status === 'open',
    bidCount: Number.isInteger(p.bid_stats?.bid_count) ? p.bid_stats.bid_count : null,
    closesAt: Number.isFinite(p.time_submitted) && Number.isInteger(p.bidperiod) ? iso(p.time_submitted + p.bidperiod * 86400) : null,
    url: p.seo_url ? BASE + '/projects/' + p.seo_url : null,
  };
}

// The active fixed-price projects under the targets' job names, newest update first: one jobs read for the
// ids, then one projects read for all of them. A name the jobs API does not know is left out by name.
export async function listProjects({ targets, fetchJson = fetchApi, limit = 30 }) {
  const names = [...new Set(targets.map((t) => t.category).filter(Boolean))];
  if (!names.length) return { projects: [], unknownJobs: [] };
  const jobs = (await fetchJson(jobsUrl(names))) ?? [];
  const ids = new Map(jobs.filter((j) => j?.name && Number.isInteger(j.id)).map((j) => [j.name, j.id]));
  const unknownJobs = names.filter((n) => !ids.has(n));
  if (!ids.size) return { projects: [], unknownJobs };
  const result = await fetchJson(activeUrl([...ids.values()], limit));
  return { projects: (result?.projects ?? []).map(projectOf).filter(Boolean), unknownJobs };
}

export async function readProject(id, { fetchJson = fetchApi } = {}) {
  const p = projectOf(await fetchJson(projectUrl(id)));
  if (!p) throw Object.assign(new Error('freelancer project ' + id + ' is not a fixed-price project with a budget range'), { code: 'FSW_FREELANCER_PROJECT' });
  return p;
}

// The API's answer to the self endpoint in the signed-in session: an unauthenticated answer is a sign-out;
// anything else is null until a signed-in recording maps the marker of a positive answer.
export function selfStatus(body) {
  const code = body?.json?.error_code ?? '';
  if (body?.json?.status === 'error' && /NOT_AUTHENTICATED/.test(code)) return { loggedIn: false, detail: 'the self API answered ' + code };
  return { loggedIn: null, detail: 'the signed-in marker is not mapped yet' };
}

export async function readSelf(session) {
  await session.navigate(SELF_URL, { settle: 500 });
  return selfStatus(await session.evaluate(pageBody));
}

// The Google sign-in of the login page, mapped 2026-10-26 by the onboarding wizard
// (src/platforms/freelancer/onboarding.mjs): Google's own button in a gsi/button iframe beside a Facebook
// one. A login page that redirects away found the account signed in, so nothing is pressed.
export async function signInWithGoogle(session, { email, google = googleSignIn }) {
  const url = await session.navigate(LOGIN_URL);
  if (!SIGN_IN_PATH.test(pathOf(url))) return { signedIn: true, alreadySignedIn: true };
  await google(session, { framed: true, email });
  const after = await readSelf(session);
  return { signedIn: after.loggedIn !== false, reason: after.detail };
}
