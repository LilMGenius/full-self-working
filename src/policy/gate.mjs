// The deterministic outbound gate. Every message, quote, listing and profile edit passes here
// before it leaves the machine; docs/DESIGN.md (Policy gate) is the contract.
import { scopeReaches } from '../learning/scope.mjs';
import { lintText } from './slop.mjs';

const SEP = '[\\s.\\-()]*';
const digitsPattern = (digits) => digits.split('').join(SEP);
const KR_PREFIX = `(?:\\+${SEP}82${SEP}0?${SEP}|0${SEP})`;
const PHONE_RES = [
  new RegExp(`(?<!\\d)${KR_PREFIX}1${SEP}[016789](?:${SEP}\\d){7,8}(?!\\d)`, 'g'),
  new RegExp(`(?<!\\d)${KR_PREFIX}(?:2|[3-6]${SEP}[1-5])(?:${SEP}\\d){7,8}(?!\\d)`, 'g'),
  new RegExp(`(?<!\\d)0${SEP}[57]${SEP}0(?:${SEP}\\d){7,9}(?!\\d)`, 'g'),
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL_RES = [
  /\bhttps?:\/\/[^\s<>"'()\[\]]+/gi,
  /\bwww\.[^\s<>"'()\[\]]+/gi,
  // Bare domains need a lowercase TLD, so ASP.NET or Node.js stay prose.
  /(?<![@\w.-])(?:[A-Za-z0-9-]+\.)+(?:com|net|org|kr|io|me|ai|app|dev|xyz|link|ly|gg|so|page|site|shop|biz|info|co|tv|to)(?![A-Za-z0-9-])(?:\/[^\s<>"'()]*)?/g,
];
// A messenger name followed by bot or API words describes a service (텔레그램 봇 개발), not a contact.
const NOT_CONTACT = '(?!\\s*(?:봇|챗봇|bot|api|알림톡|연동|로그인|login|공유하기))';
const MESSENGER_RE = new RegExp(
  `(?:카톡\\s*(?:아이디|id)|kakao\\s*(?:id|talk)|line\\s*id|라인\\s*(?:아이디|id)|오픈\\s*채팅|(?:카카오톡|카톡|telegram|텔레그램|whatsapp|왓츠앱|wechat|위챗))${NOT_CONTACT}`,
  'gi',
);
// "추가 수수료 없이" is a scope promise; a bare "수수료 없이" is a fee-dodging pitch.
const OFF_PLATFORM_RE = /계좌\s*이체|직거래|입금\s*해\s*주시면|외부\s*결제|(?<!추가\s*)수수료\s*없이|현금\s*거래|bank\s*transfer|wire\s*transfer|pay(?:ment)?\s*outside|outside\s*(?:of\s*)?(?:the\s*)?platform|paypal\s*\.?\s*me\b/gi;

const CLAIM_RES = [
  /경력\s*\d+(?:\.\d+)?\s*년(?:\s*이상)?/g,
  /\d+(?:\.\d+)?\s*년\s*(?:이상\s*)?(?:의\s*)?경력/g,
  /\d+\s*년\s*차/g,
  /\d[\d,]*\s*\+?\s*건\s*이상/g,
  /\d[\d,]*\s*\+?\s*개\s*이상(?:의)?\s*프로젝트/g,
  /\d[\d,]*\s*\+?\s*명\s*(?:이상\s*)?(?:의\s*)?고객/g,
  /\d+(?:\.\d+)?\s*%/g,
  /\d+\s*\+?\s*years?\s+(?:of\s+)?experience/gi,
  /\d[\d,]*\s*\+?\s*(?:projects|clients|customers)\b/gi,
];
// A percentage next to these words is a payment term, not an experience claim.
const PERCENT_TERMS = /선금|선급|계약금|잔금|착수금|중도금|할인|수수료|부가세|vat|deposit|upfront|balance|discount|fee|tax|milestone/i;

const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();
const overlaps = (a, spans) => spans.some((b) => a.index < b.end && b.index < a.end);
const spansOf = (re, text) => [...text.matchAll(re)].map((m) => ({ index: m.index, end: m.index + m[0].length, value: m[0] }));
const LETTER_HANGUL = /\p{Script=Hangul}/gu;
const LETTER_LATIN = /[A-Za-z]/g;

export function hangulRatio(text) {
  const ko = String(text ?? '').match(LETTER_HANGUL)?.length ?? 0;
  const en = String(text ?? '').match(LETTER_LATIN)?.length ?? 0;
  return ko + en === 0 ? null : ko / (ko + en);
}

export function detectLanguage(text) {
  const r = hangulRatio(text);
  return r === null ? null : r >= 0.25 ? 'ko' : 'en';
}

function hostOf(url) {
  return url.replace(/^https?:\/\//i, '').split(/[/?#:]/)[0].replace(/^www\./i, '').toLowerCase();
}

function gateStage(item) {
  if (item.kind === 'listing' || item.kind === 'profile') return 'pre_order';
  return item.thread?.stage ?? 'pre_order';
}

function payoutMatchers(business) {
  const out = [];
  const digits = String(business?.payout?.account ?? '').replace(/\D/g, '');
  if (digits.length >= 6) out.push(new RegExp(`(?<!\\d)${digitsPattern(digits)}(?!\\d)`, 'g'));
  const bank = String(business?.payout?.bank ?? '').trim();
  const names = [...new Set([bank, bank.replace(/은행$/, '')])].filter((n) => n.length >= 2).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (names.length) out.push(new RegExp(`(?:${names.join('|')})\\s*.{0,6}계좌|계좌\\s*.{0,6}(?:${names.join('|')})`, 'g'));
  return out;
}

// The operator's names on a platform whose terms bar identifying details (contactPolicy.identity
// "forbidden", as on 위시켓): the person's names and handle, the payout holder, the business name and
// every organisation the profile's roles show the person founding or heading, since each of those is a
// trade name. An employer or a school is not one, and the brain's prompts keep those out instead.
const OWNER_TITLE = /founder|owner|\bceo\b|대표|창업/i;

// identityParts splits them into people (names, handle, payout holder) and companies, for a caller that
// rewrites them in prose; identityNames is both. employers are the other organisations of the profile's
// roles: the gate lets them through, and prompts on such a board swap them for neutral words.
const GENERIC_ORG = /^(?:independent|freelance|self-employed|프리랜서)$/i;

export function identityParts(instance = {}) {
  const profile = instance.profile ?? {};
  const isOwned = (r) => OWNER_TITLE.test([r.title, r.title_ko].filter(Boolean).join(' '));
  const roles = profile.roles ?? [];
  const names = (raw) => {
    const split = raw.filter((n) => typeof n === 'string').flatMap((n) => [n.split(/\s*[(,]/)[0], n.match(/\(([^)]+)\)/)?.[1]]);
    return [...new Set(split.filter(Boolean).map((n) => n.trim()).filter((n) => n.length >= 2 && !GENERIC_ORG.test(n)))];
  };
  const people = names([profile.person?.nameKo, profile.person?.nameEn, profile.person?.handle, instance.business?.payout?.holder]);
  const companies = names([instance.business?.company, ...roles.filter(isOwned).flatMap((r) => [r.org, r.org_ko])]);
  return {
    people,
    companies,
    employers: names(roles.filter((r) => !isOwned(r)).flatMap((r) => [r.org, r.org_ko])).filter((n) => !companies.includes(n)),
  };
}

export function identityNames(instance = {}) {
  const { people, companies } = identityParts(instance);
  return [...new Set([...people, ...companies])];
}

// A Latin name matches as a whole word in any case (mark is not market); any name may be spaced.
export function namePattern(name, flags = '') {
  const body = name.split(/\s+/).map((w) => w.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')).join('\\s*');
  return /^[\x20-\x7E]+$/.test(name) ? new RegExp('(?<![A-Za-z0-9])' + body + '(?![A-Za-z0-9])', 'i' + flags) : new RegExp(body, flags);
}

export function gateOutbound(item, ctx = {}) {
  const violations = [];
  const warnings = [];
  const add = (list, rule, detail) => list.push({ rule, detail });
  const { descriptor, instance = {}, priceRow = null, lessonsRules = [] } = ctx;
  if (!descriptor) throw new TypeError('gateOutbound needs ctx.descriptor');
  const text = String(item.text ?? '');
  const attachmentNames = (item.attachments ?? []).map((a) => (typeof a === 'string' ? a : a?.name ?? '')).filter(Boolean);
  const scan = [text, ...attachmentNames].join('\n');
  const stage = gateStage(item);
  const policy = descriptor.contactPolicy ?? {};
  const allowedClasses = new Set(stage === 'pre_order' ? policy.preOrder ?? [] : policy.postOrder ?? []);
  const allowedHosts = (policy.allowedHosts ?? []).map((h) => h.toLowerCase());
  const directTransfer = descriptor.offPlatformPayment === true && stage === 'quote_accepted';

  // payment: the payout account and its bank name, released only for a direct transfer after acceptance
  const accountSpans = payoutMatchers(instance.business).flatMap((re) => spansOf(re, scan));
  if (accountSpans.length && !directTransfer) add(violations, 'payment.account', `payout account details at stage ${stage} on ${descriptor.id}`);
  for (const s of spansOf(OFF_PLATFORM_RE, scan)) {
    if (!directTransfer) add(violations, 'payment.offplatform', `off-platform payment wording "${s.value}"`);
  }

  // contact
  const contact = (cls, value) => {
    if (!allowedClasses.has(cls)) add(violations, `contact.${cls}`, `${cls} "${value}" is not allowed at stage ${stage} on ${descriptor.id}`);
  };
  for (const re of PHONE_RES) for (const s of spansOf(re, scan)) if (!overlaps(s, accountSpans)) contact('phone', s.value.trim());
  const emailSpans = spansOf(EMAIL_RE, scan);
  for (const s of emailSpans) contact('email', s.value);
  const urlSpans = [];
  for (const re of URL_RES) {
    for (const s of spansOf(re, scan)) {
      if (overlaps(s, emailSpans) || overlaps(s, urlSpans)) continue;
      urlSpans.push(s);
      const host = hostOf(s.value);
      if (allowedHosts.some((h) => host === h || host.endsWith('.' + h))) continue;
      contact('url', s.value);
    }
  }
  for (const s of spansOf(MESSENGER_RE, scan)) contact('messenger', s.value);

  // identity
  if (policy.identity === 'forbidden') {
    for (const name of identityNames(instance)) {
      const hit = scan.match(namePattern(name));
      if (hit) add(violations, 'identity.name', '"' + hit[0] + '" identifies the seller, which ' + descriptor.id + ' forbids');
    }
  }

  // price: a quote, and a proposal answering a buyer request on a bidding board, which code prices like a quote
  // (U8.11 of wp8). kmong's enterprise proposals answer a project and are priced by their own planner.
  if (item.kind === 'quote' || (item.kind === 'proposal' && item.thread?.kind === 'request')) {
    if (typeof item.amountKRW !== 'number') add(violations, 'price.missing', 'a ' + item.kind + ' goes out through a form that needs an amount, and this one has none');
    else if (priceRow) {
      const { floorKRW, ceilingKRW } = priceRow;
      if ((floorKRW != null && item.amountKRW < floorKRW) || (ceilingKRW != null && item.amountKRW > ceilingKRW)) {
        add(violations, 'price.range', `${item.amountKRW} KRW is outside [${floorKRW}, ${ceilingKRW}]`);
      }
    } else if (!priceRow) add(warnings, 'price.no_row', 'no price row for this service');
  }
  // A priced chat answer carries the amount line code appends (priceLine of src/brain/respond.mjs), and every
  // won figure in it is that amount or one of its split parts, so the buyer never reads a price code did not set.
  if (item.kind === 'message' && typeof item.amountKRW === 'number') {
    const allowed = new Set([item.amountKRW, ...(item.decision?.quote?.split?.parts ?? []).map((p) => p.amountKRW)]);
    const figures = [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/g)].map((m) => Number(m[1].replace(/,/g, '')));
    for (const f of figures.filter((x) => !allowed.has(x))) add(violations, 'price.text', f.toLocaleString('en') + ' KRW in the reply is not the quoted ' + item.amountKRW.toLocaleString('en') + ' KRW or a split part; write no amount, the quote line is added below the reply');
  }

  // claims
  const profile = instance.profile ?? {};
  const approved = (profile.approvedClaims ?? []).map(norm);
  const claimSpans = [];
  const cited = [];
  for (const re of CLAIM_RES) {
    for (const s of spansOf(re, text)) {
      if (overlaps(s, claimSpans)) continue;
      claimSpans.push(s);
      if (s.value.includes('%') && PERCENT_TERMS.test(text.slice(Math.max(0, s.index - 12), s.end + 12))) continue;
      if (!approved.some((a) => a.includes(norm(s.value)))) add(violations, 'claims.unapproved', `"${s.value.trim()}" is not in profile.approvedClaims`);
      else cited.push(s.value.trim());
    }
  }
  // An approved claim is experience the profile backs for the services its serviceFit ties to past work;
  // in a reply for a service whose serviceFit names none, it claims experience in that service.
  const service = item.decision?.service;
  if (service && cited.length && !(profile.serviceFit?.[service]?.evidence ?? []).length) {
    add(violations, 'claims.no_fit', `"${cited.join('", "')}" cites experience, but profile.serviceFit names no past work for ${service}`);
  }
  for (const banned of profile.claimsNotToMake ?? []) {
    if (banned && text.includes(banned)) add(violations, 'claims.forbidden', `"${banned}" is in profile.claimsNotToMake`);
  }

  // slop
  const lang = detectLanguage(text) ?? undefined;
  for (const f of lintText(text, { lang })) add(f.tier === 'floor' ? violations : warnings, `slop.${f.rule}`, f.excerpt);

  // shape
  const max = descriptor.limits?.[item.kind]?.maxChars;
  const length = [...text].length;
  if (Number.isInteger(max) && length > max) add(violations, 'shape.length', `${length} characters exceeds ${max} for ${item.kind}`);
  if (!text.trim() && !attachmentNames.length) add(violations, 'shape.empty', 'empty outbound item');
  if (item.kind === 'message' || item.kind === 'quote') {
    const inbound = item.thread?.lastInboundText;
    const expected = detectLanguage(inbound) ?? item.thread?.language ?? null;
    if (expected && lang && expected !== lang) add(violations, 'shape.language', `reply is ${lang} but the customer wrote ${expected}`);
    if ((item.thread?.recentOutbound ?? []).some((t) => norm(t) === norm(text)) && text.trim()) add(violations, 'shape.duplicate', 'same text was already sent in this thread');
  }

  // learned: a rule fires only on the platforms its lesson came from (appliesTo, normalized by
  // src/learning/scope.mjs); a rule without a scope, an empty one or one holding an unknown value fires everywhere.
  for (const rule of (lessonsRules ?? []).filter((r) => scopeReaches(r.appliesTo, item.platform))) {
    let re;
    try {
      re = new RegExp(rule.pattern, rule.flags ?? 'iu');
    } catch {
      add(warnings, 'learned.invalid', `rule ${rule.id} has an invalid pattern`);
      continue;
    }
    if (re.test(text)) add(rule.tier === 'reflex' ? warnings : violations, `learned.${rule.id}`, rule.reason ?? rule.pattern);
  }

  return { ok: violations.length === 0, violations, warnings };
}
