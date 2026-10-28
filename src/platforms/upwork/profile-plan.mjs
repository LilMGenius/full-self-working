// The Upwork profile the instance asks for, mapped without a page (src/platforms/upwork/onboarding.mjs): the
// specialties, work and education entries, the overview and the parsers of what the wizard shows back.
import catalog from '../../economics/services.json' with { type: 'json' };
import { answeredServices } from '../../economics/catalog.mjs';
import { MONTH_NAMES } from '../onboarding.mjs';

export const MAX_SPECIALTIES = 3;

const FIT_RANK = { strong: 0, some: 1 };

// The one Upwork category and up to three specialties for the services the instance answers there:
// services ranked by profile fit (strong, then some; none is left out) in catalog order, the category of
// the first, and the specialties of the services in that category, without repeats.
export function upworkSpecialties({ config, profile, services = catalog }) {
  const ranked = answeredServices(config, 'upwork', services)
    .filter((id) => services[id]?.upworkSpecialty && (profile?.serviceFit?.[id]?.strength ?? 'none') in FIT_RANK)
    .map((id, i) => ({ id, i, rank: FIT_RANK[profile.serviceFit[id].strength] }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  if (!ranked.length) return null;
  const category = services[ranked[0].id].upworkSpecialty.category;
  const specialties = [...new Set(ranked.map((r) => services[r.id].upworkSpecialty).filter((u) => u.category === category).map((u) => u.specialty))].slice(0, MAX_SPECIALTIES);
  return { category, specialties, services: ranked.filter((r) => services[r.id].upworkSpecialty.category === category).map((r) => r.id) };
}

export const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// A profile period: "2024.12 to present", "2021.03 to 2023.02", "2021.08" or "present". A side without a
// year and month is null; current is true when it runs to the present.
export function parsePeriod(period) {
  const ym = (s) => {
    const m = /^(\d{4})\.(\d{1,2})$/.exec(String(s ?? '').trim());
    return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
  };
  const [from, to] = String(period ?? '').split(/\s+to\s+/i);
  const current = /present/i.test(to ?? from ?? '');
  return { start: ym(from), end: current ? null : ym(to ?? from), current };
}

const monthYear = (d) => (d ? MONTH_NAMES[d.month - 1] + ' ' + d.year : 'Present');

// The work entry dialog refuses a title of 70 characters or more ("Must be less than 70 characters").
export const TITLE_MAX = 69;

// A title over the limit loses its trailing parenthetical, which becomes the entry's description.
export function splitTitle(title) {
  const t = String(title ?? '').trim();
  if (t.length <= TITLE_MAX) return { title: t, description: '' };
  const m = /^(.*?)\s*\(([^()]+)\)$/.exec(t);
  if (m && m[1].length <= TITLE_MAX) return { title: m[1], description: m[2].charAt(0).toUpperCase() + m[2].slice(1) + '.' };
  return null;
}

// The work entries the profile's roles give: one per role whose start month is known. A role without one
// is listed in skipped, since the form needs a start date.
export function employmentEntries(profile) {
  const entries = [];
  const skipped = [];
  for (const role of profile?.roles ?? []) {
    const p = parsePeriod(role.period);
    const t = splitTitle(role.title);
    if (!p.start || (!p.current && !p.end) || !t) {
      skipped.push(role.org);
      continue;
    }
    entries.push({ title: t.title, description: t.description, company: role.org, start: p.start, end: p.current ? null : p.end, dates: monthYear(p.start) + ' - ' + monthYear(p.current ? null : p.end) });
  }
  return { entries, skipped };
}

// A saved entry card on the employment step: "Title\nCompany | December 2024 - Present".
export function parseEmploymentCard(text) {
  const [title, rest = ''] = String(text ?? '').split(/\n/).map((l) => l.trim());
  const at = rest.lastIndexOf(' | ');
  return at < 0 ? { title, company: rest, dates: '' } : { title, company: rest.slice(0, at).trim(), dates: rest.slice(at + 3).trim() };
}

// Only a real degree goes into Upwork's Degree typeahead; anything else the profile says about the
// outcome (no degree, passed, course certificates) goes into the description, so no degree is implied.
const DEGREE = /^(?:B\.|M\.|Ph\.?\s?D|Bachelor|Master|Associate|Doctor)/i;

// "ABU (Example Bay University)" is typed as the full Latin name in the parentheses; a parenthetical in
// another script ("State exam (국가시험)") is dropped.
export function schoolName(school) {
  const m = /^(.*?)\s*\(([^()]+)\)$/.exec(String(school ?? '').trim());
  if (!m) return String(school ?? '').trim();
  return /^[\x20-\x7E]+$/.test(m[2]) && m[2].length > m[1].length ? m[2].trim() : m[1].trim();
}

// Education entries from profile.education: school, degree only when it is one, field, the years the
// period gives, and a description carrying the outcome.
export function educationEntries(profile) {
  return (profile?.education ?? []).map((e) => {
    const years = [...String(e.period ?? '').matchAll(/(\d{4})/g)].map((m) => Number(m[1]));
    const degree = DEGREE.test(e.degree ?? '') ? e.degree : '';
    const outcome = degree ? '' : String(e.degree ?? '').trim();
    const field = String(e.field ?? '').trim();
    // A field that is a count or a course list is not a field of study, so it joins the description.
    const isField = field && !/\d/.test(field) && !/[;]/.test(field);
    const description = [outcome, isField ? '' : field].filter(Boolean).join('. ');
    return { school: schoolName(e.school), degree, field: isField ? field : '', from: years[0] ?? null, to: years.at(-1) ?? null, description: description ? description.replace(/\.?$/, '.') : '' };
  });
}

// "$27.00" or "27" as a number of dollars; an empty field is null.
export const parseUsd = (text) => {
  const n = Number.parseFloat(String(text ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// The bio: config onboarding.upwork.overview when the operator wrote one, otherwise the profile's English
// headline and summary, then the English names of the services the instance offers on Upwork.
export function overviewText(instance, services = catalog) {
  const set = instance.config?.onboarding?.upwork?.overview;
  if (set) return set;
  const p = instance.profile ?? {};
  // A catalog name starts lower case mid-sentence unless it opens with an acronym (AI automation).
  const offered = (upworkSpecialties(instance, services)?.services ?? []).map((id) => services[id]?.en).filter(Boolean).map((n) => (/^[A-Z][a-z]/.test(n) ? n[0].toLowerCase() + n.slice(1) : n));
  const list = offered.length > 1 ? offered.slice(0, -1).join(', ') + ' and ' + offered.at(-1) : offered[0];
  return [p.headline_en, p.summary_en, list ? 'Here I take on ' + list + '.' : ''].filter(Boolean).join('\n\n');
}
