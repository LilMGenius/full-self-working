// Upwork seller onboarding, the /nx/create-profile wizard, mapped from the live pages on 2026-10-25.
// Each step is one URL under /nx/create-profile/; the wizard opens only the first unsaved step (a later
// step URL redirects back to it), so a dry run stops there after typing and reading it back. Values come
// from the instance: config.onboarding.upwork holds the operator's answers, the catalog's
// upworkSpecialty maps the answered services onto Upwork's category and specialties, and the profile
// gives roles, education and the overview text, which passes the outbound gate before it is typed.
import catalog from '../../economics/services.json' with { type: 'json' };
import { existsSync } from 'node:fs';
import { answeredServices } from '../../economics/catalog.mjs';
import { clickMatch, clickVisible, gated, googleSignIn, Needs, needs, pathOf, pickDate, pickOption, readIdentity, sleep, typeInto, waitFor, walkWizard } from '../onboarding.mjs';

export const START = 'https://www.upwork.com/nx/create-profile/';
const BASE = '/nx/create-profile/';
const NEXT = '[data-test=next-button]';
const SLIDE = '[data-test=carousel-slide]';
const SKILL_INPUT = 'input[aria-labelledby=skills-input]';
export const MAX_SKILLS = 15;
export const MAX_SPECIALTIES = 3;

// The wizard's step ids are the last path segment; the order is the order Upwork walks them.
export const STEPS = [
  { id: 'experience', detect: { path: BASE + 'experience', heading: /have you freelanced before/i } },
  { id: 'goal', detect: { path: BASE + 'goal', heading: /biggest goal for freelancing/i } },
  { id: 'work-preference', detect: { path: BASE + 'work-preference', heading: /how would you like to work/i } },
  { id: 'resume-import', detect: { path: BASE + 'resume-import', heading: /how would you like to tell us about yourself/i } },
  { id: 'categories', detect: { path: BASE + 'categories', heading: /what kind of work are you here to do/i } },
  { id: 'skills', detect: { path: BASE + 'skills', heading: /what work are you here to do/i } },
  { id: 'title', detect: { path: BASE + 'title', heading: /add a title to tell the world what you do/i } },
  { id: 'employment', detect: { path: BASE + 'employment', heading: /relevant work experience/i } },
  { id: 'education', detect: { path: BASE + 'education', heading: /add your education here/i } },
  { id: 'languages', detect: { path: BASE + 'languages', heading: /which languages you speak/i } },
  { id: 'overview', detect: { path: BASE + 'overview', heading: /write a bio to tell the world about yourself/i } },
  { id: 'rate', detect: { path: BASE + 'rate', heading: /set your hourly rate/i } },
  { id: 'location', detect: { path: BASE + 'location', heading: /a few last details/i } },
];

export const stepOfUrl = (url) => {
  const path = pathOf(url);
  return path.startsWith(BASE) ? path.slice(BASE.length).split('/')[0] : null;
};

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

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
export const sameSet = (a, b) => a.length === b.length && a.every((x) => b.some((y) => norm(x) === norm(y)));

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

const monthYear = (d) => (d ? MONTHS[d.month - 1] + ' ' + d.year : 'Present');

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

const sameEntry = (card, e) => norm(card.title) === norm(e.title) && norm(card.company) === norm(e.company) && norm(card.dates) === norm(e.dates);

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

// --- page readers (run in the page) ---

function readChecked(values) {
  return [...document.querySelectorAll('input[type=radio]')].find((i) => i.checked && values.includes(i.value))?.value ?? null;
}

function readWorkPreference() {
  const slide = [...document.querySelectorAll('[data-test=carousel-slide]')].find((s) => /how would you like to work/i.test(s.innerText));
  if (!slide) return null;
  const boxes = [...slide.querySelectorAll('[data-qa=button-box]')].map((b) => ({ text: b.innerText.replace(/\s+/g, ' ').trim(), checked: !!b.querySelector('input')?.checked }));
  const c2h = slide.querySelector('label[data-test=checkbox-label] input');
  return { boxes, contractToHire: !!c2h?.checked };
}

function readSpecialties() {
  return [...document.querySelectorAll('.specialties label')].filter((l) => l.querySelector('input')?.checked).map((l) => l.innerText.trim());
}

function readSkills() {
  return [...document.querySelectorAll('.air3-tokenizer .air3-token-text')].map((t) => t.innerText.trim());
}

function readCards() {
  return [...document.querySelectorAll('.carousel-list-item .card-content')].map((c) => c.innerText.trim());
}

const cardHasSchool = (cards, e) => cards.some((c) => norm(c.split(/\n/)[0]) === norm(e.school));

export const LANGUAGE_LEVELS = ['Basic', 'Conversational', 'Fluent', 'Native or Bilingual'];

export const OVERVIEW_MIN = 100;

const FIELDS = ['photo', 'dateOfBirth', 'street', 'unit', 'city', 'region', 'postalCode', 'phone'];

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

// Rows of the languages step: English is fixed in the first row (dropdown-label-english), each added
// language is a pair of dropdowns numbered from 0. An unset dropdown shows "My level is" or "Select language".
function readLanguages() {
  const val = (id) => {
    const t = document.querySelector('[aria-labelledby="' + id + '"]')?.innerText.trim() ?? null;
    return t && !/^(My level is|Select language)$/i.test(t) ? t : null;
  };
  const rows = [{ language: 'English', level: val('dropdown-label-english') }];
  for (let i = 0; document.querySelector('[aria-labelledby="dropdown-label-language-' + i + '"]'); i++) rows.push({ language: val('dropdown-label-language-' + i), level: val('dropdown-label-proficiency-' + i), index: i });
  return rows;
}

// --- steps ---

const PREFERENCES = { talentMarketplace: /find opportunities myself/i, projectCatalog: /package up my work/i };

function settings(ctx) {
  return ctx.instance.config?.onboarding?.upwork ?? {};
}

const readValue = (sel) => document.querySelector(sel)?.value ?? null;

const textStep = (selector, key, pick) => ({
  read: (s) => s.evaluate(readValue, selector),
  want: (ctx) => {
    const text = pick(ctx);
    const refused = gated(ctx, text, key);
    return refused ? needs(refused) : text;
  },
  same: (cur, want) => norm(cur) === norm(want),
  write: async (s, want) => {
    await s.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), selector);
    await s.fill(selector, want);
  },
});

const radioStep = (key, values) => ({
  read: (s) => s.evaluate(readChecked, values),
  want: (ctx) => (values.includes(settings(ctx)[key]) ? settings(ctx)[key] : needs('config onboarding.upwork.' + key + ' must be one of ' + values.join(', '))),
  same: (cur, want) => cur === want,
  write: (s, want) => s.click('[data-qa=button-box]:has(input[value="' + want + '"])'),
});

export const HANDLERS = {
  // Mapped 2026-10-25: "Upload photo" opens a dialog with a file input, a crop view and "Attach photo",
  // which saves at once; the saved portrait shows as an img from /profile-portraits/. Mapped 2026-10-26:
  // date of birth (a date picker, pickDate), street, Apt/Suite, city (a typeahead), state, ZIP and a phone
  // number after a preset country code. Those come from the identity file config.onboarding.identity
  // names (src/platforms/onboarding.mjs, readIdentity) and are never shown in a step report.
  location: {
    saves: true,
    read: (s) =>
      s.evaluate(() => {
        const v = (sel) => document.querySelector(sel)?.value ?? '';
        return {
          photo: [...document.querySelectorAll('img')].some((i) => i.getBoundingClientRect().width > 0 && /\/profile-portraits\//.test(i.src)),
          dateOfBirth: v('input[aria-labelledby=date-of-birth-label]'),
          street: v('input[aria-labelledby=street-label]'),
          unit: v('input[placeholder^="Apt/Suite"]'),
          city: v('input[aria-labelledby=city-label]'),
          region: v('input[aria-labelledby=state-label]'),
          postalCode: v('input[aria-labelledby=postal-code-label]'),
          phone: v('input[type=tel]').replace(/\D/g, ''),
        };
      }),
    want: (ctx) => {
      const photo = ctx.instance.config?.onboarding?.photo;
      if (!photo || !existsSync(photo)) return needs('upload a profile photo of yourself, or set config onboarding.photo to a public photo of you');
      const id = readIdentity(ctx);
      if (id instanceof Needs) return id;
      const a = id.address;
      return { photo: true, private: 'photo, date of birth, address and phone', dateOfBirth: id.dateOfBirth, street: a.street, unit: a.unit ?? '', city: a.city, region: a.region, postalCode: a.postalCode, phone: id.nationalNumber };
    },
    same: (cur, want) => FIELDS.every((k) => (k === 'photo' ? cur.photo === true : k === 'phone' ? cur.phone.endsWith(want.phone) : norm(cur[k]) === norm(want[k]))),
    show: (cur, want) => 'these fields read back different from the identity file: ' + FIELDS.filter((k) => !(k === 'photo' ? cur.photo : k === 'phone' ? cur.phone.endsWith(want.phone) : norm(cur[k]) === norm(want[k]))).join(', '),
    write: async (s, want, cur, ctx) => {
      if (!cur.photo) {
        await clickVisible(s, 'button[data-qa=open-loader]');
        if (!(await waitFor(s, () => !!document.querySelector('[role=dialog] input[type=file]')))) throw new Error('the photo dialog did not open');
        await s.setFiles('[role=dialog] input[type=file]', ctx.instance.config.onboarding.photo);
        if (!(await waitFor(s, () => /Zoom/i.test(document.querySelector('[role=dialog]')?.innerText ?? ''), null, { timeoutMs: 20000 }))) throw new Error('the photo did not load into the crop view');
        await clickMatch(s, '[role=dialog] button', 'Attach photo');
        if (!(await waitFor(s, () => !document.querySelector('[role=dialog]'), null, { timeoutMs: 20000 }))) throw new Error('the photo dialog did not close');
        await sleep(1500);
      }
      if (norm(cur.dateOfBirth) !== norm(want.dateOfBirth)) await pickDate(s, '#date-of-birth-label-trigger', want.dateOfBirth);
      const text = { street: 'input[aria-labelledby=street-label]', unit: 'input[placeholder^="Apt/Suite"]', region: 'input[aria-labelledby=state-label]', postalCode: 'input[aria-labelledby=postal-code-label]', phone: 'input[type=tel]' };
      for (const [k, sel] of Object.entries(text)) {
        if (k === 'phone' ? cur.phone.endsWith(want.phone) : norm(cur[k]) === norm(want[k])) continue;
        if (!want[k]) continue;
        await typeInto(s, sel, want[k]);
      }
      if (norm(cur.city) !== norm(want.city)) {
        await typeInto(s, 'input[aria-labelledby=city-label]', want.city);
        // The city typeahead lists matches; the first one that starts with the city name is taken.
        const picked = await waitFor(s, (c) => [...document.querySelectorAll('[role=option]')].some((o) => o.getBoundingClientRect().width > 0 && o.innerText.trim().toLowerCase().startsWith(c.toLowerCase())), want.city, { timeoutMs: 8000 });
        if (picked) await clickMatch(s, '[role=option]', new RegExp('^' + want.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
      }
    },
  },

  // Mapped 2026-10-25: three currency inputs (hourly rate, service fee, what you get); only the first
  // is typed, and it reformats on every key, so it is typed key by key.
  rate: {
    read: async (s) => parseUsd(await s.evaluate(() => document.querySelector('input[data-test=currency-input]')?.value)),
    want: (ctx) => {
      const rate = settings(ctx).hourlyRateUSD;
      return typeof rate === 'number' && rate >= 3 ? rate : needs('config onboarding.upwork.hourlyRateUSD must be a number of US dollars, 3 or more (Upwork minimum)');
    },
    same: (cur, want) => cur !== null && Math.abs(cur - want) < 0.005,
    write: async (s, want) => {
      await s.evaluate(() => document.querySelector('input[data-test=currency-input]')?.setAttribute('data-fsw-rate', '1'));
      await clickVisible(s, 'input[data-fsw-rate]');
      await s.typeKeys('input[data-fsw-rate]', want.toFixed(2));
      await s.press('Tab');
    },
  },
  overview: {
    read: (s) => s.evaluate(readValue, 'textarea[aria-labelledby=overview-label]'),
    want: (ctx) => {
      const text = overviewText(ctx.instance);
      if (text.length < OVERVIEW_MIN) return needs('the overview is ' + text.length + ' characters and Upwork needs ' + OVERVIEW_MIN + '; set config onboarding.upwork.overview or extend profile.summary_en');
      const refused = gated(ctx, text, 'the overview');
      return refused ? needs(refused) : text;
    },
    same: (cur, want) => norm(cur) === norm(want),
    write: async (s, want) => {
      await clickVisible(s, 'textarea[aria-labelledby=overview-label]');
      await s.fill('textarea[aria-labelledby=overview-label]', want);
    },
  },
  // Mapped 2026-10-25: English is always listed with a level dropdown; "Add a language" appends a
  // language dropdown and a level dropdown. Levels are a setting, since only the operator can say them.
  languages: {
    read: (s) => s.evaluate(readLanguages),
    want: (ctx) => {
      const list = settings(ctx).languages ?? [];
      const bad = list.filter((l) => !l?.language || !LANGUAGE_LEVELS.includes(l.level));
      if (!list.some((l) => norm(l.language) === 'english') || bad.length) return needs('config onboarding.upwork.languages must list English and each language with a level of ' + LANGUAGE_LEVELS.join(', '));
      return list;
    },
    same: (cur, want) => want.every((w) => cur.some((c) => norm(c.language) === norm(w.language) && norm(c.level) === norm(w.level))),
    write: async (s, want, cur) => {
      for (const w of want) {
        let row = cur.find((c) => norm(c.language) === norm(w.language));
        if (row && norm(row.level) === norm(w.level)) continue;
        if (!row) {
          const empty = (await s.evaluate(readLanguages)).find((c) => c.index !== undefined && !c.language);
          if (!empty) await clickVisible(s, 'button[data-qa=languages-btn-add]');
          await sleep(800);
          row = (await s.evaluate(readLanguages)).find((c) => c.index !== undefined && !c.language);
          if (!row) throw new Error('Add a language did not add a row');
          await pickOption(s, '[aria-labelledby="dropdown-label-language-' + row.index + '"]', w.language);
        }
        const toggle = row.index === undefined ? '[aria-labelledby=dropdown-label-english]' : '[aria-labelledby="dropdown-label-proficiency-' + row.index + '"]';
        await pickOption(s, toggle, w.level);
        await sleep(500);
      }
    },
  },
  // Mapped 2026-10-25: "Add education" opens a dialog with School, Degree and Field of Study typeaheads
  // (free text is kept), two year dropdowns under "Dates Attended" (From, To) and a description.
  education: {
    saves: true,
    read: (s) => s.evaluate(readCards),
    want: (ctx) => {
      const entries = educationEntries(ctx.instance.profile);
      if (!entries.length) return needs('profile.education is empty');
      const refused = gated(ctx, entries.map((e) => [e.school, e.degree, e.field, e.description].filter(Boolean).join(', ')).join('\n'), 'profile.education');
      return refused ? needs(refused) : entries;
    },
    same: (cur, want) => want.every((e) => cardHasSchool(cur, e)),
    write: async (s, want, cur) => {
      const D = '[role=dialog] ';
      if (await s.evaluate(() => !!document.querySelector('[role=dialog]'))) {
        await clickMatch(s, D + 'button', 'Cancel');
        await waitFor(s, () => !document.querySelector('[role=dialog]'), null, { timeoutMs: 5000 });
      }
      for (const e of want.filter((w) => !cardHasSchool(cur, w))) {
        if (!(await clickVisible(s, 'a.carousel-list-add-new button, button[data-qa=education-add-btn]'))) throw new Error('no Add education button');
        if (!(await waitFor(s, () => !!document.querySelector('[role=dialog] input[aria-labelledby=school-label]')))) throw new Error('the education dialog did not open');
        await typeInto(s, D + 'input[aria-labelledby=school-label]', e.school);
        if (e.degree) await typeInto(s, D + 'input[aria-labelledby=degree-label]', e.degree);
        if (e.field) await typeInto(s, D + 'input[aria-labelledby=area-of-study-label]', e.field);
        await s.evaluate(() => document.querySelectorAll('[role=dialog] [data-test=dropdown-toggle][aria-labelledby=dates-attended-label]').forEach((d, i) => d.setAttribute('data-fsw-date', String(i))));
        if (e.from) await pickOption(s, D + '[data-fsw-date="0"]', String(e.from));
        if (e.to) await pickOption(s, D + '[data-fsw-date="1"]', String(e.to));
        if (e.description) {
          await clickVisible(s, D + 'textarea[aria-labelledby=description-label]');
          await s.fill(D + 'textarea[aria-labelledby=description-label]', e.description);
        }
        await clickMatch(s, D + 'button', 'Save');
        if (!(await waitFor(s, () => !document.querySelector('[role=dialog]'), null, { timeoutMs: 10000 }))) {
          const msg = await s.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' ').slice(0, 200));
          throw new Error('the dialog for ' + e.school + ' did not close: ' + msg);
        }
        await sleep(1000);
      }
    },
  },
  // Mapped 2026-10-25: "Add experience" opens a dialog with Title and Company typeaheads (free text is
  // kept), a "currently working" checkbox that hides the end date, month and year dropdowns, and Save.
  employment: {
    saves: true,
    read: async (s) => (await s.evaluate(readCards)).map(parseEmploymentCard),
    want: (ctx) => {
      const { entries, skipped } = employmentEntries(ctx.instance.profile);
      if (!entries.length) return needs('profile.roles has no role with a start month (YYYY.MM)');
      const refused = gated(ctx, entries.map((e) => [e.title, e.company, e.description].filter(Boolean).join(', ')).join('\n'), 'profile.roles');
      return refused ? needs(refused) : Object.assign(entries, { skipped });
    },
    same: (cur, want) => want.every((e) => cur.some((c) => sameEntry(c, e))),
    write: async (s, want, cur) => {
      const D = '[role=dialog] ';
      // A dialog a failed run left open is cancelled first, so its half-typed entry is never saved.
      if (await s.evaluate(() => !!document.querySelector('[role=dialog]'))) {
        await clickMatch(s, D + 'button', 'Cancel');
        await waitFor(s, () => !document.querySelector('[role=dialog]'), null, { timeoutMs: 5000 });
      }
      for (const e of want.filter((w) => !cur.some((c) => sameEntry(c, w)))) {
        // The empty list shows a large add link; once one entry is saved it becomes a round Add button.
        if (!(await clickVisible(s, 'a.carousel-list-add-new button, button[data-qa=employment-add-btn]'))) throw new Error('no Add experience button');
        if (!(await waitFor(s, () => !!document.querySelector('[role=dialog] input[aria-labelledby=title-label]')))) throw new Error('the work experience dialog did not open');
        await typeInto(s, D + 'input[aria-labelledby=title-label]', e.title);
        await typeInto(s, D + 'input[aria-labelledby=company-label]', e.company);
        const current = await s.evaluate(() => !!document.querySelector('[role=dialog] input[type=checkbox]')?.checked);
        if (current !== (e.end === null)) await clickMatch(s, D + 'label[data-test=checkbox-label]', /currently working/i);
        await pickOption(s, D + '[aria-labelledby=start-date-month]', MONTHS[e.start.month - 1]);
        await pickOption(s, D + '[aria-labelledby=start-date-year]', String(e.start.year));
        if (e.end) {
          await pickOption(s, D + '[aria-labelledby=end-date-month]', MONTHS[e.end.month - 1]);
          await pickOption(s, D + '[aria-labelledby=end-date-year]', String(e.end.year));
        }
        if (e.description) {
          await clickVisible(s, D + 'textarea[aria-labelledby=description-label]');
          await s.fill(D + 'textarea[aria-labelledby=description-label]', e.description);
        }
        await clickMatch(s, D + 'button', 'Save');
        if (!(await waitFor(s, () => !document.querySelector('[role=dialog]'), null, { timeoutMs: 10000 }))) {
          const msg = await s.evaluate(() => document.querySelector('[role=dialog]')?.innerText.replace(/\s+/g, ' ').slice(0, 200));
          throw new Error('the dialog for ' + e.title + ' did not close: ' + msg);
        }
        await sleep(1000);
      }
    },
  },
  title: textStep('input[aria-labelledby=title-label]', 'config onboarding.upwork.title', (ctx) => settings(ctx).title),
  experience: radioStep('experience', ['NEW_TO_ME', 'NEEDS_TIP', 'FREELANCED_BEFORE']),
  goal: radioStep('goal', ['MAIN_INCOME', 'MONEY_ON_SIDE', 'GET_EXPERIENCE', 'EXPLORING']),
  'work-preference': {
    read: async (s) => {
      const r = await s.evaluate(readWorkPreference);
      if (!r) return null;
      const on = Object.entries(PREFERENCES).filter(([, re]) => r.boxes.some((b) => b.checked && re.test(b.text))).map(([k]) => k);
      return { preferences: on, contractToHire: r.contractToHire };
    },
    want: (ctx) => {
      const prefs = settings(ctx).workPreferences ?? [];
      const bad = prefs.filter((p) => !(p in PREFERENCES));
      if (bad.length || !prefs.length) return needs('config onboarding.upwork.workPreferences must list one or more of ' + Object.keys(PREFERENCES).join(', '));
      return { preferences: prefs, contractToHire: settings(ctx).contractToHire === true };
    },
    same: (cur, want) => !!cur && sameSet(cur.preferences, want.preferences) && cur.contractToHire === want.contractToHire,
    write: async (s, want, cur) => {
      for (const [key, re] of Object.entries(PREFERENCES)) {
        if (cur.preferences.includes(key) !== want.preferences.includes(key)) await clickMatch(s, '[data-qa=button-box]', re, { within: SLIDE });
      }
      if (cur.contractToHire !== want.contractToHire) await clickMatch(s, 'label[data-test=checkbox-label]', /contract-to-hire/i, { within: SLIDE });
    },
  },
  // A chooser with nothing to save: fsw always fills the profile by hand from the instance.
  'resume-import': {
    read: async () => 'manual',
    want: () => 'manual',
    same: () => true,
    next: async (s) => clickMatch(s, 'button', /^Fill out manually/i),
  },
  categories: {
    read: async (s) => s.evaluate(readSpecialties),
    want: (ctx) => upworkSpecialties(ctx.instance) ?? needs('no answered service with an upworkSpecialty and a fit in profile.serviceFit'),
    same: (cur, want) => sameSet(cur, want.specialties),
    write: async (s, want, cur) => {
      if (!(await clickMatch(s, 'ul.categories a', want.category, { within: SLIDE }))) throw new Error('no category ' + want.category);
      await waitFor(s, () => document.querySelectorAll('.specialties label').length > 0);
      for (const label of [...want.specialties, ...cur]) {
        const on = (await s.evaluate(readSpecialties)).some((x) => norm(x) === norm(label));
        const should = want.specialties.some((x) => norm(x) === norm(label));
        if (on !== should && !(await clickMatch(s, '.specialties label', label))) throw new Error('no specialty ' + label + ' under ' + want.category);
      }
    },
  },
  skills: {
    read: async (s) => s.evaluate(readSkills),
    want: (ctx) => {
      const skills = settings(ctx).skills ?? [];
      if (!skills.length || skills.length > MAX_SKILLS) return needs('config onboarding.upwork.skills must list 1 to ' + MAX_SKILLS + ' Upwork skill names');
      return skills;
    },
    same: (cur, want) => sameSet(cur, want),
    write: async (s, want, cur) => {
      for (const extra of cur.filter((c) => !want.some((w) => norm(w) === norm(c)))) await clickMatch(s, '.air3-tokenizer .air3-token-remove', 'Remove ' + extra + ' Tag');
      const missing = [];
      for (const skill of want.filter((w) => !cur.some((c) => norm(c) === norm(w)))) {
        // The typeahead takes focus only once clicked in view; typing a whole name keeps the exact one listed.
        await s.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), SKILL_INPUT);
        await s.click(SKILL_INPUT);
        await s.typeKeys(SKILL_INPUT, skill);
        const listed = await waitFor(s, (name) => [...document.querySelectorAll('[role=option]')].some((o) => o.innerText.trim().toLowerCase() === name.toLowerCase()), skill, { timeoutMs: 8000 });
        if (!listed || !(await clickMatch(s, '[role=option]', skill))) {
          const shown = await s.evaluate(() => [...document.querySelectorAll('[role=option]')].map((o) => o.innerText.trim()).slice(0, 6));
          missing.push(skill + ' (listed: ' + shown.join(' / ') + ')');
        }
        await sleep(600);
      }
      if (missing.length) throw Object.assign(new Error('Upwork lists no skill named ' + missing.join(', ')), { missing });
    },
  },
};

const describe = (want) => {
  if (want === true) return 'profile photo in place';
  if (want?.private) return want.private + ' (values withheld)';
  const one = (w) => (typeof w !== 'object' ? w : w.level ? w.language + ' ' + w.level : w.school ? [w.school, w.degree, w.field, w.from && w.from + '-' + w.to].filter(Boolean).join(', ') : w.title + ' at ' + w.company + ', ' + w.dates);
  if (Array.isArray(want)) return want.map(one).join('; ') + (want.skipped?.length ? '; left out without a start month or over the title limit: ' + want.skipped.join(', ') : '');
  return typeof want === 'object' ? JSON.stringify(want.specialties ?? want) : String(want);
};

export const onboard = (session, ctx) =>
  walkWizard(session, ctx, {
    name: 'upwork',
    steps: STEPS,
    handlers: HANDLERS,
    startUrl: START,
    stepUrl: (id) => START + id,
    stepOfUrl,
    describe,
    advance: (s) => s.click(NEXT),
    signIn: (s, ctx) => googleSignIn(s, { button: /^Continue with Google$/, email: readIdentity(ctx).googleEmail }),
  });
