// 크몽 seller adapter on the operator's signed-in Chrome. Reads never change state: the inbox unread
// check flips the client-side 안읽음 filter, and a thread opens only when it is already read or the
// caller will reply in the same tick. send() types gated text, presses 전송 and reports success only
// when the thread shows the text as the newest outbound message.
import { openSession } from '../../browser/driver.mjs';
import { loadDescriptor } from '../registry.mjs';
import { AdapterRefusal, squash, toInt } from '../kit.mjs';
import { parseDashboard, parseGigList, parseInbox, parseListingForm, parseOrders, parseProfile, parseThread, ORDER_COUNTERS } from './parse.mjs';

const BASE = 'https://kmong.com';
const INBOX = `${BASE}/inboxes?inbox_group_id=&partner_id=`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- page-side extractors (serialised into the page; no closure over module scope) ----

function pageLogin() {
  const nickLink = [...document.querySelectorAll('a[href^="/@"]')].find((a) => a.innerText.includes('프로필 완성도'));
  return {
    url: location.href,
    avatar: !!document.querySelector('[data-testid=avatar]'),
    authSection: !!document.querySelector('[data-testid=authenticate-section]'),
    loginButton: [...document.querySelectorAll('a,button')].some((e) => e.innerText.trim() === '로그인'),
    sellerMode: document.querySelector('input[aria-label="전문가 모드"]')?.checked ?? null,
    profileHref: nickLink?.getAttribute('href') ?? null,
  };
}

function pageInboxRows() {
  return [...document.querySelectorAll('a[href*="inbox_group_id="]')].filter((a) => /inbox_group_id=\d+/.test(a.getAttribute('href'))).map((a) => ({
    href: a.getAttribute('href'),
    nickname: a.querySelector('.font-bold')?.innerText ?? '',
    time: a.querySelector('p[class*="typo-12"]')?.innerText ?? '',
    preview: a.querySelector('.truncate')?.innerText ?? '',
  }));
}

async function pageSelectTab(label) {
  const tab = [...document.querySelectorAll('button[aria-selected]')].find((b) => b.innerText.trim() === label);
  if (!tab) return { ok: false, reason: 'no tab ' + label };
  if (tab.getAttribute('aria-selected') !== 'true') tab.click();
  for (let i = 0; i < 20 && tab.getAttribute('aria-selected') !== 'true'; i++) await new Promise((r) => setTimeout(r, 150));
  await new Promise((r) => setTimeout(r, 1500));
  return { ok: tab.getAttribute('aria-selected') === 'true', empty: document.body.innerText.includes('안 읽은 메시지가 없어요') };
}

function pageOpenRow(id) {
  const a = document.querySelector(`a[href*="inbox_group_id=${id}&"]`);
  if (!a) return false;
  a.click();
  return true;
}

function pageThread() {
  const stamps = [...document.querySelectorAll('p')].filter((p) => /^\d{2}\.\d{2}\.\d{2}\s+\d{2}:\d{2}$/.test(p.innerText.trim()));
  const bubbles = stamps.map((p) => {
    const row = p.closest('div.relative.flex');
    const all = row ? row.innerText : '';
    const stamp = p.innerText;
    const text = all.endsWith(stamp) ? all.slice(0, -stamp.length) : all.replace(stamp, '');
    return { text: text.trim(), stamp: stamp.replace(/\s+/g, ' '), outbound: !!row?.classList.contains('flex-row-reverse') };
  });
  const ta = document.querySelector('textarea');
  const send = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '전송');
  if (ta) ta.setAttribute('data-fsw', 'composer');
  if (send) send.setAttribute('data-fsw', 'send');
  return {
    url: location.href,
    gigHrefs: [...document.querySelectorAll('a[href^="/gig/"]')].map((a) => a.getAttribute('href')),
    bubbles,
    // An unreachable counterpart renders a read-only textarea (placeholder 대화할 수 없는 회원입니다).
    composer: { found: !!ta, disabled: !!ta && (ta.disabled || ta.readOnly), placeholder: ta?.placeholder ?? null, value: ta?.value ?? '', sendButton: !!send, sendDisabled: !!send?.disabled, fileInput: !!document.querySelector('[data-testid=dropzone-layout] input[type=file]') },
  };
}

function pageOrders(testids) {
  const counters = {};
  for (const id of testids) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el) counters[id] = el.innerText;
  }
  return { counters, emptyState: document.body.innerText.includes('조회 기간에 거래 내역이 없어요') };
}

function pageOpenGigEdit(gigId) {
  const tag = [...document.querySelectorAll('*')].find((e) => !e.children.length && e.innerText?.trim() === '#' + gigId);
  let n = tag;
  while (n && ![...n.querySelectorAll('button')].some((b) => b.innerText.trim() === '편집하기')) n = n.parentElement;
  const button = n && [...n.querySelectorAll('button')].find((b) => b.innerText.trim() === '편집하기');
  if (!button) return false;
  button.click();
  return true;
}

function pageListingForm() {
  const labelOf = (el) => {
    let n = el.parentElement;
    for (let i = 0; i < 3 && n; i++, n = n.parentElement) {
      const l = n.querySelector(':scope > label, :scope > div > label');
      if (l) return l.innerText.trim();
    }
    return '';
  };
  const texts = [...document.querySelectorAll('input[type=text]')];
  const packages = {};
  let packageTitle = null;
  let packageDescription = null;
  for (const t of document.querySelectorAll('textarea[name^="PACKAGE_OPTION_GROUP.valueData.packages."]')) {
    const m = t.name.match(/packages\.(\d+)\.values\.(\d+)\./);
    packages[m[1] + '.' + m[2]] = t.value;
    if (m[1] === '0') packageTitle = t.maxLength;
    if (m[1] === '1') packageDescription = t.maxLength;
  }
  const questions = texts.filter((i) => labelOf(i).startsWith('질문'));
  const answers = [...document.querySelectorAll('textarea[name^="FAQ.valueData.faqs."]')];
  const keyword = texts.find((i) => i.placeholder === '키워드를 입력해 주세요');
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,label')].map((e) => e.innerText.trim()).filter(Boolean);
  return {
    url: location.href,
    title: headings[0] ?? null,
    headings,
    counters: [...document.querySelectorAll('*')].filter((e) => !e.children.length && /^\d+\s*\/\s*[\d,]+$/.test(e.innerText?.trim() ?? '')).map((e) => e.innerText.trim()),
    packages,
    prices: texts.filter((i) => labelOf(i).startsWith('금액')).map((i) => i.value),
    faqs: questions.map((q, i) => ({ question: q.value, answer: answers[i]?.value ?? null })),
    limits: { packageTitle, packageDescription, faq: questions[0]?.maxLength ?? null, keyword: keyword?.maxLength ?? null },
  };
}


// ---- gig form writers (page side). React owns these inputs, so values go through the native setter
// and an input event; react-select menus open on mousedown and take a click on an option. ----

async function pageFillForm(spec) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errors = [];
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const labelOf = (el) => {
    let n = el.parentElement;
    for (let i = 0; i < 10 && n; i++, n = n.parentElement) {
      const l = n.querySelector('label');
      if (l && l.innerText.trim()) return l.innerText.replace(/\*/g, '').trim();
    }
    return '';
  };
  const pick = async (input, text) => {
    const control = input.closest('[class*="-control"]');
    if (control.innerText.trim() === text) return true;
    control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await sleep(250);
    const opt = [...document.querySelectorAll('[class*="-option"]')].find((o) => o.innerText.trim() === text);
    if (!opt) {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      return false;
    }
    opt.click();
    await sleep(250);
    return control.innerText.trim() === text;
  };
  // Rich editors (tiptap): replace the whole document, one paragraph per line. Which of the three a
  // form has depends on the category (사진 보정 forms carry only 서비스 설명), so each is found by its
  // field wrapper and a missing wrapper is reported, not filled.
  const counters = {};
  const absent = [];
  for (const [id, text] of [['DESCRIPTION', spec.description], ['DESCRIPTION_PROGRESS', spec.process], ['DESCRIPTION_PREPARATION', spec.preparation]]) {
    const wrap = document.getElementById(id);
    if (!wrap) {
      absent.push(id);
      continue;
    }
    const ed = wrap.querySelector('.tiptap.ProseMirror');
    if (!ed) {
      errors.push(id + ' has no rich editor');
      continue;
    }
    ed.focus();
    document.execCommand('selectAll');
    document.execCommand('delete');
    text.split('\n').forEach((line, j) => {
      if (j) document.execCommand('insertParagraph');
      if (line) document.execCommand('insertText', false, line);
    });
    await sleep(200);
    counters[id] = [...wrap.querySelectorAll('p')].map((p) => p.innerText.trim()).find((t) => /^[\d,]+\s*\/\s*20000$/.test(t)) ?? null;
  }
  if (!document.getElementById('DESCRIPTION')) errors.push('the 서비스 설명 field is missing');

  for (const input of document.querySelectorAll('section#detailed input[id^="react-select-gig-metadata-"]')) {
    const label = labelOf(input);
    const want = spec.meta[label];
    if (want && !(await pick(input, want))) errors.push('metadata ' + label + ' has no option ' + want);
  }

  const sw = document.getElementById('package-type-switch');
  if (sw && !sw.checked) {
    sw.click();
    await sleep(600);
  }
  spec.packages.forEach((p, i) => {
    const title = document.querySelector('textarea[name="PACKAGE_OPTION_GROUP.valueData.packages.0.values.' + i + '.packageValue"]');
    const desc = document.querySelector('textarea[name="PACKAGE_OPTION_GROUP.valueData.packages.1.values.' + i + '.packageValue"]');
    if (!title || !desc) errors.push('package ' + i + ' title or description field missing');
    else {
      setValue(title, p.title);
      setValue(desc, p.description);
    }
  });
  [...document.querySelectorAll('section#price input[inputmode=numeric]')].slice(0, 3).forEach((el, i) => el.setAttribute('data-fsw', 'price-' + i));

  const columns = {};
  for (const input of document.querySelectorAll('section#price input[id^="react-select-"]')) (columns[labelOf(input)] ??= []).push(input);
  for (const [label, values] of Object.entries(spec.packageSelects)) {
    const inputs = columns[label] ?? [];
    if (inputs.length !== 3) {
      errors.push('package row ' + label + ' has ' + inputs.length + ' selects');
      continue;
    }
    for (const [i, v] of values.entries()) if (v != null && !(await pick(inputs[i], v))) errors.push('package row ' + label + ' column ' + i + ' has no option ' + v);
  }
  const boxes = {};
  for (const box of document.querySelectorAll('section#price input[type=checkbox]:not(#package-type-switch)')) {
    let n = box.parentElement;
    let text = '';
    for (let i = 0; i < 4 && n && !text; i++, n = n.parentElement) text = n.innerText.trim();
    (boxes[text] ??= []).push(box);
  }
  for (const [label, values] of Object.entries(spec.packageChecks)) {
    const list = boxes[label] ?? [];
    if (list.length < 3) {
      errors.push('package row ' + label + ' has ' + list.length + ' checkboxes');
      continue;
    }
    values.forEach((on, i) => {
      if (list[i].checked !== on) list[i].click();
    });
  }
  // 수정 및 재진행 안내 renders only once package mode is on.
  const revision = document.querySelector('textarea[name="REVISION.valueData.revision"]');
  if (revision) setValue(revision, spec.revision);
  else if (document.getElementById('REVISION')) errors.push('the 수정 및 재진행 안내 field has no text box');
  else absent.push('REVISION');
  return { errors, counters, absent };
}

async function pageFillCore(faqs) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sec = document.querySelector('section#core');
  if (!sec) return { errors: ['section 판매 핵심 정보 missing'] };
  const head = sec.querySelector(':scope > button');
  if (head?.getAttribute('aria-expanded') === 'false') {
    head.click();
    await sleep(1200);
  }
  const setValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const errors = [];
  const answers = () => [...sec.querySelectorAll('textarea[name^="FAQ.valueData.faqs."]')];
  const addFaq = [...sec.querySelectorAll('button')].filter((b) => b.innerText.trim() === '추가')[0];
  while (answers().length < faqs.length && addFaq) {
    addFaq.click();
    await sleep(500);
  }
  for (const [i, f] of faqs.entries()) {
    const a = sec.querySelector('textarea[name="FAQ.valueData.faqs.' + i + '.answer"]');
    let n = a;
    let q = null;
    for (let k = 0; k < 6 && n && !q; k++) {
      n = n.parentElement;
      q = [...n.querySelectorAll('input[type=text]')].find((x) => x.maxLength === 255) ?? null;
    }
    if (!a || !q) {
      errors.push('faq ' + i + ' fields missing');
      continue;
    }
    setValue(q, f.question);
    setValue(a, f.answer);
  }
  sec.querySelector('input[placeholder="키워드를 입력해 주세요"]')?.setAttribute('data-fsw', 'keyword');
  return { errors, faqFields: answers().length };
}

// What the form holds now, read back after filling: the proof that each write landed.
function pageFormState() {
  const t = document.body.innerText;
  const count = (label) => t.match(new RegExp(label + '\\s*\\((\\d+)\\s*/\\s*(\\d+)\\)'))?.slice(1).map(Number) ?? null;
  const val = (sel) => document.querySelector(sel)?.value ?? null;
  const sec = document.querySelector('section#core');
  const kwStart = sec ? sec.innerText.indexOf('엔터를 눌러 등록하기') : -1;
  return {
    url: location.href,
    title: [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '편집')?.parentElement?.innerText.replace(/편집\s*$/, '').trim() ?? null,
    // Counters of the rich editors the form has, by field wrapper id; a field the category lacks is absent.
    counters: Object.fromEntries(['DESCRIPTION', 'DESCRIPTION_PROGRESS', 'DESCRIPTION_PREPARATION'].filter((id) => document.getElementById(id)).map((id) => [id, [...document.getElementById(id).querySelectorAll('p')].map((p) => p.innerText.trim()).find((x) => /^[\d,]+\s*\/\s*20000$/.test(x)) ?? null])),
    mainImages: count('메인 이미지'),
    detailImages: count('상세 이미지'),
    videos: count('동영상'),
    packageMode: document.getElementById('package-type-switch')?.checked ?? null,
    packages: [0, 1, 2].map((i) => ({ title: val('textarea[name="PACKAGE_OPTION_GROUP.valueData.packages.0.values.' + i + '.packageValue"]'), description: val('textarea[name="PACKAGE_OPTION_GROUP.valueData.packages.1.values.' + i + '.packageValue"]') })),
    prices: [...document.querySelectorAll('section#price input[inputmode=numeric]')].slice(0, 3).map((e) => e.value),
    keywords: count('검색 키워드'),
    keywordText: kwStart >= 0 ? sec.innerText.slice(kwStart, kwStart + 200) : null,
    faqs: [...document.querySelectorAll('textarea[name^="FAQ.valueData.faqs."]')].map((a) => a.value.length),
    revision: document.querySelector('textarea[name="REVISION.valueData.revision"]')?.value ?? null,
    revisionField: !!document.getElementById('REVISION') || !!document.querySelector('textarea[name="REVISION.valueData.revision"]'),
    submit: !![...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '제출하기'),
  };
}

// Marks a file input so the driver can hand it files; the input is hidden, and the upload tool needs a
// box, so it is shown as a 24 px transparent square until restore.
function pageRevealFile(fieldId) {
  const f = document.querySelector('#' + fieldId + ' input[type=file]');
  if (!f) return false;
  document.activeElement?.blur?.();
  f.setAttribute('data-fsw', 'file-up');
  f.dataset.fswStyle = f.getAttribute('style') ?? '';
  f.setAttribute('style', 'display:block!important;position:fixed;left:0;top:0;width:24px;height:24px;opacity:0.01;z-index:2147483647');
  return true;
}

function pageRestoreFile() {
  const f = document.querySelector('[data-fsw=file-up]');
  if (!f) return false;
  f.setAttribute('style', f.dataset.fswStyle ?? '');
  f.removeAttribute('data-fsw');
  return true;
}

async function pageNewGig({ root, sub, third }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const button = (t) => [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === t);
  const opener = (prefix) => [...document.querySelectorAll('button')].find((x) => x.innerText.trim().startsWith(prefix));
  opener('1차 카테고리')?.click();
  await sleep(600);
  if (!button(root)) return { ok: false, reason: 'no 1st level category ' + root };
  button(root).click();
  await sleep(600);
  opener('2차 카테고리')?.click();
  await sleep(600);
  if (!button(sub)) return { ok: false, reason: 'no 2nd level category ' + sub };
  button(sub).click();
  await sleep(600);
  // Some subs (AI 디자인, AI 이미지, 숏폼 영상) open a 3차 카테고리 picker that must be set before 다음.
  if (third) {
    opener('3차 카테고리')?.click();
    await sleep(600);
    if (!button(third)) return { ok: false, reason: 'no 3rd level category ' + third };
    button(third).click();
    await sleep(600);
  }
  const picked = [...document.querySelectorAll('button')].filter((x) => /카테고리\*/.test(x.innerText)).map((x) => x.innerText.replace(/\s+/g, ' ').trim());
  const ok = picked.some((p) => p.endsWith(root)) && picked.some((p) => p.endsWith(sub)) && (!third || picked.some((p) => p.endsWith(third)));
  if (ok) button('다음')?.setAttribute('data-fsw', 'next');
  return { ok, picked };
}

// Removes every file a gallery slot holds (#MAIN_GALLERY or #IMAGE_GALLERY): each thumbnail has its own
// 삭제 button. Returns how many files the slot reports afterwards.
async function pageClearSlot(fieldId) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const slot = document.getElementById(fieldId);
  if (!slot) return { ok: false, reason: 'no ' + fieldId + ' field' };
  const count = () => Number(slot.querySelector('h3')?.innerText.match(/\((\d+)\s*\/\s*\d+\)/)?.[1] ?? NaN);
  for (let i = 0; i < 12 && count() > 0; i++) {
    const del = [...slot.querySelectorAll('button')].find((b) => b.innerText.trim() === '삭제');
    if (!del) break;
    del.click();
    await sleep(700);
    const d = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].at(-1);
    const confirm = d && [...d.querySelectorAll('button')].find((b) => ['삭제', '확인'].includes(b.innerText.trim()));
    if (confirm) {
      confirm.click();
      await sleep(700);
    }
  }
  return { ok: count() === 0, left: count() };
}

// The review notice of one /my-gigs row: the 승인 안내 toggle under the row opens kmong's message box
// (approval, edit approval or rejection with its reason). Returns the row text before and after the
// toggle opened (src/listings/review.mjs addedText takes the difference), or toggle false when the row
// has none (a gig still waiting shows 승인 대기 중 instead).
async function pageGigNotice(gigId) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tag = [...document.querySelectorAll('span,p,div')].find((e) => e.innerText?.trim() === '#' + gigId && e.children.length <= 1);
  if (!tag) return { found: false };
  let row = tag;
  while (row && ![...row.querySelectorAll('button')].some((b) => ['편집하기', '제출 취소'].includes(b.innerText.trim()))) row = row.parentElement;
  const toggle = row && [...row.querySelectorAll('button')].find((b) => b.innerText.trim() === '승인 안내');
  if (!toggle) return { found: true, toggle: false, notice: null, row: row?.innerText.slice(0, 600) ?? null };
  const first = row.innerText;
  toggle.click();
  await sleep(1200);
  const second = row.innerText;
  if (second.length > first.length) return { found: true, toggle: true, before: first, after: second };
  // The toggle was already open and the click closed it; open it again.
  toggle.click();
  await sleep(1200);
  return { found: true, toggle: true, before: second, after: row.innerText };
}

function pageMarkSubmit() {
  const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '제출하기');
  if (b) b.setAttribute('data-fsw', 'submit');
  return !!b;
}

// After 제출하기: field errors the form shows, any dialog, and where the page went.
function pageAfterSubmit() {
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Each error names the field wrapper it sits in (DESCRIPTION, VIDEO_GALLERY ...), since the same text
  // (최소 1개 이상 등록해 주세요) appears under several fields.
  const errors = [...document.querySelectorAll('p,span,div')].filter((e) => !e.children.length && vis(e) && /(?:해 주세요|할 수 없어요|이상 입력|선택해 주세요)$/.test(e.innerText.trim()) && getComputedStyle(e).color.replace(/\s/g, '').startsWith('rgb(2')).map((e) => {
    const field = e.closest('[id]')?.id;
    return (field && /^[A-Z_]+$/.test(field) ? field + ': ' : '') + e.innerText.trim();
  });
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis).map((d) => ({ text: d.innerText.trim().slice(0, 400), buttons: [...d.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) }));
  return { url: location.href, errors: [...new Set(errors)].slice(0, 20), dialogs };
}

function pageDialogButton(label) {
  const d = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].at(-1);
  const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === label);
  if (!b) return false;
  b.click();
  return true;
}

// The submit dialog's confirmations (내 프로필에서 증빙을 완료했어요, 관련 표현은 삭제했어요). The listing
// gate keeps both true: no seller-record claim and none of the listed phrases reach a listing.
function pageTickDialog() {
  const d = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].at(-1);
  const boxes = d ? [...d.querySelectorAll('input[type=checkbox]')] : [];
  const ticked = [];
  for (const box of boxes) {
    if (box.checked) continue;
    let n = box.parentElement;
    let text = '';
    for (let i = 0; i < 4 && n && !text; i++, n = n.parentElement) text = n.innerText.trim().split('\n')[0];
    box.click();
    ticked.push(text);
  }
  return { ticked, checked: boxes.every((x) => x.checked) };
}

async function pageRenameGig(title) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const edit = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '편집');
  if (!edit) return { ok: false, reason: 'no 편집 button beside the title' };
  edit.click();
  await sleep(1000);
  const d = document.querySelector('[role=dialog]');
  const input = d?.querySelector('input[maxlength="30"]');
  if (!input) return { ok: false, reason: 'the title dialog did not open' };
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, title);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  const save = [...d.querySelectorAll('button')].find((b) => b.innerText.trim() === '변경하기');
  if (!save || save.disabled) return { ok: false, reason: '변경하기 is disabled for this title' };
  save.click();
  await sleep(1500);
  return { ok: true };
}


// Differences between the read-back form and the listing that was written into it.
export function formProblems(state, listing) {
  const out = [];
  const counters = state.counters ?? {};
  if (!('DESCRIPTION' in counters)) out.push('description field is missing');
  for (const [id, f] of [['DESCRIPTION', 'description'], ['DESCRIPTION_PROGRESS', 'process'], ['DESCRIPTION_PREPARATION', 'preparation']]) {
    if (id in counters && !toInt(counters[id]?.split('/')[0])) out.push(f + ' is empty');
  }
  if (state.packageMode !== true) out.push('package mode is off');
  listing.packages.forEach((p, i) => {
    if (state.packages?.[i]?.title !== p.title) out.push('package ' + i + ' title differs');
    if (state.packages?.[i]?.description !== p.description) out.push('package ' + i + ' description differs');
    if (toInt(state.prices?.[i]) !== p.priceKRW) out.push('package ' + i + ' price reads ' + state.prices?.[i]);
  });
  if (!(state.mainImages?.[0] >= 1)) out.push('no main image');
  if (!(state.detailImages?.[0] >= Math.min(1, listing.images.detail.length))) out.push('no detail image');
  if (listing.images.video?.length && !(state.videos?.[0] >= 1)) out.push('no video');
  if (state.keywords?.[0] !== listing.keywords.length) out.push('keywords read ' + (state.keywords?.[0] ?? 'none') + ' of ' + listing.keywords.length);
  if ((state.faqs ?? []).length !== listing.faqs.length || state.faqs.some((n) => !n)) out.push('faqs read ' + (state.faqs ?? []).length + ' of ' + listing.faqs.length);
  if (state.revisionField !== false && state.revision !== listing.revision) out.push('revision text differs');
  return out;
}

// The gig id and category ids an edit form URL carries (/my-gigs/edit/<id>?rootCategoryId=..&
// subCategoryId=..&thirdCategoryId=..); the bare /my-gigs/edit/<id> URL redirects away without them.
export function editIds(url) {
  const m = String(url ?? '').match(/\/my-gigs\/edit\/(\d+)(?:\?(.*))?$/);
  if (!m) return null;
  const q = new URLSearchParams(m[2] ?? '');
  const id = (k) => (/^\d+$/.test(q.get(k) ?? '') ? Number(q.get(k)) : null);
  return { gigId: Number(m[1]), categoryIds: { root: id('rootCategoryId'), sub: id('subCategoryId'), third: id('thirdCategoryId') } };
}

// ---- adapter ----

export async function openKmong({ session } = {}) {
  const s = session ?? (await openSession('kmong', { platform: 'kmong', pacing: loadDescriptor('kmong').pacing }));

  const unreadHrefs = async () => {
    const tab = await s.evaluate(pageSelectTab, '안읽음');
    if (!tab.ok) throw new AdapterRefusal('FSW_UNREAD_UNKNOWN', 'the 안읽음 filter did not switch, so unread threads cannot be told apart');
    const rows = tab.empty ? [] : (await s.evaluate(pageInboxRows)).map((r) => r.href);
    await s.evaluate(pageSelectTab, '전체');
    return rows;
  };

  // Opens a thread from the list after the unread check; never navigates to a thread URL directly.
  const openThread = async (id, { willReply = false } = {}) => {
    await s.navigate(INBOX);
    const rows = await s.evaluate(pageInboxRows);
    const row = rows.find((r) => r.href.includes(`inbox_group_id=${id}&`));
    if (!row) throw new AdapterRefusal('FSW_THREAD_NOT_LISTED', `thread ${id} is not in the inbox list`);
    const unread = (await unreadHrefs()).some((h) => h.includes(`inbox_group_id=${id}&`));
    if (unread && !willReply) throw new AdapterRefusal('FSW_UNREAD_REFUSED', `thread ${id} is unread; open it only with willReply`);
    if (!(await s.evaluate(pageOpenRow, String(id)))) throw new AdapterRefusal('FSW_THREAD_NOT_LISTED', `thread ${id} row vanished`);
    await wait(5000);
    return { row, unread, page: await s.evaluate(pageThread) };
  };

  const adapter = {
    platform: 'kmong',
    session: s,

    async login() {
      await s.navigate(`${BASE}/seller/dashboard`);
      const p = await s.evaluate(pageLogin);
      const nickname = p.profileHref ? decodeURIComponent(p.profileHref.slice(2)) : null;
      return { loggedIn: p.avatar && p.authSection && !p.loginButton, sellerMode: p.sellerMode, nickname, url: p.url };
    },

    async inbox() {
      await s.navigate(INBOX);
      const rows = await s.evaluate(pageInboxRows);
      return parseInbox(rows, await unreadHrefs());
    },

    async readThread(id, { willReply = false } = {}) {
      const { row, unread, page } = await openThread(id, { willReply });
      return { ...parseThread({ id: String(id), url: page.url, nickname: row.nickname, gigHrefs: page.gigHrefs, bubbles: page.bubbles, composer: page.composer }), wasUnread: unread, stage: 'pre_order' };
    },

    // dryRun types into the composer, confirms the send button, then clears the composer.
    async send(id, { text, files = [], gate, dryRun = false } = {}) {
      if (gate?.ok !== true) return { sent: false, observed: false, reason: 'gate result missing or not ok' };
      if (!squash(text)) return { sent: false, observed: false, reason: 'empty text' };
      const { page } = await openThread(id, { willReply: true });
      const c = page.composer;
      if (!c.found || c.disabled) return { sent: false, observed: false, reason: `composer unavailable${c.placeholder ? ': ' + c.placeholder : ''}` };
      if (!c.sendButton) return { sent: false, observed: false, reason: 'send button 전송 not found' };
      if (!dryRun) s.guard.beforeMessage();
      await s.fill('[data-fsw=composer]', text);
      if (files.length) await s.setFiles('[data-testid=dropzone-layout] input[type=file]', files);
      const typed = await s.evaluate(pageThread);
      if (squash(typed.composer.value) !== squash(text)) {
        await s.fill('[data-fsw=composer]', '');
        return { sent: false, observed: false, reason: 'the composer did not hold the typed text' };
      }
      if (dryRun) {
        await s.fill('[data-fsw=composer]', '');
        const cleared = await s.evaluate(pageThread);
        return { sent: false, observed: false, dryRun: true, typed: true, sendButton: true, sendDisabled: typed.composer.sendDisabled, cleared: cleared.composer.value === '' };
      }
      if (typed.composer.sendDisabled) return { sent: false, observed: false, reason: 'send button disabled after typing' };
      await s.click('[data-fsw=send]');
      await wait(4000);
      const after = await s.evaluate(pageThread);
      const last = after.bubbles.filter((b) => b.outbound).at(-1);
      const observed = !!last && squash(last.text).includes(squash(text).slice(0, 60));
      const snip = last ? squash(last.text).slice(0, 80) : null;
      return observed ? { sent: true, observed: true, observedSnippet: snip, text } : { sent: false, observed: false, reason: 'the sent text was not observed in the thread', observedSnippet: snip };
    },

    async listings() {
      await s.navigate(`${BASE}/my-gigs`);
      return parseGigList(await s.evaluate(() => document.body.innerText));
    },

    async orders() {
      await s.navigate(`${BASE}/seller/order-list`);
      return parseOrders(await s.evaluate(pageOrders, Object.keys(ORDER_COUNTERS)));
    },

    async profile() {
      const login = await adapter.login();
      const dashboard = parseDashboard(await s.evaluate(() => document.body.innerText));
      if (!login.nickname) return { dashboard, profile: null };
      const url = `${BASE}/@${encodeURIComponent(login.nickname)}`;
      await s.navigate(url);
      return { dashboard, profile: parseProfile(await s.evaluate(() => document.body.innerText), { nickname: login.nickname, url }) };
    },

    // Reads the gig edit form without saving: the edit page is reached through 편집하기 on /my-gigs,
    // since the bare /my-gigs/edit/<id> URL redirects back without category ids.
    async listingForm(gigId) {
      await s.navigate(`${BASE}/my-gigs`);
      if (!(await s.evaluate(pageOpenGigEdit, String(gigId)))) throw new AdapterRefusal('FSW_GIG_NOT_FOUND', `gig ${gigId} has no 편집하기 button on /my-gigs`);
      await wait(8000);
      const form = await s.evaluate(pageListingForm);
      if (!form.url.includes(`/my-gigs/edit/${gigId}`)) throw new AdapterRefusal('FSW_GIG_FORM', `edit form for ${gigId} did not open (at ${form.url})`);
      return parseListingForm(form);
    },

    // The 승인 안내 notice box of a gig row on /my-gigs, read without changing anything.
    async gigNotice(gigId) {
      await s.navigate(`${BASE}/my-gigs`, { settle: 7000 });
      return s.evaluate(pageGigNotice, String(gigId), { timeoutMs: 20_000 });
    },

    // Creates or updates a gig and submits it for review. listing is a built spec (src/listings/kmong.mjs)
    // with absolute image paths; listing.gigId reuses a draft or a rejected gig, opened by its category
    // ids when known and otherwise through 편집하기 on /my-gigs. replaceImages lists the slots (main,
    // detail) whose current files are deleted first, so a rebuilt listing shows its new images. Each step
    // reads the form back, and nothing is submitted unless every field holds what was written. Returns
    // what /my-gigs showed, with the category ids the edit URL carried.
    async upsertListing(listing, { submit = true, replaceImages = [] } = {}) {
      const steps = [];
      const fail = (reason, extra = {}) => ({ observed: false, submitted: false, gigId, categoryIds, reason, steps, ...extra });
      let gigId = listing.gigId ?? null;
      let categoryIds = listing.categoryIds ?? null;
      const { root, sub, third } = listing.category ?? {};
      if (!gigId) {
        await s.navigate(BASE + '/my-gigs/new', { settle: 7000 });
        await s.fill('input[placeholder="제목을 입력해 주세요"]', listing.title);
        const cat = await s.evaluate(pageNewGig, { root, sub, third });
        steps.push({ step: 'category', ...cat });
        if (!cat.ok) return fail(cat.reason ?? 'the categories did not take');
        await s.click('[data-fsw=next]');
        await wait(9000);
        const ids = editIds(await s.evaluate(() => location.href));
        gigId = ids?.gigId ?? null;
        categoryIds = ids?.categoryIds ?? null;
        steps.push({ step: 'draft', gigId });
        if (!gigId) return fail('다음 did not open a draft edit form');
      } else if (categoryIds?.root && categoryIds?.sub) {
        await s.navigate(BASE + '/my-gigs/edit/' + gigId + '?rootCategoryId=' + categoryIds.root + '&subCategoryId=' + categoryIds.sub + (categoryIds.third ? '&thirdCategoryId=' + categoryIds.third : ''), { settle: 8000 });
      } else {
        await s.navigate(BASE + '/my-gigs', { settle: 7000 });
        if (!(await s.evaluate(pageOpenGigEdit, String(gigId)))) return fail('gig ' + gigId + ' has no 편집하기 button on /my-gigs');
        await wait(9000);
        categoryIds = editIds(await s.evaluate(() => location.href))?.categoryIds ?? null;
      }
      let state = await s.evaluate(pageFormState);
      if (!state.url.includes('/my-gigs/edit/' + gigId)) return fail('the edit form for ' + gigId + ' did not open (at ' + state.url + ')');
      if (squash(state.title) !== squash(listing.title)) {
        const r = await s.evaluate(pageRenameGig, listing.title);
        steps.push({ step: 'title', ...r });
        if (!r.ok) return fail(r.reason);
      }
      // Images go first: the slot inputs stop taking files once the fields below hold focus and state.
      // A slot that already holds files is left as it is (a re-run keeps the uploaded set) unless
      // replaceImages names it, in which case its files are deleted first.
      // Video categories (AI 영상) require one file in 동영상; listing.images.video carries it.
      const slots = [['main', [listing.images.main], 'MAIN_GALLERY', 'mainImages'], ['detail', listing.images.detail, 'IMAGE_GALLERY', 'detailImages']];
      if (listing.images.video?.length) slots.push(['video', listing.images.video, 'VIDEO_GALLERY', 'videos']);
      for (const [slot, files, fieldId, stateKey] of slots) {
        let count = (await s.evaluate(pageFormState))[stateKey]?.[0] ?? 0;
        if (count > 0 && replaceImages.includes(slot)) {
          const cleared = await s.evaluate(pageClearSlot, fieldId, { timeoutMs: 30_000 });
          steps.push({ step: 'images.' + slot + '.clear', ...cleared });
          if (!cleared.ok) return fail('the ' + slot + ' images could not be removed: ' + (cleared.reason ?? cleared.left + ' left'));
          count = 0;
        }
        if (count > 0) {
          steps.push({ step: 'images.' + slot, kept: count });
          continue;
        }
        if (!(await s.evaluate(pageRevealFile, fieldId))) return fail('no file input for the ' + slot + ' slot');
        try {
          await s.setFiles('[data-fsw=file-up]', files);
        } finally {
          await s.evaluate(pageRestoreFile);
        }
        await wait(slot === 'video' ? 20_000 : 4000 + 1500 * files.length);
        steps.push({ step: 'images.' + slot, uploaded: files.length });
      }

      const form = listing.form ?? { meta: {}, packageSelects: {}, packageChecks: {} };
      const filled = await s.evaluate(pageFillForm, {
        description: listing.description,
        process: listing.process,
        preparation: listing.preparation,
        revision: listing.revision,
        meta: form.meta,
        packages: listing.packages.map((p) => ({ title: p.title, description: p.description })),
        packageSelects: { ...form.packageSelects, '작업 기간': listing.packages.map((p) => p.days + '일'), '수정 횟수': listing.packages.map((p) => p.revisions + '회') },
        packageChecks: form.packageChecks,
      }, { timeoutMs: 90_000 });
      steps.push({ step: 'fields', errors: filled.errors, counters: filled.counters, absent: filled.absent });
      if (filled.errors.length) return fail('form fields: ' + filled.errors.join('; '));
      for (const [i, p] of listing.packages.entries()) await s.typeKeys('[data-fsw=price-' + i + ']', String(p.priceKRW));

      const core = await s.evaluate(pageFillCore, listing.faqs, { timeoutMs: 30_000 });
      steps.push({ step: 'core', ...core });
      if (core.errors?.length) return fail('core fields: ' + core.errors.join('; '));
      state = await s.evaluate(pageFormState);
      for (const k of listing.keywords) {
        if (state.keywordText?.split('\n').some((l) => l.trim() === k)) continue;
        await s.fill('[data-fsw=keyword]', k);
        await s.press('Enter', { target: '[data-fsw=keyword]' });
        await wait(400);
      }

      state = await s.evaluate(pageFormState);
      const problems = formProblems(state, listing);
      steps.push({ step: 'readback', problems });
      if (problems.length) return fail('read back: ' + problems.join('; '), { state });
      if (!submit) return { observed: true, submitted: false, gigId, categoryIds, steps, state };

      if (!(await s.evaluate(pageMarkSubmit))) return fail('no 제출하기 button');
      await s.click('[data-fsw=submit]');
      await wait(5000);
      let after = await s.evaluate(pageAfterSubmit);
      for (let i = 0; i < 2 && after.dialogs.length; i++) {
        const confirm = after.dialogs.at(-1).buttons.find((b) => ['제출하기', '확인', '제출'].includes(b));
        const tick = await s.evaluate(pageTickDialog);
        steps.push({ step: 'dialog', text: after.dialogs.at(-1).text.slice(0, 200), ticked: tick.ticked, pressed: confirm ?? null });
        if (!confirm || !tick.checked) break;
        await s.evaluate(pageDialogButton, confirm);
        await wait(5000);
        after = await s.evaluate(pageAfterSubmit);
      }
      steps.push({ step: 'submit', url: after.url, errors: after.errors });
      if (after.errors.length) return fail('the form refused the submit: ' + after.errors.join('; '), { submitted: false });
      await s.navigate(BASE + '/my-gigs', { settle: 7000 });
      const list = parseGigList(await s.evaluate(() => document.body.innerText));
      const gig = list.gigs.find((g) => g.gigId === gigId);
      steps.push({ step: 'my-gigs', found: !!gig, status: gig?.status ?? null });
      if (!gig) return fail('gig ' + gigId + ' is not listed on /my-gigs after submit', { submitted: true });
      const submitted = gig.status !== '임시 저장' && gig.status !== '작성 중';
      return { observed: true, submitted, gigId, categoryIds, status: gig.status, title: gig.title, priceKRW: gig.priceKRW, url: gig.url, counts: list.counts, steps };
    },

    stop: () => s.stop(),
  };
  return adapter;
}
