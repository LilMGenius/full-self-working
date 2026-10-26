// Fiverr seller onboarding, mapped on 2026-10-26 in the operator's signed-in Chrome. Every step reads
// the page, compares it with the instance and writes only the difference; a dry run (ctx.apply false)
// stops after reading. Nothing here publishes a gig, and every step that needs the operator (phone or SMS
// code, ID or selfie check, payment or tax forms) is reported, never attempted.
//
// Page facts behind the code:
// - /seller_onboarding/overview first offers a LinkedIn or CV PDF import or [data-testid=fill-out-manually-button];
//   after Continue ([data-testid=continue-button]) the same URL shows "Edit your new profile" (later
//   "Review your new profile") with a photo input (name profile[image]), display name (15 characters),
//   title (80), languages, About (150 to 600 characters) and skills, plus optional work experience,
//   education and certifications. Continue stays blocked until the first six are set.
// - The fields are read-only stand-ins until clicked, and the clicks the browser daemon sends did not open
//   them; a synthetic pointerdown, mousedown, pointerup, mouseup and click sequence does, so press() below
//   sends that. Comboboxes ([role=combobox]) open the same way, and each one's options sit in the [role=dialog]
//   right after it (combobox.parentElement.nextElementSibling) as labels around radio inputs.
// - Languages save as soon as a row has both values; "Add languages" adds a row. Language codes are ISO
//   (KO, EN) and levels BASIC, CONVERSATIONAL, FLUENT, NATIVE_OR_BILINGUAL.
// - A skill is typed, picked from the suggestions, given BEGINNER, INTERMEDIATE or PRO and added with "Add".
// - Mid-session, about an hour after the first edits, the overview answered with a PerimeterX page ("It needs a
//   human touch", ERRCODE PXCR...). That is a human check; every step stops and reports it.
// - The display name in the recommended form (first name and last initial) was refused with
//   "This name violates our Terms of Service."; the full English name was accepted.
import { gateOutbound } from '../../policy/gate.mjs';
import { challengeOf, squash } from '../kit.mjs';
import { result, sleep, waitFor } from '../onboarding.mjs';

export const OVERVIEW_URL = 'https://www.fiverr.com/seller_onboarding/overview';

const EDITOR_HEADING = /(Edit|Review) your new profile/;

export const STEPS = [
  { id: 'start', detect: { path: /^\/seller_onboarding\/overview/, heading: /Grow your brand/ } },
  { id: 'profile', detect: { path: /^\/seller_onboarding\/overview/, heading: EDITOR_HEADING } },
  { id: 'continue', detect: { path: /^\/seller_onboarding\// } },
];

// ---- pure planning ----

// The display name: profile.person.nameEn when it fits the page's 3 to 15 characters.
export function displayName(profile) {
  const name = squash(profile?.person?.nameEn);
  return name.length >= 3 && name.length <= 15 ? name : null;
}

// The title: onboarding.fiverr.title, else the first sentence of headline_en, within 80 characters.
export function titleOf(instance) {
  const set = instance.config?.onboarding?.fiverr?.title;
  const text = squash(set ?? String(instance.profile?.headline_en ?? '').split(/(?<=\.)\s/)[0]);
  return text && text.length <= 80 ? text.replace(/\.$/, '') : null;
}

const LANGUAGE_CODES = { korean: 'KO', english: 'EN', japanese: 'JA', chinese: 'ZH', spanish: 'ES', french: 'FR', german: 'DE' };
// "Korean (native)" -> KO NATIVE_OR_BILINGUAL. Working proficiency maps to CONVERSATIONAL, the lower of
// the two levels it could mean, since a stated level is a claim.
export function languagesOf(profile) {
  return (profile?.languages ?? []).map((l) => {
    const name = String(l).split(/[\s(]/)[0].toLowerCase();
    const level = /native|bilingual/i.test(l) ? 'NATIVE_OR_BILINGUAL' : /fluent/i.test(l) ? 'FLUENT' : /working|conversational/i.test(l) ? 'CONVERSATIONAL' : 'BASIC';
    return LANGUAGE_CODES[name] ? { code: LANGUAGE_CODES[name], name: name[0].toUpperCase() + name.slice(1), level } : null;
  }).filter(Boolean);
}

// About: profile.summary_en, which must fit the page's 150 to 600 characters.
export function aboutOf(profile) {
  const text = squash(profile?.summary_en);
  return text.length >= 150 && text.length <= 600 ? text : null;
}

// Skill candidates from profile.skills: the parts of each entry around " and " that are one or two words,
// single words first; the page's suggestions decide which exist. Each try costs about six paced actions,
// so longer phrases, which never match a suggestion exactly, are not tried.
export function skillCandidates(profile) {
  const parts = [...new Set(Object.values(profile?.skills ?? {}).flat().flatMap((e) => String(e).split(/\s+and\s+/)).map((t) => t.trim()))];
  const words = (t) => t.split(/\s+/).length;
  return parts.filter((t) => t.length >= 2 && words(t) <= 2).sort((a, b) => words(a) - words(b));
}

export const LEVELS = ['BEGINNER', 'INTERMEDIATE', 'PRO'];
export function skillLevel(instance) {
  const v = String(instance.config?.onboarding?.fiverr?.skillLevel ?? 'INTERMEDIATE').toUpperCase();
  return LEVELS.includes(v) ? v : 'INTERMEDIATE';
}

// The profile header text -> what is set. The page writes "Speaks Korean, English" once languages exist,
// and lists each skill as its name followed by its level.
export function parseProfileText(text) {
  const t = String(text ?? '');
  const speaks = t.match(/Speaks ([^\n|]+)/)?.[1]?.split(/,\s*/).map((s) => s.trim()).filter(Boolean) ?? [];
  const skillBlock = t.match(/Skills and expertise([\s\S]*?)Work experience/)?.[1] ?? '';
  const rows = skillBlock.split(/\n|\|/).map((s) => s.trim()).filter(Boolean);
  const skills = [];
  for (let i = 0; i < rows.length - 1; i++) if (/^(Beginner|Intermediate|Pro)$/.test(rows[i + 1])) skills.push(rows[i]);
  return { speaks, skills, nameRefused: /violates our Terms of Service/.test(t), missing: t.match(/You need to add ([^\n.]+)/)?.[1] ?? null };
}

// The profile fields the page does not hold yet, by what want plans, what the page shows and what its text reads.
export function unsetFields(want, held, seen) {
  const left = [];
  if (want.name && (held.name !== want.name || seen.nameRefused)) left.push('display name');
  if (want.title && held.title !== want.title) left.push('title');
  if (want.languages.some((l) => !seen.speaks.includes(l.name))) left.push('languages');
  if (want.about && squash(held.about) !== want.about) left.push('about');
  return left;
}

export function gateTexts(texts, ctx) {
  return texts.filter((t) => String(t ?? '').trim()).flatMap((text) => gateOutbound({ kind: 'profile', platform: 'fiverr', text }, { descriptor: ctx.descriptor, instance: ctx.instance }).violations.map((v) => v.rule + ' ' + v.detail));
}

// ---- page actions ----

// Sends the synthetic pointer and mouse sequence to the element the body returns (body sees document).
async function press(session, body) {
  session.guard.beforeAction();
  const ok = await session.evaluate((body) => {
    const el = new Function(body)();
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true }));
    el.click();
    return true;
  }, body);
  await sleep(700);
  return ok;
}

const buttonByText = (text) => "return [...document.querySelectorAll('button')].find((b) => b.offsetWidth && b.innerText.trim() === " + JSON.stringify(text) + ')';

async function readPage(session) {
  const page = await session.evaluate(() => {
    const field = (ph) => document.querySelector('input[placeholder="' + ph + '"]')?.value ?? null;
    const about = document.querySelector('textarea[placeholder^="Share some details"]');
    const aboutText = (document.body.innerText.match(/About\n([\s\S]*?)\nSkills and expertise/)?.[1] ?? '').trim();
    return {
      url: location.href,
      heading: [...document.querySelectorAll('h1,h2')].map((h) => h.innerText.trim()).join(' | '),
      text: document.body.innerText,
      name: field('Add display name'),
      title: field('Add title'),
      about: about ? about.value : aboutText,
      photo: !!document.querySelector('img[src*="profile"], img[alt*="profile" i]') && !/Add profile picture|Upload photo/i.test(document.body.innerText.slice(0, 600)),
    };
  });
  const wall = challengeOf({ title: page.heading, text: page.text.slice(0, 2000) });
  if (wall) throw Object.assign(new Error('Fiverr shows a ' + wall + ' human check (' + page.heading.slice(0, 40) + '); the operator passes it in Chrome'), { code: 'FSW_FIVERR_CHALLENGE' });
  return page;
}

async function setInline(session, placeholder, value) {
  const sel = 'input[placeholder="' + placeholder + '"]';
  await press(session, 'const i = document.querySelector(' + JSON.stringify(sel) + '); for (const el of [i.parentElement.parentElement, i.parentElement]) { for (const t of ["pointerdown","mousedown","pointerup","mouseup"]) el.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, { bubbles: true })); el.click(); } return i;');
  await session.fill(sel, value);
  await session.press('Enter');
  await sleep(1500);
}

async function pickOption(session, comboIndex, value) {
  await press(session, "return document.querySelectorAll('[role=combobox]')[" + comboIndex + ']');
  const ok = await press(session, "const c = document.querySelectorAll('[role=combobox]')[" + comboIndex + "]; const l = c && c.parentElement.nextElementSibling; const r = l && l.querySelector('input[value=" + JSON.stringify(value) + "]'); return r && r.closest('label');");
  await sleep(500);
  return ok;
}

async function setLanguages(session, langs) {
  await press(session, "const el = [...document.querySelectorAll('button,[role=button],span')].find((e) => /^(Add languages|Speaks )/.test(e.innerText?.trim() ?? '') && e.offsetWidth); return el && (el.closest('button,[role=button]') || el);");
  const rows = await session.evaluate(() => [...document.querySelectorAll('[role=combobox] input')].map((i) => i.value));
  for (let i = 0; i < langs.length; i++) {
    if (i * 2 >= rows.length) await press(session, buttonByText('Add languages'));
    await pickOption(session, i * 2, langs[i].code);
    await pickOption(session, i * 2 + 1, langs[i].level);
  }
  await session.press('Escape');
  await sleep(800);
}

// The skill input renders about 2 s after "Add new" is pressed (mapped 2026-10-26), so it is awaited
// before typing; a fill sent earlier failed with selector_not_found and ended the run.
export async function addSkill(session, name, level, { timeoutMs = 10000 } = {}) {
  const sel = 'input[placeholder^="Add skill or expertise"]';
  const shown = (sel) => !!document.querySelector(sel)?.offsetWidth;
  if (!(await session.evaluate(shown, sel))) {
    await press(session, "const b = [...document.querySelectorAll('button')].find((b) => b.offsetWidth && /^(Add skills and expertise|Add new)$/.test(b.innerText.trim()) && b.closest('section,div') && /Skills and expertise/.test(b.closest('section') ? b.closest('section').innerText : b.parentElement.parentElement.innerText)); return b;");
    if (!(await waitFor(session, shown, sel, { timeoutMs }))) return false;
  }
  await press(session, 'return document.querySelector(' + JSON.stringify(sel) + ").closest('[role=combobox]')");
  await session.fill(sel, name);
  await sleep(1800);
  const picked = await press(session, 'const c = document.querySelector(' + JSON.stringify(sel) + ").closest('[role=combobox]'); const l = c.parentElement.nextElementSibling; return l && [...l.querySelectorAll('label')].find((x) => x.innerText.trim().toLowerCase() === " + JSON.stringify(name.toLowerCase()) + ');');
  if (!picked) {
    await press(session, buttonByText('Cancel'));
    return false;
  }
  await press(session, "return document.querySelector('input[type=radio][value=" + level + "]').closest('label')");
  await press(session, buttonByText('Add'));
  await sleep(1000);
  return true;
}

async function startStep(session, ctx) {
  await session.navigate(OVERVIEW_URL);
  const page = await readPage(session);
  if (EDITOR_HEADING.test(page.heading)) return result('start', 'done', 'manual profile chosen');
  if (!/Grow your brand/.test(page.heading)) return result('start', 'unmapped', 'overview shows ' + page.heading.slice(0, 80));
  if (!ctx.apply) return result('start', 'filled', 'dry run: would choose to fill out the profile manually');
  await press(session, "return document.querySelector('[data-testid=fill-out-manually-button]')");
  await press(session, "return document.querySelector('[data-testid=continue-button]')");
  await sleep(4000);
  const after = await readPage(session);
  return EDITOR_HEADING.test(after.heading) ? result('start', 'done', 'chose the manual profile') : result('start', 'unmapped', 'after choosing manual the page shows ' + after.heading.slice(0, 80));
}

async function profileStep(session, ctx) {
  const { instance, apply } = ctx;
  const p = instance.profile ?? {};
  const want = { name: displayName(p), title: titleOf(instance), about: aboutOf(p), languages: languagesOf(p), level: skillLevel(instance) };
  const bad = gateTexts([want.title, want.about], ctx);
  if (bad.length) return result('profile', 'needs-operator', 'the gate refused profile copy: ' + bad.join('; '));
  let page = await readPage(session);
  if (!EDITOR_HEADING.test(page.heading)) {
    await session.navigate(OVERVIEW_URL);
    page = await readPage(session);
    if (!EDITOR_HEADING.test(page.heading)) return result('profile', 'unmapped', 'the profile editor is not open (' + page.heading.slice(0, 60) + ')');
  }
  const seen = parseProfileText(page.text);
  const todo = unsetFields(want, page, seen);
  const candidates = skillCandidates(p);
  const missingSkills = candidates.filter((c) => !seen.skills.some((s) => s.toLowerCase() === c.toLowerCase()));
  const photoFile = instance.config?.onboarding?.photo ?? null;
  const notes = [];
  if (!want.name) notes.push('profile.person.nameEn does not fit 3 to 15 characters');
  if (!want.about) notes.push('profile.summary_en does not fit 150 to 600 characters');
  if (!apply) return result('profile', todo.length || missingSkills.length ? 'filled' : 'done', 'dry run: would set ' + (todo.concat(missingSkills.length ? ['up to ' + missingSkills.length + ' skill candidate(s)'] : []).join(', ') || 'nothing') + (notes.length ? '; ' + notes.join('; ') : ''));
  if (todo.includes('display name')) await setInline(session, 'Add display name', want.name);
  if (todo.includes('title')) await setInline(session, 'Add title', want.title);
  if (todo.includes('languages')) await setLanguages(session, want.languages);
  if (todo.includes('about')) {
    const sel = 'textarea[placeholder^="Share some details"]';
    if (!(await session.evaluate((sel) => !!document.querySelector(sel), sel))) await press(session, buttonByText('Add details'));
    await session.fill(sel, want.about);
    await session.press('Tab');
    await sleep(1500);
  }
  const added = [];
  for (const name of missingSkills) {
    try {
      if (await addSkill(session, name, want.level)) added.push(name);
    } catch (err) {
      if (err.code === 'FSW_PACING_LIMIT') break;
      throw err;
    }
  }
  let photo = 'set';
  const hasPhotoInput = await session.evaluate(() => !!document.querySelector('input[name="profile[image]"]'));
  const photoMissing = /profile picture/.test(parseProfileText((await readPage(session)).text).missing ?? '');
  if (photoMissing || (!page.photo && hasPhotoInput)) {
    if (!photoFile) photo = 'missing';
    else {
      await session.evaluate(() => Object.assign(document.querySelector('input[name="profile[image]"]').style, { display: 'block', width: '200px', height: '30px', opacity: '1' }));
      await session.setFiles('input[name="profile[image]"]', photoFile);
      await sleep(4000);
      const crop = await session.evaluate(() => [...document.querySelectorAll('button')].filter((b) => b.offsetWidth).map((b) => b.innerText.trim()).find((t) => /^(Save|Apply|Done|Upload)$/.test(t)) ?? null);
      if (crop) await press(session, buttonByText(crop));
      photo = 'uploaded';
    }
  }
  const after = await readPage(session);
  const seenAfter = parseProfileText(after.text);
  const left = unsetFields(want, after, seenAfter);
  if (!seenAfter.skills.length) left.push('skills');
  if (seenAfter.missing) left.push('page still asks for: ' + seenAfter.missing);
  const detail = 'skills added: ' + (added.join(', ') || 'none') + '; photo ' + photo + (left.length ? '; not set: ' + left.join(', ') : '');
  if (added.length || todo.length) ctx.ledger?.addEvent({ kind: 'platform.profile_edit', platform: 'fiverr', ref: 'profile', payload: { fields: todo, skills: added } });
  if (photo === 'missing') return result('profile', 'needs-operator', detail + '; set onboarding.photo to a public photo of the operator');
  return result('profile', left.length ? 'needs-operator' : 'done', detail);
}

// Presses Continue and reports where the page lands. Steps that need the operator are named, never filled.
const OPERATOR_PAGE = /phone|sms|verification code|verify your identity|selfie|government id|payment method|tax|w-8|w-9|payoneer|paypal/i;
async function continueStep(session, ctx) {
  const page = await readPage(session);
  if (!ctx.apply) return result('continue', 'filled', 'dry run: would press Continue from ' + new URL(page.url).pathname);
  const missing = parseProfileText(page.text).missing;
  if (missing) return result('continue', 'needs-operator', 'Continue is blocked until the page has: ' + missing);
  await press(session, "return document.querySelector('[data-testid=continue-button]')");
  await sleep(5000);
  const next = await readPage(session);
  const head = next.heading.slice(0, 120);
  if (OPERATOR_PAGE.test(head + ' ' + next.text.slice(0, 1500))) return result('continue', 'needs-operator', 'next page needs the operator: ' + new URL(next.url).pathname + ' ' + head);
  return result('continue', 'unmapped', 'landed on ' + new URL(next.url).pathname + ' (' + head + '), not mapped yet');
}

export async function onboard(session, ctx) {
  const out = [];
  const log = ctx.log ?? (() => {});
  const want = (id) => !ctx.step || ctx.step === id;
  for (const [id, fn] of [['start', startStep], ['profile', profileStep], ['continue', continueStep]]) {
    if (!want(id)) continue;
    let r;
    try {
      r = await fn(session, ctx);
    } catch (err) {
      // A human check is the operator's; a spent hourly action budget (each skill takes several
      // presses) leaves the rest to the next run, which reads the page and continues.
      if (err.code === 'FSW_FIVERR_CHALLENGE') r = result(id, 'needs-operator', err.message);
      else if (err.code === 'FSW_PACING_LIMIT') r = result(id, 'filled', 'stopped at the hourly action budget; rerun after an hour to continue');
      else throw err;
      out.push(r);
      log(id + ': ' + r.state + ' ' + r.detail);
      break;
    }
    out.push(r);
    log(id + ': ' + r.state + ' ' + r.detail);
    if (r.state !== 'done' && id === 'start' && ctx.apply) break;
  }
  return out;
}

