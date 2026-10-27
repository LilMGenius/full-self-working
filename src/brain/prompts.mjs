// Builds the decision prompt for one thread. Everything the model may say about the operator comes
// from the instance profile; everything it may do on a platform comes from the descriptor.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../core/instance.mjs';
import { operatorDelivered } from '../economics/catalog.mjs';
import { scopeReaches } from '../learning/scope.mjs';

export const INTENTS = ['inquiry', 'quote_request', 'negotiation', 'order_detail', 'revision', 'delivery', 'smalltalk', 'system', 'spam', 'unsupported'];
export const LESSONS_IN_PROMPT = 12;
export const HISTORY_IN_PROMPT = 30;

export function loadCatalog() {
  return JSON.parse(readFileSync(join(repoRoot, 'src', 'economics', 'services.json'), 'utf8'));
}

export const catalogIds = (catalog) => Object.keys(catalog).filter((k) => !k.startsWith('_'));

const readIf = (path) => (existsSync(path) ? readFileSync(path, 'utf8').trim() : '');

// Generic playbooks are tracked under playbooks/; the learned playbook and lessons are instance state
// that does not exist until the first learning pass, so an absent file means "nothing learned yet".
export function loadPlaybook(instance, platform) {
  const parts = [readIf(join(repoRoot, 'playbooks', 'common.md')), readIf(join(repoRoot, 'playbooks', platform + '.md'))];
  const learned = readIf(join(instance.paths.lessons, 'playbook.md'));
  if (learned) parts.push('## Learned rules (instance)\n\n' + learned);
  return parts.filter(Boolean).join('\n\n');
}

// The newest lessons for one platform's prompt: a lesson scoped to other platforms (appliesTo) stays out; a
// lesson without appliesTo, with an empty one, one holding an unknown value, or scoped to all, reaches every
// platform (src/learning/scope.mjs).
export function loadLessons(instance, { platform = null, limit = LESSONS_IN_PROMPT } = {}) {
  const file = join(instance.paths.lessons, 'lessons.jsonl');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const applies = (l) => !platform || scopeReaches(l.appliesTo, platform);
  return lines.map((l) => JSON.parse(l)).filter(applies).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))).slice(0, limit);
}

// The payout account is released only where the gate would let it through: a platform that allows
// direct transfer, after the quote was accepted (src/policy/gate.mjs, payment rule).
export const payoutReleasable = (descriptor, stage) => descriptor.offPlatformPayment === true && stage === 'quote_accepted';

function businessTerms(business, descriptor, stage) {
  const lines = [];
  if (business?.company) lines.push('- 상호: ' + business.company);
  if (business?.taxInvoice) lines.push('- 전자세금계산서 발행 가능' + (business.taxInvoiceNote ? ' (' + business.taxInvoiceNote + ')' : ''));
  if (payoutReleasable(descriptor, stage) && business?.payout?.account) {
    lines.push('- 입금 계좌 (견적 수락 후에만 안내): ' + [business.payout.bank, business.payout.account, business.payout.holder].filter(Boolean).join(' '));
  } else {
    lines.push('- Never write a bank account, payout account or transfer instruction in this reply.');
  }
  return lines.join('\n');
}

function priceLines(priceRows, catalog) {
  if (!priceRows.length) return '(no price rows for this platform; do not quote a number, set needsOperator)';
  return priceRows
    .map((r) => {
      const name = catalog[r.service]?.ko ?? r.service;
      const pk = r.packages ? 'standard ' + r.packages.standard + ', deluxe ' + r.packages.deluxe + ', premium ' + r.packages.premium : 'base ' + r.baseKRW;
      return '- ' + r.service + ' (' + name + '): ' + pk + ' KRW; allowed range ' + r.floorKRW + ' to ' + r.ceilingKRW + ' KRW' + (r.viable === false ? '; NOT VIABLE, do not quote, set needsOperator' : '');
    })
    .join('\n');
}

// Each service with the past work the profile ties to it and what its recipe delivers, so a reply cites
// a project only where serviceFit names it and scopes only what the job hands over.
function catalogLines(catalog, profile) {
  return catalogIds(catalog)
    .map((id) => {
      const fit = profile.serviceFit?.[id];
      const evidence = fit?.evidence ?? [];
      const cite = evidence.length ? '; past work to cite: ' + evidence.join(', ') : '; no past work to cite';
      const delivers = catalog[id].deliverables?.length ? '; delivers ' + catalog[id].deliverables.join(', ') : '';
      const mine = catalog[id].operatorSteps?.length ? '; operator steps I do myself after the build passes its checks: ' + catalog[id].operatorSteps.join(', ') : '';
      return '- ' + id + ': ' + catalog[id].ko + ' / ' + catalog[id].en + ' (fit: ' + (fit?.strength ?? 'none') + cite + ')' + delivers + mine;
    })
    .join('\n');
}

// Services the operator delivers (lessons): what a reply asks before quoting one, and how its price reads.
function operatorServiceLines(catalog) {
  const ids = catalogIds(catalog).filter((id) => operatorDelivered(id, catalog));
  if (!ids.length) return [];
  return [
    '',
    '# Services I deliver myself',
    'I teach these myself in sessions I schedule with the client, online or in person; no files are delivered and nothing starts before the deposit. Before quoting one, ask what its line lists that the customer has not said. Its standard package and a request quote price one session of the length below, so the quote scope names the number of sessions and their length. With no price row for it on this platform, write no price and set needsOperator.',
    ...ids.map((id) => '- ' + id + ' (' + catalog[id].ko + '): ' + (catalog[id].humanMinutes?.standard ?? 60) + '-minute sessions; ask ' + (catalog[id].questions ?? []).join('; ')),
  ];
}

export function threadHistory(thread, limit = HISTORY_IN_PROMPT) {
  const msgs = (thread.messages ?? []).slice(-limit);
  if (!msgs.length) return '(no messages)';
  return msgs.map((m) => '[' + (m.direction === 'out' ? 'me' : 'customer') + (m.at ? ' ' + m.at : '') + '] ' + String(m.text ?? m.body ?? '').trim()).join('\n');
}

const replyLanguage = (descriptor) =>
  descriptor.region === 'kr'
    ? 'Write the reply in Korean 존댓말 (합니다체 or 해요체, polite and plain) unless the customer wrote in another language; then use the customer\'s language.'
    : 'Write the reply in the customer\'s language.';

export function buildDecisionPrompt({ thread, instance, descriptor, priceRows = [], catalog = loadCatalog(), playbook = '', lessons = [], violations = [], previousReply = null }) {
  const p = instance.profile ?? {};
  const stage = thread.stage ?? 'pre_order';
  const pre = stage === 'pre_order';
  const contactAllowed = (pre ? descriptor.contactPolicy.preOrder : descriptor.contactPolicy.postOrder).join(', ') || 'none';
  const sections = [
    '# Role',
    'You answer customers on ' + descriptor.name + ' (' + descriptor.id + ') as the seller below, in the first person, as yourself. You are deciding one reply for one conversation. Do not run commands or read files; answer only with the JSON object the schema describes.',
    replyLanguage(descriptor),
    '',
    '# Who I am (the only facts you may state about me)',
    'Name: ' + (p.person?.nameKo ?? '') + ' / ' + (p.person?.nameEn ?? ''),
    'Headline: ' + (p.headline_ko ?? '') + ' / ' + (p.headline_en ?? ''),
    'Summary (ko): ' + (p.summary_ko ?? ''),
    'Summary (en): ' + (p.summary_en ?? ''),
    'Approved claims, the only experience numbers you may write, verbatim: ' + JSON.stringify(p.approvedClaims ?? []),
    'Claims never to make: ' + JSON.stringify(p.claimsNotToMake ?? []),
    'Projects I can cite by name: ' + JSON.stringify((p.projects ?? []).map((x) => x.name)),
    '',
    '# Business terms',
    businessTerms(instance.business, descriptor, stage),
    '',
    '# Platform rules (' + descriptor.name + ')',
    '- Stage of this conversation: ' + stage + '. Contact classes allowed now: ' + contactAllowed + '. Never write a phone number, e-mail, URL, messenger ID or open chat link unless its class is allowed.',
    '- Contact policy: ' + (descriptor.contactPolicy.notes ?? ''),
    '- Off-platform payment allowed: ' + descriptor.offPlatformPayment + '. ' + (descriptor.offPlatformPayment ? '' : 'Never suggest 계좌이체, 직거래 or paying outside the platform.'),
    '- Payment split mechanism: ' + descriptor.splitMechanism,
    '- AI policy: ' + descriptor.aiPolicy,
    '- Automation rules: do not do ' + JSON.stringify(descriptor.automation?.forbidden ?? []),
    '',
    '# Service catalog (set service to one of these ids, or null)',
    catalogLines(catalog, p),
    ...operatorServiceLines(catalog),
    '',
    '# Price rows on this platform (KRW)',
    priceLines(priceRows, catalog),
    '',
    '# Conversion flow',
    '1. Answer fast and specifically; one short greeting at most.',
    '2. Ask only the two or three questions that decide the scope and price (see the playbook for the service family).',
    '3. When the scope is clear enough, propose a package from the price rows or a scoped quote inside the allowed range, with scope items and delivery days. Put the same numbers in the quote field.',
    '   quote.complexity rates the work against a typical job in its service, from 0.6 (much smaller) through 1.0 (typical) to 1.6 (much larger).',
    '   Every package and quote includes one revision round, which the catalog hours assume; offer further rounds as extra paid work, never as included.',
    '4. Offer the platform split mechanism above for larger amounts (deposit and balance, or phase orders on 크몽), never an off-platform transfer.',
    '5. Never promise what my profile cannot back: no invented numbers, clients, reviews, guarantees or timelines you cannot keep. Cite a project as past work only for the service whose catalog line names it, and scope only what that line delivers. The operator steps of a line are mine to do after the build passes its checks: name them as my steps in the scope, and promise one that a line marks as conditional only when its condition holds. List every profile claim you used in claimsUsed.',
    '6. If the service is not in the catalog, or the work would break a law or another service\'s terms (a game bot or cheat, fake reviews, account farming), set intent "unsupported", needsOperator true and say why in operatorReason; you may still write a polite holding reply that promises nothing. A fit of "none" only means there is no past work to cite: offer the service from the price rows and claim no experience in it.',
    '7. Set needsOperator only for a decision the profile, the price rows and the reply cannot make: a price outside the allowed range, a legal, refund or dispute question, a call or visit asked for before any order, or a commitment the profile does not back. Scope, volume, schedule, location and materials the customer has not given yet are not such a decision: price the typical job from the rows, state the assumption in the scope, and ask for the missing facts in the reply. Set reply null for spam or when no reply is due.',
    '8. Plain text only: no markdown, no em dash, no middle-dot lists, no hype words, no emoji bullets.',
    '9. After a delivery I asked whether the work may be shown in my portfolio. When the customer answers, set portfolioPermission and copy their sentence verbatim into permissionQuote; otherwise both are null. granted only when the consent sets no condition, limitation, preference or timing about what, where, how or when the work is shown; conditional when it sets any, with permissionQuote holding the sentence that sets it ("네, 로고만 빼고 올려 주세요." is conditional; "Sure, once the site is live." is conditional); refused when they say no. Never infer a yes from thanks alone.',
    '10. A request to change delivered work is intent "revision"; restate what changes in the reply. Only one revision round is included; do not promise a further round as free.',
    '',
    '# Playbook',
    playbook || '(none)',
  ];
  if (lessons.length) {
    sections.push('', '# Newest lessons', ...lessons.map((l) => '- [' + (l.class ?? 'lesson') + '] ' + l.rule));
  }
  sections.push('', '# Conversation (' + (thread.kind ?? 'message') + ', customer: ' + (thread.customer ?? 'unknown') + (thread.title ? ', title: ' + thread.title : '') + ')', threadHistory(thread));
  if (thread.kind === 'request') {
    sections.push(
      '',
      '# This is a buyer request',
      'The reply goes out through the platform quote form, which shows the price beside your text, so quote is required: scope, deliveryDays (a whole number of days, at least 1; for a service I deliver myself, the days until the first session), priceType "fixed" and complexity. On a platform with a price guide the amount is computed from the guide and your complexity, so write no price in the reply and set amountKRW to your best estimate. Use the reply to show you read the request: restate the need in one line, say what is included, ask the one or two questions that remain, and mention the deposit and balance split. Set statedBudgetKRW to the budget the customer states for this work, in the request form or in the text, as whole KRW, or null when none is stated.',
    );
  }
  if (violations.length) {
    sections.push(
      '',
      '# Your previous reply was blocked by the outbound gate',
      'Previous reply: ' + JSON.stringify(previousReply ?? ''),
      'Violations (rule: detail):',
      ...violations.map((v) => '- ' + v.rule + ': ' + v.detail),
      'Write a new reply that keeps the intent and fixes every violation.',
    );
  }
  return sections.join('\n');
}
