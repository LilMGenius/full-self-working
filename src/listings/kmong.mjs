// 크몽 gig listing builder (docs/DESIGN.md, src/listings). The brain writes the copy through runCodex
// with a JSON schema; prices come only from the price table and work days from the service's agent
// hours; every field limit the gig form enforces (instance platforms/kmong-notes.md, mapped from the live
// form) is checked here, and every text, image copy included, passes the outbound gate. A draft that
// fails goes back once with its violations; a second failure throws, so nothing unchecked is published.
import { existsSync, readFileSync } from 'node:fs';
import { gateOutbound } from '../policy/gate.mjs';
import { priceRowFor } from '../economics/pricing.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { loadCatalog, loadPlaybook } from '../brain/prompts.mjs';
import { loadGateRules } from '../brain/respond.mjs';
import { runCodex as defaultRunCodex } from '../brain/codex.mjs';

export class ListingError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ListingError';
    this.code = code;
    Object.assign(this, detail);
  }
}

// Limits copied from the 크몽 gig form. Image copy limits keep the rendered layouts from overflowing.
export const KMONG_LIMITS = {
  title: { min: 10, max: 30 },
  description: { min: 100, max: 20000 },
  process: { min: 50, max: 20000 },
  preparation: { min: 50, max: 20000 },
  // 수정 및 재진행 안내: required once the package switch is on; not in the first form map.
  revision: { min: 20, max: 20000 },
  packageTitle: { max: 20 },
  packageDescription: { max: 60 },
  keywords: { count: 5, max: 20 },
  faq: { min: 1, max: 5, chars: 255 },
  card: { headlineLine: 9, subline: 26, tag: 8 },
  intro: { headlineLine: 15, body: 150 },
  audience: { count: 3, chars: 32 },
  included: { min: 3, max: 5, chars: 32 },
  steps: { min: 4, max: 5, title: 14, detail: 64 },
  aiNote: { max: 130 },
};
export const TIERS = ['STANDARD', 'DELUXE', 'PREMIUM'];
const TIER_KEYS = { STANDARD: 'standard', DELUXE: 'deluxe', PREMIUM: 'premium' };

// The title may hold only Hangul, Latin letters, digits, spaces and : + - # / . ( ).
const TITLE_RE = /^[\p{Script=Hangul}A-Za-z0-9 :+\-#/.()]+$/u;
const KEYWORD_RE = /^[\p{Script=Hangul}A-Za-z0-9 ]+$/u;
// 크몽 rejects unverifiable superlatives (국내 최고, 업계 1위, 100% 보장) in listings.
const SUPERLATIVE_RE = /국내\s*(?:최고|최초|유일|1\s*위)|업계\s*(?:최고|최초|유일|1\s*위)|100\s*%\s*(?:보장|만족|환불)|최저가|(?<!\d)1\s*위|No\.?\s*1\b|넘버\s*원|가장\s*(?:싸|저렴|빠르|잘)/giu;
const FORM_BANNED_RE = /[<\u0060]/g;
// The 크몽 submit dialog (seen 2026-10-25) makes the seller tick 내 프로필에서 증빙을 완료했어요 and
// warns that a claim without profile proof gets the gig rejected. A listing therefore describes the
// service only; the seller's titles, employers and past work live in the seller profile, which keeps
// that confirmation true.
const CAREER_RE = /대표(?:로|가|인|이며|입니다)|출신|경력|이력|재직|근무(?:했|한|하며)|(?:구축|개발|제작|운영)해\s*(?:온|왔)|해\s*온\s*경험|경험을\s*바탕|수석|강사|교수|수상/gu;

const len = (s) => [...String(s ?? '')].length;

// Work days per package from the service's agent hours: about six agent hours a day plus a review day.
export function packageTerms(service, row, catalog) {
  const entry = catalog[service];
  if (!row?.packages) throw new ListingError('FSW_LISTING_NO_PRICE', 'no kmong price row with packages for ' + service);
  if (row.viable === false) throw new ListingError('FSW_LISTING_NOT_VIABLE', service + ' is not viable on kmong: ' + (row.reason ?? 'cost floor above the market'));
  return TIERS.map((tier, i) => {
    const hours = entry?.agentHours?.[TIER_KEYS[tier]];
    if (typeof hours !== 'number') throw new ListingError('FSW_LISTING_NO_HOURS', service + ' has no agentHours.' + TIER_KEYS[tier]);
    return { tier, priceKRW: row.packages[TIER_KEYS[tier]], days: Math.ceil(hours / 6) + 1, revisions: i + 1 };
  });
}

// The texts a listing shows anywhere, form fields and image copy alike, labelled for violations.
export function listingTexts(l) {
  const out = [
    ['title', l.title],
    ['description', l.description],
    ['process', l.process],
    ['preparation', l.preparation],
    ['revision', l.revision],
    ...(l.packages ?? []).flatMap((p, i) => [['packages.' + i + '.title', p.title], ['packages.' + i + '.description', p.description]]),
    ...(l.keywords ?? []).map((k, i) => ['keywords.' + i, k]),
    ...(l.faqs ?? []).flatMap((f, i) => [['faqs.' + i + '.question', f.question], ['faqs.' + i + '.answer', f.answer]]),
  ];
  const c = l.imageCopy;
  if (c) {
    out.push(['imageCopy.card', [...(c.card?.headline ?? []), c.card?.subline, ...(c.card?.tags ?? [])].join('\n')]);
    out.push(['imageCopy.intro', [...(c.intro?.headline ?? []), c.intro?.body].join('\n')]);
    out.push(['imageCopy.audience', (c.audience ?? []).join('\n')]);
    out.push(['imageCopy.included', (c.included ?? []).join('\n')]);
    out.push(['imageCopy.steps', (c.steps ?? []).map((s) => s.title + '\n' + s.detail).join('\n')]);
    out.push(['imageCopy.aiNote', c.aiNote]);
    out.push(['imageCopy.proof', (c.proofCaptions ?? []).join('\n')]);
  }
  // An optional block with nothing in it (no proof captions) is not an empty outbound item.
  return out.filter(([, t]) => typeof t === 'string' && t.trim());
}

// Every deterministic rule a listing must meet before it may leave the machine.
export function checkListing(l, { descriptor = loadDescriptor('kmong'), instance = {}, lessonsRules = [], priceRow = null } = {}) {
  const v = [];
  const add = (field, rule, detail) => v.push({ field, rule, detail });
  const L = KMONG_LIMITS;
  const range = (field, value, { min = 0, max }) => {
    const n = len(value);
    if (typeof value !== 'string' || n < min || n > max) add(field, 'limit.length', field + ' has ' + n + ' characters; allowed ' + min + ' to ' + max);
  };

  range('title', l.title, L.title);
  if (typeof l.title === 'string' && !TITLE_RE.test(l.title)) add('title', 'limit.title_chars', 'the title may use only letters, digits, spaces and : + - # / . ( )');
  for (const f of ['description', 'process', 'preparation', 'revision']) {
    range(f, l[f], L[f]);
    if (typeof l[f] === 'string' && FORM_BANNED_RE.test(l[f])) add(f, 'limit.banned_chars', f + ' holds < or a backtick');
    FORM_BANNED_RE.lastIndex = 0;
  }

  const pk = l.packages ?? [];
  if (pk.length !== 3 || pk.some((p, i) => p.tier !== TIERS[i])) add('packages', 'limit.packages', 'three packages STANDARD, DELUXE, PREMIUM are required');
  pk.forEach((p, i) => {
    range('packages.' + i + '.title', p.title, { min: 1, max: L.packageTitle.max });
    range('packages.' + i + '.description', p.description, { min: 1, max: L.packageDescription.max });
    if (!Number.isInteger(p.priceKRW) || p.priceKRW <= 0) add('packages.' + i + '.priceKRW', 'price.missing', 'no price');
    if (!Number.isInteger(p.days) || p.days < 1) add('packages.' + i + '.days', 'limit.days', 'days must be a positive integer');
    if (!Number.isInteger(p.revisions) || p.revisions < 0) add('packages.' + i + '.revisions', 'limit.revisions', 'revisions must be a non-negative integer');
    if (priceRow && (p.priceKRW < priceRow.floorKRW || p.priceKRW > priceRow.ceilingKRW)) add('packages.' + i + '.priceKRW', 'price.range', p.priceKRW + ' KRW is outside [' + priceRow.floorKRW + ', ' + priceRow.ceilingKRW + ']');
    if (priceRow?.packages && p.priceKRW !== priceRow.packages[TIER_KEYS[p.tier]]) add('packages.' + i + '.priceKRW', 'price.table', 'the price differs from the price table');
  });
  if (pk.length === 3 && !(pk[0].priceKRW < pk[1].priceKRW && pk[1].priceKRW < pk[2].priceKRW)) add('packages', 'price.order', 'package prices must rise from STANDARD to PREMIUM');

  const kw = l.keywords ?? [];
  if (kw.length !== L.keywords.count) add('keywords', 'limit.keywords', 'exactly ' + L.keywords.count + ' keywords are required, got ' + kw.length);
  if (new Set(kw.map((k) => String(k).replace(/\s+/g, ''))).size !== kw.length) add('keywords', 'limit.keywords_unique', 'keywords repeat');
  kw.forEach((k, i) => {
    range('keywords.' + i, k, { min: 1, max: L.keywords.max });
    if (typeof k === 'string' && !KEYWORD_RE.test(k)) add('keywords.' + i, 'limit.keyword_chars', 'keywords use letters, digits and spaces only');
  });

  const faqs = l.faqs ?? [];
  if (faqs.length < L.faq.min || faqs.length > L.faq.max) add('faqs', 'limit.faqs', L.faq.min + ' to ' + L.faq.max + ' FAQs are required, got ' + faqs.length);
  faqs.forEach((f, i) => {
    range('faqs.' + i + '.question', f.question, { min: 1, max: L.faq.chars });
    range('faqs.' + i + '.answer', f.answer, { min: 1, max: L.faq.chars });
  });

  const c = l.imageCopy;
  if (!c) add('imageCopy', 'limit.image_copy', 'image copy is missing');
  else {
    if (c.card?.headline?.length !== 2) add('imageCopy.card.headline', 'limit.lines', 'the card headline needs exactly 2 lines');
    (c.card?.headline ?? []).forEach((h, i) => range('imageCopy.card.headline.' + i, h, { min: 2, max: L.card.headlineLine }));
    range('imageCopy.card.subline', c.card?.subline, { min: 4, max: L.card.subline });
    if (c.card?.tags?.length !== 3) add('imageCopy.card.tags', 'limit.count', 'the card needs exactly 3 tags');
    (c.card?.tags ?? []).forEach((t, i) => range('imageCopy.card.tags.' + i, t, { min: 2, max: L.card.tag }));
    if (c.intro?.headline?.length !== 2) add('imageCopy.intro.headline', 'limit.lines', 'the intro headline needs exactly 2 lines');
    (c.intro?.headline ?? []).forEach((h, i) => range('imageCopy.intro.headline.' + i, h, { min: 2, max: L.intro.headlineLine }));
    range('imageCopy.intro.body', c.intro?.body, { min: 20, max: L.intro.body });
    if (c.audience?.length !== L.audience.count) add('imageCopy.audience', 'limit.count', 'exactly ' + L.audience.count + ' audience lines are required');
    (c.audience ?? []).forEach((t, i) => range('imageCopy.audience.' + i, t, { min: 4, max: L.audience.chars }));
    const inc = c.included ?? [];
    if (inc.length < L.included.min || inc.length > L.included.max) add('imageCopy.included', 'limit.count', L.included.min + ' to ' + L.included.max + ' included items are required');
    inc.forEach((t, i) => range('imageCopy.included.' + i, t, { min: 2, max: L.included.chars }));
    const steps = c.steps ?? [];
    if (steps.length < L.steps.min || steps.length > L.steps.max) add('imageCopy.steps', 'limit.count', L.steps.min + ' to ' + L.steps.max + ' steps are required');
    steps.forEach((s, i) => {
      range('imageCopy.steps.' + i + '.title', s.title, { min: 2, max: L.steps.title });
      range('imageCopy.steps.' + i + '.detail', s.detail, { min: 4, max: L.steps.detail });
    });
    range('imageCopy.aiNote', c.aiNote, { min: 20, max: L.aiNote.max });
  }

  // kmong's AI policy: hiding AI use is deceptive advertising, so the description and the image note say it.
  const discloses = (t) => /AI|인공지능/.test(t ?? '') && /검수|검토|확인/.test(t ?? '');
  if (!discloses(l.description)) add('description', 'listing.ai_disclosure', 'the description must say that AI tools are used and a person reviews the result');
  if (c && !discloses(c.aiNote)) add('imageCopy.aiNote', 'listing.ai_disclosure', 'the image note must say that AI tools are used and a person reviews the result');

  for (const [field, text] of listingTexts(l)) {
    for (const m of text.matchAll(SUPERLATIVE_RE)) add(field, 'listing.superlative', 'unverifiable superlative "' + m[0] + '"');
    for (const m of text.matchAll(CAREER_RE)) add(field, 'listing.career_claim', '"' + m[0] + '" states the seller\'s record, which needs profile proof on 크몽; describe the service instead');
    const g = gateOutbound({ platform: 'kmong', kind: 'listing', text }, { descriptor, instance, lessonsRules });
    for (const x of g.violations) add(field, x.rule, x.detail);
    // Hype and vanity phrasing only warns in a chat reply; a storefront listing is rejected for it.
    for (const x of g.warnings) if (/^slop\.(hype_|vanity_metric)/.test(x.rule)) add(field, x.rule, x.detail);
  }
  return v;
}

// Lengths and counts ride in descriptions: structured output does not enforce every JSON Schema
// keyword, and checkListing is where they are enforced.
const str = (max, min = 1) => ({ type: 'string', description: min + ' to ' + max + ' characters' });
const arr = (items, min, max = min) => ({ type: 'array', items, description: min === max ? 'exactly ' + min + ' items' : min + ' to ' + max + ' items' });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const LISTING_SCHEMA = obj({
  title: str(KMONG_LIMITS.title.max, KMONG_LIMITS.title.min),
  description: str(4000, KMONG_LIMITS.description.min),
  preparation: str(1500, KMONG_LIMITS.preparation.min),
  revision: str(800, 80),
  packages: arr(obj({ tier: { type: 'string', enum: TIERS }, title: str(KMONG_LIMITS.packageTitle.max), description: str(KMONG_LIMITS.packageDescription.max) }), 3),
  keywords: arr(str(KMONG_LIMITS.keywords.max), 5),
  faqs: arr(obj({ question: str(KMONG_LIMITS.faq.chars), answer: str(KMONG_LIMITS.faq.chars) }), 3, 5),
  card: obj({ headline: arr(str(KMONG_LIMITS.card.headlineLine), 2), subline: str(KMONG_LIMITS.card.subline), tags: arr(str(KMONG_LIMITS.card.tag), 3) }),
  intro: obj({ headline: arr(str(KMONG_LIMITS.intro.headlineLine), 2), body: str(KMONG_LIMITS.intro.body) }),
  audience: arr(str(KMONG_LIMITS.audience.chars), 3),
  included: arr(str(KMONG_LIMITS.included.chars), 3, 5),
  steps: arr(obj({ title: str(KMONG_LIMITS.steps.title), detail: str(KMONG_LIMITS.steps.detail) }), 4, 5),
  aiNote: str(KMONG_LIMITS.aiNote.max),
  proofCaptions: { type: 'array', items: str(60) },
  claimsUsed: { type: 'array', items: { type: 'string' } },
});

// The process field is the numbered steps the detail image shows, so the two never disagree.
export const processText = (steps) => steps.map((s, i) => (i + 1) + '. ' + s.title + ': ' + s.detail).join('\n');

function evidenceProjects(profile, service) {
  const names = new Set(profile.serviceFit?.[service]?.evidence ?? []);
  return (profile.projects ?? []).filter((p) => names.has(p.name)).map(({ name, role, what, proof, stack }) => ({ name, role, what, proof, stack }));
}

export function buildListingPrompt({ service, gig, entry, terms, profile, background, playbook, proofs = [], violations = [], previous = null }) {
  const L = KMONG_LIMITS;
  const scope = entry.kmongForm?.scope ?? [];
  const facts = {
    headline_ko: profile.headline_ko,
    summary_ko: profile.summary_ko,
    roles: (profile.roles ?? []).map(({ org, title, period }) => ({ org, title, period })),
    awards: (profile.awards ?? []).map(({ name, year }) => ({ name, year })),
    evidenceForThisService: evidenceProjects(profile, service),
    skills: profile.skills,
    serviceFit: profile.serviceFit?.[service] ?? null,
    approvedClaims: profile.approvedClaims ?? [],
  };
  const parts = [
    'You write one gig listing for the Korean freelance marketplace 크몽 (kmong.com), for the seller described below. Answer with JSON only, matching the schema.',
    '## Service\n' + JSON.stringify({ id: service, name_ko: entry.ko, name_en: entry.en, category: gig, deliverables: entry.deliverables }),
    '## Packages (fixed by code; write only each title and description, and describe this scope)\n' + terms.map((t, i) => '- ' + t.tier + ': ' + t.priceKRW + ' KRW including fee and VAT, ' + t.days + ' working days, ' + t.revisions + ' revision round(s); scope: ' + (scope[i] ?? 'same deliverables')).join('\n'),
    '## Seller facts (the only facts you may state)\n' + JSON.stringify(facts, null, 1),
    '## Claims never to make\n' + (profile.claimsNotToMake ?? []).map((c) => '- ' + c).join('\n'),
    '## Seller bios (adapt; facts only from above)\n' + background,
    '## Platform playbook\n' + playbook,
    '## Proof screenshots shown in the detail images (write one short Korean caption each, in this order, saying what it is and what the seller did; never a domain or project URL)\n' + (proofs.length ? proofs.map((p, i) => (i + 1) + '. ' + p.project + ': ' + p.note).join('\n') : '(none)'),
    [
      '## Rules',
      '- Plain Korean 합니다체. No em or en dashes, no middle dot (·) anywhere, no emoji, no exclamation marks, no hype (최고의, 완벽한, 압도적인, 혁신적인, 국내 최고, 업계 1위, 100% 보장, 최저가).',
      '- No URL, domain name (anything like name.com or name.ai), e-mail, phone number, messenger or SNS handle anywhere, including captions. Name a project by what it is, never by its domain.',
      '- Describe the service, never the seller\'s record: no title or role (대표, 수석, 강사), employer, school, award, career length or past client work, and no phrase like 경험을 바탕으로, 구축해 온, 출신, 경력. 크몽 rejects such claims without profile documents. The seller facts above are context only; proof captions may name a site as the seller\'s own work.',
      '- No number attached to experience (years, project or client counts, percentages). Nothing from the never list.',
      '- State honestly that AI tools are used in production and that a person reviews every result before delivery, in the description and in aiNote. Never present AI output as hand-made.',
      '- Do not mention tax invoices, external payment, meetings outside 크몽 or contact outside 크몽 messages.',
      '- Promise only what the packages and deliverables cover; say what is not included where a buyer might assume it.',
      '- title: ' + L.title.min + ' to ' + L.title.max + ' characters, only Hangul, Latin letters, digits, spaces and : + - # / . ( ). It names the service plainly.',
      '- description: 700 to 1800 characters of plain text with short paragraphs and simple "- " lists; sections 서비스 소개, 이런 분께 맞습니다, 제공 범위, 진행 방식, AI 활용과 검수, 유의사항. No < or backtick.',
      '- preparation: what the buyer sends before work starts, at least 60 characters.',
      '- revision: 수정 및 재진행 안내, 80 to 600 characters: what a revision round covers, what counts as new work instead, and how a redo is handled when the result misses the agreed scope.',
      '- packages: titles at most ' + L.packageTitle.max + ' characters naming the scope (not the revision count), descriptions at most ' + L.packageDescription.max + ' stating that scope; the form already shows days and revisions.',
      '- keywords: 5 distinct search terms a buyer types, at most ' + L.keywords.max + ' characters, letters, digits and spaces only.',
      '- faqs: 3 to 5 pairs, each question and answer at most ' + L.faq.chars + ' characters.',
      '- card: the 652x488 thumbnail. headline is 2 lines of at most ' + L.card.headlineLine + ' characters each (it must read at 190 px wide, so short words); subline at most ' + L.card.subline + '; 3 tags of at most ' + L.card.tag + '.',
      '- intro: the first detail image. headline 2 lines of at most ' + L.intro.headlineLine + ' characters; body at most ' + L.intro.body + '.',
      '- audience: 3 lines of at most ' + L.audience.chars + ' characters. included: 3 to 5 deliverables of at most ' + L.included.chars + '. steps: 4 to 5 process steps, title at most ' + L.steps.title + ', detail at most ' + L.steps.detail + ' (these also fill the 서비스 제공 절차 field). aiNote at most ' + L.aiNote.max + '.',
      '- claimsUsed: list each seller fact you stated.',
    ].join('\n'),
  ];
  if (violations.length) {
    parts.push('## Your previous draft was blocked. Fix every violation and keep the rest.\n' + violations.map((x) => '- ' + x.field + ' [' + x.rule + ']: ' + x.detail).join('\n'));
    if (previous) parts.push('## Previous draft\n' + JSON.stringify(previous));
  }
  return parts.join('\n\n');
}

// Assembles the listing from the model's copy and the code-owned terms.
export function assembleListing({ service, gig, terms, data, form = null }) {
  return {
    platform: 'kmong',
    service,
    category: { root: gig.root, sub: gig.sub, ...(gig.third ? { third: gig.third } : {}) },
    form: form ? { meta: form.meta ?? {}, packageSelects: form.packageSelects ?? {}, packageChecks: form.packageChecks ?? {} } : null,
    title: data.title,
    description: data.description,
    process: processText(data.steps),
    preparation: data.preparation,
    // The form labels this field already; a copy of the label as its first line is dropped.
    revision: String(data.revision ?? '').replace(/^\s*수정 및 재진행 안내\s*\n+/, ''),
    packages: terms.map((t, i) => ({ tier: t.tier, title: data.packages[i]?.title, description: data.packages[i]?.description, priceKRW: t.priceKRW, days: t.days, revisions: t.revisions })),
    keywords: data.keywords,
    faqs: data.faqs,
    imageCopy: { card: data.card, intro: data.intro, audience: data.audience, included: data.included, steps: data.steps, aiNote: data.aiNote, proofCaptions: data.proofCaptions },
    claimsUsed: data.claimsUsed,
    images: null,
  };
}

export function readBackground(instance) {
  const file = instance.paths?.background;
  return file && existsSync(file) ? readFileSync(file, 'utf8') : '';
}

export async function buildListing(service, ctx) {
  const { instance, priceTable = [], runCodex = defaultRunCodex, proofs = [] } = ctx;
  if (!instance) throw new TypeError('buildListing needs ctx.instance');
  const catalog = ctx.catalog ?? loadCatalog();
  const entry = catalog[service];
  const gig = entry?.kmongGig;
  if (!gig) throw new ListingError('FSW_LISTING_NO_CATEGORY', service + ' has no kmongGig category in services.json');
  const descriptor = ctx.descriptor ?? loadDescriptor('kmong');
  const row = priceRowFor(priceTable, 'kmong', service);
  const terms = packageTerms(service, row, catalog);
  const lessonsRules = ctx.lessonsRules ?? loadGateRules(instance);
  const brain = instance.config?.brain ?? {};
  const base = { service, gig, entry, terms, profile: instance.profile, background: ctx.background ?? readBackground(instance), playbook: ctx.playbook ?? loadPlaybook(instance, 'kmong'), proofs };
  const draft = async (extra) => {
    const { data } = await runCodex({ prompt: buildListingPrompt({ ...base, ...extra }), schema: LISTING_SCHEMA, model: ctx.model ?? brain.model, effort: ctx.effort ?? brain.effort, timeoutMs: ctx.timeoutMs ?? brain.timeoutMs });
    if ((data.proofCaptions ?? []).length !== proofs.length) data.proofCaptions = (data.proofCaptions ?? []).slice(0, proofs.length);
    const listing = assembleListing({ service, gig, terms, data, form: entry.kmongForm });
    return { data, listing, violations: checkListing(listing, { descriptor, instance, lessonsRules, priceRow: row }).concat(proofCaptionViolations(listing, proofs)) };
  };
  const first = await draft({});
  if (!first.violations.length) return { listing: first.listing, modelCalls: 1, retried: [] };
  const second = await draft({ violations: first.violations, previous: first.data });
  if (!second.violations.length) return { listing: second.listing, modelCalls: 2, retried: first.violations };
  throw new ListingError('FSW_LISTING_BLOCKED', 'the ' + service + ' listing failed its checks twice', { violations: second.violations, firstViolations: first.violations, draft: second.listing });
}

function proofCaptionViolations(listing, proofs) {
  const caps = listing.imageCopy?.proofCaptions ?? [];
  return caps.length === proofs.length ? [] : [{ field: 'imageCopy.proofCaptions', rule: 'limit.count', detail: proofs.length + ' captions are required, got ' + caps.length }];
}

