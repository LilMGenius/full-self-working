// The functions the Upwork onboarding steps evaluate inside the page (src/platforms/upwork/onboarding.mjs): each
// reads the wizard's DOM and closes over no node value, since it runs in the browser.
export function readChecked(values) {
  return [...document.querySelectorAll('input[type=radio]')].find((i) => i.checked && values.includes(i.value))?.value ?? null;
}

export function readWorkPreference() {
  const slide = [...document.querySelectorAll('[data-test=carousel-slide]')].find((s) => /how would you like to work/i.test(s.innerText));
  if (!slide) return null;
  const boxes = [...slide.querySelectorAll('[data-qa=button-box]')].map((b) => ({ text: b.innerText.replace(/\s+/g, ' ').trim(), checked: !!b.querySelector('input')?.checked }));
  const c2h = slide.querySelector('label[data-test=checkbox-label] input');
  return { boxes, contractToHire: !!c2h?.checked };
}

export function readSpecialties() {
  return [...document.querySelectorAll('.specialties label')].filter((l) => l.querySelector('input')?.checked).map((l) => l.innerText.trim());
}

export function readSkills() {
  return [...document.querySelectorAll('.air3-tokenizer .air3-token-text')].map((t) => t.innerText.trim());
}

export function readCards() {
  return [...document.querySelectorAll('.carousel-list-item .card-content')].map((c) => c.innerText.trim());
}

// Rows of the languages step: English is fixed in the first row (dropdown-label-english), each added
// language is a pair of dropdowns numbered from 0. An unset dropdown shows "My level is" or "Select language".
export function readLanguages() {
  const val = (id) => {
    const t = document.querySelector('[aria-labelledby="' + id + '"]')?.innerText.trim() ?? null;
    return t && !/^(My level is|Select language)$/i.test(t) ? t : null;
  };
  const rows = [{ language: 'English', level: val('dropdown-label-english') }];
  for (let i = 0; document.querySelector('[aria-labelledby="dropdown-label-language-' + i + '"]'); i++) rows.push({ language: val('dropdown-label-language-' + i), level: val('dropdown-label-proficiency-' + i), index: i });
  return rows;
}

export const readValue = (sel) => document.querySelector(sel)?.value ?? null;
