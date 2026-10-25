// Shared by the platform onboarding scripts that fsw onboard runs (src/cli/onboard.mjs holds the
// interface). Pages are read and clicked through DOM queries, never a whole-page snapshot, since one
// stalled page stalls the BrowserSkill extension every agent shares (docs/DESIGN.md, Browser).

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

// A typeahead or plain text field: click it in view so it takes focus, then type the text key by key.
export async function typeInto(session, selector, text) {
  if (!(await clickVisible(session, selector))) throw new Error('no field ' + selector);
  await session.typeKeys(selector, text);
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

