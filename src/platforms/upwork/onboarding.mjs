// Upwork seller onboarding, the /nx/create-profile wizard, mapped from the live pages on 2026-10-25.
// Each step is one URL under /nx/create-profile/; the wizard opens only the first unsaved step (a later
// step URL redirects back to it), so a dry run stops there after typing and reading it back. Values come
// from the instance: config.onboarding.upwork holds the operator's answers, the catalog's
// upworkSpecialty maps the answered services onto Upwork's category and specialties, and the profile
// gives roles, education and the overview text, which passes the outbound gate before it is typed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { clickMatch, clickVisible, gated, googleSignIn, Needs, needs, pathOf, MONTH_NAMES, pickDate, pickOption, readIdentity, sleep, typeInto, waitFor, walkWizard } from '../onboarding.mjs';
import { readCards, readChecked, readLanguages, readSkills, readSpecialties, readValue, readWorkPreference } from './onboarding-page.mjs';
import { educationEntries, employmentEntries, norm, overviewText, parseEmploymentCard, parseUsd, upworkSpecialties } from './profile-plan.mjs';

export const START = 'https://www.upwork.com/nx/create-profile/';
const BASE = '/nx/create-profile/';
const NEXT = '[data-test=next-button]';
const SLIDE = '[data-test=carousel-slide]';
const SKILL_INPUT = 'input[aria-labelledby=skills-input]';
export const MAX_SKILLS = 15;
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
  { id: 'submit', detect: { path: BASE + 'submit', heading: /preview profile/i } },
];

export const stepOfUrl = (url) => {
  const path = pathOf(url);
  return path.startsWith(BASE) ? path.slice(BASE.length).split('/')[0] : null;
};

export const sameSet = (a, b) => a.length === b.length && a.every((x) => b.some((y) => norm(x) === norm(y)));

const sameEntry = (card, e) => norm(card.title) === norm(e.title) && norm(card.company) === norm(e.company) && norm(card.dates) === norm(e.dates);

const cardHasSchool = (cards, e) => cards.some((c) => norm(c.split(/\n/)[0]) === norm(e.school));

export const LANGUAGE_LEVELS = ['Basic', 'Conversational', 'Fluent', 'Native or Bilingual'];

export const OVERVIEW_MIN = 100;

const FIELDS = ['photo', 'dateOfBirth', 'street', 'unit', 'city', 'region', 'postalCode', 'phone'];

// --- steps ---

const PREFERENCES = { talentMarketplace: /find opportunities myself/i, projectCatalog: /package up my work/i };

function settings(ctx) {
  return ctx.instance.config?.onboarding?.upwork ?? {};
}

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
  // Mapped 2026-10-26: the preview page shows the whole profile and two "Submit profile" buttons;
  // submitting leaves create-profile. The last step of the wizard, so the walk ends here, and the page
  // the site lands on is captured to the evidence folder.
  submit: {
    saves: true,
    final: true,
    read: (s) => s.evaluate(() => !location.pathname.startsWith('/nx/create-profile/submit')),
    want: () => true,
    same: (cur) => cur === true,
    write: async (s, want, cur, ctx) => {
      if (!(await clickMatch(s, 'button', 'Submit profile'))) throw new Error('no Submit profile button');
      if (!(await waitFor(s, () => !location.pathname.startsWith('/nx/create-profile/submit'), null, { timeoutMs: 30000 }))) throw new Error('the profile page stayed on submit');
      await sleep(4000);
      if (ctx.evidenceDir) await s.screenshot(join(ctx.evidenceDir, 'submitted-' + Date.now() + '.jpg'));
    },
  },

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
        await pickOption(s, D + '[aria-labelledby=start-date-month]', MONTH_NAMES[e.start.month - 1]);
        await pickOption(s, D + '[aria-labelledby=start-date-year]', String(e.start.year));
        if (e.end) {
          await pickOption(s, D + '[aria-labelledby=end-date-month]', MONTH_NAMES[e.end.month - 1]);
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
  if (want === true) return 'in place';
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
