// 숨고 service items at /profile/services. 숨고 sends a pro the customer requests whose answers match the
// items set on each offered service, so a service still marked 항목 미설정 receives no matched requests.
// The page and its item modal are read from the accessibility snapshot, where every row and checkbox
// has a name, and a checkbox is addressed by its group heading and label. Each row also carries an
// unlabeled trash icon that deletes the service, so rows are opened only by their named button.
import { AdapterRefusal } from '../kit.mjs';

const BASE = 'https://soomgo.com';
const ROW = /^\s*(@e\d+) button "(.+?) (세부 항목 설정됨|항목 미설정)"/;
const HEADING = /^\s*heading "(.+)"\s*$/;
const CHECKBOX = /^\s*(@e\d+) checkbox "(.+?)"(?: \[ctx:.*?\])? \[(checked|unchecked)\]/;
const SAVE = /^\s*(@e\d+) button "저장하기"( \[disabled\])?/;

// Offered services in page order: {ref, name, itemsSet}.
export function parseServiceRows(text) {
  return String(text ?? '').split('\n').map((l) => l.match(ROW)).filter(Boolean).map(([, ref, name, state]) => ({ ref, name, itemsSet: state === '세부 항목 설정됨' }));
}

// The open item modal: its title (the service), checkbox groups under their headings and the save
// button; null when no modal layer is open.
export function parseItemModal(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => /^L\d+ modal\b/.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^L\d+ /.test(l));
  let title = null;
  let heading = null;
  let save = null;
  const groups = [];
  for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
    const h = line.match(HEADING);
    if (h) {
      title ??= h[1];
      heading = h[1];
      continue;
    }
    const c = line.match(CHECKBOX);
    if (c) {
      if (groups.at(-1)?.heading !== heading) groups.push({ heading, options: [] });
      groups.at(-1).options.push({ ref: c[1], label: c[2], checked: c[3] === 'checked' });
      continue;
    }
    const sv = line.match(SAVE);
    if (sv) save = { ref: sv[1], disabled: Boolean(sv[2]) };
  }
  return { title, groups, save };
}

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

const snapText = async (s) => {
  const snap = await s.snapshot({ interactive: false });
  return typeof snap === 'string' ? snap : snap.text;
};

export async function readServices(s) {
  await s.navigate(`${BASE}/profile/services`);
  return parseServiceRows(await snapText(s));
}

async function openModal(s, name, wait) {
  const rows = await readServices(s);
  const row = rows.find((r) => r.name === name);
  if (!row) throw new AdapterRefusal('FSW_SERVICE_NOT_OFFERED', `${name} is not an offered service (${rows.map((r) => r.name).join(', ')})`);
  await s.click(row.ref);
  await wait(3000);
  const modal = parseItemModal(await snapText(s));
  if (modal?.title !== name) throw new AdapterRefusal('FSW_ITEM_MODAL', `the item modal for ${name} did not open`);
  return { row, modal };
}

const describe = (items) => items.map((i) => i.heading + ' / ' + i.label).join('; ');

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
  modal = parseItemModal(await snapText(s));
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

