// A resume PDF built from profile.json, for platforms that ask for one before an operator may propose
// (kmong's enterprise profile). Facts come only from the profile. An entry may carry Korean renderings
// beside its English fields (org_ko, title_ko, detail_ko on roles; name_ko, role_ko, what_ko on projects;
// name_ko on awards; school_ko, field_ko, degree_ko on education; skills_ko and languages_ko beside skills
// and languages), the convention src/portfolio/store.mjs already reads; an entry without them prints its
// English values. Links, proof notes, handles and contact details never print: marketplaces forbid contact
// before a contract, so the printed text passes the outbound gate as a profile item and a refusal stops the
// build. The page is printed by the owned headless browser with Pretendard inlined, and the renderer's own
// per-node font report must show that face alone (AGENTS.md webfontRace), because Chrome draws a variable
// face, and an emoji fallback too, as unnamed Type3 glyphs that a PDF name check cannot tell apart.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gateOutbound } from '../policy/gate.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { fontProblems, pdfFonts, pdfPageCount, platformFontProblems, pretendardFontFace } from '../render/fonts.mjs';
import { openRenderer as defaultOpenRenderer } from '../render/html2png.mjs';

export const FONT_FAMILY = 'Pretendard';
export const MAX_PAGES = 2;

export class ResumeError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ResumeError';
    this.code = code;
    Object.assign(this, detail);
  }
}

const LABELS = {
  ko: {
    summary: '소개', roles: '경력', projects: '주요 프로젝트', contributions: '오픈소스 기여', awards: '수상과 활동',
    education: '학력과 교육', skills: '보유 기술', languages: '언어', present: '현재', stack: '사용 기술',
    skillGroups: { web: '웹', app_and_backend: '앱과 백엔드', ai: 'AI', ops: '인프라와 운영', design_and_content: '디자인과 콘텐츠', teaching: '교육' },
  },
  en: {
    summary: 'Summary', roles: 'Experience', projects: 'Selected projects', contributions: 'Open source contributions', awards: 'Awards and activities',
    education: 'Education', skills: 'Skills', languages: 'Languages', present: 'present', stack: 'Stack',
    skillGroups: { web: 'Web', app_and_backend: 'Apps and backend', ai: 'AI', ops: 'Infrastructure and operations', design_and_content: 'Design and content', teaching: 'Teaching' },
  },
};

// "2024.12 to present" prints as "2024.12 ~ 현재"; a period the profile gives in another shape prints as written.
export function formatPeriod(period, lang = 'ko') {
  const p = String(period ?? '').trim();
  if (!p) return '';
  return p.replace(/\s+to\s+/gi, ' ~ ').replace(/\bpresent\b/gi, LABELS[lang].present);
}

// A project is someone else's when the profile says so: contribution true, or a role naming a contribution.
export const isContribution = (p) => p?.contribution === true || /\bcontribut/i.test(p?.role ?? '');

// The printed resume as data: sections in the order the profile lists its entries.
export function resumeModel(profile, { lang = 'ko' } = {}) {
  if (!LABELS[lang]) throw new ResumeError('FSW_RESUME_LANG', 'lang is ko or en');
  const p = profile ?? {};
  const ko = lang === 'ko';
  const pick = (entry, key) => (ko && typeof entry?.[key + '_ko'] === 'string' && entry[key + '_ko'].trim() ? entry[key + '_ko'] : entry?.[key]) ?? '';
  const name = ko ? p.person?.nameKo || p.person?.nameEn || '' : p.person?.nameEn || p.person?.nameKo || '';
  const altName = ko ? (p.person?.nameKo && p.person?.nameEn ? p.person.nameEn : '') : '';
  const project = (x) => ({ name: pick(x, 'name'), role: pick(x, 'role'), what: pick(x, 'what'), stack: (x.stack ?? []).filter(Boolean) });
  const skills = ko && p.skills_ko && typeof p.skills_ko === 'object' ? p.skills_ko : p.skills ?? {};
  return {
    lang,
    labels: LABELS[lang],
    name,
    altName,
    headline: (ko ? p.headline_ko : p.headline_en) || '',
    summary: (ko ? p.summary_ko : p.summary_en) || '',
    roles: (p.roles ?? []).map((r) => ({ org: pick(r, 'org'), title: pick(r, 'title'), period: formatPeriod(r.period, lang), detail: pick(r, 'detail') })),
    projects: (p.projects ?? []).filter((x) => !isContribution(x)).map(project),
    contributions: (p.projects ?? []).filter(isContribution).map(project),
    awards: (p.awards ?? []).map((a) => ({ name: pick(a, 'name'), year: a.year ? String(a.year) : '' })),
    education: (p.education ?? []).map((e) => ({ school: pick(e, 'school'), field: pick(e, 'field'), degree: pick(e, 'degree'), period: formatPeriod(e.period, lang) })),
    skills: Object.entries(skills).filter(([, list]) => Array.isArray(list) && list.length).map(([group, list]) => ({ group: LABELS[lang].skillGroups[group] ?? group, items: list })),
    languages: ko && Array.isArray(p.languages_ko) && p.languages_ko.length ? p.languages_ko : p.languages ?? [],
  };
}

// Every string the page prints, in reading order: what the gate reads.
export function resumeLines(m) {
  const out = [m.name, m.altName, m.headline, m.summary];
  for (const r of m.roles) out.push(r.org, r.title, r.period, r.detail);
  for (const x of [...m.projects, ...m.contributions]) out.push(x.name, x.role, x.what, x.stack.join(', '));
  for (const a of m.awards) out.push(a.name, a.year);
  for (const e of m.education) out.push(e.school, e.field, e.degree, e.period);
  for (const s of m.skills) out.push(s.group, s.items.join(', '));
  out.push(...m.languages);
  return out.filter((s) => s && String(s).trim());
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = [
  '@page{size:A4;margin:14mm 16mm 14mm 16mm}',
  '*{box-sizing:border-box;margin:0;padding:0}',
  'html{font-family:"Pretendard";color:#15171c;font-size:9.2pt;line-height:1.55;word-break:keep-all;overflow-wrap:break-word;-webkit-print-color-adjust:exact;print-color-adjust:exact;font-feature-settings:"tnum" 1}',
  'header{padding-bottom:4.2mm;border-bottom:1.1pt solid #15171c}',
  'h1{font-size:21pt;font-weight:700;letter-spacing:-0.01em;line-height:1.2}',
  'h1 small{font-size:10.5pt;font-weight:500;color:#5d6371;margin-left:2.6mm;letter-spacing:0.01em}',
  '.headline{margin-top:1.6mm;font-size:10.6pt;font-weight:600;color:#23406e}',
  '.summary{margin-top:2.6mm;color:#2b2f37;max-width:168mm}',
  'section{margin-top:5mm}',
  'h2{font-size:9.6pt;font-weight:700;color:#23406e;letter-spacing:0.02em;padding-bottom:1.3mm;border-bottom:0.5pt solid #d6d9e0;margin-bottom:2.4mm;break-after:avoid}',
  '.entry{display:grid;grid-template-columns:1fr auto;column-gap:6mm;margin-bottom:2.3mm;break-inside:avoid}',
  '.entry .head{font-weight:600}',
  '.entry .head span{font-weight:400;color:#4a4f5c}',
  '.entry .period{color:#5d6371;white-space:nowrap;font-size:8.7pt;padding-top:0.3mm}',
  '.entry .body{grid-column:1/-1;color:#30343d}',
  '.entry .stack{grid-column:1/-1;color:#6a707d;font-size:8.3pt;margin-top:0.4mm}',
  '.rows{display:grid;grid-template-columns:34mm 1fr;column-gap:4mm;row-gap:1.3mm}',
  '.rows dt{color:#4a4f5c;font-weight:600}',
  '.rows dd{color:#30343d}',
  '.cols{display:grid;grid-template-columns:1fr 1fr;column-gap:8mm}',
].join('');

function entry({ head, sub, period, body, stack }) {
  return '<div class="entry"><div class="head">' + esc(head) + (sub ? ' <span>' + esc(sub) + '</span>' : '') + '</div><div class="period">' + esc(period ?? '') + '</div>' +
    (body ? '<div class="body">' + esc(body) + '</div>' : '') + (stack ? '<div class="stack">' + esc(stack) + '</div>' : '') + '</div>';
}

const section = (title, inner) => (inner ? '<section><h2>' + esc(title) + '</h2>' + inner + '</section>' : '');

export function resumeHtml(m, { fontFace = pretendardFontFace() } = {}) {
  const L = m.labels;
  const roles = m.roles.map((r) => entry({ head: r.org, sub: r.title, period: r.period, body: r.detail })).join('');
  const projects = m.projects.map((x) => entry({ head: x.name, sub: x.role, body: x.what, stack: x.stack.length ? L.stack + ': ' + x.stack.join(', ') : '' })).join('');
  const contributions = m.contributions.map((x) => entry({ head: x.name, sub: x.role, body: x.what })).join('');
  const awards = m.awards.map((a) => entry({ head: a.name, period: a.year })).join('');
  const education = m.education.map((e) => entry({ head: e.school, sub: [e.field, e.degree].filter(Boolean).join(', '), period: e.period })).join('');
  const skills = m.skills.length ? '<dl class="rows">' + m.skills.map((s) => '<dt>' + esc(s.group) + '</dt><dd>' + esc(s.items.join(', ')) + '</dd>').join('') + '</dl>' : '';
  const languages = m.languages.length ? '<p>' + esc(m.languages.join(', ')) + '</p>' : '';
  return '<!doctype html><html lang="' + m.lang + '"><head><meta charset="utf-8"><title>' + esc(m.name) + '</title><style>' + fontFace + CSS + '</style></head><body>' +
    '<header><h1>' + esc(m.name) + (m.altName ? '<small>' + esc(m.altName) + '</small>' : '') + '</h1>' +
    (m.headline ? '<p class="headline">' + esc(m.headline) + '</p>' : '') + (m.summary ? '<p class="summary">' + esc(m.summary) + '</p>' : '') + '</header>' +
    section(L.roles, roles) + section(L.projects, projects) + section(L.contributions, contributions) + section(L.awards, awards) + section(L.education, education) +
    section(L.skills, skills) + section(L.languages, languages) + '</body></html>';
}

// The gate as a profile item on the platform the resume is for: contact, payment, unapproved claims and
// slop floor findings all refuse the build.
export function checkResume(m, { instance, descriptor }) {
  const gate = gateOutbound({ platform: descriptor.id, kind: 'profile', text: resumeLines(m).join('\n') }, { descriptor, instance });
  return gate;
}

export const defaultResumePath = (instance, lang = 'ko') => join(instance.dir, 'documents', 'resume-' + lang + '.pdf');

// Builds the PDF and writes it only after every check passed: the gate before printing, then the font
// report and the page count on a copy beside the target. The printed HTML is kept next to the PDF; when
// it matches the last build the print is skipped, since the same HTML prints the same pages.
export async function buildResume({ instance, lang = 'ko', platform = 'kmong', out = null, openRenderer = defaultOpenRenderer } = {}) {
  if (!instance?.profile) throw new ResumeError('FSW_RESUME_PROFILE', 'buildResume needs an instance with a profile');
  const target = resolve(out ?? defaultResumePath(instance, lang));
  const htmlFile = target.replace(/\.pdf$/i, '') + '.html';
  const descriptor = loadDescriptor(platform);
  const model = resumeModel(instance.profile, { lang });
  const gate = checkResume(model, { instance, descriptor });
  if (!gate.ok) throw new ResumeError('FSW_RESUME_GATE', 'the resume text fails the ' + platform + ' gate: ' + gate.violations.map((v) => v.rule + ' ' + v.detail).join('; '), { violations: gate.violations });
  const html = resumeHtml(model);
  const digest = createHash('sha256').update(html).digest('hex');
  if (existsSync(target) && existsSync(htmlFile) && createHash('sha256').update(readFileSync(htmlFile)).digest('hex') === digest) {
    const bytes = readFileSync(target);
    return { out: target, html: htmlFile, unchanged: true, pages: pdfPageCount(bytes), warnings: gate.warnings };
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = target + '.' + process.pid + '.tmp.pdf';
  const renderer = await openRenderer();
  let printed;
  try {
    printed = await renderer.pdf({ html, out: tmp });
  } finally {
    await renderer.close();
  }
  const bytes = readFileSync(tmp);
  const fonts = pdfFonts(bytes);
  const pages = pdfPageCount(bytes);
  const problems = [...platformFontProblems(printed.platformFonts, FONT_FAMILY), ...fontProblems(fonts, FONT_FAMILY)];
  if (pages > MAX_PAGES) problems.push(pages + ' pages; a resume here keeps to ' + MAX_PAGES);
  if (problems.length) {
    rmSync(tmp, { force: true });
    throw new ResumeError('FSW_RESUME_PRINT', 'the printed resume failed its checks: ' + problems.join('; '), { problems, platformFonts: printed.platformFonts, fonts });
  }
  renameSync(tmp, target);
  writeFileSync(htmlFile, html);
  return { out: target, html: htmlFile, unchanged: false, pages, bytes: bytes.length, fonts, platformFonts: printed.platformFonts, warnings: gate.warnings };
}

