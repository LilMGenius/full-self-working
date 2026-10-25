// Shared by the platform onboarding scripts that fsw onboard runs (src/cli/onboard.mjs holds the
// interface). Pages are read and clicked through DOM queries, never a whole-page snapshot, since one
// stalled page stalls the BrowserSkill extension every agent shares (docs/DESIGN.md, Browser).
import { gateOutbound } from '../policy/gate.mjs';

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
    const el = [...root.querySelectorAll(selector)].find((e) => e.getBoundingClientRect().width > 0 && test(e.innerText ?? e.textContent));
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
  return h.same(back, want) ? result(id, 'filled', wiz.describe(want)) : result(id, 'needs-operator', 'read back ' + JSON.stringify(back) + ' instead of ' + JSON.stringify(want));
}

async function advance(session, id, wiz) {
  const before = await session.evaluate(() => location.href);
  if (wiz.handlers[id].next) await wiz.handlers[id].next(session);
  else await wiz.advance(session, id);
  const moved = await waitFor(session, (u) => location.href !== u && location.href, before, { timeoutMs: 20000 });
  await sleep(1500);
  return moved;
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
    // A sign-in page is never the end of a wizard: the operator's session expired or never existed.
    if (/\/(?:login|signin|sign-in|ab\/account-security\/login)\b/i.test(pathOf(url))) {
      results.push(result(only ?? 'login', 'needs-operator', 'sign in to ' + wiz.name + ' in Chrome; ' + pathOf(url) + ' opened instead of the wizard'));
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
    if (r.state === 'needs-operator' || r.state === 'unmapped' || only) break;
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

