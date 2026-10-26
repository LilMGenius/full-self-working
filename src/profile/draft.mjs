// Drafts profile.json from numbered sources. The model extracts; this module decides what survives.
// Every claim carries a cite {source, line, quote}; verifyDraft keeps a claim only when its quote is found
// at that line (or within two lines of it) of that source, and when the words and numbers the claim
// states are inside the quote. What a source does not state is dropped and listed for the operator.
import catalog from '../economics/services.json' with { type: 'json' };
import { runCodex as defaultRunCodex } from '../brain/codex.mjs';

export const SERVICE_IDS = Object.keys(catalog).filter((k) => !k.startsWith('_'));
export const SKILL_CATEGORIES = ['web', 'app_and_backend', 'ai', 'ops', 'design_and_content', 'teaching'];
export const STRENGTHS = ['strong', 'some', 'none'];

const str = { type: 'string' };
const nstr = { type: ['string', 'null'] };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const list = (items) => ({ type: 'array', items });
const cite = obj({ source: { ...str, description: 'source id such as S2' }, line: { type: 'integer', description: 'line number inside that source, as printed in the input' }, quote: { ...str, description: 'the exact words from that line that state the fact' } });

export const DRAFT_SCHEMA = obj({
  person: obj({ nameKo: nstr, nameEn: nstr, handle: nstr, phone: nstr, email: nstr, links: list(str), cite }),
  headline_ko: obj({ text: str, cites: list(cite) }),
  headline_en: obj({ text: str, cites: list(cite) }),
  summary_ko: obj({ text: str, cites: list(cite) }),
  summary_en: obj({ text: str, cites: list(cite) }),
  roles: list(obj({ org: str, title: str, period: nstr, cite })),
  education: list(obj({ school: str, degree: nstr, field: nstr, period: nstr, cite })),
  awards: list(obj({ name: str, year: { type: ['integer', 'null'] }, cite })),
  projects: list(obj({ name: str, role: nstr, url: nstr, what: str, proof: nstr, stack: list(str), cite })),
  skills: list(obj({ category: { type: 'string', enum: SKILL_CATEGORIES }, name: str })),
  languages: list(obj({ code: str, cite })),
  serviceFit: list(obj({ service: { type: 'string', enum: SERVICE_IDS }, strength: { type: 'string', enum: STRENGTHS }, evidence: list(str), cite: { anyOf: [{ type: 'null' }, cite] } })),
  approvedClaims: list(obj({ text: str, cite })),
  claimsNotToMake: list(obj({ text: str, reason: str })),
  conflicts: list(obj({ field: str, values: list(obj({ value: str, number: { type: ['number', 'null'] }, cite })), chosen: str })),
});

export const sourceBlock = (sources) => sources.map((s) => `### ${s.id} ${s.label} (${s.kind})\n` + s.lines.map((l, i) => `${s.id}:${i + 1}| ${l}`).join('\n')).join('\n\n');

export function buildPrompt(sources, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const services = SERVICE_IDS.map((id) => `- ${id}: ${catalog[id].ko} / ${catalog[id].en}`).join('\n');
  return [
    '# Role',
    'You extract a freelancer profile from the background material below. You do not run commands or read files; answer only with the JSON object the schema describes.',
    '',
    '# Rules',
    '1. State only what a source states. Every fact carries a cite: the source id, the line number printed in front of that line, and the exact words from that line. A fact with no such line does not go in.',
    '2. Never invent or round up. No degree, title, employer, award, year or number that the sources do not give. Do not compute years of experience from dates; an approved claim is a sentence a source already says, with its number.',
    '3. When sources disagree (two dates, two titles, two degrees), put every version in conflicts with its cite and choose the lower or lesser one: the shorter period, the lower degree, the smaller number.',
    '4. Do not name a client or an employer a source does not make public. A project is described by what was built, not for whom, unless the project itself is the public product.',
    '5. Do not put a number into a headline or summary unless a cite carries it. Headlines and summaries are written in plain words from what the cites state, one version in Korean and one in English.',
    '6. A repository folder shows what the person authored through its README and its commit subjects; list only projects whose README or commits show the person built them, and say so in what. Commits by other authors are not theirs.',
    '7. serviceFit covers every catalog service below. strong: at least two pieces of evidence (project names or role orgs from your own lists) for that service; some: one; none: nothing in the sources. Evidence is the name of a project, role org or award you listed, copied exactly.',
    '8. claimsNotToMake lists things a reader might wrongly assume from this profile (a big-company background, a professional title, a degree, a skill the sources lack), each with the reason. These need no cite.',
    '9. Copy names, titles, schools, awards, project names, claims and stack items exactly as the source writes them, in the source language; never translate or paraphrase them. Only headline_ko, headline_en, summary_ko and summary_en are written by you, one per language. An approved claim is a sentence or phrase copied from the source that carries a number about experience.',
    '10. A degree is listed only when the source says it was earned. Studies not finished, an enrolment or a course is not a degree: leave it out.',
    '11. Leave a field null or empty when unknown. Skills are tools, languages or methods the sources name, copied as written, filed under the closest category.',
    '',
    `Today is ${today}.`,
    '',
    '# Service catalog',
    services,
    '',
    '# Sources (each line is printed as <id>:<line>| text)',
    sourceBlock(sources),
  ].join('\n');
}

// ---- verification ----

const fold = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const WORD_NUMBERS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|dozen|half|single|double|triple|decade';
const KO_NUMBERS = '[일이삼사오육칠팔구십백천만한두세네]+(?=\\s*(?:년|개|건|명|곳|배|%))';
// Digits and spelled-out numbers (ten, 십) both count as numbers the claim states.
const numbersOf = (s) => [
  ...(String(s ?? '').match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, '')),
  ...(String(s ?? '').toLowerCase().match(new RegExp('\\b(?:' + WORD_NUMBERS + ')\\b', 'g')) ?? []),
  ...(String(s ?? '').match(new RegExp(KO_NUMBERS, 'g')) ?? []),
];

// A cite holds when its quote is found in the cited source within two lines of the claimed line; the
// line is then set to where the quote starts. Returns {ok, cite, reason}.
export function checkCite(c, sources) {
  if (!c || typeof c !== 'object') return { ok: false, reason: 'no cite' };
  const source = sources.find((s) => s.id === c.source);
  if (!source) return { ok: false, reason: `unknown source ${c.source}` };
  const quote = fold(c.quote);
  if (quote.length < 2) return { ok: false, reason: 'empty quote' };
  const at = (c.line ?? 0) - 1;
  for (const start of [0, -1, 1, -2, 2].map((d) => at + d)) {
    if (start < 0 || start >= source.lines.length) continue;
    if (fold(source.lines.slice(start, start + 3).join(' ')).includes(quote)) {
      return { ok: true, cite: { source: source.id, label: source.label, line: start + 1, quote: String(c.quote).trim() } };
    }
  }
  return { ok: false, reason: `quote not found near ${c.source}:${c.line}` };
}

// Words the claim states must be inside the quote; numbers always, and the named text when given.
const supports = (quote, ...texts) => {
  const q = fold(quote);
  return texts.filter((t) => t != null && String(t).trim() !== '').every((t) => fold(t).length === 0 || q.includes(fold(t)));
};
const numbersSupported = (quote, text) => numbersOf(text).every((n) => numbersOf(quote).includes(n));

export function verifyDraft(raw, sources, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const dropped = [];
  const provenance = [];
  const drop = (path, text, reason) => dropped.push({ path, text: String(text ?? '').slice(0, 120), reason });
  const everything = fold(sources.map((s) => s.lines.join(' ')).join(' '));
  const stated = (value) => fold(value).length > 0 && everything.includes(fold(value));
  const prove = (path, c, ...mustAppear) => {
    const r = checkCite(c, sources);
    if (!r.ok) return drop(path, mustAppear[0] ?? c?.quote, r.reason), null;
    const missing = mustAppear.filter((t) => t != null && String(t).trim() !== '' && !supports(r.cite.quote, t));
    if (missing.length) return drop(path, missing[0], 'not stated in its quote'), null;
    provenance.push({ path, source: r.cite.label, line: r.cite.line, quote: r.cite.quote });
    return r.cite;
  };

  const out = { person: {}, languages: [], skills: Object.fromEntries(SKILL_CATEGORIES.map((c) => [c, []])) };

  const p = raw.person ?? {};
  for (const k of ['nameKo', 'nameEn', 'handle', 'phone', 'email']) {
    if (p[k] && stated(p[k])) out.person[k] = p[k];
    else if (p[k]) drop('person.' + k, p[k], 'not found in any source');
  }
  out.person.links = (p.links ?? []).filter((l) => (stated(l) ? true : (drop('person.links', l, 'not found in any source'), false)));
  if (out.person.nameKo || out.person.nameEn) prove('person', p.cite, out.person.nameKo ?? out.person.nameEn);

  for (const key of ['headline_ko', 'headline_en', 'summary_ko', 'summary_en']) {
    const f = raw[key] ?? { text: '', cites: [] };
    const good = (f.cites ?? []).map((c, i) => prove(`${key}.cites.${i}`, c)).filter(Boolean);
    const evidence = good.map((c) => c.quote).join(' ');
    if (!f.text?.trim()) out[key] = '';
    else if (!good.length) (drop(key, f.text, 'no verifiable cite'), (out[key] = ''));
    else if (!numbersSupported(evidence, f.text)) (drop(key, f.text, 'carries a number its cites do not state'), (out[key] = ''));
    else out[key] = f.text.trim();
  }

  out.roles = (raw.roles ?? []).flatMap((r, i) => (prove(`roles.${i}`, r.cite, r.org, r.title, r.period) ? [{ org: r.org, title: r.title, period: r.period ?? undefined }] : []));
  out.education = (raw.education ?? []).flatMap((e, i) => {
    if (!e.degree) return drop(`education.${i}`, e.school, 'no earned degree stated'), [];
    if (!prove(`education.${i}`, e.cite, e.school, e.degree, e.period)) return [];
    return [{ school: e.school, degree: e.degree, field: e.field ?? undefined, period: e.period ?? undefined }];
  });
  out.awards = (raw.awards ?? []).flatMap((a, i) => (prove(`awards.${i}`, a.cite, a.name, a.year) ? [{ name: a.name, year: a.year ?? undefined }] : []));
  out.projects = (raw.projects ?? []).flatMap((x, i) => {
    if (!prove(`projects.${i}`, x.cite, x.name)) return [];
    const keepStated = (field, value) => (value && !stated(value) ? (drop(`projects.${i}.${field}`, value, 'not found in any source'), undefined) : value ?? undefined);
    return [{ name: x.name, role: x.role ?? undefined, url: keepStated('url', x.url), what: x.what, proof: keepStated('proof', x.proof), stack: (x.stack ?? []).filter((t) => (stated(t) ? true : (drop(`projects.${i}.stack`, t, 'not found in any source'), false))) }];
  });
  for (const [i, s] of (raw.skills ?? []).entries()) {
    if (!stated(s.name)) drop(`skills.${i}`, s.name, 'not found in any source');
    else if (!out.skills[s.category]?.some((n) => fold(n) === fold(s.name))) out.skills[s.category].push(s.name);
  }
  out.languages = [...new Set((raw.languages ?? []).flatMap((l, i) => (prove(`languages.${i}`, l.cite) ? [l.code] : [])))];

  const named = new Set([...out.projects.map((x) => x.name), ...out.roles.map((r) => r.org), ...out.awards.map((a) => a.name)]);
  const fit = new Map();
  for (const f of raw.serviceFit ?? []) {
    const evidence = [...new Set((f.evidence ?? []).filter((e) => (named.has(e) ? true : (drop(`serviceFit.${f.service}`, e, 'evidence is not a listed project, role or award'), false))))];
    const strength = !evidence.length ? 'none' : f.strength === 'strong' && evidence.length < 2 ? 'some' : f.strength;
    if (strength !== f.strength) drop(`serviceFit.${f.service}`, `${f.strength}`, `strength set to ${strength}: ${evidence.length} verified evidence`);
    fit.set(f.service, { evidence, strength });
  }
  out.serviceFit = Object.fromEntries(SERVICE_IDS.map((id) => [id, fit.get(id) ?? { evidence: [], strength: 'none' }]));

  out.approvedClaims = [];
  for (const [i, c] of (raw.approvedClaims ?? []).entries()) {
    const got = prove(`approvedClaims.${i}`, c.cite, c.text);
    if (!got) continue;
    if (!numbersSupported(got.quote, c.text)) drop(`approvedClaims.${i}`, c.text, 'its number is not in the quote');
    else if (!out.approvedClaims.includes(c.text)) out.approvedClaims.push(c.text);
  }
  out.claimsNotToMake = [...new Set((raw.claimsNotToMake ?? []).map((c) => c.text.trim()).filter(Boolean))];

  // The lower value wins: a chosen value that is not the lowest number among cited versions is replaced.
  const conflicts = [];
  for (const c of raw.conflicts ?? []) {
    const versions = c.values.filter((v, i) => prove(`conflicts.${c.field}.${i}`, v.cite));
    const nums = versions.map((v) => v.number).filter((n) => typeof n === 'number');
    const lowest = nums.length ? Math.min(...nums) : null;
    const chosenNumber = versions.find((v) => v.value === c.chosen)?.number;
    const chosen = lowest !== null && chosenNumber !== lowest ? versions.find((v) => v.number === lowest).value : c.chosen;
    conflicts.push({ field: c.field, versions: versions.map((v) => v.value), chosen, corrected: chosen !== c.chosen });
  }

  return { profile: { ...out, provenance, generatedAt: today }, dropped, conflicts };
}

export async function draftProfile(sources, { runCodex = defaultRunCodex, model, effort, timeoutMs = 600_000, today } = {}) {
  const { data } = await runCodex({ prompt: buildPrompt(sources, { today }), schema: DRAFT_SCHEMA, model, effort, timeoutMs });
  return { raw: data, ...verifyDraft(data, sources, { today }) };
}
