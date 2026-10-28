// The functions src/platforms/kmong/projects.mjs serialises into the 크몽 엔터프라이즈 pages: the list and detail
// fetches and the proposal form readers and fillers. Each closes over no node value, since it runs in the page.
export async function pageFetchList(query) {
  const res = await fetch('/api/custom-project/v1/requests?' + query, { credentials: 'omit', headers: { accept: 'application/json' } });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

export function pageDetail(id) {
  const q = window.__NEXT_DATA__?.props?.pageProps?.dehydratedState?.queries ?? [];
  const entry = q.find((x) => x.queryKey?.[0] === 'projectDetail' && String(x.queryKey?.[1]) === String(id));
  return entry ? { ok: true, data: entry.state?.data ?? null } : { ok: false, url: location.href, title: document.title };
}

export function pageProposeButton() {
  const b = [...document.querySelectorAll('button, a')].find((x) => /^(?:로그인 후 )?제안하기$/.test(x.innerText.trim()));
  if (!b) return { found: false };
  b.setAttribute('data-fsw', 'propose');
  return { found: true, text: b.innerText.trim(), disabled: !!b.disabled };
}

// Everything a form shows after 제안하기: visible fields with their limits, buttons and dialogs. Each
// visible field gets data-fsw=field-N so the filler can address it.
export function pageProposalForm() {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const labelOf = (el) => {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText.trim(); }
    let n = el.parentElement;
    for (let i = 0; i < 5 && n; i++, n = n.parentElement) { const l = n.querySelector('label, h3, h4, strong, p'); if (l && l.innerText.trim()) return l.innerText.trim().slice(0, 80); }
    return '';
  };
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis);
  const scope = dialogs.at(-1) ?? document;
  const fields = [...scope.querySelectorAll('input, textarea, select, [contenteditable=true]')].filter((e) => e.type !== 'hidden' && (vis(e) || e.type === 'file')).map((e, i) => {
    e.setAttribute('data-fsw', 'field-' + i);
    return { ref: 'field-' + i, tag: e.tagName, type: e.type ?? null, name: e.name || null, placeholder: e.placeholder || null, maxLength: e.maxLength > 0 ? e.maxLength : null, accept: e.accept || null, required: !!e.required || e.getAttribute('aria-required') === 'true', label: labelOf(e), value: e.value ?? e.innerText ?? '', checked: e.type === 'checkbox' || e.type === 'radio' ? e.checked : null };
  });
  return {
    url: location.href,
    dialogs: dialogs.map((d) => d.innerText.trim().slice(0, 600)),
    registrationNeeded: dialogs.some((d) => /엔터프라이즈 프로필 등록/.test(d.innerText)),
    fields,
    buttons: [...scope.querySelectorAll('button')].filter(vis).map((b) => ({ text: b.innerText.trim().slice(0, 40), disabled: !!b.disabled, className: String(b.className ?? '').slice(0, 120), pressed: b.getAttribute('aria-pressed') ?? b.getAttribute('aria-checked') ?? b.getAttribute('data-state') ?? null })).filter((b) => b.text),
    counters: [...scope.querySelectorAll('*')].filter((e) => !e.children.length && /^[0-9][0-9,]*\s*[/]\s*[0-9,]+/.test(e.innerText?.trim() ?? '')).map((e) => e.innerText.trim()),
  };
}

// React owns the inputs, so values go through the native setter and an input event.
export function pageSetField({ ref, value }) {
  const el = document.querySelector('[data-fsw="' + ref + '"]');
  if (!el) return { ok: false, reason: 'no field ' + ref };
  if (el.isContentEditable) {
    el.focus();
    document.execCommand('selectAll');
    document.execCommand('insertText', false, value);
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return { ok: true, value: el.isContentEditable ? el.innerText : el.value };
}

// A required acknowledgement: ticks the box through its label, which is what React listens to.
export function pageCheck(ref) {
  const el = document.querySelector('[data-fsw="' + ref + '"]');
  if (!el) return { ok: false, reason: 'no field ' + ref };
  if (!el.checked) (el.closest('label') ?? el).click();
  return { ok: el.checked, checked: el.checked };
}

// One button of a choice pair (세금계산서 발행 여부: 가능 or 불가능) in the open dialog.
export function pageChoose(text) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis);
  const scope = dialogs.at(-1) ?? document;
  const b = [...scope.querySelectorAll('button')].filter(vis).find((x) => x.innerText.trim() === text);
  if (!b || b.disabled) return { ok: false, reason: 'no enabled ' + text + ' button' };
  b.click();
  return { ok: true };
}

export function pageMarkSubmit(labels) {
  const dialogs = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')];
  const scope = dialogs.at(-1) ?? document;
  const b = [...scope.querySelectorAll('button')].filter((x) => x.getAttribute('data-fsw') !== 'propose').find((x) => labels.includes(x.innerText.trim()));
  if (!b) return { found: false };
  b.setAttribute('data-fsw', 'submit');
  return { found: true, text: b.innerText.trim(), disabled: !!b.disabled };
}

// A confirmation dialog after submit: one without a visible text field whose button confirms. kmong's
// final confirm is a SweetAlert2 popup, which carries hidden input and textarea elements of its own,
// so only a visible field marks the form dialog.
export function pageConfirm(labels) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis).filter((x) => ![...x.querySelectorAll('textarea, [contenteditable=true]')].some(vis)).at(-1);
  const b = d && [...d.querySelectorAll('button')].find((x) => labels.includes(x.innerText.trim()) && !x.disabled && vis(x));
  if (!b) return { pressed: null };
  const text = d.innerText.trim().slice(0, 300);
  b.click();
  return { pressed: b.innerText.trim(), text };
}

export function pageAfterSubmit() {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const errors = [...document.querySelectorAll('p,span,div')].filter((e) => !e.children.length && vis(e) && /(?:해 주세요|할 수 없어요|이상 입력|선택해 주세요|입력해주세요)$/.test(e.innerText.trim()) && getComputedStyle(e).color.replace(/\s/g, '').startsWith('rgb(2')).map((e) => e.innerText.trim());
  return { url: location.href, errors, dialogs: [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].filter(vis).map((d) => d.innerText.trim().slice(0, 300)) };
}
