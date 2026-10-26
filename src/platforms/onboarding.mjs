// Shared by the platform onboarding scripts that fsw onboard runs (src/cli/onboard.mjs holds the
// interface). Pages are read and clicked through DOM queries, never a whole-page snapshot, since one
// stalled page stalls the BrowserSkill extension every agent shares (docs/DESIGN.md, Browser).
import { existsSync, readFileSync } from 'node:fs';
import { gateOutbound } from '../policy/gate.mjs';
import { challengeOf } from './kit.mjs';

export const STATES = ['done', 'filled', 'needs-operator', 'unmapped'];
export const result = (step, state, detail = '') => ({ step, state, detail });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A match is an exact string (case and spacing ignored) or a RegExp; it crosses into the page as data.
export const matchSpec = (m) => (m instanceof RegExp ? { re: m.source, flags: m.flags } : { exact: String(m) });

// Runs in the page. Tags the first element under selector, inside the first element of within whose box
// sits in the viewport (an onboarding carousel keeps every slide in the DOM, off to the side), whose
// text matches; scrolls it to the middle, since a fixed footer covers the bottom of the page and a click
// there lands on the footer. Returns whether one was found.
export function markInPage({ selector, spec, token, within }) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const onScreen = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.right > 0 && r.left < innerWidth;
  };
  const roots = within ? [...document.querySelectorAll(within)].filter(onScreen) : [document];
  const test = spec.exact !== undefined ? (t) => norm(t) === norm(spec.exact) : (t) => new RegExp(spec.re, spec.flags).test(String(t ?? '').trim());
  for (const root of roots) {
    // Only a rendered target counts: a hidden twin with the same text (freelancer keeps a hidden
    // social sign-in button) would open the wrong flow.
    const shown = (e) => e.getBoundingClientRect().width > 0 && (e.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true);
    const el = [...root.querySelectorAll(selector)].find((e) => shown(e) && test(e.innerText ?? e.textContent));
    if (el) {
      el.setAttribute('data-fsw-mark', token);
      el.scrollIntoView({ block: 'center' });
      return true;
    }
  }
  return false;
}

let marks = 0;
export async function clickMatch(session, selector, match, { within = null } = {}) {
  const token = 'm' + ++marks;
  const found = await session.evaluate(markInPage, { selector, spec: matchSpec(match), token, within });
  if (!found) return false;
  await session.click('[data-fsw-mark="' + token + '"]');
  return true;
}

// Clicks the first visible element of selector after scrolling it to the middle; false when there is none.
export async function clickVisible(session, selector) {
  return clickMatch(session, selector, /[\s\S]*/);
}

// A typeahead or plain text field: click it in view so it takes focus, then type the text key by key. A
// dialog still animating in refuses focus, so the click and focus are tried three times a second apart.
export async function typeInto(session, selector, text) {
  for (let attempt = 1; ; attempt++) {
    try {
      if (!(await clickVisible(session, selector))) throw new Error('no field ' + selector);
      return await session.typeKeys(selector, text);
    } catch (err) {
      if (attempt >= 3) throw new Error(selector + ': ' + err.message);
      await sleep(1000);
    }
  }
}

// A dropdown whose menu lists role=option items: open it, then click the item with this text.
export async function pickOption(session, toggle, text) {
  if (!(await clickVisible(session, toggle))) throw new Error('no dropdown ' + toggle);
  await sleep(500);
  if (!(await clickMatch(session, '[role=option]', text))) throw new Error('dropdown ' + toggle + ' lists no ' + text);
}

// Polls a page function until it returns something truthy, or returns null after timeoutMs.
export async function waitFor(session, fn, arg, { timeoutMs = 15000, everyMs = 700 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await session.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() > until) return null;
    await sleep(everyMs);
  }
}

// What an unmapped page shows, for the step report: headings, buttons and form fields without values.
export function pageOutline() {
  const txt = (e) => String(e.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.right > 0 && r.left < innerWidth;
  };
  return {
    url: location.href,
    title: document.title,
    headings: [...document.querySelectorAll('h1,h2,h3,legend')].filter(vis).map(txt).filter(Boolean).slice(0, 8),
    buttons: [...document.querySelectorAll('button')].filter(vis).map(txt).filter(Boolean).slice(0, 15),
    fields: [...document.querySelectorAll('input,textarea,select')].filter(vis).filter((e) => e.type !== 'hidden').map((e) => [e.tagName.toLowerCase(), e.type, e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.name || e.placeholder, e.getAttribute('data-test') || e.getAttribute('data-qa') || ''].join(':')).slice(0, 20),
    text: String(document.querySelector('main')?.innerText ?? document.body.innerText).replace(/\s+/g, ' ').trim().slice(0, 700),
  };
}

export const pathOf = (url) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
};


// A step whose instance values cannot be typed says what the operator must change instead.
export class Needs {
  constructor(message) {
    this.message = message;
  }
}
export const needs = (message) => new Needs(message);

// Text a profile shows passes the outbound gate first; a refusal is the operator's to fix in the instance.
export function gated(ctx, text, key) {
  if (!text || !String(text).trim()) return key + ' is empty';
  const g = gateOutbound({ kind: 'profile', platform: ctx.descriptor.id, text }, { descriptor: ctx.descriptor, instance: ctx.instance });
  return g.ok ? null : key + ' refused by the gate: ' + g.violations.map((v) => v.rule + ' ' + v.detail).join('; ');
}

// A wizard is { name, steps: [{id, detect: {heading}}], handlers: {id: handler}, startUrl, stepUrl(id)
// or null when the wizard cannot open a step by URL, stepOfUrl(url) -> id, or null once the wizard has
// left its pages, describe(want), advance(session, id) -> clicks the step's next control }.
// A handler is { read(s), want(ctx) -> value or Needs, same(cur, want), write(s, want, cur, ctx),
// saves (its dialog saves at once, so a dry run only describes it), pending(s) -> what the operator
// still has to fill on this page, next(s) -> a custom next control }.
export async function runStep(session, id, ctx, wiz) {
  const h = wiz.handlers[id];
  const want = h.want(ctx);
  if (want instanceof Needs) return result(id, 'needs-operator', want.message);
  // A wizard renders a step a few seconds after its URL changes; read it only once its heading shows.
  const heading = wiz.steps.find((s) => s.id === id)?.detect.heading;
  if (heading && !(await waitFor(session, (spec) => [...document.querySelectorAll('h1,h2,h3,h4')].some((h) => h.getBoundingClientRect().width > 0 && new RegExp(spec.re, spec.flags).test(h.innerText)), { re: heading.source, flags: heading.flags }, { timeoutMs: 20000 }))) {
    return result(id, 'needs-operator', 'the ' + id + ' page did not show its heading within 20 s');
  }
  await sleep(1000);
  const cur = await h.read(session);
  if (h.same(cur, want)) return result(id, 'done', wiz.describe(want));
  if (!h.write) return result(id, 'needs-operator', 'no writer for this step');
  if (h.saves && !ctx.apply) return result(id, 'filled', 'dry run, not typed since its dialog saves at once: ' + wiz.describe(want));
  try {
    await h.write(session, want, cur, ctx);
  } catch (err) {
    return result(id, 'needs-operator', err.message);
  }
  await sleep(800);
  const back = await h.read(session);
  if (h.same(back, want)) return result(id, 'filled', wiz.describe(want));
  // A step that holds private values says which fields differ, never their values.
  return result(id, 'needs-operator', h.show ? h.show(back, want) : 'read back ' + JSON.stringify(back) + ' instead of ' + JSON.stringify(want));
}

async function advance(session, id, wiz) {
  const before = await session.evaluate(() => location.href);
  if (wiz.handlers[id].next) await wiz.handlers[id].next(session);
  else await wiz.advance(session, id);
  const moved = await waitFor(session, (u) => location.href !== u && location.href, before, { timeoutMs: 20000 });
  await sleep(1500);
  // A wizard may pass through a page that redirects at once (freelancer's profile-completion-choice
  // opened photo-and-name on 2026-10-26), so the step is the page it settled on.
  return moved && (await session.evaluate(() => location.href));
}

// Walks the wizard from wherever it opens: each known step is read, compared and, when it differs,
// typed and read back; under ctx.apply the step's next control saves it and the walk goes on. A dry run
// saves nothing, so it goes past a step only when that step already holds the instance's values and the
// wizard can open the next one by URL.
export async function walkWizard(session, ctx, wiz) {
  const log = ctx.log ?? (() => {});
  const results = [];
  const only = ctx.step ?? null;
  let url = await session.navigate(only && wiz.stepUrl ? wiz.stepUrl(only) : wiz.startUrl);
  for (let guard = 0; guard < 40; guard++) {
    let blocked = await pageBlock(session, wiz.name);
    // Under --apply a wizard that knows its sign-in signs in once, then opens the wizard again.
    if (blocked && ctx.apply && wiz.signIn && !results.some((r) => r.step === 'sign-in') && SIGN_IN_PATH.test(pathOf(url))) {
      try {
        await wiz.signIn(session, ctx);
        results.push(result('sign-in', 'filled', 'signed in to ' + wiz.name + ' with Google'));
        url = await session.navigate(only && wiz.stepUrl ? wiz.stepUrl(only) : wiz.startUrl);
        continue;
      } catch (err) {
        blocked = err.message;
      }
    }
    if (blocked) {
      results.push(result(only ?? 'login', 'needs-operator', blocked));
      break;
    }
    const id = wiz.stepOfUrl(url);
    if (id === null) {
      results.push(result('submitted', 'done', wiz.name + ' now opens ' + pathOf(url) + ', so the wizard is finished'));
      break;
    }
    if (!(id in wiz.handlers)) {
      results.push(result(id, 'unmapped', JSON.stringify(await session.evaluate(pageOutline))));
      break;
    }
    if (results.some((r) => r.step === id)) break;
    if (only && id !== only) {
      results.push(result(only, 'needs-operator', wiz.name + ' opened ' + id + ' instead; the wizard opens a step only after the steps before it are saved'));
      break;
    }
    const r = await runStep(session, id, ctx, wiz);
    results.push(r);
    log(r.step + ': ' + r.state + (r.detail ? ' (' + r.detail + ')' : ''));
    // A site that signs the session out or shows a challenge mid-step ends the walk at once.
    const after = await pageBlock(session, wiz.name);
    if (after) {
      results.push(result(id, 'needs-operator', after));
      break;
    }
    if (r.state === 'needs-operator' || r.state === 'unmapped' || only) break;
    // A final step (the submit button) leaves the wizard itself, so nothing follows it.
    if (wiz.handlers[id].final) break;
    const pending = wiz.handlers[id].pending ? await wiz.handlers[id].pending(session) : null;
    if (pending) {
      results.push(result(id, 'needs-operator', pending));
      log(id + ': needs-operator (' + pending + ')');
      break;
    }
    if (!ctx.apply) {
      const nextId = wiz.steps[wiz.steps.findIndex((s) => s.id === id) + 1]?.id;
      if (r.state !== 'done' || !nextId || !wiz.stepUrl) break;
      url = await session.navigate(wiz.stepUrl(nextId));
      continue;
    }
    url = await advance(session, id, wiz);
    if (!url) {
      results.push(result(id, 'needs-operator', 'next did not leave ' + id + '; the page may show a validation message'));
      break;
    }
  }
  return results;
}


// A sign-in or bot-challenge page is never the end of a wizard: the site signed the operator out or
// wants a person. Returns what the operator must do, or null.
export const SIGN_IN_PATH = /\/(?:login|signin|sign-in|ab\/account-security\/login)\b/i;
export function blockOf({ url = '', title = '', text = '' } = {}, name = 'the site') {
  if (SIGN_IN_PATH.test(pathOf(url))) return 'sign in to ' + name + ' in Chrome; ' + pathOf(url) + ' opened instead of the wizard, so the walk stopped';
  const challenge = challengeOf({ title, text });
  if (challenge) return name + ' showed a ' + challenge + ' challenge; solve it in Chrome before the next run';
  return null;
}
export async function pageBlock(session, name) {
  const page = await session.evaluate(() => ({ url: location.href, title: document.title, text: String(document.body?.innerText ?? '').slice(0, 3000) }));
  return blockOf(page ?? {}, name);
}

// Wraps a driver session so every action waits a random human-scale gap first and typing is paced
// key by key (descriptor onboardingPacing.actionGapMs and keyGapMs, [min, max] in milliseconds).
// Mapped 2026-10-26: upwork, freelancer and wishket signed the operator out after onboarding scripts
// clicked and typed at machine speed, while sites polled at a slow pace stayed signed in.
export function humanize(session, { actionGapMs = [0, 0], keyGapMs = [0, 0] } = {}, { wait = sleep, random = Math.random } = {}) {
  const pick = ([lo, hi]) => Math.round(lo + random() * (hi - lo));
  const paced = (name) => async (...args) => {
    await wait(pick(actionGapMs));
    return session[name](...args);
  };
  return Object.assign(Object.create(session), {
    click: paced('click'),
    fill: paced('fill'),
    press: paced('press'),
    setFiles: paced('setFiles'),
    async typeKeys(target, text) {
      await wait(pick(actionGapMs));
      return session.typeKeys(target, text, { keyGapMs: pick(keyGapMs) });
    },
  });
}


// The operator's private identity for payout and verification forms, read from the JSON file that
// config.onboarding.identity names (kept outside the repository): {person: {date_of_birth, phone},
// business: {address_en: {street, unit, city, region, postal_code, country}}}. Its values are typed
// into a platform's private fields only and never appear in a step report or a log.
export function readIdentity(ctx) {
  const file = ctx.instance.config?.onboarding?.identity;
  if (!file || !existsSync(file)) return needs('set config onboarding.identity to the identity JSON file (date of birth, phone, address), or fill those fields yourself');
  const { person = {}, business: org = {} } = JSON.parse(readFileSync(file, 'utf8'));
  const a = org.address_en ?? {};
  const phone = String(person.phone ?? '');
  const missing = [['date of birth', person.date_of_birth], ['phone', phone], ['street', a.street], ['city', a.city], ['postal code', a.postal_code], ['country', a.country]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return needs('the identity file lacks ' + missing.join(', '));
  const cc = /^\+(\d{1,3})[\s-]/.exec(phone)?.[1] ?? null;
  return {
    googleEmail: person.google_login_email ?? null,
    legalNameEn: person.legal_name_en ?? null,
    dateOfBirth: person.date_of_birth,
    phone,
    countryCode: cc,
    // The number after the country code, without the trunk 0 a national number starts with.
    nationalNumber: (cc ? phone.slice(cc.length + 1) : phone).replace(/\D/g, '').replace(/^0/, ''),
    address: { street: a.street, unit: a.unit ?? '', city: a.city, region: a.region ?? '', postalCode: String(a.postal_code), country: a.country },
  };
}


// Google sign-in through a site's "Continue with Google" button, mapped on upwork 2026-10-26: the
// button opens Google's account chooser as a popup outside the agent window, which the driver claims
// with a tab borrow (the daemon may ask the operator to allow it). The chooser lists one element per
// signed-in account with data-identifier set to its email; picking one closes the popup and posts the
// token to the page that opened it, so that page must stay open in the same session until it leaves
// the sign-in path. A password or second-factor prompt is the operator's.
export async function googleSignIn(session, { button, framed = false, email, timeoutMs = 60000, wait = sleep }) {
  if (!email) throw new Error('no Google account to sign in with; set person.google_login_email in the identity file');
  // A site that renders Google's own button (an accounts.google.com/gsi/button iframe) is clicked
  // through the semantic tree, where the frame's button names the account; a text match on the page
  // can hit a hidden button of another provider.
  const pressed = framed ? await clickObserved(session, new RegExp('button "[^"]*' + escapeRe(email))) : await clickMatch(session, 'button, a, [role=button]', button);
  if (!pressed) throw new Error('no Google sign-in button on ' + (await session.evaluate(() => location.pathname)));
  const bsk = session.session;
  let tab = null;
  for (let i = 0; i < 15 && !tab; i++) {
    await wait(1000);
    tab = (await bsk.tabList({ scope: 'all' })).tabs.find((t) => /^https:\/\/accounts\.google\.com\//.test(t.url)) ?? null;
  }
  // A button that already names the account may sign in without showing the chooser.
  if (!tab && !SIGN_IN_PATH.test(await session.evaluate(() => location.pathname))) return session.evaluate(() => location.pathname);
  if (!tab) throw new Error('the Google account chooser did not open');
  if (tab.scope !== 'agent') await bsk.tabBorrow(tab.tab_id, { confirmationTimeoutMs: 180000 });
  const inTab = async (fn, arg) => {
    const r = await bsk.evaluate('Promise.resolve((' + fn + ')(' + JSON.stringify(arg ?? null) + ')).then((v) => JSON.stringify(v === undefined ? null : v))', { tabId: tab.tab_id, awaitPromise: true, returnByValue: true, timeoutMs: 15000 });
    return JSON.parse(r?.value ?? r?.result ?? 'null');
  };
  const chooser = await inTab(() => ({ accounts: [...document.querySelectorAll('[data-identifier]')].map((e) => e.getAttribute('data-identifier')), password: !!document.querySelector('input[type=password]') }));
  if (chooser.password || !chooser.accounts.includes(email)) throw new Error('Google asked for a password or does not list ' + email + '; sign in to Google in Chrome first');
  // The chooser ignores a synthetic click on its row, so the row is clicked through the tree too.
  if (!(await clickObserved(session, new RegExp(escapeRe(email)), { tabId: tab.tab_id }))) throw new Error('the chooser row for the account was not clickable');
  // A first sign-in to a site shows a consent page with a Continue button before the popup closes.
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await wait(2000);
    const path = await session.evaluate(() => location.pathname);
    if (!SIGN_IN_PATH.test(path)) return path;
    const open = (await bsk.tabList({ scope: 'all' })).tabs.some((t) => t.tab_id === tab.tab_id && /accounts\.google\.com\/(?:signin|v3)/.test(t.url));
    if (open) await inTab(() => [...document.querySelectorAll('button')].find((b) => /^(Continue|계속)$/.test(b.innerText.trim()))?.click()).catch(() => null);
  }
  throw new Error('the site still shows its sign-in page after the Google account was picked');
}


// The upwork date picker (air3-datepicker), mapped 2026-10-26: its trigger opens a month grid whose
// month-year button swaps it for a month list and a year list (each item's text is the month name or
// the year) and an Apply button; each day is a button whose text starts with its full date, such as
// "Thursday, August 03, 2000". The text input itself takes no typing (inputmode none).
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const dayLabel = (ymd) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return MONTH_NAMES[m - 1] + ' ' + String(d).padStart(2, '0') + ', ' + y;
};
export async function pickDate(session, trigger, ymd, { picker = '.air3-datepicker' } = {}) {
  const [y, m] = String(ymd).split('-').map(Number);
  if (!(await clickVisible(session, trigger))) throw new Error('no date picker trigger ' + trigger);
  await sleep(1200);
  if (!(await clickVisible(session, picker + ' [data-test=month-year-selector-btn]'))) throw new Error('the date picker has no month and year selector');
  await sleep(1200);
  const leaf = picker + ' li, ' + picker + ' [role=option], ' + picker + ' [role=menuitem], ' + picker + ' button, ' + picker + ' span';
  if (!(await clickMatch(session, leaf, String(y)))) throw new Error('the date picker lists no year ' + y);
  await sleep(800);
  if (!(await clickMatch(session, leaf, MONTH_NAMES[m - 1]))) throw new Error('the date picker lists no month ' + MONTH_NAMES[m - 1]);
  await sleep(800);
  await clickMatch(session, picker + ' button', 'Apply');
  await sleep(1200);
  const day = new RegExp('^\\w+, ' + dayLabel(ymd));
  if (!(await clickMatch(session, picker + ' button[data-test^=date-]', day))) throw new Error('the date picker shows no day ' + ymd);
}


// Clicks the first element of the engine's semantic tree (observe) whose line matches pattern. The tree
// reaches into cross-origin frames, where Google renders its sign-in button and where a DOM query
// cannot see, and gives refs the engine clicks as a person would. Mapped 2026-10-26 on freelancer:
// the button reads 'button "Continue as <name>, <email>. Opens in new tab"' inside the gsi iframe.
export async function clickObserved(session, pattern, { tabId, maxTokens = 3000 } = {}) {
  const tree = await session.session.observe({ tabId, maxTokens });
  const line = String(tree?.text ?? '').split(/\n/).find((l) => /@e\d+/.test(l) && pattern.test(l));
  const ref = line?.match(/@(e\d+)/)?.[1];
  if (!ref) return false;
  await session.session.click(ref, { tabId });
  return true;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

