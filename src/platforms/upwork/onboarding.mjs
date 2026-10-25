// Upwork seller onboarding, the /nx/create-profile wizard, mapped from the live pages on 2026-10-25.
// Each step is one URL under /nx/create-profile/; the wizard opens only the first unsaved step (a later
// step URL redirects back to it), so a dry run stops there after typing and reading it back. Values come
// from the instance: config.onboarding.upwork holds the operator's answers, the catalog's
// upworkSpecialty maps the answered services onto Upwork's category and specialties, and the profile
// gives roles, education and the overview text, which passes the outbound gate before it is typed.
import catalog from '../../economics/services.json' with { type: 'json' };
import { answeredServices } from '../../economics/catalog.mjs';
import { gateOutbound } from '../../policy/gate.mjs';
import { clickMatch, clickVisible, pageOutline, pathOf, pickOption, result, sleep, typeInto, waitFor } from '../onboarding.mjs';

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

// The work entries the profile's roles give: one per role whose start month is known. A role without one
// is listed in skipped, since the form needs a start date.
export function employmentEntries(profile) {
  const entries = [];
  const skipped = [];
  for (const role of profile?.roles ?? []) {
    const p = parsePeriod(role.period);
    if (!p.start || (!p.current && !p.end)) {
      skipped.push(role.org);
      continue;
    }
    entries.push({ title: role.title, company: role.org, start: p.start, end: p.current ? null : p.end, dates: monthYear(p.start) + ' - ' + monthYear(p.current ? null : p.end) });
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

// --- steps ---

const PREFERENCES = { talentMarketplace: /find opportunities myself/i, projectCatalog: /package up my work/i };

function settings(ctx) {
  return ctx.instance.config?.onboarding?.upwork ?? {};
}

// Text the profile shows passes the outbound gate first; a refusal is the operator's to fix in the instance.
export function gated(ctx, text, key) {
  if (!text || !String(text).trim()) return key + ' is empty';
  const g = gateOutbound({ kind: 'profile', platform: 'upwork', text }, { descriptor: ctx.descriptor, instance: ctx.instance });
  return g.ok ? null : key + ' refused by the gate: ' + g.violations.map((v) => v.rule + ' ' + v.detail).join('; ');
}

// A step whose instance values cannot be typed says what the operator must change instead.
class Needs {
  constructor(message) {
    this.message = message;
  }
}
const needs = (message) => new Needs(message);

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
  // Mapped 2026-10-25: "Add experience" opens a dialog with Title and Company typeaheads (free text is
  // kept), a "currently working" checkbox that hides the end date, month and year dropdowns, and Save.
  employment: {
    read: async (s) => (await s.evaluate(readCards)).map(parseEmploymentCard),
    want: (ctx) => {
      const { entries, skipped } = employmentEntries(ctx.instance.profile);
      if (!entries.length) return needs('profile.roles has no role with a start month (YYYY.MM)');
      const refused = gated(ctx, entries.map((e) => e.title + ', ' + e.company).join('\n'), 'profile.roles');
      return refused ? needs(refused) : Object.assign(entries, { skipped });
    },
    same: (cur, want) => want.every((e) => cur.some((c) => sameEntry(c, e))),
    write: async (s, want, cur) => {
      const D = '[role=dialog] ';
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

async function runStep(session, id, ctx) {
  const h = HANDLERS[id];
  const want = h.want(ctx);
  if (want instanceof Needs) return result(id, 'needs-operator', want.message);
  // The wizard renders a step a few seconds after its URL changes; read it only once its heading shows.
  const heading = STEPS.find((s) => s.id === id)?.detect.heading;
  if (heading && !(await waitFor(session, (spec) => [...document.querySelectorAll('h1,h2,h3')].some((h) => h.getBoundingClientRect().width > 0 && new RegExp(spec.re, spec.flags).test(h.innerText)), { re: heading.source, flags: heading.flags }, { timeoutMs: 20000 }))) {
    return result(id, 'needs-operator', 'the ' + id + ' page did not show its heading within 20 s');
  }
  await sleep(1000);
  const cur = await h.read(session);
  if (h.same(cur, want)) return result(id, 'done', describe(want));
  if (!h.write) return result(id, 'needs-operator', 'no writer for this step');
  try {
    await h.write(session, want, cur);
  } catch (err) {
    return result(id, 'needs-operator', err.message);
  }
  await sleep(800);
  const back = await h.read(session);
  return h.same(back, want) ? result(id, 'filled', describe(want)) : result(id, 'needs-operator', 'read back ' + JSON.stringify(back) + ' instead of ' + JSON.stringify(want));
}

const describe = (want) => {
  if (Array.isArray(want)) return want.map((w) => (typeof w === 'object' ? w.title + ' at ' + w.company + ', ' + w.dates : w)).join('; ') + (want.skipped?.length ? '; left out without a start month: ' + want.skipped.join(', ') : '');
  return typeof want === 'object' ? JSON.stringify(want.specialties ?? want) : String(want);
};

async function advance(session, id) {
  const before = pathOf(await session.evaluate(() => location.href));
  if (HANDLERS[id].next) await HANDLERS[id].next(session);
  else await session.click(NEXT);
  const moved = await waitFor(session, (p) => location.pathname.replace(/\/+$/, '') !== p && location.href, before, { timeoutMs: 20000 });
  await sleep(1500);
  return moved;
}

export async function onboard(session, ctx) {
  const log = ctx.log ?? (() => {});
  const results = [];
  const only = ctx.step ?? null;
  let url = await session.navigate(only ? START + only : START);
  for (let guard = 0; guard < 40; guard++) {
    const id = stepOfUrl(url);
    if (id === null) {
      results.push(result('submitted', 'done', 'create-profile now opens ' + pathOf(url) + ', so the wizard is finished'));
      break;
    }
    if (!(id in HANDLERS)) {
      results.push(result(id, 'unmapped', JSON.stringify(await session.evaluate(pageOutline))));
      break;
    }
    if (results.some((r) => r.step === id)) break;
    if (only && id !== only) {
      results.push(result(only, 'needs-operator', 'upwork opened ' + id + ' instead; the wizard opens a step only after the steps before it are saved'));
      break;
    }
    const r = await runStep(session, id, ctx);
    results.push(r);
    log(r.step + ': ' + r.state + (r.detail ? ' (' + r.detail + ')' : ''));
    if (r.state === 'needs-operator' || r.state === 'unmapped' || only) break;
    if (!ctx.apply) {
      // A dry run saves nothing, so the wizard keeps every later step closed; report and stop here
      // unless this step was already saved, in which case the next one is open.
      const at = STEPS.findIndex((s) => s.id === id);
      const nextId = STEPS[at + 1]?.id;
      if (r.state !== 'done' || !nextId) break;
      url = await session.navigate(START + nextId);
      continue;
    }
    url = await advance(session, id);
    if (!url) {
      results.push(result(id, 'needs-operator', 'next did not leave ' + id + '; the page may show a validation message'));
      break;
    }
  }
  return results;
}

