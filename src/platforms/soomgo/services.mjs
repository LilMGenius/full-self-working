// 숨고 service items at /profile/services. 숨고 sends a pro the customer requests whose answers match the
// items set on each offered service, so a service still marked 항목 미설정 receives no matched requests.
// The page and its item modal are read through DOM queries, never a whole-page snapshot, since one
// snapshot of a soomgo modal stalled the shared BrowserSkill extension (docs/NEGATIVE-CORPUS.md row 27).
// A row's own button reads "<service> 세부 항목 설정됨" or "<service> 항목 미설정", and a checkbox is
// addressed by its group heading and label. Each row also carries an unlabeled trash icon that deletes
// the service, so rows are opened only by their named button, which the read marks for the click.
import { AdapterRefusal } from '../kit.mjs';

const BASE = 'https://soomgo.com';
// In-page: offered services in page order, {ref, name, itemsSet}. On the live page (read 2026-10-26, fixture
// test/fixtures/surfaces/soomgo/services-page.json) a row is a plain div inside its list item, the service
// name followed by a p holding the state, and no row is a button or has a role. So a row is the innermost
// element whose text, or aria-label, reads "<service> 세부 항목 설정됨" or "<service> 항목 미설정"; ref is the
// selector of that element, which this read marks with data-fsw-service.
export const pageServiceRows = () => {
  const ROW = /^(.+?) (세부 항목 설정됨|항목 미설정)$/;
  const textOf = (e) => (e.getAttribute('aria-label') || e.innerText || '').replace(/\s+/g, ' ').trim();
  const rows = [];
  for (const e of (document.body ?? document).querySelectorAll('*')) {
    const m = textOf(e).match(ROW);
    if (!m || [...(e.children ?? [])].some((c) => ROW.test(textOf(c)))) continue;
    e.setAttribute('data-fsw-service', String(rows.length));
    rows.push({ ref: '[data-fsw-service="' + rows.length + '"]', name: m[1], itemsSet: m[2] === '세부 항목 설정됨' });
  }
  return rows;
};

// In-page: the open item modal, null when none is open. The modal is the nearest box around its visible
// 저장하기 button that holds checkboxes, so the services page behind it is never read. Its first heading
// is the service; each checkbox belongs to the last heading before it and is named by its label.
export const pageItemModal = () => {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const save = [...document.querySelectorAll('button')].find((b) => shown(b) && b.innerText.trim() === '저장하기');
  if (!save) return null;
  let box = save.parentElement;
  while (box && !box.querySelector('input[type=checkbox]')) box = box.parentElement;
  if (!box) return null;
  save.setAttribute('data-fsw', 'item-save');
  let title = null;
  let heading = null;
  const groups = [];
  let n = 0;
  for (const el of box.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],input[type=checkbox]')) {
    if (el.tagName !== 'INPUT') {
      heading = el.innerText.trim();
      title ??= heading;
      continue;
    }
    const tag = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    el.setAttribute('data-fsw-item', String(n));
    if (groups.at(-1)?.heading !== heading) groups.push({ heading, options: [] });
    groups.at(-1).options.push({ ref: '[data-fsw-item="' + n + '"]', label: tag ? tag.innerText.trim() : '', checked: el.checked });
    n += 1;
  }
  return { title, groups, save: { ref: '[data-fsw="item-save"]', disabled: save.disabled } };
};

// wanted is {heading: [label]}. Returns the wanted options still unchecked and every wanted option the
// modal does not show, which callers refuse on, since it means 숨고 renamed an item.
export function planItems(modal, wanted) {
  const clicks = [];
  const missing = [];
  for (const [heading, labels] of Object.entries(wanted ?? {})) {
    const group = modal?.groups.find((g) => g.heading === heading);
    for (const label of labels) {
      const option = group?.options.find((o) => o.label === label);
      if (!option) missing.push({ heading, label });
      else if (!option.checked) clicks.push({ heading, label });
    }
  }
  return { clicks, missing };
}

// In-page: ticks one unchecked box by clicking its label, since a click at the input's coordinates does
// not reach these inputs. Headings and boxes come back in document order, so a box belongs to the last
// heading before it.
const pageTick = ({ heading, label }) => {
  let current = null;
  for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],input[type=checkbox]')) {
    if (el.tagName !== 'INPUT') {
      current = el.innerText.trim();
      continue;
    }
    const tag = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (current === heading && tag?.innerText.trim() === label) {
      if (!el.checked) tag.click();
      return el.checked;
    }
  }
  return null;
};

const pageSave = () => {
  const button = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '저장하기');
  if (!button || button.disabled) return false;
  button.click();
  return true;
};

// The list renders after the page loads, so the read polls the DOM once a second for up to
// SERVICES_WAIT_MS instead of trusting a fixed settle. A pro on soomgo offers at least one service, so a page
// that never shows a row was not read: an empty list would report every offered service as set. It is a
// refusal the caller reports by name.
export const SERVICES_WAIT_MS = 20_000;

export async function readServices(s, { wait = (ms) => new Promise((r) => setTimeout(r, ms)), waitMs = SERVICES_WAIT_MS } = {}) {
  await s.navigate(`${BASE}/profile/services`, { settle: 0 });
  for (let waited = 0; ; waited += 1000) {
    const rows = await s.evaluate(pageServiceRows);
    if (rows.length) return rows;
    if (waited >= waitMs) throw new AdapterRefusal('FSW_SERVICES_UNREAD', 'no offered service row was found on /profile/services within ' + waitMs / 1000 + ' s');
    await wait(1000);
  }
}

async function openModal(s, name, wait) {
  const rows = await readServices(s);
  const row = rows.find((r) => r.name === name);
  if (!row) throw new AdapterRefusal('FSW_SERVICE_NOT_OFFERED', `${name} is not an offered service (${rows.map((r) => r.name).join(', ')})`);
  await s.click(row.ref);
  await wait(3000);
  const modal = await s.evaluate(pageItemModal);
  if (modal?.title !== name) throw new AdapterRefusal('FSW_ITEM_MODAL', `the item modal for ${name} did not open`);
  return { row, modal };
}

const describe = (items) => items.map((i) => i.heading + ' / ' + i.label).join('; ');

// In-page: clicks the visible button whose text is exactly label; false when there is none.
const pageClickButton = (label) => {
  const button = [...document.querySelectorAll('button')].find((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && b.innerText.replace(/\s+/g, ' ').trim() === label;
  });
  if (!button) return false;
  button.click();
  return true;
};

// Adds a service to the offered ones from the 서비스 추가 modal: its top-level category tab (외주 for
// outsourcing work), then the service's own button, which only marks it, then 등록하기, which registers
// every marked service. The modal lists every soomgo service, and a full snapshot of it stalled the
// browser extension for minutes on 2026-10-25, so inside it buttons are found and clicked by their text
// in the page. A dry run finds the service's button and reloads the page, which adds nothing. A real run
// marks it, registers it and reports whether the services page then lists the service; its request
// items are set afterwards with setServiceItems, from a modal that exists only once the service is
// offered.
export async function addService(s, name, { category = '외주', dryRun = false, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const rows = await readServices(s);
  if (rows.some((r) => r.name === name)) return { name, changed: false };
  s.guard?.beforeAction();
  if (!(await s.evaluate(pageClickButton, '서비스 추가'))) throw new AdapterRefusal('FSW_EDITOR_MISSING', 'no 서비스 추가 button on the services page');
  await wait(2500);
  if (!(await s.evaluate(pageClickButton, category))) {
    await s.navigate(`${BASE}/profile/services`);
    throw new AdapterRefusal('FSW_EDITOR_MISSING', `no ${category} category in the add-service modal`);
  }
  await wait(2500);
  const found = await s.evaluate((label) => [...document.querySelectorAll('button')].some((b) => b.innerText.replace(/\s+/g, ' ').trim() === label && b.getBoundingClientRect().width > 0), name);
  if (!found) {
    await s.navigate(`${BASE}/profile/services`);
    throw new AdapterRefusal('FSW_SERVICE_UNKNOWN', `${category} has no service named ${name}`);
  }
  if (dryRun) {
    await s.navigate(`${BASE}/profile/services`);
    return { name, changed: true, saved: false, dryRun };
  }
  s.guard?.beforeAction();
  await s.evaluate(pageClickButton, name);
  await wait(1500);
  s.guard?.beforeAction();
  if (!(await s.evaluate(pageClickButton, '등록하기'))) {
    await s.navigate(`${BASE}/profile/services`);
    throw new AdapterRefusal('FSW_EDITOR_MISSING', 'no 등록하기 button in the add-service modal');
  }
  await wait(3500);
  const after = await readServices(s);
  return { name, changed: true, saved: after.some((r) => r.name === name) };
}

// Adds the wanted items to one offered service and leaves every other item as it was. Escape does not
// close this modal, so it is discarded by loading the services page again, which saves nothing; a dry
// run ends that way after ticking the boxes and reading them back. A real run saves, then reopens the
// modal and reports what 숨고 kept. Ticks change only page state, so the pacing guard counts the loads,
// the row clicks and the save, which are what the server sees.
export async function setServiceItems(s, name, wanted, { dryRun = false, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let { row, modal } = await openModal(s, name, wait);
  const plan = planItems(modal, wanted);
  const discard = () => s.navigate(`${BASE}/profile/services`);
  if (plan.missing.length) {
    await discard();
    throw new AdapterRefusal('FSW_ITEM_MISSING', `${name} shows no item ${describe(plan.missing)}`);
  }
  for (const item of plan.clicks) {
    await s.evaluate(pageTick, item);
    await wait(500);
  }
  modal = await s.evaluate(pageItemModal);
  const left = planItems(modal, wanted).clicks;
  const report = { name, wasSet: row.itemsSet, ticked: plan.clicks.length };
  if (left.length) {
    await discard();
    throw new AdapterRefusal('FSW_ITEM_UNCHECKED', `${name}: still unchecked after ticking: ${describe(left)}`);
  }
  if (dryRun || !plan.clicks.length) {
    await discard();
    return { ...report, saved: false, dryRun };
  }
  s.guard?.beforeAction();
  if (!(await s.evaluate(pageSave))) {
    await discard();
    throw new AdapterRefusal('FSW_ITEM_SAVE', `${name}: the save button is missing or disabled`);
  }
  await wait(3000);
  ({ row, modal } = await openModal(s, name, wait));
  const kept = planItems(modal, wanted);
  await discard();
  return { ...report, saved: row.itemsSet && !kept.clicks.length && !kept.missing.length, itemsSet: row.itemsSet, notKept: describe(kept.clicks) || null, observed: true };
}

