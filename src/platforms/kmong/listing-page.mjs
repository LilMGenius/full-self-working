// 크몽 gig pages: the gig list and edit-form extractors and the gig form writers, serialised into the page
// by the driver. Moved verbatim from src/platforms/kmong/adapter.mjs:84-127 and :130-473 at 2c77326.

export function pageOpenGigEdit(gigId) {
  const tag = [...document.querySelectorAll('*')].find((e) => !e.children.length && e.innerText?.trim() === '#' + gigId);
  let n = tag;
  while (n && ![...n.querySelectorAll('button')].some((b) => b.innerText.trim() === '편집하기')) n = n.parentElement;
  const button = n && [...n.querySelectorAll('button')].find((b) => b.innerText.trim() === '편집하기');
  if (!button) return false;
  button.click();
  return true;
}

export function pageListingForm() {
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

export async function pageFillForm(spec) {
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

export async function pageFillCore(faqs) {
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
export function pageFormState() {
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
export function pageRevealFile(fieldId) {
  const f = document.querySelector('#' + fieldId + ' input[type=file]');
  if (!f) return false;
  document.activeElement?.blur?.();
  f.setAttribute('data-fsw', 'file-up');
  f.dataset.fswStyle = f.getAttribute('style') ?? '';
  f.setAttribute('style', 'display:block!important;position:fixed;left:0;top:0;width:24px;height:24px;opacity:0.01;z-index:2147483647');
  return true;
}

export function pageRestoreFile() {
  const f = document.querySelector('[data-fsw=file-up]');
  if (!f) return false;
  f.setAttribute('style', f.dataset.fswStyle ?? '');
  f.removeAttribute('data-fsw');
  return true;
}

export async function pageNewGig({ root, sub, third }) {
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
export async function pageClearSlot(fieldId) {
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
export async function pageGigNotice(gigId) {
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

export function pageMarkSubmit() {
  const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '제출하기');
  if (b) b.setAttribute('data-fsw', 'submit');
  return !!b;
}

// After 제출하기: field errors the form shows, any dialog, and where the page went.
export function pageAfterSubmit() {
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

export function pageDialogButton(label) {
  const d = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].at(-1);
  const b = d && [...d.querySelectorAll('button')].find((x) => x.innerText.trim() === label);
  if (!b) return false;
  b.click();
  return true;
}

// The submit dialog's confirmations (내 프로필에서 증빙을 완료했어요, 관련 표현은 삭제했어요). The listing
// gate keeps both true: no seller-record claim and none of the listed phrases reach a listing.
export function pageTickDialog() {
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

export async function pageRenameGig(title) {
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
