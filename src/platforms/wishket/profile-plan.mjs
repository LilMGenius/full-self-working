// The 위시켓 profile the instance asks for, planned without a page (src/platforms/wishket/onboarding.mjs): the
// introduction, skills, career, awards and portfolio picks, and the gate each text passes before it is written.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateOutbound, identityParts, namePattern } from '../../policy/gate.mjs';
import { isEligible, rankPortfolio } from '../../portfolio/rank.mjs';

export const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

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

export const seoulMonth = (now = Date.now()) => new Date(now + 9 * 3_600_000).toISOString().slice(0, 7);

export function readItemsFile(instance) {
  const file = join(instance.paths.portfolio, 'items.json');
  if (!existsSync(file)) return [];
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(j) ? j : j.items ?? [];
}
