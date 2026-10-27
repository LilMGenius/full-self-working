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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEligible, rankPortfolio } from '../../portfolio/rank.mjs';

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

// ---- portfolio planning ----

// 위시켓 asks for one portfolio item before a partner applies to projects (mapped 2026-10-26 at
// /partners/p/<user>/portfolio/update/add/). Its form takes a title, 업무 범위 (category: develop, design,
// plan), 카테고리 (subcategory: web, android, ios, pc, embedded, etc), up to three 분야 (field_subcategory
// values), skills joined by *!*, start and end month as YYYY.MM., a participation rate, an optional
// client and role, a description (5,000 characters) and at least one image. The page deletes text that
// carries an e-mail, phone, company name or homepage, so the text names what was built and how.
// Keywords in an item's text pick the 분야; the item chosen is the best ranked one with an image and a
// dated period whose text passes, preferring one that lands in an AI 분야, since 위시켓's web and AI
// projects are the ones this operator answers.
const FIELD_WORDS = [
  [/\bAI\b|LLM|에이전트|agent/i, 'gen_ai'],
  [/챗봇|chatbot/i, 'chat_gpt_chatbot'],
  [/LLM/i, 'llm'],
  [/랜딩|landing/i, 'landing_introduction_page'],
  [/게임|game/i, 'game_reward'],
  [/회사 사이트|홈페이지|website/i, 'website_board'],
  [/SaaS|솔루션|엔진|engine/i, 'saas_solution'],
];
const AI_FIELDS = new Set(['gen_ai', 'chat_gpt_chatbot', 'llm']);
const URLISH = /https?:\/\/|www\.|\b[\w-]+\.(?:com|ai|io|net|kr|co|dev|app)\b/i;
const ym = (s) => String(s ?? '').replace(/^(\d{4})-(\d{2}).*$/, '$1.$2.');

export function portfolioFields(text) {
  return [...new Set(FIELD_WORDS.filter(([re]) => re.test(text)).map(([, f]) => f))].slice(0, 3);
}

// One candidate per eligible item: the form fields it would fill, or why it cannot be used. An item's
// period ({ start: 'YYYY-MM', end: 'YYYY-MM' or null for ongoing work }) and participation ({ rate })
// are facts read from the project's own record, such as its repository's creation date and the
// operator's share of its commits; ongoing work ends at the current month, and only a project the
// profile lists with the role Author counts as 100 percent without a recorded rate.
export function portfolioCandidates(instance, items, { month }) {
  const m = masker(instance);
  const projects = instance.profile?.projects ?? [];
  return rankPortfolio(items.filter(isEligible)).map((item) => {
    const project = projects.find((p) => p.name === item.title_en) ?? projects.find((p) => item.url && p.url === item.url) ?? {};
    const image = (item.media ?? []).find((x) => x.kind === 'image');
    const title = item.title_ko ?? item.title_en ?? '';
    const role = project.role_ko ?? project.role ?? '';
    const rate = item.participation?.rate ?? (/^Author$/.test(project.role ?? '') ? 100 : null);
    const ongoing = !item.period?.end;
    const description = [item.summary_ko ?? '', role && '역할: ' + role, project.stack?.length && '사용 기술: ' + project.stack.join(', '), ongoing && '현재 진행 중인 프로젝트입니다.'].filter(Boolean).join('\n');
    const texts = [title, description, role];
    const why = !image ? 'no image' : !item.period?.start ? 'no period' : !rate ? 'no participation rate' : texts.some((t) => m.hits(t)) ? 'names the operator or a company' : texts.some((t) => URLISH.test(t)) ? 'carries an address' : null;
    const fields = portfolioFields([title, item.summary_ko, item.title_en, item.summary_en].join(' '));
    return {
      id: item.id,
      why,
      ai: fields.some((f) => AI_FIELDS.has(f)),
      image: image ? join(instance.paths?.portfolio ?? '', image.src) : null,
      form: { title, category: ['develop'], subcategory: ['web'], field_subcategory: fields, skills: (project.stack ?? []).join('*!*'), date_started: ym(item.period?.start), date_ended: ym(item.period?.end ?? month), participation_rate: String(rate ?? ''), role, description, caption: title },
    };
  });
}

export function pickPortfolio(candidates, ctx) {
  const usable = candidates.filter((c) => !c.why && c.form.field_subcategory.length).map((c) => {
    const bad = gateTexts([c.form.title, c.form.description], ctx);
    return bad.length ? { ...c, why: 'refused by the gate: ' + bad.join('; ') } : c;
  }).filter((c) => !c.why);
  return usable.find((c) => c.ai) ?? usable[0] ?? null;
}

// ---- page reads and writes ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = (step, state, detail) => ({ step, state, detail });

// A page that shows the login (auth.wishket.com, /accounts/login/, or a header with 로그인 and no 로그아웃 or
// 마이위시켓) means the session was signed out. On 2026-10-26 the site signed the operator out about an hour
// after a skills cleanup ran at the hourly budget, so a run stops at the first sign of it and never retries.
export function isSignedOut({ url = '', text = '' } = {}) {
  if (/auth\.wishket\.com|\/accounts\/login/.test(url)) return true;
  const head = String(text).slice(0, 1500);
  return /로그인/.test(head) && !/로그아웃|마이위시켓|내 프로필/.test(head);
}

const signedOutError = (where) => Object.assign(new Error('위시켓 shows the login at ' + where + '; the operator signs in again before the next run'), { code: 'FSW_WISHKET_SIGNED_OUT' });

async function go(session, url) {
  await session.navigate(url);
  const page = await session.evaluate(() => ({ url: location.href, text: document.body.innerText }));
  if (isSignedOut(page)) throw signedOutError(new URL(page.url).pathname);
}

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

export function pendingIdentity(ledger, now) {
  try {
    const row = ledger?.db?.prepare("SELECT at, payload FROM events WHERE kind = 'platform.identity_request' AND platform = 'wishket' ORDER BY id DESC LIMIT 1").get();
    return row && now - Date.parse(row.at) < 2 * DAY_MS ? row : null;
  } catch {
    return null;
  }
}

async function identityStep(session, ctx) {
  const { instance, apply, ledger } = ctx;
  await go(session, IDENTITY_URL);
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
  await go(session, BASE + user + 'introduction/update/');
  for (let i = 0; i < 2; i++) {
    if ((await readIntro(session)).description !== null) return true;
    const link = await session.evaluate(() => !!document.querySelector('.edit-box-view a[href="edit"]'));
    if (link) await session.click('.edit-box-view a[href="edit"]');
    else await go(session, BASE + user + 'introduction/update/edit/');
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
    // form-scoped: the page head holds a <meta name="description"> that a bare [name=description] hits first
    if (want[k]) await session.fill('form [name="' + k + '"]', want[k]);
    else await session.evaluate((n) => { const e = document.querySelector('form [name="' + n + '"]'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }, k);
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
    return { pk, title, start: date ? date[1] + '-' + date[2] : null, menu };
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

// Writes go slower than the descriptor allows: onboarding.wishket.writeGapMs between two writes (30 s by
// default) and at most onboarding.wishket.writesPerRun per run (10 by default); a rerun continues.
export function writePace(instance) {
  const set = instance?.config?.onboarding?.wishket ?? {};
  const num = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  return { gapMs: num(set.writeGapMs, 30_000), perRun: Math.max(1, num(set.writesPerRun, 10)) };
}

// One list menu: plan, then (with apply) delete what the profile does not hold and add what is missing,
// within the descriptor's hourly action budget; a rerun continues where the budget stopped.
async function listStep(session, ctx, { id, menu, url, desired, keyOfPage }) {
  await go(session, url);
  const items = await readItems(session, menu);
  const plan = planList(items.map((i) => ({ ...i, key: keyOfPage(i) })), desired);
  const summary = 'keep ' + plan.keep.length + ', add ' + plan.add.length + ', delete ' + plan.remove.length;
  if (!plan.add.length && !plan.remove.length) return result(id, 'done', 'matches the profile (' + plan.keep.length + ' items)');
  if (!ctx.apply) return result(id, 'filled', 'dry run: ' + summary + (plan.remove.length ? ' (' + plan.remove.map((r) => r.key).join(', ') + ')' : ''));
  const failures = [];
  let done = 0;
  const { gapMs, perRun } = writePace(ctx.instance);
  const writes = [...plan.remove.map((r) => ['delete', r]), ...plan.add.map((d) => ['add', d])];
  try {
    for (const [kind, item] of writes) {
      if (done >= perRun) {
        failures.push('stopped at onboarding.wishket.writesPerRun (' + perRun + '); rerun to continue');
        break;
      }
      if (done) await sleep(gapMs);
      const r = kind === 'delete' ? { status: await remove(session, menu, item.pk), body: '' } : await post(session, item.fields);
      // A login page or a refusal means the session is gone: stop, never retry.
      if (r.status === 401 || r.status === 403 || /로그인|accounts\/login/.test(r.body)) throw signedOutError(kind + ' ' + item.key);
      if (r.status === 200) done += 1;
      else failures.push(kind + ' ' + item.key + ' answered ' + r.status + ' ' + r.body.replace(/\s+/g, ' ').slice(0, 120));
    }
  } catch (err) {
    if (err.code !== 'FSW_PACING_LIMIT') throw err;
    failures.push('stopped at the hourly action budget; rerun to continue');
  }
  if (done) ctx.ledger?.addEvent({ kind: 'platform.profile_edit', platform: 'wishket', ref: id, payload: { changes: done } });
  // The read back is a page load too, so a spent budget leaves it to the next run.
  if (failures.some((f) => /budget|writesPerRun/.test(f))) return result(id, 'filled', done + ' of ' + (plan.add.length + plan.remove.length) + ' changes written, then ' + failures.join('; '));
  await go(session, url);
  const after = planList((await readItems(session, menu)).map((i) => ({ ...i, key: keyOfPage(i) })), desired);
  if (!after.add.length && !after.remove.length) return result(id, 'done', summary + ', read back');
  return result(id, 'needs-operator', 'after writing: add ' + after.add.length + ', delete ' + after.remove.length + ' remain; ' + failures.join('; '));
}

async function educationStep(session, user) {
  await go(session, BASE + user + 'info/update/');
  const text = await session.evaluate(() => document.body.innerText);
  if (/학력[\s\S]{0,80}사용 불가/.test(text)) return result('education', 'done', 'education and certificates are not offered to an individual business partner; the introduction lists them');
  return result('education', 'unmapped', 'education is offered for this partner type and its form is not mapped yet');
}

async function portfolioCount(session, user) {
  await go(session, BASE + user);
  const text = await session.evaluate(() => document.body.innerText);
  return Number(text.match(/포트폴리오\s*\n\s*(\d+)/)?.[1] ?? NaN);
}

const seoulMonth = (now = Date.now()) => new Date(now + 9 * 3_600_000).toISOString().slice(0, 7);

function readItemsFile(instance) {
  const file = join(instance.paths.portfolio, 'items.json');
  if (!existsSync(file)) return [];
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(j) ? j : j.items ?? [];
}

// Fills the add form, attaches the image through the page's hidden file input, then presses 등록, which
// posts the form and follows the redirect it answers with. The choices are set as checked boxes with
// their chips marked selected: on 2026-10-26 a change event on a category box ran a page handler that
// threw (it reads a click event the trigger does not carry), and the category handler also swaps the
// description for a template, so the description is typed after the boxes. Each remaining page event
// runs on its own, and one that throws is listed in the step report.
async function addPortfolio(session, user, pick) {
  await go(session, BASE + user + 'portfolio/update/add/');
  const f = pick.form;
  await session.fill('#portfolio-form input[name=title]', f.title);
  const thrown = await session.evaluate((f) => {
    const $ = window.jQuery;
    const errors = [];
    const quietly = (what, fn) => { try { fn(); } catch (err) { errors.push(what + ': ' + err.message); } };
    for (const name of ['category', 'subcategory', 'field_subcategory']) for (const v of f[name]) $('#portfolio-form input[name="' + name + '"][value="' + v + '"]').prop('checked', true).closest('.field-chip').addClass('selected');
    quietly('field_subcategory', () => $('#portfolio-form input[name="field_subcategory"]:checked').first().trigger('change'));
    $('#portfolio-form input[name="skills"]').val(f.skills);
    quietly('skills', () => $('#portfolio-form input[name="skills"]').trigger('change'));
    return errors;
  }, f);
  for (const name of ['date_started', 'date_ended', 'participation_rate', 'role']) if (f[name]) await session.fill('#portfolio-form input[name=' + name + ']', f[name]);
  await session.fill('#portfolio-form textarea[name=description]', f.description);
  const box = await session.evaluate(() => {
    window.jQuery('.portfolio-img-add').first().trigger('click');
    const boxes = document.querySelectorAll('#portfolio-img-box-list .portfolio-img-content-box');
    const last = boxes[boxes.length - 1];
    const target = last?.getAttribute('data-target');
    if (!target || !last.querySelector('.img-box')) return null;
    last.querySelector('.img-box').setAttribute('data-fsw', 'portfolio-image');
    return target;
  });
  if (!box) return 'the form added no image box';
  // The upload tool presses the image box, whose click opens the page's file chooser (the hidden
  // input refuses files set on it directly: file_input_not_activated), and answers it with the file.
  await session.setFiles('[data-fsw=portfolio-image]', pick.image);
  await sleep(2500);
  const attached = await session.evaluate((t) => !!document.querySelector('#portfolio-img-box-list .portfolio-img-content-box[data-target="' + t + '"] input.image_file')?.files?.length, box);
  if (!attached) return 'the page did not take the image';
  if (f.caption) await session.fill('#portfolio-form input[name=caption_' + box + ']', f.caption);
  await session.evaluate(() => [...document.querySelectorAll('.btn-submit')].find((b) => b.getBoundingClientRect().width > 0)?.setAttribute('data-fsw', 'portfolio-submit'));
  const before = await session.evaluate(() => location.href);
  await session.click('[data-fsw=portfolio-submit]');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const now = await session.evaluate(() => location.href);
    if (now !== before) return null;
  }
  const errors = await session.evaluate(() => [...document.querySelectorAll('#portfolio-form .error')].map((e) => e.getAttribute('name') ?? e.querySelector('[name]')?.getAttribute('name') ?? e.className).slice(0, 8));
  return '등록 did not leave the form; marked fields: ' + (errors.join(', ') || 'none') + (thrown.length ? '; page handlers threw: ' + thrown.join('; ') : '');
}

async function portfolioStep(session, ctx, user) {
  if ((await portfolioCount(session, user)) > 0) return result('portfolio', 'done', 'a portfolio item is listed');
  const pick = pickPortfolio(portfolioCandidates(ctx.instance, readItemsFile(ctx.instance), { month: seoulMonth() }), ctx);
  if (!pick) return result('portfolio', 'needs-operator', 'no portfolio item has an image, a period and text 위시켓 keeps; add one to portfolio/items.json');
  const plan = pick.id + ' as ' + pick.form.field_subcategory.join('/') + ', ' + pick.form.date_started + ' to ' + pick.form.date_ended;
  if (!ctx.apply) return result('portfolio', 'filled', 'dry run: would add ' + plan);
  const failed = await addPortfolio(session, user, pick);
  if (failed) return result('portfolio', 'needs-operator', failed);
  ctx.ledger?.addEvent({ kind: 'platform.profile_edit', platform: 'wishket', ref: 'portfolio', payload: { item: pick.id } });
  if ((await portfolioCount(session, user)) > 0) return result('portfolio', 'done', 'added ' + plan + ' and read back');
  return result('portfolio', 'needs-operator', 'added ' + pick.id + ', but the profile still lists no portfolio item');
}

async function availabilityStep(session, user) {
  await go(session, BASE + user);
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
    if (!/wishket\.com/.test(await session.evaluate(() => location.href).catch(() => ''))) await go(session, IDENTITY_URL);
    return (user = await userPath(session));
  };
  let stopped = false;
  const run = async (id, fn) => {
    if (!want(id)) return;
    if (stopped) {
      out.push(stopped === 'signed out' ? result(id, 'needs-operator', 'not read: 위시켓 signed the session out at an earlier step') : result(id, 'filled', 'not read: the hourly action budget was spent by an earlier step'));
      return;
    }
    try {
      const r = await fn();
      out.push(r);
      log(id + ': ' + r.state + ' ' + r.detail);
    } catch (err) {
      // The descriptor's hourly budget is spent: later steps wait for the next run.
      if (err.code === 'FSW_PACING_LIMIT') {
        out.push(result(id, 'filled', 'stopped at the hourly action budget; rerun after an hour to continue'));
        stopped = true;
        return;
      }
      if (err.code === 'FSW_WISHKET_SIGNED_OUT') {
        out.push(result(id, 'needs-operator', err.message));
        log(id + ': needs-operator ' + err.message);
        stopped = 'signed out';
        return;
      }
      throw err;
    }
  };
  await run('identity', () => identityStep(session, ctx));
  await run('introduction', async () => introStep(session, ctx, await userOf()));
  await run('employment', async () => {
    const u = await userOf();
    await go(session, BASE + u + 'skill/update/');
    const skills = desiredSkills(ctx.instance.profile, await stackVocabulary(session, skillCandidates(ctx.instance.profile)), ctx.instance.config?.onboarding?.wishket?.directSkills);
    const entries = careerEntries(ctx.instance, skills);
    const bad = gateTexts(entries.flatMap((e) => [e.fields.company_name, e.fields.position, e.fields.description]), ctx);
    if (bad.length) return result('employment', 'needs-operator', 'the gate refused a career item: ' + bad.join('; '));
    // A career card's title line is its company name, or 프리랜서 for a freelance item.
    return listStep(session, ctx, { id: 'employment', menu: 'employment', url: BASE + u + 'employment/update/', desired: entries, keyOfPage: (i) => i.title + '|' + i.start });
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
    await go(session, BASE + u + 'skill/update/');
    const vocab = await stackVocabulary(session, skillCandidates(ctx.instance.profile));
    const names = desiredSkills(ctx.instance.profile, vocab, ctx.instance.config?.onboarding?.wishket?.directSkills);
    if (!names.length) return result('skills', 'needs-operator', 'no profile skill matched 위시켓\'s stack vocabulary');
    return listStep(session, ctx, { id: 'skills', menu: 'skill', url: BASE + u + 'skill/update/', desired: names.map((n) => ({ key: n, fields: { title: n } })), keyOfPage: (i) => i.title });
  });
  await run('education', async () => educationStep(session, await userOf()));
  await run('portfolio', async () => portfolioStep(session, ctx, await userOf()));
  await run('availability', async () => availabilityStep(session, await userOf()));
  return out;
}

