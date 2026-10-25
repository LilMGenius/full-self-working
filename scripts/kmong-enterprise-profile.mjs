#!/usr/bin/env node
// Fills the kmong enterprise profile (/enterprise/seller/profile?step=4) from the operator's recorded
// decisions in <instance>/platforms/kmong-enterprise-profile.json (examples/kmong-enterprise-profile.json
// shows the shape), so the judgement of what to enter is made once and every rerun replays it.
//   node scripts/kmong-enterprise-profile.mjs <section>...   sections: headline intro skills years careers
//   portfolios education awards resume consent register state
// Each section opens its editor, fills it, saves and reads the page back; entries already in their
// section are skipped, so a rerun adds only what is missing. Widget values change page state only, so they
// go through page functions; loads, editor opens, month pickers, uploads and saves go through the driver
// and its pacing guard. Nothing registers unless "register" is named, after "consent" in the same run.
// The surface it drives was mapped on 2026-10-25; the operator's <instance>/platforms/kmong-notes.md keeps that map.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withSession } from '../src/browser/driver.mjs';
import { loadInstance } from '../src/core/instance.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';

const instance = loadInstance();
const ev = join(instance.dir, 'qa', 'kmong-enterprise');
mkdirSync(ev, { recursive: true });
const URL = 'https://kmong.com/enterprise/seller/profile?step=4';
const D = JSON.parse(readFileSync(join(instance.paths.platforms, 'kmong-enterprise-profile.json'), 'utf8'));
const textOf = (snap) => (typeof snap === 'string' ? snap : snap.text);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const note = (...a) => { const l = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); log.push(l); console.log(l); };

// ---- page functions ----
function pModal() {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = [...document.querySelectorAll('[role=dialog],[class*=modal],[class*=Modal]')].filter(vis).at(-1);
  if (!d) return null;
  return { title: (d.querySelector('h1,h2,h3,h4,strong,p')?.innerText ?? '').trim().slice(0, 40), text: d.innerText.slice(0, 1200) };
}
function pMark({ selector, index = 0, mark, where = 'modal' }) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = where === 'modal' ? [...document.querySelectorAll('[role=dialog],[class*=modal],[class*=Modal]')].filter(vis).at(-1) : document;
  if (!d) return false;
  const el = [...d.querySelectorAll(selector)][index];
  if (!el) return false;
  document.querySelectorAll('[data-fsw="' + mark + '"]').forEach((x) => x.removeAttribute('data-fsw'));
  el.setAttribute('data-fsw', mark);
  return true;
}
function pSet({ mark, value }) {
  const el = document.querySelector('[data-fsw="' + mark + '"]');
  if (!el) return { ok: false };
  el.focus();
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: el.value };
}
function pClickText({ text, scope = 'modal' }) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = scope === 'modal' ? [...document.querySelectorAll('[role=dialog],[class*=modal],[class*=Modal]')].filter(vis).at(-1) : document;
  if (!d) return { ok: false, reason: 'no scope' };
  const el = [...d.querySelectorAll('button, label, [role=button]')].filter(vis).find((b) => b.innerText.trim() === text);
  if (!el) return { ok: false, reason: 'no ' + text };
  if (el.disabled) return { ok: false, reason: text + ' disabled' };
  el.click();
  return { ok: true };
}
function pOptions() {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('[id*="-option-"]')].filter(vis).map((o) => o.innerText.trim());
}
function pPickOption(label) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const o = [...document.querySelectorAll('[id*="-option-"]')].filter(vis).find((x) => x.innerText.trim() === label);
  if (!o) return false;
  o.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  o.click();
  return true;
}
// Opens a react-select menu the way the control expects: a mousedown on its control element.
function pOpenSelect(mark) {
  const input = document.querySelector('[data-fsw="' + mark + '"]');
  if (!input) return false;
  let control = input;
  for (let i = 0; i < 6 && control && !/control/i.test(control.className?.toString() ?? ''); i++) control = control.parentElement;
  (control ?? input.parentElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  return true;
}
function pDatepicker({ year, month }) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const picker = [...document.querySelectorAll('.react-datepicker')].filter(vis).at(-1);
  if (!picker) return { ok: false, reason: 'no datepicker' };
  const shown = Number((picker.innerText.match(/(\d{4})년/) ?? [])[1]);
  if (!shown) return { ok: false, reason: 'no year header' };
  if (shown !== year) {
    const want = shown > year ? '<' : '>';
    const nav = [...picker.querySelectorAll('button')].find((b) => b.innerText.trim() === want || (b.getAttribute('aria-label') ?? '').toLowerCase().includes(shown > year ? 'previous' : 'next'));
    if (!nav) return { ok: false, reason: 'no year navigation' };
    if (nav.disabled) return { ok: false, reason: 'year navigation ' + want + ' disabled at ' + shown };
    nav.click();
    return { ok: true, moved: true, shown };
  }
  const opt = [...picker.querySelectorAll('[role=option]')].find((o) => (o.getAttribute('aria-label') ?? '').includes(month + '월 ' + year) || o.innerText.trim() === month + '월');
  if (!opt) return { ok: false, reason: 'no month ' + month };
  if (opt.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'month disabled' };
  opt.click();
  return { ok: true, picked: true };
}
function pFieldValues() {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = [...document.querySelectorAll('[role=dialog],[class*=modal],[class*=Modal]')].filter(vis).at(-1);
  if (!d) return null;
  return [...d.querySelectorAll('input, textarea')].filter((e) => vis(e) && e.type !== 'file').map((e) => ({ ph: e.placeholder || e.name || e.type, value: e.type === 'checkbox' || e.type === 'radio' ? e.checked : e.value }));
}
function pErrors() {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('p,span,div')].filter((e) => !e.children.length && vis(e) && /(해 주세요|해주세요|입력|선택|없어요|초과)/.test(e.innerText.trim()) && /rgb\((2[0-9]{2}|1[5-9][0-9]), ?[0-9]{1,2}, ?[0-9]{1,2}\)/.test(getComputedStyle(e).color)).map((e) => e.innerText.trim()).slice(0, 8);
}
function pSection(label) {
  const t = document.body.innerText;
  const at = t.indexOf(label);
  return at < 0 ? null : t.slice(at, at + 700);
}
// The text of one section of the page: from the last heading line equal to start up to the next heading
// line equal to end, so an entry is not mistaken for one that only appears in the intro text.
function pSectionBetween({ start, end }) {
  const lines = document.body.innerText.split('\n').map((l) => l.trim());
  let a = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i] === start) { a = i; break; }
  if (a < 0) return '';
  let b = lines.findIndex((l, i) => i > a && l === end);
  if (b < 0) b = lines.length;
  return lines.slice(a + 1, b).join('\n');
}
const inSection = async (s, start, end, needle) => (await s.evaluate(pSectionBetween, { start, end })).split('\n').includes(needle);

// ---- driver steps ----
async function openEditor(s, section) {
  const snap = textOf(await s.snapshot({ interactive: false })).split('\n');
  const at = snap.findIndex((l) => l.trim().startsWith('heading "' + section));
  if (at < 0) throw new Error('no heading ' + section);
  const line = snap.slice(at + 1).find((l) => /@e\d+ button "(편집|추가하기)"/.test(l));
  if (!line) throw new Error('no editor button for ' + section);
  await s.click(line.match(/@e\d+/)[0]);
  await wait(2500);
  const m = await s.evaluate(pModal);
  if (!m) throw new Error('editor for ' + section + ' did not open');
  return m;
}
async function setField(s, selector, value, index = 0) {
  if (!(await s.evaluate(pMark, { selector, index, mark: 'f' }))) throw new Error('no field ' + selector + '#' + index);
  const r = await s.evaluate(pSet, { mark: 'f', value });
  if (!r.ok || r.value !== value) throw new Error('field ' + selector + ' holds ' + JSON.stringify(r.value));
}
async function pickMonth(s, placeholder, ym) {
  const [year, month] = ym.split('.').map(Number);
  if (!(await s.evaluate(pMark, { selector: 'input[placeholder="' + placeholder + '"]', mark: 'm' }))) throw new Error('no month input ' + placeholder);
  await s.click('[data-fsw=m]');
  await wait(800);
  for (let i = 0; i < 40; i++) {
    const r = await s.evaluate(pDatepicker, { year, month });
    if (!r.ok) throw new Error(placeholder + ' ' + ym + ': ' + r.reason);
    if (r.picked) break;
    await wait(250);
  }
  await wait(500);
}
async function pickSelect(s, inputIndex, query, label) {
  if (!(await s.evaluate(pMark, { selector: 'input[id^="react-select"][id$="-input"]', index: inputIndex, mark: 'rs' }))) throw new Error('no select #' + inputIndex);
  if (query !== null) await s.evaluate(pSet, { mark: 'rs', value: query });
  else await s.evaluate(pOpenSelect, 'rs');
  await wait(1300);
  if (!(await s.evaluate(pPickOption, label))) throw new Error('no option ' + label + ' (shown: ' + JSON.stringify(await s.evaluate(pOptions)) + ')');
  await wait(600);
}
async function toggle(s, text) {
  const r = await s.evaluate(pClickText, { text });
  if (!r.ok) throw new Error(r.reason);
  await wait(400);
}
async function upload(s, path) {
  // The file input is hidden behind a 파일 첨부하기 button; the upload tool clicks the visible trigger and
  // answers the file chooser it opens.
  const marked = await s.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const d = [...document.querySelectorAll('[role=dialog],[class*=modal],[class*=Modal]')].filter(vis).at(-1);
    const b = d && [...d.querySelectorAll('button, label')].filter(vis).find((x) => x.innerText.trim() === '파일 첨부하기');
    if (!b) return false;
    document.querySelectorAll('[data-fsw="file"]').forEach((x) => x.removeAttribute('data-fsw'));
    b.setAttribute('data-fsw', 'file');
    return true;
  });
  if (!marked) throw new Error('no 파일 첨부하기 trigger');
  await s.setFiles('[data-fsw=file]', resolve(instance.dir, path));
  await wait(4000);
  const shown = await s.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const d = [...document.querySelectorAll('[role=dialog],[class*=modal],[class*=Modal]')].filter(vis).at(-1);
    return d ? d.innerText.slice(0, 800) : null;
  });
  note('after upload', (shown ?? '').replace(/\s+/g, ' ').slice(0, 300));
}
async function save(s, what) {
  const before = await s.evaluate(pFieldValues);
  s.guard.beforeAction();
  const r = await s.evaluate(pClickText, { text: '저장' });
  if (!r.ok) throw new Error(what + ': ' + r.reason + ' ' + JSON.stringify(before));
  await wait(3000);
  const still = await s.evaluate(pModal);
  if (still) {
    const errors = await s.evaluate(pErrors);
    await s.screenshot(ev + '/fail-' + what.replace(/[^a-z0-9]+/gi, '-') + '.jpg');
    throw new Error(what + ': the editor stayed open: ' + JSON.stringify(errors) + ' values ' + JSON.stringify(before));
  }
  note('saved', what);
}
const cancel = async (s) => { await s.evaluate(pClickText, { text: '취소' }); await wait(1200); };

const SECTIONS = {
  async headline(s) {
    await openEditor(s, '한줄 소개');
    await setField(s, 'input[type=text]', D.headline);
    await save(s, 'headline');
  },
  async intro(s) {
    await openEditor(s, '소개');
    await setField(s, 'textarea', D.intro);
    await save(s, 'intro');
  },
  async skills(s) {
    const page = await s.evaluate(() => document.body.innerText);
    for (const skill of D.skills) {
      if (new RegExp('(^|\\n)' + skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\n|$)').test(page)) { note('skill present', skill); continue; }
      await openEditor(s, '보유기술');
      try {
        await pickSelect(s, 0, skill, skill);
        await save(s, 'skill ' + skill);
      } catch (err) {
        note('skill failed', skill, err.message);
        await cancel(s);
      }
    }
  },
  async careers(s) {
    for (const c of D.careers) {
      if (await inSection(s, '경력*', '프로젝트 이력', c.company)) { note('career present', c.company); continue; }
      await openEditor(s, '경력');
      try {
        await setField(s, 'input[name=companyName]', c.company);
        await pickMonth(s, '시작 연월', c.start);
        if (c.end) await pickMonth(s, '마감 연월', c.end);
        else await toggle(s, '재직 중');
        for (const k of c.skills) await pickSelect(s, 0, k, k);
        await setField(s, 'textarea[name=description]', c.description);
        await save(s, 'career ' + c.company);
      } catch (err) {
        note('career failed', c.company, err.message);
        await cancel(s);
        throw err;
      }
    }
  },
  async portfolios(s) {
    for (const p of D.portfolios) {
      if (await inSection(s, '포트폴리오*', '최종 학력', p.title)) { note('portfolio present', p.title); continue; }
      await openEditor(s, '포트폴리오');
      try {
        await setField(s, 'input[name=title]', p.title);
        await pickMonth(s, '시작 연월', p.start);
        if (p.end) await pickMonth(s, '마감 연월', p.end);
        else await toggle(s, '진행 중');
        for (const k of p.skills) await pickSelect(s, 0, k, k);
        await setField(s, 'input[placeholder="ex. 100"]', String(p.participation));
        await setField(s, 'input[name=role]', p.role);
        await upload(s, p.file);
        await save(s, 'portfolio ' + p.title);
      } catch (err) {
        note('portfolio failed', p.title, err.message);
        await cancel(s);
        throw err;
      }
    }
  },
  async education(s) {
    for (const e of D.education) {
      if (await inSection(s, '학력*', '인증 ∙ 수상 ∙ 자격증', e.school)) { note('education present', e.school); continue; }
      await openEditor(s, '학력');
      try {
        await setField(s, 'input[name=schoolName]', e.school);
        await pickSelect(s, 0, null, e.type);
        await setField(s, 'input[name=major]', e.major);
        await pickMonth(s, '입학 연월', e.start);
        await pickMonth(s, '졸업 연월', e.end);
        await save(s, 'education ' + e.school);
      } catch (err) {
        note('education failed', e.school, err.message);
        await cancel(s);
        throw err;
      }
    }
  },
  async awards(s) {
    for (const a of D.awards) {
      if (await inSection(s, '인증 ∙ 수상 ∙ 자격증', '이력서*', a.title)) { note('award present', a.title); continue; }
      await openEditor(s, '인증 ∙ 수상 ∙ 자격증');
      try {
        await setField(s, 'input[name=title]', a.title);
        await setField(s, 'input[name=organization]', a.organization);
        await pickMonth(s, '수여 연월', a.date);
        await save(s, 'award ' + a.title);
      } catch (err) {
        note('award failed', a.title, err.message);
        await cancel(s);
      }
    }
  },
  async resume(s) {
    await openEditor(s, '이력서');
    await upload(s, D.resume);
    await save(s, 'resume');
  },
  async consent(s) {
    const r = await s.evaluate((wantThird) => {
      const textNear = (i) => { let n = i; for (let k = 0; k < 4 && n; k++, n = n.parentElement) { const t = (n.innerText ?? '').trim(); if (t) return t; } return ''; };
      const boxes = [...document.querySelectorAll('input[type=checkbox]')].map((i) => ({ i, text: textNear(i) }));
      const fee = boxes.find((b) => b.text.includes('엔터프라이즈 중개 수수료'));
      const third = boxes.find((b) => b.text.includes('제3자 제공'));
      if (!fee) return { ok: false, reason: 'no fee consent box', seen: boxes.map((b) => b.text.slice(0, 60)) };
      if (!fee.i.checked) (fee.i.closest('label') ?? fee.i).click();
      if (third && third.i.checked !== wantThird) (third.i.closest('label') ?? third.i).click();
      return { ok: true, fee: fee.i.checked, third: third?.i.checked ?? null };
    }, D.consents.thirdParty);
    if (!r.ok || !r.fee) throw new Error('consent: ' + JSON.stringify(r));
    note('consents', r);
  },
  async register(s) {
    if (!(await s.evaluate(pMark, { selector: 'button', mark: 'reg', where: 'page', index: 0 }))) throw new Error('no buttons');
    const marked = await s.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '등록하기');
      if (!b) return false;
      document.querySelectorAll('[data-fsw="reg"]').forEach((x) => x.removeAttribute('data-fsw'));
      b.setAttribute('data-fsw', 'reg');
      return { disabled: b.disabled };
    });
    if (!marked || marked.disabled) throw new Error('등록하기 is ' + (marked ? 'disabled' : 'missing'));
    await s.click('[data-fsw=reg]');
    await wait(5000);
    const after = await s.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 1500), dialogs: [...document.querySelectorAll('[role=dialog],[role=alertdialog],[class*=modal],[class*=Modal]')].filter((e) => e.getBoundingClientRect().width > 0).map((d) => d.innerText.slice(0, 400)) }));
    writeFileSync(ev + '/register-after.json', JSON.stringify(after, null, 1));
    await s.screenshot(ev + '/register-after.jpg');
    note('register', { url: after.url, dialogs: after.dialogs, errors: await s.evaluate(pErrors) });
  },
  async years(s) {
    const m = await openEditor(s, '총 경력 연수');
    if (!/총 경력 연수 편집/.test(m.text)) throw new Error('wrong editor: ' + m.title);
    await setField(s, 'input[placeholder="ex. 0~100"]', String(D.totalCareer.years));
    await setField(s, 'input[placeholder="ex. 0~11"]', String(D.totalCareer.months));
    await save(s, 'total career');
  },
  async state(s) {
    const t = await s.evaluate(() => document.body.innerText);
    writeFileSync(ev + '/state.txt', t);
    await s.screenshot(ev + '/state-top.jpg');
    note('state saved', t.length);
  },
};

const order = process.argv.slice(2);
if (!order.length) {
  console.error('usage: node scripts/kmong-enterprise-profile.mjs <section>... (' + Object.keys(SECTIONS).join(' ') + ')');
  process.exit(1);
}
await withSession('kmong-ent-fill', async (s) => {
  await s.navigate(URL, { settle: 6000 });
  for (const name of order) {
    if (!SECTIONS[name]) throw new Error('no section ' + name);
    note('== ' + name);
    await SECTIONS[name](s);
  }
}, { platform: 'kmong', pacing: loadDescriptor('kmong').pacing }).finally(() => writeFileSync(ev + '/fill-log-' + Date.now() + '.txt', log.join('\n')));

