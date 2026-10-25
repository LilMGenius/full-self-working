// 위시켓 partner onboarding and profile refresh, mapped on 2026-10-26 in the operator's signed-in Chrome.
// Every step reads the page first, compares it with what the instance says, and writes only the
// difference, so a rerun after a finished run changes nothing. A dry run (ctx.apply false) reads and
// plans; --apply writes, one item per paced action, and reads each section back.
//
// Page facts behind the code:
// - /accounts/settings/modify_identity/ shows the current identity as hidden inputs (business_form_value,
//   identify_number, user_type, company_name, representer_name, address_detail) and takes images only
//   through a display:none #upl input (multiple, name identity_images). Its script checks JPEG, PNG or GIF
//   magic bytes, then the submit input post_identity_image posts the form; 위시켓 staff read the
//   certificate and update the identity within 24 hours, and until then the page looks unchanged, so a
//   sent request is remembered as a ledger event (platform.identity_request).
// - The profile editor lives under /partners/p/<user>/<menu>/update/. The introduction edits at
//   .../introduction/update/edit/ in one form (description, strength, team_size, description_of_team,
//   5,000 characters each); the page warns that e-mail, phone, company name or homepage gets the text
//   deleted. Skills, career (employment) and awards (prize) are lists whose items the page's own script
//   posts by AJAX to the menu URL (submit_type new, csrf header) and deletes by GET
//   /partners/p/api/delete/<menu>/<pk>/; this module sends the same requests from the page.
// - Skill names come from 위시켓's stack vocabulary at /matching/stack/search/?startwith=<prefix>.
// - Education and certificates are offered to individual and team partners only; an individual business
//   partner (개인 사업자) sees them as 사용 불가 on /partners/p/<user>/info/update/.
import { gateOutbound, identityParts, namePattern } from '../../policy/gate.mjs';

const BASE = 'https://www.wishket.com';
const IDENTITY_URL = BASE + '/accounts/settings/modify_identity/';
const DAY_MS = 86_400_000;

export const STEPS = [
  { id: 'identity', detect: { path: /^\/accounts\/settings\/(?:modify|verify)_identity\/$/ } },
  { id: 'introduction', detect: { path: /^\/partners\/p\/[^/]+\/introduction\/update\// } },
  { id: 'employment', detect: { path: /^\/partners\/p\/[^/]+\/employment\/update\/$/ } },
  { id: 'prize', detect: { path: /^\/partners\/p\/[^/]+\/prize\/update\/$/ } },
  { id: 'skills', detect: { path: /^\/partners\/p\/[^/]+\/skill\/update\/$/ } },
  { id: 'education', detect: { path: /^\/partners\/p\/[^/]+\/info\/update\/$/, heading: /학력/ } },
  { id: 'portfolio', detect: { path: /^\/partners\/p\/[^/]+\/portfolio\/update\/$/ } },
  { id: 'availability', detect: { path: /^\/partners\/p\/[^/]+\/$/ } },
];

// ---- pure planning: instance -> desired page content ----

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const norm = (s) => String(s ?? '').replace(/[\s()]/g, '').toLowerCase();

// "2024.12 to present", "2021.03 to 2023.02", "2021.08" -> { start: '2024-12', end: '2023-02' | null }.
export function periodOf(text) {
  const months = [...String(text ?? '').matchAll(/(\d{4})\.(\d{1,2})/g)].map((m) => m[1] + '-' + m[2].padStart(2, '0'));
  if (!months.length) return null;
  const present = /present|현재/i.test(text ?? '');
  return { start: months[0], end: present ? null : months[1] ?? null };
}
const dotted = (ym) => (ym ? ym.replace('-', '.') : '');
const span = (p) => (p ? dotted(p.start) + ' ~ ' + (p.end ? dotted(p.end) : '현재') : '현재');

// A company name on the identity page against business.company: either the part before the brackets or
// the bracketed part matching counts, so an older trade name such as 옛상호(Oldname) does not.
export function sameCompany(page, wanted) {
  const parts = (s) => [String(s ?? '').split('(')[0], String(s ?? '').match(/\(([^)]+)\)/)?.[1]].map(norm).filter(Boolean);
  const a = parts(page);
  return parts(wanted).some((w) => a.includes(w));
}

const OWNER = /founder|owner|\bceo\b|대표|창업/i;
const TEACHER = /instructor|lecturer|teacher|강사|교수/i;
const isOwned = (r) => OWNER.test([r.title, r.title_ko].join(' '));

function masker(instance) {
  const { people, companies } = identityParts(instance);
  const res = [...people, ...companies].sort((a, b) => b.length - a.length).map((n) => namePattern(n, 'g'));
  return {
    hits: (text) => res.some((re) => (re.lastIndex = 0, re.test(text))),
  };
}

// The introduction in Korean from the profile. 위시켓 bars identifying names, so a summary sentence that
// names the operator or a company the operator owns is dropped (the dated career lines carry its facts),
// and an owned company is written as 창업 회사. Employers and schools stay, as the gate allows them.
export function introCopy(instance) {
  const p = instance.profile ?? {};
  const m = masker(instance);
  const sentences = String(p.summary_ko ?? '').split(/(?<=[.다])\s+/).map(squash).filter(Boolean);
  const lead = sentences.filter((s) => !m.hits(s)).join(' ');
  const roles = (p.roles ?? []).map((r) => {
    const per = periodOf(r.period);
    const org = isOwned(r) ? '창업 회사' : (r.org_ko ?? r.org);
    const what = [org, r.title_ko ?? r.title].filter(Boolean).join(' ');
    return { key: per?.start ?? '0000', line: '- ' + span(per) + ': ' + what + (r.detail_ko ? '. ' + r.detail_ko.replace(/\.$/, '') : '') };
  }).sort((a, b) => (a.key < b.key ? 1 : -1)).map((x) => x.line);
  const awards = (p.awards ?? []).map((a) => '- ' + (a.date ?? a.year) + ' ' + (a.name_ko ?? a.name));
  const edu = (p.education ?? []).map((e) => '- ' + [e.school_ko ?? e.school, e.field_ko ?? e.field].filter(Boolean).join(' ') + ', ' + (e.degree_ko ?? e.degree) + ' (' + String(e.period ?? '').replace(/ to /g, ' ~ ') + ')');
  const block = (title, rows) => (rows.length ? '[' + title + ']\n' + rows.join('\n') : '');
  const description = [lead, block('경력', roles), block('수상과 활동', awards), block('교육과 자격', edu)].filter(Boolean).join('\n\n');
  const LABELS = { web: '웹', app_and_backend: '앱과 백엔드', ai: 'AI', ops: '운영', design_and_content: '디자인과 콘텐츠', teaching: '교육' };
  const skills = p.skills_ko ?? p.skills ?? {};
  const strength = Object.entries(skills).map(([k, list]) => '- ' + (LABELS[k] ?? k) + ': ' + [list].flat().join(', ')).join('\n');
  return { description, strength, team_size: '', description_of_team: '' };
}

// Skill-name candidates from profile.skills: each entry, its parts around " and ", and each part's first
// word; the stack vocabulary decides which of them are skills.
export function skillCandidates(profile) {
  const out = [];
  for (const entry of Object.values(profile?.skills ?? {}).flat()) {
    for (const part of String(entry).split(/\s+and\s+/)) {
      const t = part.trim();
      out.push(t, t.split(/\s+/)[0]);
    }
  }
  return [...new Set(out.filter((t) => t.length >= 2))];
}

// The vocabulary's answer for a prefix, as names. The endpoint answers with HTML: known skills as
// .stack-result-list .stack-selector[data-tag-name], then a .write-direct-list entry that echoes whatever
// was typed, which is not vocabulary.
export function parseStackResult(html) {
  const known = String(html ?? '').split('write-direct-list')[0];
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return [...known.matchAll(/class="stack-selector"[^>]*?data-tag-name="([^"]+)"/g)].map((m) => decode(m[1]).trim());
}

export function pickSkills(candidates, vocabulary) {
  const byLower = new Map(vocabulary.map((v) => [v.toLowerCase(), v]));
  return [...new Set(candidates.map((c) => byLower.get(c.toLowerCase())).filter(Boolean))];
}

// The vocabulary is narrow (no RAG, Vite or Prompt Engineering on 2026-10-26), and the page also takes a
// typed name. onboarding.wishket.directSkills lists the names the operator wants typed; each one counts
// only when profile.skills mentions it, so the list cannot add a skill the profile does not back.
export function desiredSkills(profile, vocabulary, direct = []) {
  const text = Object.values(profile?.skills ?? {}).flat().join(' | ').toLowerCase();
  const backed = [direct ?? []].flat().filter((n) => n && text.includes(String(n).toLowerCase()));
  const picked = pickSkills(skillCandidates(profile), vocabulary);
  const seen = new Set(picked.map((n) => n.toLowerCase()));
  return [...picked, ...backed.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))];
}

const LEVEL = [[/founder|ceo|owner|대표/i, 'director'], [/principal|수석|lead|리드/i, 'techlead'], [/senior|시니어/i, 'senior']];
const ROLE = [[/founder|ceo|owner|대표/i, 'ceo'], [/\bai\b|ml|data/i, 'ai_ml_data_engineer']];
const pickBy = (table, text, fallback) => table.find(([re]) => re.test(text))?.[1] ?? fallback;

// Career items: every dated role that is not teaching (위시켓 has no instructor role; the introduction
// carries those). An owned company is a freelance item, since its name may not appear.
export function careerEntries(instance, skills = []) {
  const p = instance.profile ?? {};
  return (p.roles ?? []).filter((r) => periodOf(r.period) && !TEACHER.test([r.title, r.title_ko].join(' '))).map((r) => {
    const per = periodOf(r.period);
    const owned = isOwned(r);
    const title = [r.title, r.title_ko].join(' ');
    const fields = {
      is_freelance: owned ? 'true' : 'false',
      role: pickBy(ROLE, title, 'fullstack_developer'),
      level: pickBy(LEVEL, title, 'mid_level'),
      skills: skills.join('*!*'),
      company_name: owned ? '프리랜서' : (r.org_ko ?? r.org),
      position: r.title_ko ?? r.title,
      date_hired: per.start + '-01',
      description: r.detail_ko ?? (owned ? '창업 회사 ' : '') + (r.title_ko ?? r.title),
      project_history: '[]',
    };
    if (per.end) fields.date_retired = per.end + '-01';
    else fields.is_present = 'on';
    return { key: fields.company_name + '|' + per.start, fields };
  });
}

// Awards with an awarding body; judging and speaking have none and stay in the introduction.
export function prizeEntries(instance) {
  return (instance.profile?.awards ?? []).filter((a) => a.organization_ko || a.organization).map((a) => {
    const per = periodOf(a.date ?? '');
    return {
      key: a.name_ko ?? a.name,
      fields: { title: a.name_ko ?? a.name, organization: a.organization_ko ?? a.organization, date_prized: per ? per.start + '-01' : String(a.year) + '-01-01', description: '' },
    };
  });
}

// Compares page items with desired ones by key: what to add, what to delete (page items the profile does
// not hold) and what already matches.
export function planList(current, desired, keyOf = (x) => x.key) {
  const want = new Map(desired.map((d) => [norm(keyOf(d)), d]));
  const have = new Map(current.map((c) => [norm(keyOf(c)), c]));
  return {
    add: desired.filter((d) => !have.has(norm(keyOf(d)))),
    remove: current.filter((c) => !want.has(norm(keyOf(c)))),
    keep: current.filter((c) => want.has(norm(keyOf(c)))),
  };
}

export function gateTexts(texts, ctx) {
  const violations = [];
  for (const text of texts.filter((t) => String(t ?? '').trim())) {
    const g = gateOutbound({ kind: 'profile', platform: 'wishket', text }, { descriptor: ctx.descriptor, instance: ctx.instance });
    violations.push(...g.violations.map((v) => v.rule + ' ' + v.detail));
  }
  return violations;
}

// ---- page reads and writes ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = (step, state, detail) => ({ step, state, detail });

async function userPath(session) {
  const path = await session.evaluate(() => [...document.querySelectorAll('a[href^="/partners/p/"]')].map((a) => a.getAttribute('href')).find((h) => /^\/partners\/p\/[^/]+\/$/.test(h)) ?? null);
  if (!path) throw Object.assign(new Error('no /partners/p/<user>/ link; is the session signed in to 위시켓?'), { code: 'FSW_WISHKET_SIGNED_OUT' });
  return path;
}

export async function readIdentity(session) {
  return session.evaluate(() => {
    const v = (n) => document.querySelector('input[name="' + n + '"]')?.value ?? null;
    return { form: v('business_form_value'), number: v('identify_number'), type: v('user_type'), company: v('company_name'), upload: !!document.querySelector('input[name=identity_images]') };
  });
}

function pendingIdentity(ledger, now) {
  try {
    const row = ledger?.db?.prepare("SELECT at, payload FROM events WHERE kind = 'platform.identity_request' AND platform = 'wishket' ORDER BY at DESC LIMIT 1").get();
    return row && now - Date.parse(row.at) < 2 * DAY_MS ? row : null;
  } catch {
    return null;
  }
}

async function identityStep(session, ctx) {
  const { instance, apply, ledger } = ctx;
  await session.navigate(IDENTITY_URL);
  const id = await readIdentity(session);
  const business = instance.business ?? {};
  const want = String(business.bizRegNo ?? '').replace(/\D/g, '');
  if (id.number && want && id.number.replace(/\D/g, '') !== want) {
    return result('identity', 'needs-operator', 'the verified registration number differs from business.bizRegNo; 위시켓 allows no change to another identity, so this needs a new account or the operator');
  }
  if (sameCompany(id.company, business.company)) return result('identity', 'done', 'identity shows ' + id.type + ' ' + id.form + ' under the business company name');
  const pending = pendingIdentity(ledger, Date.now());
  if (pending) return result('identity', 'filled', 'a certificate was sent at ' + pending.at + ' and 위시켓 reviews it within 24 hours; the page still shows the old trade name');
  const file = instance.config?.onboarding?.wishket?.certificate;
  if (!file) return result('identity', 'needs-operator', 'the page shows an older trade name; set onboarding.wishket.certificate to an image of the current business registration certificate');
  if (!/\.(jpe?g|png|gif)$/i.test(file)) return result('identity', 'needs-operator', 'onboarding.wishket.certificate must be a JPEG, PNG or GIF image; the page refuses other files');
  if (!apply) return result('identity', 'filled', 'dry run: would upload ' + file.split(/[\\/]/).pop() + ' to replace the older trade name');
  await session.evaluate(() => Object.assign(document.querySelector('#upl').style, { display: 'block', width: '200px', height: '30px' }));
  await session.setFiles('#upl', file);
  await sleep(2500);
  const ready = await session.evaluate(() => {
    document.querySelector('#upl').style.display = 'none';
    return { complete: document.querySelector('#is_attach_complete')?.value, listed: document.querySelector('.attachment_ul')?.innerText ?? '' };
  });
  if (ready.complete !== 'true' || !ready.listed) return result('identity', 'needs-operator', 'the page did not accept the image (its byte check failed or the list stayed empty)');
  await session.click('input[name=post_identity_image]');
  await sleep(6000);
  const done = await session.evaluate(() => /수정 요청 완료|세부 정보 수정 요청이 완료/.test(document.body.innerText));
  if (!done) return result('identity', 'needs-operator', 'submitted, but the page did not confirm the request');
  ledger?.addEvent({ kind: 'platform.identity_request', platform: 'wishket', ref: 'identity', payload: { file: file.split(/[\\/]/).pop() } });
  return result('identity', 'filled', 'certificate sent; 위시켓 updates the identity within 24 hours and reports by SMS and e-mail');
}

async function readIntro(session) {
  return session.evaluate(() => Object.fromEntries(['description', 'strength', 'team_size', 'description_of_team'].map((n) => [n, document.querySelector('form [name="' + n + '"]')?.value ?? null])));
}

// The editor opens from the view's edit icon (a[href=edit]), as the page does; a direct load of the
// edit URL sometimes shows the view instead.
async function openIntroEditor(session, user) {
  await session.navigate(BASE + user + 'introduction/update/');
  for (let i = 0; i < 2; i++) {
    if ((await readIntro(session)).description !== null) return true;
    const link = await session.evaluate(() => !!document.querySelector('.edit-box-view a[href="edit"]'));
    if (link) await session.click('.edit-box-view a[href="edit"]');
    else await session.navigate(BASE + user + 'introduction/update/edit/');
    for (let t = 0; t < 8 && (await readIntro(session)).description === null; t++) await sleep(1000);
  }
  return (await readIntro(session)).description !== null;
}

async function introStep(session, ctx, user) {
  const want = introCopy(ctx.instance);
  const bad = gateTexts([want.description, want.strength], ctx);
  if (bad.length) return result('introduction', 'needs-operator', 'the gate refused the introduction: ' + bad.join('; '));
  if (!(await openIntroEditor(session, user))) return result('introduction', 'unmapped', 'the introduction editor did not open from ' + user + 'introduction/update/');
  const have = await readIntro(session);
  const changed = Object.keys(want).filter((k) => squash(have[k]) !== squash(want[k]));
  if (!changed.length) return result('introduction', 'done', 'introduction matches the profile');
  if (!ctx.apply) return result('introduction', 'filled', 'dry run: would replace ' + changed.join(', '));
  for (const k of changed) {
    if (want[k]) await session.fill('[name="' + k + '"]', want[k]);
    else await session.evaluate((n) => { const e = document.querySelector('[name="' + n + '"]'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }, k);
  }
  await session.evaluate(() => document.querySelector('.edit-menu-box form .btn-submit, form .btn-submit')?.setAttribute('data-fsw', 'intro-submit'));
  await session.click('[data-fsw=intro-submit]');
  await sleep(4000);
  await openIntroEditor(session, user);
  const back = await readIntro(session);
  const still = Object.keys(want).filter((k) => squash(back[k]) !== squash(want[k]));
  if (still.length) return result('introduction', 'needs-operator', 'saved, but the read back differs in ' + still.join(', '));
  ctx.ledger?.addEvent({ kind: 'platform.profile_edit', platform: 'wishket', ref: 'introduction', payload: { fields: changed } });
  return result('introduction', 'done', 'replaced ' + changed.join(', ') + ' and read back');
}

// Items of a list menu: pk and the view's title line.
async function readItems(session, menu) {
  return session.evaluate((menu) => [...document.querySelectorAll('.edit-box-view .box')].map((b) => {
    const pk = b.querySelector('input[name=pk]')?.value ?? b.querySelector('.edit-box')?.dataset.target ?? null;
    const view = b.querySelector('.view-box-content');
    const title = (view?.querySelector('.title, .body-1-medium')?.innerText ?? '').trim();
    const date = (view?.querySelector('.date-employ')?.innerText ?? '').match(/(\d{4})년\s*(\d{2})월/);
    const company = (view?.querySelector('.info-content')?.innerText ?? '').trim();
    return { pk, title, start: date ? date[1] + '-' + date[2] : null, company, menu };
  }).filter((x) => x.pk), menu);
}

async function post(session, fields) {
  session.guard.beforeAction();
  return session.evaluate(async (fields) => {
    const token = document.querySelector('input[name=csrfmiddlewaretoken]')?.value;
    const r = await fetch(location.pathname, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRFToken': token, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: new URLSearchParams({ ...fields, submit_type: 'new' }).toString() });
    const text = await r.text();
    return { status: r.status, body: text.slice(0, 300) };
  }, fields);
}

async function remove(session, menu, pk) {
  session.guard.beforeAction();
  return session.evaluate(async ([menu, pk]) => (await fetch('/partners/p/api/delete/' + menu + '/' + pk + '/', { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })).status, [menu, pk]);
}

async function stackVocabulary(session, candidates) {
  const pages = await session.evaluate(async (cands) => {
    const out = [];
    for (const c of cands) out.push(await (await fetch('/matching/stack/search/?' + new URLSearchParams({ startwith: c, selected: '' }), { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })).text());
    return out;
  }, candidates, { timeoutMs: 60_000 });
  return [...new Set(pages.flatMap(parseStackResult))];
}

// One list menu: plan, then (with apply) delete what the profile does not hold and add what is missing,
// within the descriptor's hourly action budget; a rerun continues where the budget stopped.
async function listStep(session, ctx, { id, menu, url, desired, keyOfPage }) {
  await session.navigate(url);
  const items = await readItems(session, menu);
  const plan = planList(items.map((i) => ({ ...i, key: keyOfPage(i) })), desired);
  const summary = 'keep ' + plan.keep.length + ', add ' + plan.add.length + ', delete ' + plan.remove.length;
  if (!plan.add.length && !plan.remove.length) return result(id, 'done', 'matches the profile (' + plan.keep.length + ' items)');
  if (!ctx.apply) return result(id, 'filled', 'dry run: ' + summary + (plan.remove.length ? ' (' + plan.remove.map((r) => r.key).join(', ') + ')' : ''));
  const failures = [];
  let done = 0;
  try {
    for (const r of plan.remove) {
      const status = await remove(session, menu, r.pk);
      if (status === 200) done += 1;
      else failures.push('delete ' + r.key + ' answered ' + status);
    }
    for (const d of plan.add) {
      const r = await post(session, d.fields);
      if (r.status === 200) done += 1;
      else failures.push('add ' + d.key + ' answered ' + r.status + ' ' + r.body.replace(/\s+/g, ' ').slice(0, 120));
    }
  } catch (err) {
    if (err.code !== 'FSW_PACING_LIMIT') throw err;
    failures.push('stopped at the hourly action budget; rerun to continue');
  }
  await session.navigate(url);
  const after = planList((await readItems(session, menu)).map((i) => ({ ...i, key: keyOfPage(i) })), desired);
  if (done) ctx.ledger?.addEvent({ kind: 'platform.profile_edit', platform: 'wishket', ref: id, payload: { changes: done } });
  if (!after.add.length && !after.remove.length) return result(id, 'done', summary + ', read back');
  return result(id, failures.some((f) => /budget/.test(f)) ? 'filled' : 'needs-operator', 'after writing: add ' + after.add.length + ', delete ' + after.remove.length + ' remain; ' + failures.join('; '));
}

async function educationStep(session, user) {
  await session.navigate(BASE + user + 'info/update/');
  const text = await session.evaluate(() => document.body.innerText);
  if (/학력[\s\S]{0,80}사용 불가/.test(text)) return result('education', 'done', 'education and certificates are not offered to an individual business partner; the introduction lists them');
  return result('education', 'unmapped', 'education is offered for this partner type and its form is not mapped yet');
}

async function portfolioStep(session, user) {
  await session.navigate(BASE + user);
  const text = await session.evaluate(() => document.body.innerText);
  const count = Number(text.match(/포트폴리오\s*\n\s*(\d+)/)?.[1] ?? NaN);
  if (count > 0) return result('portfolio', 'done', count + ' portfolio item(s) listed');
  return result('portfolio', 'needs-operator', '위시켓 requires a portfolio item before applying to 외주 projects; an item needs images and the client\'s permission for portfolio use, which the operator gives');
}

async function availabilityStep(session, user) {
  await session.navigate(BASE + user);
  const header = await session.evaluate(() => (document.querySelector('.profile-box')?.innerText ?? '').replace(/\s+/g, ' '));
  const state = header.match(/활동 가능|협의 필요|활동 불가/)?.[0] ?? null;
  if (state === '활동 가능') return result('availability', 'done', 'shows 활동 가능; region and start date come from the account settings the operator keeps');
  return result('availability', 'needs-operator', 'profile shows ' + (state ?? 'no availability badge') + '; the operator sets it in the profile header');
}

export async function onboard(session, ctx) {
  const only = ctx.step ?? null;
  const log = ctx.log ?? (() => {});
  const out = [];
  const want = (id) => !only || only === id;
  let user = null;
  const userOf = async () => {
    if (user) return user;
    if (!/wishket\.com/.test(await session.evaluate(() => location.href).catch(() => ''))) await session.navigate(IDENTITY_URL);
    return (user = await userPath(session));
  };
  const run = async (id, fn) => {
    if (!want(id)) return;
    try {
      const r = await fn();
      out.push(r);
      log(id + ': ' + r.state + ' ' + r.detail);
    } catch (err) {
      if (/timed out|timeout/i.test(err.message)) {
        out.push(result(id, 'needs-operator', 'browser timed out: ' + err.message));
        throw err;
      }
      throw err;
    }
  };
  await run('identity', () => identityStep(session, ctx));
  await run('introduction', async () => introStep(session, ctx, await userOf()));
  await run('employment', async () => {
    const u = await userOf();
    await session.navigate(BASE + u + 'skill/update/');
    const skills = desiredSkills(ctx.instance.profile, await stackVocabulary(session, skillCandidates(ctx.instance.profile)), ctx.instance.config?.onboarding?.wishket?.directSkills);
    const entries = careerEntries(ctx.instance, skills);
    const bad = gateTexts(entries.flatMap((e) => [e.fields.company_name, e.fields.position, e.fields.description]), ctx);
    if (bad.length) return result('employment', 'needs-operator', 'the gate refused a career item: ' + bad.join('; '));
    return listStep(session, ctx, { id: 'employment', menu: 'employment', url: BASE + u + 'employment/update/', desired: entries, keyOfPage: (i) => (i.title === '프리랜서' ? '프리랜서' : i.company || i.title) + '|' + i.start });
  });
  await run('prize', async () => {
    const u = await userOf();
    const entries = prizeEntries(ctx.instance);
    const bad = gateTexts(entries.flatMap((e) => [e.fields.title, e.fields.organization]), ctx);
    if (bad.length) return result('prize', 'needs-operator', 'the gate refused an award: ' + bad.join('; '));
    return listStep(session, ctx, { id: 'prize', menu: 'prize', url: BASE + u + 'prize/update/', desired: entries, keyOfPage: (i) => i.title });
  });
  await run('skills', async () => {
    const u = await userOf();
    await session.navigate(BASE + u + 'skill/update/');
    const vocab = await stackVocabulary(session, skillCandidates(ctx.instance.profile));
    const names = desiredSkills(ctx.instance.profile, vocab, ctx.instance.config?.onboarding?.wishket?.directSkills);
    if (!names.length) return result('skills', 'needs-operator', 'no profile skill matched 위시켓\'s stack vocabulary');
    return listStep(session, ctx, { id: 'skills', menu: 'skill', url: BASE + u + 'skill/update/', desired: names.map((n) => ({ key: n, fields: { title: n } })), keyOfPage: (i) => i.title });
  });
  await run('education', async () => educationStep(session, await userOf()));
  await run('portfolio', async () => portfolioStep(session, await userOf()));
  await run('availability', async () => availabilityStep(session, await userOf()));
  return out;
}

