// Freelancer.com seller onboarding, the /new-freelancer wizard, mapped from the live pages on 2026-10-25.
// The wizard opens its first unsaved step; a choice there is kept only when its Next is pressed, so a
// dry run types and reads back without saving. Values come from config.onboarding.freelancer and the
// profile; every typed text passes the outbound gate as kind profile first. Bids and deposits are never
// part of onboarding.
import { clickMatch, clickVisible, needs, pathOf, sleep, typeInto, waitFor, walkWizard } from '../onboarding.mjs';

export const START = 'https://www.freelancer.com/new-freelancer/skills';
const BASE = '/new-freelancer/';
export const MAX_SKILLS = 20;

export const STEPS = [{ id: 'skills', detect: { path: BASE + 'skills', heading: /tell us your top skills/i } }];

export const stepOfUrl = (url) => {
  const path = pathOf(url);
  return path.startsWith(BASE) ? path.slice(BASE.length).split('/')[0] : null;
};

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.some((y) => norm(x) === norm(y)));
const settings = (ctx) => ctx.instance.config?.onboarding?.freelancer ?? {};

// The selected panel lists its heading ("3 out of 20 skills selected"), then one line per skill.
export function parseSelectedSkills(text) {
  return String(text ?? '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/skills? selected$/i.test(l) && !/^Select at least one skill/i.test(l));
}

// A search result reads "Web Scraping (42 jobs)"; the name is the part before the count.
export const skillOfResult = (text) => String(text ?? '').replace(/\s*\(\d[\d,]*\s+jobs?\)\s*$/i, '').trim();

const SEARCH = 'input[placeholder="Search a skill"]';

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
        await typeInto(s, SEARCH, skill);
        const listed = await waitFor(s, (name) => [...document.querySelectorAll('.SkillsContent-text')].some((e) => e.getBoundingClientRect().width > 0 && e.innerText.replace(/\s*\(\d[\d,]*\s+jobs?\)\s*$/i, '').trim().toLowerCase() === name.toLowerCase()), skill, { timeoutMs: 8000 });
        if (!listed || !(await clickMatch(s, '.SkillsContent-text', new RegExp('^' + skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'i')))) {
          const shown = await s.evaluate(() => [...document.querySelectorAll('.SkillsContent-text')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => e.innerText.trim()).slice(0, 6));
          missing.push(skill + ' (listed: ' + shown.map(skillOfResult).join(' / ') + ')');
        }
        await sleep(500);
      }
      if (missing.length) throw new Error('Freelancer lists no skill named ' + missing.join(', '));
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
  });

