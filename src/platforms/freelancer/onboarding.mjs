// Freelancer.com seller onboarding, the /new-freelancer wizard, mapped from the live pages on 2026-10-25.
// The wizard opens its first unsaved step; a choice there is kept only when its Next is pressed, so a
// dry run types and reads back without saving. Values come from config.onboarding.freelancer and the
// profile; every typed text passes the outbound gate as kind profile first. Bids and deposits are never
// part of onboarding.
import { Needs, clickMatch, gated, googleSignIn, needs, pathOf, readIdentity, sleep, typeInto, waitFor, walkWizard } from '../onboarding.mjs';

export const START = 'https://www.freelancer.com/new-freelancer/skills';
const BASE = '/new-freelancer/';
export const MAX_SKILLS = 20;
export const SUMMARY_MAX = 3000;
const HEADLINE = 'input[placeholder="e.g. Data Scientist"]';
const SUMMARY = 'main textarea';
const LANGUAGE = 'input[placeholder="Please select the languages you speak"]';
const BIRTHDATE = '#inputBirthdate';

export const STEPS = [
  { id: 'skills', detect: { path: BASE + 'skills', heading: /tell us your top skills/i } },
  { id: 'linked-accounts', detect: { path: BASE + 'linked-accounts', heading: /link your accounts/i } },
  { id: 'profile-details/photo-and-name', detect: { path: BASE + 'profile-details/photo-and-name', heading: /what is your name/i } },
  { id: 'profile-details/headline-and-summary', detect: { path: BASE + 'profile-details/headline-and-summary', heading: /tell us a bit about yourself/i } },
  { id: 'profile-details/languages-and-birthdate', detect: { path: BASE + 'profile-details/languages-and-birthdate', heading: /what languages do you speak/i } },
];

// A step is the wizard path after /new-freelancer/, since profile-details holds several pages.
export const stepOfUrl = (url) => {
  const path = pathOf(url);
  return path.startsWith(BASE) ? path.slice(BASE.length) : null;
};

// The identity file's legal English name as a passport writes it ("GIVEN FAMILY", capitals): the last
// word is the family name, and capitals are written as a name is on a profile.
export function splitLegalName(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const cap = (w) => (w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w);
  return { first: words.slice(0, -1).map(cap).join(' '), last: cap(words.at(-1)) };
}

// Runs in the page: the name fields, whether the photo area shows a picture (before one is taken the
// page shows only the logo and the camera button; asset images are the site's own) and whether Next
// is enabled.
const readPhotoAndName = () => ({
  photo: [...document.querySelectorAll('img')].some((i) => i.getBoundingClientRect().width > 40 && !/\/assets\/|logo/i.test(i.src)),
  first: document.querySelector('#inputFirstName')?.value ?? '',
  last: document.querySelector('#inputLastName')?.value ?? '',
  next: [...document.querySelectorAll('button')].some((b) => /^Next$/.test(b.innerText.trim()) && !b.disabled),
});

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.some((y) => norm(x) === norm(y)));
const settings = (ctx) => ctx.instance.config?.onboarding?.freelancer ?? {};

// The selected panel lists its heading, then one line per skill. The heading reads "3 out of 20 skills
// selected" and, once the wizard has counted matching jobs, "996 jobs matching your skills" (live
// 2026-10-26, after all 12 skills were added).
export function parseSelectedSkills(text) {
  return String(text ?? '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/skills? selected$/i.test(l) && !/^[\d,]+ jobs? matching your skills$/i.test(l) && !/^Select at least one skill/i.test(l));
}

// A search result reads "Web Scraping (42 jobs)"; the name is the part before the count.
export const skillOfResult = (text) => String(text ?? '').replace(/\s*\(\d[\d,]*\s+jobs?\)\s*$/i, '').trim();

const SEARCH = 'input[placeholder="Search a skill"]';

// A search result reads "Name (N jobs)", or the bare name when the skill has no open jobs.
export const resultPattern = (skill) => new RegExp('^' + skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s*\\(|$)', 'i');

// Types one skill into the search and clicks its result. The list sometimes stays empty after the
// typing (on 2026-10-26, for 3 of 12 skills the jobs API lists). Typing the same term again does not
// refresh it, since the search drops a term equal to the last one it took (the apply run at 05:36 failed
// twice on one skill that way); deleting the last character and pressing it again after a pause sends
// two new terms, and that brought the list back in a live probe.
export async function addSkill(s, skill, { timeoutMs = 10000, pauseMs = 3000 } = {}) {
  const listed = (name) => [...document.querySelectorAll('.SkillsContent-text')].some((e) => e.getBoundingClientRect().width > 0 && e.innerText.replace(/\s*\(\d[\d,]*\s+jobs?\)\s*$/i, '').trim().toLowerCase() === name.toLowerCase());
  const last = skill.slice(-1);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      await s.press('Backspace', { target: SEARCH });
      await sleep(pauseMs);
      await s.press(last === ' ' ? 'Space' : last, { target: SEARCH });
    } else await typeInto(s, SEARCH, skill);
    if (await waitFor(s, listed, skill, { timeoutMs })) return clickMatch(s, '.SkillsContent-text', resultPattern(skill));
  }
  return false;
}

export const HANDLERS = {
  // Mapped 2026-10-25: a search box lists matching skills as .SkillsContent-text "Name (N jobs)";
  // clicking one adds it to fl-skills-selected (at most 20). The choice is saved by Next.
  skills: {
    read: async (s) => parseSelectedSkills(await s.evaluate(() => document.querySelector('fl-skills-selected')?.innerText ?? '')),
    want: (ctx) => {
      const skills = settings(ctx).skills ?? [];
      return skills.length && skills.length <= MAX_SKILLS ? skills : needs('config onboarding.freelancer.skills must list 1 to ' + MAX_SKILLS + ' Freelancer skill names');
    },
    same: (cur, want) => sameSet(cur, want),
    write: async (s, want, cur) => {
      const missing = [];
      for (const skill of want.filter((w) => !cur.some((c) => norm(c) === norm(w)))) {
        if (!(await addSkill(s, skill))) {
          const shown = await s.evaluate(() => [...document.querySelectorAll('.SkillsContent-text')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.innerText.trim()).slice(0, 6));
          missing.push(skill + ' (listed: ' + shown.map(skillOfResult).join(' / ') + ')');
        }
        await sleep(500);
      }
      if (missing.length) throw new Error('Freelancer lists no skill named ' + missing.join(', '));
    },
  },
  // Mapped 2026-10-26: offers Facebook and LinkedIn imports of photo, name and e-mail, with Back, Skip
  // and Next. The profile steps after it take those values from the instance, so no account is linked
  // and Skip leaves the step.
  'linked-accounts': {
    read: async () => 'not linked',
    want: () => 'not linked',
    same: (cur, want) => cur === want,
    next: (s) => clickMatch(s, 'button', /^Skip$/),
  },
  // Mapped 2026-10-26: #inputFirstName and #inputLastName take the name; the page asks for the real
  // name, since identity verification checks it, so the name is the identity file's legal name. The
  // photo comes only from the camera: its button asks for camera access to take "a clear picture of
  // your face" for identity verification and offers no file upload ("No, thanks" ends in "Cannot connect
  // to Camera"), so a person takes it. Next stays disabled with one name typed and no photo.
  'profile-details/photo-and-name': {
    show: (cur, want) => 'read back differs in: ' + ['first', 'last'].filter((k) => cur[k] !== want[k]).join(', '),
    read: (s) => s.evaluate(readPhotoAndName),
    want: (ctx) => {
      const id = readIdentity(ctx);
      if (id instanceof Needs) return id;
      const name = splitLegalName(id.legalNameEn);
      return name ? { private: 'legal first and last name', ...name } : needs('the identity file lacks person.legal_name_en as given and family name');
    },
    same: (cur, want) => cur.first === want.first && cur.last === want.last,
    write: async (s, want, cur) => {
      if (cur.first !== want.first) await typeInto(s, '#inputFirstName', want.first);
      if (cur.last !== want.last) await typeInto(s, '#inputLastName', want.last);
    },
    // With the names typed, a disabled Next means the page waits for the camera picture.
    pending: async (s) => {
      const page = await s.evaluate(readPhotoAndName);
      return page.next ? null : 'the profile photo is taken with the camera for identity verification: on /new-freelancer/profile-details/photo-and-name press the camera button, Continue, allow the camera and take the picture; the names are typed';
    },
  },
  // Mapped 2026-10-26: "What do you do?" is a one line headline (placeholder "e.g. Data Scientist") and
  // "Describe yourself" a textarea of 3,000 characters. The headline is config onboarding.freelancer.headline
  // and the description onboarding.freelancer.summary, else profile.summary_en; both pass the gate.
  'profile-details/headline-and-summary': {
    read: (s) => s.evaluate(({ h, d }) => ({ headline: document.querySelector(h)?.value ?? '', summary: document.querySelector(d)?.value ?? '' }), { h: HEADLINE, d: SUMMARY }),
    want: (ctx) => headlineAndSummary(ctx),
    same: (cur, want) => norm(cur.headline) === norm(want.headline) && norm(cur.summary) === norm(want.summary),
    write: async (s, want, cur) => {
      if (norm(cur.headline) !== norm(want.headline)) await typeInto(s, HEADLINE, want.headline);
      if (norm(cur.summary) !== norm(want.summary)) await s.fill(SUMMARY, want.summary);
    },
  },
  // Mapped 2026-10-26: an fl-multi-select whose search lists each language as p.DropdownItemText with the
  // language as its id, and #inputBirthdate, a date field typed as MM/DD/YYYY. Languages come from
  // profile.languages, the birth date from the identity file; the page keeps it for verification.
  'profile-details/languages-and-birthdate': {
    show: (cur, want) => 'read back differs in: ' + [!sameSet(cur.languages, want.languages) && 'languages (read ' + cur.languages.join(', ') + ')', cur.birthdate !== want.birthdate && 'birth date'].filter(Boolean).join(', '),
    read: (s) => s.evaluate(({ input }) => {
      const box = document.querySelector('fl-multi-select');
      const skip = new Set([...(box?.querySelectorAll('.DropdownItemText') ?? [])].map((e) => e.innerText.trim()));
      const lines = String(box?.innerText ?? '').split(/\n/).map((l) => l.trim()).filter((l) => l && !skip.has(l) && l !== document.querySelector(input)?.placeholder);
      return { languages: lines, birthdate: document.querySelector('#inputBirthdate')?.value ?? '' };
    }, { input: LANGUAGE }),
    want: (ctx) => {
      const id = readIdentity(ctx);
      if (id instanceof Needs) return id;
      const languages = profileLanguages(ctx.instance.profile);
      const birthdate = usDate(id.dateOfBirth);
      if (!languages.length) return needs('profile.languages lists no language');
      return birthdate ? { private: 'languages ' + languages.join(', ') + ' and the birth date', languages, birthdate } : needs('the identity file date_of_birth is not a YYYY-MM-DD date');
    },
    same: (cur, want) => sameSet(cur.languages, want.languages) && cur.birthdate === want.birthdate,
    write: async (s, want, cur) => {
      for (const lang of want.languages.filter((l) => !cur.languages.some((c) => norm(c) === norm(l)))) {
        await typeInto(s, LANGUAGE, lang);
        const listed = await waitFor(s, (name) => [...document.querySelectorAll('.DropdownItemText')].some((e) => e.getBoundingClientRect().width > 0 && e.innerText.trim().toLowerCase() === name.toLowerCase()), lang, { timeoutMs: 10000 });
        if (!listed || !(await clickMatch(s, '.DropdownItemText', lang))) throw new Error('Freelancer lists no language named ' + lang);
        await sleep(800);
      }
      if (cur.birthdate !== want.birthdate) await typeInto(s, BIRTHDATE, want.birthdate);
    },
  },
};

const LANGUAGE_CODES = { en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German' };
// profile.languages holds codes ("ko") or names with a note ("Korean (native)"); the page lists names.
export const profileLanguages = (profile) => [...new Set((profile?.languages ?? []).map((l) => LANGUAGE_CODES[String(l).toLowerCase()] ?? String(l).split('(')[0].trim()).filter(Boolean))];
// YYYY-MM-DD as the page's MM/DD/YYYY.
export const usDate = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim());
  return m ? m[2] + '/' + m[3] + '/' + m[1] : null;
};

export function headlineAndSummary(ctx) {
  const set = settings(ctx);
  const headline = String(set.headline ?? '').trim();
  const summary = String(set.summary ?? ctx.instance.profile?.summary_en ?? '').trim();
  if (!headline) return needs('set config onboarding.freelancer.headline to a one line description of what you do');
  if (summary.length > SUMMARY_MAX) return needs('the summary is ' + summary.length + ' characters and Freelancer takes ' + SUMMARY_MAX);
  const refused = gated(ctx, headline, 'onboarding.freelancer.headline') ?? gated(ctx, summary, 'the summary');
  return refused ? needs(refused) : { headline, summary };
}

// A step holding private values describes them by want.private, never by value.
const describe = (want) => (Array.isArray(want) ? want.join(', ') : want?.private ? want.private : typeof want === 'object' ? JSON.stringify(want) : String(want));

export const onboard = (session, ctx) =>
  walkWizard(session, ctx, {
    name: 'freelancer',
    steps: STEPS,
    handlers: HANDLERS,
    startUrl: START,
    stepUrl: null,
    stepOfUrl,
    describe,
    advance: (s) => clickMatch(s, 'button', /^Next$/),
    // Mapped 2026-10-26: the login page renders Google's button in a gsi/button iframe beside a
    // Continue with Facebook button.
    signIn: (s, ctx) => googleSignIn(s, { framed: true, email: readIdentity(ctx).googleEmail }),
  });

