// The prompts src/projects/draft.mjs sends: how each board appears to the writer and the critic, the profile lines
// each may cite (masked on a board that forbids identifying details), and the critic's answer schema.
import { dayKey } from '../core/clock.mjs';
import { identityParts, namePattern } from '../policy/gate.mjs';

export const PILOT_RE = /시범|파일럿|pilot|PoC|POC|개념\s*검증|테스트\s*구축|1차\s*구축/i;

// How each board appears in the prompts: the program a proposal is for, the platform payment stays on,
// the project lines the writer and the critic read, and any rule on terms the board adds.
export const won = (n) => n.toLocaleString('en-US') + '원';

const percents = (shares) => shares.map((s) => Math.round(s * 100)).join(', ') + ' percent';

export const BOARD_COPY = {
  kmong: {
    board: '크몽 엔터프라이즈',
    platform: '크몽',
    projectLines: (p) => [
      'Category: ' + [p.root?.name, p.sub?.name].filter(Boolean).join(' / '),
      'Budget: ' + p.amountKRW + ' KRW' + (p.isTax ? ', tax invoice needed' : ''),
      'Start: ' + (p.startDate ?? 'not given') + ', end: ' + (p.endDate ?? 'not given') + ', deadline to propose: ' + (p.deadlineAt ?? 'unknown'),
      'Readiness: ' + (p.readiness ?? 'not given'),
    ],
    criticBudget: (p) => 'Budget: ' + p.amountKRW + ' KRW; start ' + (p.startDate ?? '?') + ', end ' + (p.endDate ?? '?'),
    termsRule: () => null,
    periodRule: () => '',
    criticRule: '',
  },
  wishket: {
    board: '위시켓',
    platform: '위시켓',
    projectLines: (p) => [
      'Category: ' + [p.root?.name, p.sub?.name].filter(Boolean).join(' / '),
      'Skills the client named: ' + ((p.skills ?? []).join(', ') || 'none'),
      'Budget: ' + p.amountKRW + ' KRW before VAT' + (p.budgetSource === 'description' ? ' (the page leaves the budget to negotiation; this is the amount its description names)' : ''),
      'Expected period: ' + (p.durationDays ? p.durationDays + ' days' : 'not given') + ', start: ' + (p.startDate ?? p.startText ?? 'not given') + ', deadline to apply: ' + (p.deadlineAt ?? 'unknown'),
    ],
    criticBudget: (p) => 'Budget: ' + p.amountKRW + ' KRW before VAT; expected period ' + (p.durationDays ? p.durationDays + ' days' : 'not given') + ', start ' + (p.startDate ?? p.startText ?? '?'),
    // 위시켓 holds the client's payment in escrow under its standard contract and adds VAT on top, so the
    // split is proposed as contract stages, in the shares config.payment sets.
    termsRule: (payment) => '- terms: every amount is before VAT, which 위시켓 adds to what the client pays, and payment runs through 위시켓 escrow under its standard contract, so propose the split as contract stages tied to the phases' + (Array.isArray(payment?.milestones) && payment.milestones.length ? ' (for example ' + percents(payment.milestones) + ')' : '') + ', never as a payment to me directly.',
    periodRule: (p) => (p.durationDays ? ' The client expects about ' + p.durationDays + ' days from the start; fit the plan to that or say in need why the scope takes longer.' : ''),
    criticRule: ' A name, a company or trade name, a project or product name or a link anywhere in the proposal is a problem and makes claimsBacked false, since 위시켓 forbids anything that identifies a member.',
  },
};

const copyOf = (platform) => {
  const copy = BOARD_COPY[platform];
  if (!copy) throw new RangeError('no proposal copy for platform ' + platform);
  return copy;
};

export const toDay = (now) => dayKey(now).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');

function anonymizer(instance) {
  const { people, companies, employers } = identityParts(instance);
  const swaps = [...people.map((n) => [n, '본인']), ...companies.map((n) => [n, '제 회사']), ...employers.map((n) => [n, '이전 직장'])]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([n, to]) => [namePattern(n, 'g'), to]);
  return (text) => swaps.reduce((t, [re, to]) => t.replace(re, to), String(text ?? ''));
}

function profileLines(profile, mask = null) {
  const p = profile ?? {};
  if (mask) {
    return [
      'Headline: ' + mask(p.headline_ko ?? ''),
      'Summary: ' + mask(p.summary_ko ?? ''),
      'Work I can describe (by what was built, my role and the stack; never name a project, product, client or company, never paste a link): ' + JSON.stringify((p.projects ?? []).map((x) => ({ role: mask(x.role_ko ?? x.role), what: mask(x.what_ko ?? x.what), stack: x.stack }))),
      'Skills: ' + JSON.stringify(p.skills ?? {}),
      'Approved claims, the only experience numbers you may write, verbatim: ' + JSON.stringify(p.approvedClaims ?? []),
      'Claims never to make: ' + JSON.stringify(p.claimsNotToMake ?? []),
    ].join('\n');
  }
  return [
    'Name: ' + (p.person?.nameKo ?? '') + ' / ' + (p.person?.nameEn ?? ''),
    'Headline: ' + (p.headline_ko ?? ''),
    'Summary: ' + (p.summary_ko ?? ''),
    'Projects I can describe (by what was built; never cite a client name, never paste a link): ' + JSON.stringify((p.projects ?? []).map((x) => ({ name: x.name, role: x.role, what: x.what, stack: x.stack }))),
    'Skills: ' + JSON.stringify(p.skills ?? {}),
    'Approved claims, the only experience numbers you may write, verbatim: ' + JSON.stringify(p.approvedClaims ?? []),
    'Claims never to make: ' + JSON.stringify(p.claimsNotToMake ?? []),
  ].join('\n');
}

// critique is the critic's verdict on an earlier draft ({score, problems, text}); violations are the gate
// and plan findings on the draft just written (previous). platform picks the board's copy; anonymous drops
// every identifying detail from what the writer reads.
export function buildProposalPrompt({ project, instance, service, floorKRW, minKRW = 0, maxChars = null, now = new Date(), violations = [], previous = null, critique = null, platform = 'kmong', anonymous = false }) {
  const requested = project.requested ?? [];
  const least = Math.max(floorKRW, minKRW);
  const copy = copyOf(platform);
  const mask = anonymous ? anonymizer(instance) : null;
  const terms = copy.termsRule(instance.config?.payment);
  const sections = [
    '# Role',
    'You write one proposal for a ' + copy.board + ' project as the seller below, in Korean 합니다체, plain and specific. Answer only with the JSON object the schema describes; do not run commands or read files.',
    '',
    '# Who I am (the only facts you may state about me)',
    profileLines(instance.profile, mask),
    ...(mask ? [] : ['Company: ' + (instance.business?.company ?? '')]),
    '',
    '# Rules',
    '- Restate the need in need, in your own words.',
    '- answers has exactly ' + requested.length + ' entries, one per requested item below, in order. Restate each item as a short phrase in item and answer it concretely: approach, tools, what the client gets, and what you need from them. If something cannot be promised, say what you would do and what decides it.',
    '- When an item asks for past cases or similar experience, describe the closest projects from my profile by what was built, my role and the stack, and say plainly which part of this project they do not cover. Never answer only that there is nothing to show. For experience the profile does not show (a platform, a payment gateway, a language), name the nearest real work and how you would cover the gap (a pilot, a test environment, a review step); never claim it.',
    '- phases is a plan of 2 to 5 phases, each with distinct deliverables, start and end dates (YYYY-MM-DD, starting no earlier than ' + toDay(now) + (project.endDate ? ', ending by ' + project.endDate + ' with a few working days of buffer before it' : '') + ') and a price in KRW rounded to 10,000. The total must be at most the budget ' + project.amountKRW + ' KRW and at least ' + least + ' KRW. Price it as a fair offer for the scope, not automatically at the budget; when the scope does not fit the budget, keep the core inside it and name the rest as options with a price range.' + (PILOT_RE.test(project.description) ? ' The client asked for a pilot: phase 1 is the pilot (pilot true) with its own deliverable and acceptance check.' : ' Set pilot true only on a pilot phase.') + (project.startDate ? ' If the plan starts after the client\'s start date ' + project.startDate + ', say why in need or closing.' : '') + copy.periodRule(project),
    '- deliverables are short noun phrases. Prices, VAT, the tax invoice, payment terms and exclusions go in terms; what you need from the client goes in closing.',
    ...(terms ? [terms] : []),
    '- aiNote says plainly that production uses AI tools and every deliverable is reviewed by me before delivery.',
    '- Never write a phone number, e-mail, URL, domain, messenger ID or meeting link, and never suggest paying outside ' + copy.platform + '. No client or employer names. No numbers about experience unless they are approved claims. No guarantees you cannot keep.',
    ...(mask ? ['- Never write my name, a company or trade name, a project or product name, a logo or a link: ' + copy.platform + ' forbids anything that identifies a member, and the proposal is blocked when one appears. Describe past work by what was built, my role and the stack.'] : []),
    '- Plain text: no markdown, no em dash, no middle dot between words (write 과 or a comma), no hype words, no emoji. Write every amount with thousands separators and 원 (500,000원).' + (maxChars ? ' The composed proposal must stay under ' + maxChars + ' characters, headings included, so keep each answer to what the client needs to decide.' : ''),
    '- List every profile fact you used in claimsUsed.',
    '',
    '# Project (catalog service: ' + service + ')',
    'Title: ' + project.title,
    ...copy.projectLines(project),
    'Description:',
    project.description,
    '',
    '# Requested items (answer each)',
    ...(requested.length ? requested.map((r, i) => i + 1 + '. ' + r) : ['(none listed)']),
  ];
  if (critique) {
    sections.push('', '# A reviewer scored your previous draft ' + critique.score + ' of 1', 'Previous text: ' + JSON.stringify(critique.text ?? ''), 'Problems the reviewer found:', ...(critique.problems ?? []).map((p) => '- ' + p), 'Write new parts that keep what was right and fix every problem.');
  }
  if (violations.length) {
    sections.push('', '# Your previous draft was blocked', 'Previous text: ' + JSON.stringify(previous ?? ''), 'Violations (rule: detail):', ...violations.map((x) => '- ' + x.rule + ': ' + x.detail), 'Write new parts that keep the intent and fix every violation.');
  }
  return sections.join('\n');
}

export const CRITIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'needRestated', 'everyItemAnswered', 'claimsBacked', 'pricePlausible', 'problems'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    needRestated: { type: 'boolean' },
    everyItemAnswered: { type: 'boolean' },
    claimsBacked: { type: 'boolean' },
    pricePlausible: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
  },
};

export function buildCriticPrompt({ project, proposal, instance, platform = 'kmong', anonymous = false }) {
  const copy = copyOf(platform);
  return [
    '# Role',
    'You review a proposal before it is sent to a client on ' + copy.board + '. You did not write it. Judge it strictly against the project and the seller profile, and answer only with the JSON object the schema describes.',
    '',
    '# Score',
    'score from 0 to 1: would a careful client shortlist this proposal? needRestated: the need is restated correctly. everyItemAnswered: every requested item gets a concrete answer, none skipped or answered vaguely. claimsBacked: every fact about the seller is backed by the profile below and nothing is invented (no client names, no numbers outside approved claims). pricePlausible: the phases, dates and prices are realistic for the scope and inside the budget. problems: the concrete faults, in English.' + (anonymous ? copy.criticRule : ''),
    '',
    '# Seller profile',
    profileLines(instance.profile, anonymous ? anonymizer(instance) : null),
    '',
    '# Project',
    'Title: ' + project.title,
    copy.criticBudget(project),
    project.description,
    '',
    '# Requested items',
    ...(project.requested ?? []).map((r, i) => i + 1 + '. ' + r),
    '',
    '# Proposal',
    proposal.text,
  ].join('\n');
}
