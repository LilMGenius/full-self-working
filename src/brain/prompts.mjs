// Builds the decision prompt for one thread. Everything the model may say about the operator comes
// from the instance profile; everything it may do on a platform comes from the descriptor.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../core/instance.mjs';

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

export function loadLessons(instance, limit = LESSONS_IN_PROMPT) {
  const file = join(instance.paths.lessons, 'lessons.jsonl');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  return lines.map((l) => JSON.parse(l)).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))).slice(0, limit);
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

function catalogLines(catalog, profile) {
  return catalogIds(catalog)
    .map((id) => '- ' + id + ': ' + catalog[id].ko + ' / ' + catalog[id].en + ' (fit: ' + (profile.serviceFit?.[id]?.strength ?? 'not offered') + ')')
    .join('\n');
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
    '5. Never promise what my profile cannot back: no invented numbers, clients, reviews, guarantees or timelines you cannot keep. List every profile claim you used in claimsUsed.',
    '6. If the service is not in the catalog or its fit is "not offered" or "none", set intent "unsupported", needsOperator true and say why in operatorReason; you may still write a polite holding reply that promises nothing.',
    '7. Set needsOperator when a human decision is needed (custom pricing outside the range, legal or refund questions, a meeting request, anything you are unsure of). Set reply null for spam or when no reply is due.',
    '8. Plain text only: no markdown, no em dash, no middle-dot lists, no hype words, no emoji bullets.',
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
      'The reply goes out through the platform quote form, which shows the price beside your text, so quote is required: scope, deliveryDays, priceType "fixed" and complexity. On a platform with a price guide the amount is computed from the guide and your complexity, so write no price in the reply and set amountKRW to your best estimate. Use the reply to show you read the request: restate the need in one line, say what is included, ask the one or two questions that remain, and mention the deposit and balance split.',
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
