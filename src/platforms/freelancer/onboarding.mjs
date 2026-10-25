// Freelancer.com seller onboarding, the /new-freelancer wizard, mapped from the live pages on 2026-10-25.
// The wizard opens its first unsaved step; a choice there is kept only when its Next is pressed, so a
// dry run types and reads back without saving. Values come from config.onboarding.freelancer and the
// profile; every typed text passes the outbound gate as kind profile first. Bids and deposits are never
// part of onboarding.
import { existsSync } from 'node:fs';
import { Needs, clickMatch, googleSignIn, needs, pathOf, readIdentity, sleep, typeInto, waitFor, walkWizard } from '../onboarding.mjs';

export const START = 'https://www.freelancer.com/new-freelancer/skills';
const BASE = '/new-freelancer/';
export const MAX_SKILLS = 20;

export const STEPS = [
  { id: 'skills', detect: { path: BASE + 'skills', heading: /tell us your top skills/i } },
  { id: 'linked-accounts', detect: { path: BASE + 'linked-accounts', heading: /link your accounts/i } },
  { id: 'profile-details/photo-and-name', detect: { path: BASE + 'profile-details/photo-and-name', heading: /what is your name/i } },
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

// Runs in the page: the name fields, and whether the photo area shows an uploaded picture. Before an
// upload the page shows only the logo and the camera button; asset images are the site's own.
const readPhotoAndName = () => ({
  photo: [...document.querySelectorAll('img')].some((i) => i.getBoundingClientRect().width > 40 && !/\/assets\/|logo/i.test(i.src)),
  first: document.querySelector('#inputFirstName')?.value ?? '',
  last: document.querySelector('#inputLastName')?.value ?? '',
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
  // Mapped 2026-10-26: a camera button in fl-camera-input opens the photo chooser, and #inputFirstName and
  // #inputLastName take the name; the page asks for the real name, since identity verification checks
  // it, so the name is the identity file's legal name. Next stays disabled until both names are typed.
  'profile-details/photo-and-name': {
    show: (cur, want) => 'read back differs in: ' + ['photo', 'first', 'last'].filter((k) => (k === 'photo' ? !cur.photo : cur[k] !== want[k])).join(', '),
    read: (s) => s.evaluate(readPhotoAndName),
    want: (ctx) => {
      const id = readIdentity(ctx);
      if (id instanceof Needs) return id;
      const name = splitLegalName(id.legalNameEn);
      if (!name) return needs('the identity file lacks person.legal_name_en as given and family name');
      const photo = ctx.instance.config?.onboarding?.photo;
      if (!photo || !existsSync(photo)) return needs('set config onboarding.photo to a photo of you');
      return { photo, ...name };
    },
    same: (cur, want) => cur.photo === true && cur.first === want.first && cur.last === want.last,
    write: async (s, want, cur) => {
      if (cur.first !== want.first) await typeInto(s, '#inputFirstName', want.first);
      if (cur.last !== want.last) await typeInto(s, '#inputLastName', want.last);
      if (cur.photo) return;
      // The upload tool presses the camera button and answers the chooser it opens with the file.
      await s.setFiles('fl-camera-input button', want.photo);
      // A crop dialog may follow; its confirm button saves the picture.
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        if ((await s.evaluate(readPhotoAndName)).photo) return;
        if (await clickMatch(s, '[role=dialog] button, fl-modal button, .ModalContainer button', /^(Save|Upload|Done|Apply|Confirm|Crop|Use photo|Upload photo)$/i)) await sleep(2000);
      }
      throw new Error('the photo did not show after the upload; the page outline: ' + JSON.stringify(await s.evaluate(() => ({ dialogs: [...document.querySelectorAll('[role=dialog], fl-modal')].map((d) => d.innerText.replace(/\s+/g, ' ').slice(0, 200)), files: document.querySelectorAll('input[type=file]').length }))));
    },
  },
};

const describe = (want) => (Array.isArray(want) ? want.join(', ') : typeof want === 'object' ? JSON.stringify(want) : String(want));

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

