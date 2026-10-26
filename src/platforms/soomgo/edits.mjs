// 숨고 profile text the operator approved: the one-line intro (내 소개 편집, 한 줄 소개, at most 80 characters),
// a paragraph appended to the service detail (서비스 상세 설명) and saved quote templates (/mypage/quote-template:
// title at most 20 characters, description at most 1000, a cost and 총 비용 or 시간 당). Each write reads the
// current state first and writes nothing when it already holds the approved text. The forms validate on real
// key events and keep their save buttons disabled for values set by script, so text goes in through fill()
// and the reformatting cost input through typeKeys(). A dry run types, reads back and reloads the page,
// which keeps nothing; a real run saves and reads the saved value back.
import { AdapterRefusal } from '../kit.mjs';

const BASE = 'https://soomgo.com';
export const INTRO_MAX = 80;
export const TEMPLATE_TITLE_MAX = 20;
export const TEMPLATE_TEXT_MAX = 1000;
const DETAIL_SELECTOR = 'textarea[placeholder="최소 30자 이상 입력해 주세요"]';

// In-page: marks the visible button whose text is exactly label and returns its selector, or null. A DOM
// query, never a whole-page snapshot, which once stalled the shared BrowserSkill extension (corpus row 27).
export const pageMarkButton = (label) => {
  const button = [...document.querySelectorAll('button')].find((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && b.innerText.replace(/\s+/g, ' ').trim() === label;
  });
  if (!button) return null;
  button.setAttribute('data-fsw', 'edit-open');
  return '[data-fsw="edit-open"]';
};

// In-page: presses the visible button whose text is exactly label; false when there is none or it is disabled.
const pagePress = (label) => {
  const button = [...document.querySelectorAll('button')].find((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && b.innerText.trim() === label;
  });
  if (!button || button.disabled) return false;
  button.click();
  return true;
};
const pageValue = (selector) => document.querySelector(selector)?.value ?? null;

async function openByButton(s, url, label, wait) {
  await s.navigate(url);
  const ref = await s.evaluate(pageMarkButton, label);
  if (!ref) throw new AdapterRefusal('FSW_EDITOR_MISSING', `no ${label} button on ${url}`);
  await s.click(ref);
  await wait(3000);
}

async function press(s, label) {
  s.guard?.beforeAction();
  if (!(await s.evaluate(pagePress, label))) throw new AdapterRefusal('FSW_EDITOR_SAVE', `the ${label} button is missing or disabled`);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The new service detail: the current text with the paragraph after a blank line, or null when the text
// already holds the paragraph.
export function appendedDetail(current, paragraph) {
  const text = String(current ?? '');
  const add = String(paragraph ?? '').trim();
  if (!add) throw new RangeError('the paragraph to append is empty');
  return text.includes(add) ? null : (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + add;
}

export async function setIntro(s, intro, { dryRun = false, wait = pause } = {}) {
  if (intro.length > INTRO_MAX) throw new AdapterRefusal('FSW_LIMIT', `the intro has ${intro.length} characters, over ${INTRO_MAX}`);
  await openByButton(s, `${BASE}/profile`, '내 소개 편집', wait);
  const before = await s.evaluate(pageValue, 'textarea[name=introduce]');
  if (before === null) throw new AdapterRefusal('FSW_EDITOR_MISSING', 'the intro editor has no introduce field');
  if (before === intro) {
    await s.navigate(`${BASE}/profile`);
    return { part: 'intro', changed: false };
  }
  await s.fill('textarea[name=introduce]', intro);
  if ((await s.evaluate(pageValue, 'textarea[name=introduce]')) !== intro) throw new AdapterRefusal('FSW_READBACK', 'the intro field does not hold the typed text');
  if (dryRun) {
    await s.navigate(`${BASE}/profile`);
    return { part: 'intro', changed: true, saved: false, dryRun, before };
  }
  await press(s, '저장');
  await wait(3000);
  await openByButton(s, `${BASE}/profile`, '내 소개 편집', wait);
  const after = await s.evaluate(pageValue, 'textarea[name=introduce]');
  await s.navigate(`${BASE}/profile`);
  return { part: 'intro', changed: true, saved: after === intro, before };
}

export async function appendServiceDetail(s, paragraph, { dryRun = false, wait = pause } = {}) {
  await openByButton(s, `${BASE}/profile`, '서비스 상세 설명', wait);
  const before = await s.evaluate(pageValue, DETAIL_SELECTOR);
  if (before === null) throw new AdapterRefusal('FSW_EDITOR_MISSING', 'the service detail editor did not open');
  const next = appendedDetail(before, paragraph);
  if (next === null) {
    await s.navigate(`${BASE}/profile`);
    return { part: 'detail', changed: false };
  }
  await s.fill(DETAIL_SELECTOR, next);
  if ((await s.evaluate(pageValue, DETAIL_SELECTOR)) !== next) throw new AdapterRefusal('FSW_READBACK', 'the service detail does not hold the typed text');
  if (dryRun) {
    await s.navigate(`${BASE}/profile`);
    return { part: 'detail', changed: true, saved: false, dryRun, length: next.length };
  }
  await press(s, '저장하기');
  await wait(3000);
  await openByButton(s, `${BASE}/profile`, '서비스 상세 설명', wait);
  const after = await s.evaluate(pageValue, DETAIL_SELECTOR);
  await s.navigate(`${BASE}/profile`);
  return { part: 'detail', changed: true, saved: String(after).includes(String(paragraph).trim()), length: next.length };
}

const pageTemplateTitles = () => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,p,span')].map((e) => (e.childElementCount === 0 ? e.innerText.trim() : '')).filter(Boolean);

// template: {title, priceType: 'total' | 'hourly', costKRW, description}.
export async function addQuoteTemplate(s, template, { dryRun = false, wait = pause } = {}) {
  const { title, priceType, costKRW, description } = template;
  if (title.length > TEMPLATE_TITLE_MAX) throw new AdapterRefusal('FSW_LIMIT', `the template title has ${title.length} characters, over ${TEMPLATE_TITLE_MAX}`);
  if (description.length > TEMPLATE_TEXT_MAX) throw new AdapterRefusal('FSW_LIMIT', `the template text has ${description.length} characters, over ${TEMPLATE_TEXT_MAX}`);
  if (!Number.isInteger(costKRW) || costKRW <= 0) throw new AdapterRefusal('FSW_LIMIT', `the template cost must be a positive whole number of won, got ${costKRW}`);
  const url = `${BASE}/mypage/quote-template`;
  await s.navigate(url);
  if ((await s.evaluate(pageTemplateTitles)).includes(title)) return { part: 'template', title, changed: false };
  const add = await s.evaluate(pageMarkButton, '추가하기');
  if (!add) throw new AdapterRefusal('FSW_EDITOR_MISSING', 'no 추가하기 button on the quote template page');
  await s.click(add);
  await wait(3000);
  try {
    if (!(await s.evaluate(pagePress, priceType === 'hourly' ? '시간 당' : '총 비용'))) throw new AdapterRefusal('FSW_EDITOR_MISSING', 'the price type buttons are missing');
    await s.fill('input[name=title]', title);
    await s.typeKeys('input[name=cost]', String(costKRW));
    await s.fill('textarea[name=description]', description);
    await wait(1000);
    const form = await s.evaluate(() => ({ title: document.querySelector('input[name=title]')?.value, cost: document.querySelector('input[name=cost]')?.value, description: document.querySelector('textarea[name=description]')?.value, submit: document.querySelector('button[type=submit]')?.disabled === false }));
    if (form.title !== title || Number(String(form.cost).replace(/\D/g, '')) !== costKRW || form.description !== description) throw new AdapterRefusal('FSW_READBACK', 'the template form does not hold the typed values');
    if (!form.submit) throw new AdapterRefusal('FSW_EDITOR_SAVE', 'the template submit button stayed disabled');
    if (dryRun) return { part: 'template', title, changed: true, saved: false, dryRun };
    s.guard?.beforeAction();
    await s.evaluate(() => document.querySelector('button[type=submit]').click());
    await wait(3000);
  } finally {
    await s.navigate(url);
  }
  return { part: 'template', title, changed: true, saved: (await s.evaluate(pageTemplateTitles)).includes(title) };
}

