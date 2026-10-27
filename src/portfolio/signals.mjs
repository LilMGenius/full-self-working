// What the portfolio ordering reads that another system owns (AGENTS.md neverReinventTheWheel): the public
// reach of an item from GitHub (stars) and npm (downloads of the last month), and a quality score from rendering
// the item's live page. The daily portfolio job reads them once per Seoul day into portfolio/signals-<day>.json
// (AGENTS.md roundClockSchedules: a cache keyed by the period it covers); a figure whose source did not answer
// is absent that day, never a remembered number.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey } from '../core/clock.mjs';
import { ensureDir } from '../core/instance.mjs';
import { checkPage } from '../render/checks.mjs';
import { VIEWPORTS } from '../render/viewports.mjs';

export const repoOf = (url) => {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(String(url ?? ''));
  return m ? m[1] + '/' + m[2].replace(/\.git$/, '') : null;
};

async function readJsonFrom(fetch, url, headers, errors, label) {
  try {
    const res = await fetch(url, { headers });
    if (res.ok) return await res.json();
    errors.push(label + ' answered ' + res.status);
  } catch (err) {
    errors.push(label + ': ' + (err.code ?? err.cause?.code ?? err.message));
  }
  return null;
}

// The operator's GitHub login, from the github.com link in profile.person.links; null without one.
export function githubLogin(profile) {
  const link = (profile?.person?.links ?? []).map(String).find((u) => /^https:\/\/github\.com\/[^/]+\/?$/.test(u));
  return link ? link.replace(/\/$/, '').split('/').pop().toLowerCase() : null;
}

// The login that made a repository's first commit. GitHub lists commits newest first, so the last page of a
// one-per-page listing (its Link header) holds the first one.
async function firstCommitter(fetch, repo, errors) {
  const headers = { accept: 'application/vnd.github+json' };
  try {
    const head = await fetch('https://api.github.com/repos/' + repo + '/commits?per_page=1', { headers });
    if (!head.ok) {
      errors.push('github ' + repo + ' commits answered ' + head.status);
      return null;
    }
    const last = /<([^>]+)>;\s*rel="last"/.exec(head.headers.get('link') ?? '')?.[1];
    const rows = last ? await (await fetch(last, { headers })).json() : await head.json();
    return rows.at(-1)?.author?.login?.toLowerCase() ?? null;
  } catch (err) {
    errors.push('github ' + repo + ' commits: ' + (err.code ?? err.cause?.code ?? err.message));
    return null;
  }
}

// {authored, why, stars, downloads, errors} per item that names a repository or a package. Only an item the
// operator authored carries figures (AGENTS.md publicClaims: a project's Author created the repository and made
// its first commit): not a contribution in the profile, not a fork, owned by the operator's login, first commit by
// that login. Another maintainer's repository stays a contribution with no fame, whatever its stars.
export async function readReach(items, { fetch = globalThis.fetch, login = null } = {}) {
  const out = {};
  for (const i of items) {
    const repo = repoOf(i.url);
    if (!repo && !i.package) continue;
    const errors = [];
    if (i.contribution) {
      out[i.id] = { authored: false, why: 'a contribution to another maintainer\'s repository', stars: null, downloads: null, errors };
      continue;
    }
    let why = null;
    let stars = null;
    if (repo) {
      const gh = await readJsonFrom(fetch, 'https://api.github.com/repos/' + repo, { accept: 'application/vnd.github+json' }, errors, 'github ' + repo);
      const first = gh && login ? await firstCommitter(fetch, repo, errors) : null;
      why = !login ? 'no github.com link in profile.person.links' : !gh ? 'repository unread' : gh.fork ? 'a fork' : String(gh.owner?.login ?? '').toLowerCase() !== login ? 'owned by ' + gh.owner?.login : first !== login ? 'first commit by ' + (first ?? 'an unknown author') : null;
      stars = why === null ? gh.stargazers_count ?? null : null;
    }
    const npm = why === null && i.package ? await readJsonFrom(fetch, 'https://api.npmjs.org/downloads/point/last-month/' + encodeURIComponent(i.package), {}, errors, 'npm ' + i.package) : null;
    out[i.id] = { authored: why === null, why, stars, downloads: npm?.downloads ?? null, errors };
  }
  return out;
}

// fame in [0, 1]: each figure on a log scale against the largest any of the instance's own items reaches that day,
// the higher of the two, so no typed constant sets the scale. An item without a figure has no fame.
export function fameOf(reach) {
  const rows = Object.values(reach);
  const top = (k) => Math.max(0, ...rows.map((r) => r[k] ?? 0));
  const scaled = (v, max) => (v == null || max <= 0 ? null : Math.log10(1 + v) / Math.log10(1 + max));
  const stars = top('stars');
  const downloads = top('downloads');
  return Object.fromEntries(Object.entries(reach).map(([id, r]) => {
    const v = [scaled(r.stars, stars), scaled(r.downloads, downloads)].filter((x) => x != null);
    return [id, v.length ? Math.round(Math.max(...v) * 1000) / 1000 : null];
  }));
}

// quality in [0, 1] of an item whose url is a web page and not a repository: the share of VIEWPORTS at which the
// live page renders with no horizontal overflow and no broken image. The page's fonts are its own, so no family.
export async function qualityOf(items, { renderer, dir, viewports = VIEWPORTS }) {
  const out = {};
  for (const i of items) {
    if (!i.url || repoOf(i.url)) continue;
    let passed = 0;
    const problems = [];
    for (const [n, viewport] of viewports.entries()) {
      try {
        const p = await checkPage(renderer, { url: i.url, viewport, out: join(dir, i.id + '-' + n + '.jpg') });
        if (!p.length) passed += 1;
        problems.push(...p);
      } catch (err) {
        problems.push(i.url + '@' + viewport.width + 'x' + viewport.height + ': ' + (err.code ? err.code + ' ' : '') + err.message);
      }
    }
    out[i.id] = { quality: Math.round((passed / viewports.length) * 1000) / 1000, problems: problems.slice(0, 10) };
  }
  return out;
}

// One read per Seoul day: a second run that day returns what the first one wrote.
export async function readSignals(instance, items, { fetch, openRenderer, now = new Date() }) {
  const day = dayKey(now);
  const file = join(instance.paths.portfolio, 'signals-' + day + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const reach = await readReach(items, { fetch, login: githubLogin(instance.profile) });
  const fame = fameOf(reach);
  const dir = join(instance.dir, 'qa', 'portfolio', day);
  ensureDir(dir);
  const renderer = await openRenderer();
  let quality;
  try {
    quality = await qualityOf(items, { renderer, dir });
  } finally {
    await renderer.close();
  }
  const signals = { day, reach: Object.fromEntries(Object.entries(reach).map(([id, r]) => [id, { ...r, fame: fame[id] }])), quality };
  ensureDir(instance.paths.portfolio);
  writeFileSync(file + '.tmp', JSON.stringify(signals, null, 2) + '\n');
  renameSync(file + '.tmp', file);
  return signals;
}
