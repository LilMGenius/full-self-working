// 위시켓 projects: the public list of open 외주(도급) projects and each project's public detail page,
// read signed out in an owned headless browser (src/render/html2png.mjs) at the descriptor's pacing, a
// few pages per run. The list keeps its filter in a d parameter the page encodes with its own lz-string,
// and market.mjs owns the card reader both modules use. A detail page carries the client's full text in
// its JobPosting JSON-LD; budget, period, applicants, deadline and skills come from the page itself,
// since the JSON-LD salary is a derived monthly figure. Requirements, pre-screening questions and the
// apply form sit behind the login, so applyToProject refuses by name until the signed-in form is mapped.
// Project records stay in the instance for the agent's own decisions and are never published or
// committed.
import { createHash } from 'node:crypto';
import { createPacingGuard } from '../../browser/driver.mjs';
import { dayKey } from '../../core/clock.mjs';
import { openRenderer } from '../../render/html2png.mjs';
import { loadDescriptor } from '../registry.mjs';
import { AdapterRefusal, ChallengeError, challengeOf, squash, toInt } from '../kit.mjs';
import { encodeFilter, listUrl, pageCards } from './market.mjs';

const BASE = 'https://www.wishket.com';
export const PER_PAGE = 10;
// 외주(도급) only, closed projects excluded, newest first (the list's pt, ecd and srt filters).
export const LIST_QUERY = 'pt=task_based&ecd=True&srt=new';
export const listQuery = (page = 1) => LIST_QUERY + (page > 1 ? '&page=' + page : '');
export const detailUrl = (id) => BASE + '/project/' + id + '/';
export const APPLY_UNMAPPED = 'FSW_WISHKET_APPLY_UNMAPPED';

const detailError = (message) => Object.assign(new Error(message), { code: 'FSW_WISHKET_PROJECT_DETAIL' });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');

// 2026년 10월 30일 or 2026.10.23. as YYYY-MM-DD; null for anything else (계약 체결 이후, 즉시 시작).
export function dateOf(text) {
  const m = String(text ?? '').match(/(\d{4})\s*(?:년|\.)\s*(\d{1,2})\s*(?:월|\.)\s*(\d{1,2})/);
  return m ? m[1] + '-' + pad(m[2]) + '-' + pad(m[3]) : null;
}

// Whole Seoul days from today to a YYYY-MM-DD date; negative once it has passed.
export function daysUntil(date, now = new Date()) {
  if (!DATE_RE.test(date ?? '')) return null;
  const today = dayKey(now).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  return Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000);
}

// The 예상 금액 of a card (예상 금액 22,000,000원) or a detail page (22,000,000원). A negotiable budget
// (협의 후 결정) and a monthly amount (월 금액 10,000,000원 /월) have no project amount.
export function budgetOf(text) {
  const t = squash(text);
  const monthly = /^월\s*금액|\/\s*월$/.test(t);
  const negotiable = /협의/.test(t);
  const statedKRW = monthly || negotiable ? null : toInt(t.match(/([\d,]+)\s*원/)?.[1]);
  return { statedKRW, amountKRW: statedKRW, negotiable, monthly, budgetSource: statedKRW === null ? null : 'page' };
}

// The amount on the first 예산 line of the description that names one (예산: 1,000만원, 1,200만 원 (부가세
// 별도)), read only when the page leaves the budget to negotiation. A range gives its lower end, so neither
// the score nor the plan counts on more than the client committed to.
export function descriptionBudget(description) {
  for (const line of String(description ?? '').split('\n')) {
    if (!/예산/.test(line)) continue;
    const amounts = [...line.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(만\s*원|만|원)/g)]
      .map((m) => Number(m[1].replace(/,/g, '')) * (m[2].startsWith('만') ? 10_000 : 1))
      .filter((n) => n >= 100_000);
    if (amounts.length) return Math.round(Math.min(...amounts));
  }
  return null;
}

const typeOf = (text) => (/외주/.test(text ?? '') ? 'task_based' : /기간제/.test(text ?? '') ? 'term_based' : null);

// The page version a judgement was made on, from what a list card and a detail page both show: title,
// stated budget, period, type and the private mark. Applicant counts and the days left move on their own
// and are not part of it; an edit of the description alone is read when its project is drafted.
export function projectHash(p) {
  return createHash('sha1').update(JSON.stringify([p.title, p.statedKRW, p.negotiable, p.monthly, p.durationDays, p.projectType, p.private])).digest('hex').slice(0, 16);
}

// Bracketed description headings under which a client lists what every proposal must contain
// ([제안 포함 필수 사항], [견적 시 함께 부탁드립니다]); their marked lines are the requested items, and an
// unmarked line there (지원 내용은 아래 기준으로 검토합니다.) is a preamble.
const REQUEST_HEADING = /^\[[^\]]*(?:제안|견적|지원)[^\]]*(?:포함|부탁|요청|필수|기재|작성)[^\]]*\]$/;

export function requestedItems(description) {
  const out = [];
  let inside = false;
  for (const raw of String(description ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inside = REQUEST_HEADING.test(line);
      continue;
    }
    const item = inside ? line.match(/^(?:[-*•]|\d+[.)])\s*(.+)$/)?.[1]?.trim() : null;
    if (item) out.push(item);
  }
  return out;
}

// One card of the list (market.mjs pageCards) as a project summary, or null without a project link.
export function parseListCard(card, { now = new Date() } = {}) {
  const id = toInt(String(card?.href ?? '').match(/\/project\/(\d+)/)?.[1]);
  if (!Number.isInteger(id)) return null;
  const p = {
    id,
    url: detailUrl(id),
    title: squash(card.title),
    ...budgetOf(card.budget),
    durationDays: toInt(squash(card.term).match(/(\d+)\s*일/)?.[1]),
    applicants: card.applicants === '비공개' ? null : toInt(card.applicants),
    applicantsHidden: card.applicants === '비공개',
    private: card.private === true,
    projectType: typeOf(card.type),
    deadlineText: card.deadline ? squash(card.deadline) : null,
    postedOn: dateOf(card.posted),
    field: card.field ?? null,
    location: card.location ?? null,
    source: 'list',
    readAt: now.toISOString(),
  };
  return { ...p, hash: projectHash(p) };
}

// One detail page (pageProjectDetail) as a project the scorer and the drafter read. root and sub carry
// the page's category and subcategory labels in the shape the kmong reader gives them.
export function parseProjectDetail(raw, { now = new Date() } = {}) {
  const ld = raw?.jobPosting ?? null;
  const id = toInt(ld?.identifier) ?? toInt(String(raw?.url ?? '').match(/\/project\/(\d+)/)?.[1]);
  if (!Number.isInteger(id)) throw detailError('a wishket project page without a project id (' + (raw?.url ?? 'no url') + ')');
  const title = squash(raw.heading);
  if (!title) throw detailError('wishket project ' + id + ' has no title heading');
  const isPrivate = raw.private === true || raw.privateNotice === true;
  const description = String(ld?.description ?? '').replace(/\r\n?/g, '\n').trim();
  if (!description && !isPrivate) throw detailError('wishket project ' + id + ' carries no JobPosting description' + (raw.ldErrors?.length ? ' (' + raw.ldErrors.join('; ') + ')' : ''));
  const budget = budgetOf(raw.budget);
  const written = budget.negotiable ? descriptionBudget(description) : null;
  if (written) Object.assign(budget, { amountKRW: written, budgetSource: 'description' });
  const row = (label) => (raw.rows ?? []).find((r) => squash(r.label) === label) ?? null;
  const validThrough = String(ld?.validThrough ?? '').slice(0, 10);
  const deadlineAt = dateOf(row('모집 마감일')?.data) ?? (DATE_RE.test(validThrough) ? validThrough : null);
  const [category = [], platforms = [], subcategories = []] = (raw.categories ?? []).map((c) => c.map((s) => squash(s).replace(/,$/, '')).filter(Boolean));
  const marks = (raw.marks ?? []).map(squash);
  const start = row('예상 시작일')?.data ? squash(row('예상 시작일').data) : null;
  const hidden = /비공개/.test(raw.applicants ?? '');
  const p = {
    id,
    url: detailUrl(id),
    title,
    description,
    ...budget,
    durationDays: toInt(squash(raw.term).match(/(\d+)\s*일/)?.[1]),
    applicants: hidden ? null : toInt(raw.applicants),
    applicantsHidden: hidden,
    deadlineAt,
    deadlineDays: daysUntil(deadlineAt, now),
    status: marks.includes('모집 중') ? 'open' : marks.some((m) => /마감|완료|종료|취소|중단/.test(m)) ? 'closed' : 'unknown',
    projectType: marks.includes('외주') ? 'task_based' : marks.includes('기간제') ? 'term_based' : null,
    private: isPrivate,
    root: { id: null, name: category.join(', ') || null },
    sub: { id: null, name: subcategories.join(', ') || null },
    platforms,
    subcategories,
    skills: (row('관련 기술')?.chips ?? []).map(squash).filter(Boolean),
    startDate: dateOf(start),
    startText: start,
    location: raw.location ? squash(raw.location) : ld?.location ?? null,
    preQuestions: raw.preQuestions === true,
    inquiries: toInt(raw.inquiries),
    postedOn: DATE_RE.test(ld?.datePosted ?? '') ? ld.datePosted : dateOf(raw.posted),
    source: 'detail',
    readAt: now.toISOString(),
  };
  return { ...p, requested: requestedItems(description), hash: projectHash(p) };
}

// ---- page-side code (serialised into the page) ----

// Everything a signed-out detail page shows about one project. A status mark's own text skips its
// tooltip; a condition row's own text skips its relative accent (마감 5일 10시간 전).
export function pageProjectDetail() {
  const text = (el) => el?.innerText?.replace(/\s+/g, ' ').trim() || null;
  const own = (el) => [...(el?.childNodes ?? [])].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
  const head = document.querySelector('.project-content-title');
  let jobPosting = null;
  const ldErrors = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try {
      data = JSON.parse(s.textContent);
    } catch (err) {
      ldErrors.push('JSON-LD: ' + String(err.message).slice(0, 120));
      continue;
    }
    const found = [data, ...(data?.['@graph'] ?? [])].flat().find((x) => x?.['@type'] === 'JobPosting');
    if (found && !jobPosting) {
      jobPosting = { description: found.description ?? null, identifier: found.identifier?.value ?? found.identifier ?? null, datePosted: found.datePosted ?? null, validThrough: found.validThrough ?? null, location: found.jobLocation?.address?.streetAddress ?? null };
    }
  }
  const body = document.body?.innerText ?? '';
  return {
    url: location.href,
    title: document.title,
    text: body.slice(0, 2000),
    heading: text(head?.querySelector('h1')),
    marks: [...(head?.querySelectorAll('.status-mark') ?? [])].map(own).filter(Boolean),
    private: Boolean(head?.querySelector('.private-mark')),
    privateNotice: /프라이빗 매칭 프로젝트입니다/.test(body),
    posted: text(head?.querySelector('.project-recruit-guide')),
    categories: [...(head?.querySelectorAll('.project-classification .project-category') ?? [])].map((p) => [...p.querySelectorAll('.category-wrapper')].map((s) => text(s)).filter(Boolean)),
    budget: text(document.querySelector('.project-budget .project-condition-data')),
    term: text(document.querySelector('.project-term .project-condition-data')),
    applicants: text(document.querySelector('.project-applicant .project-condition-data')),
    rows: [...document.querySelectorAll('.project-detail-condition-row')].map((r) => ({
      label: text(r.querySelector('.condition-label')),
      data: own(r.querySelector('.condition-data')) || text(r.querySelector('.condition-data')),
      chips: [...r.querySelectorAll('.subcategory-box')].map((c) => text(c)).filter(Boolean),
    })),
    location: text(document.querySelector('.meeting-condition-data')),
    preQuestions: Boolean(document.querySelector('a[href="#pre_question"]')),
    inquiries: text(document.querySelector('.comment-layer-count')),
    jobPosting,
    ldErrors,
  };
}

// ---- reader ----

// Public list and detail reads in an owned headless browser, each load behind the descriptor's pacing
// guard. A bot wall ends the run with ChallengeError.
export async function openProjectReader({ renderer, pacing = loadDescriptor('wishket').pacing } = {}) {
  const own = !renderer;
  const r = renderer ?? (await openRenderer());
  const page = await r.page();
  const guard = createPacingGuard('wishket', pacing);
  let onList = false;
  const load = async (url, settle) => {
    await guard.beforeLoad();
    await page.navigate(url, { settle });
  };
  const wall = (snap, url) => {
    const challenge = challengeOf(snap);
    if (challenge) throw new ChallengeError(challenge, url);
  };
  return {
    loads: () => guard.counts().actions,
    // Open 외주 projects, newest first, up to pages pages of ten. The first load is the list page itself,
    // whose LZString encodes the filter.
    async listProjects({ pages = 3, now = new Date() } = {}) {
      if (!onList) {
        await load(BASE + '/project/', 3000);
        onList = true;
      }
      const projects = [];
      let total = null;
      let skipped = 0;
      for (let n = 1; n <= pages && (n === 1 || total > (n - 1) * PER_PAGE); n++) {
        const encoded = await page.evaluate(encodeFilter, listQuery(n));
        if (!encoded) throw Object.assign(new Error('the wishket project list no longer offers LZString to encode its filter'), { code: 'FSW_WISHKET_LIST' });
        const url = listUrl(encoded);
        await load(url, 3000);
        const listing = await page.evaluate(pageCards);
        wall(listing, url);
        if (n === 1) total = toInt(listing.total);
        for (const card of listing.cards) {
          const p = parseListCard(card, { now });
          if (p) projects.push(p);
          else skipped += 1;
        }
      }
      return { projects, total, skipped };
    },
    async readProject(id, { now = new Date() } = {}) {
      onList = false;
      const url = detailUrl(id);
      await load(url, 2500);
      const raw = await page.evaluate(pageProjectDetail);
      wall(raw, url);
      return parseProjectDetail(raw, { now });
    },
    async close() {
      try {
        await page.close();
      } finally {
        if (own) await r.close();
      }
    },
  };
}

// Applying. 프로젝트 지원하기 sends a signed-out page to auth.wishket.com/login, and the signed-in form
// (its fields, character limits and pre-screening questions) has not been read, so every call refuses by
// name until that form is mapped on a live signed-in project.
export function applyToProject(project) {
  throw new AdapterRefusal(APPLY_UNMAPPED, 'the wishket apply form is not mapped, so project ' + (project?.id ?? '?') + ' gets no proposal; sign in, open 프로젝트 지원하기 on a live project and map its fields first');
}
