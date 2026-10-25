// 위시켓 market sampling: the public project list (/project/), which needs no login, filtered to 외주
// (task_based) projects in each service's wishketField, newest first, two pages of ten. 위시켓 is a
// bidding platform, so the signal is the client's budget: each project with a stated 예상 금액 becomes a
// sample at that amount, a single figure being its own midpoint. A budget left to negotiation (협의 후
// 결정), a monthly amount and a 기간제 project are skipped and counted by name. The list keeps its filter
// in a d parameter compressed with the site's own lz-string (LZString.compressToBase64), so the query is
// encoded in the page; field ids are read from the list's own filter inputs by label on every run.
import { toInt } from '../kit.mjs';

const BASE = 'https://www.wishket.com';
const PER_PAGE = 10;

const pageFields = () => [...document.querySelectorAll('input[name=pf]')].map((i) => [i.getAttribute('data-name'), i.value]);
const encodeFilter = (query) => window.LZString?.compressToBase64(query) ?? null;

function pageCards() {
  const text = (box, sel) => box.querySelector(sel)?.innerText?.replace(/\s+/g, ' ').trim() ?? null;
  return {
    total: (document.body.innerText.match(/([\d,]+)개의 프로젝트/) || [])[1] ?? null,
    cards: [...document.querySelectorAll('.project-info-box')].map((box) => ({
      href: box.querySelector('a.project-link')?.getAttribute('href') ?? null,
      title: text(box, 'a.project-link'),
      status: text(box, '.project-organic-info > .project-status-label > .status-mark'),
      budget: text(box, '.budget'),
      term: text(box, '.term'),
      field: text(box, '.project-field-subcategory'),
      type: text(box, '.project-type-mark'),
      posted: text(box, '.start-recruitment-data'),
      applicants: (box.innerText.match(/지원자\s*([\d,]+명|비공개)/) || [])[1] ?? null,
    })),
  };
}

export const listUrl = (encoded) => BASE + '/project/?d=' + encodeURIComponent(encoded);
export const filterQuery = (fieldId, page) => 'pt=task_based&pf=' + fieldId + (page > 1 ? '&page=' + page : '');

// A card becomes {project} or {skip: reason}.
export function parseCard(card) {
  if (!card?.href) return { skip: 'no project link' };
  if (/기간제/.test(card.type ?? '')) return { skip: 'term based' };
  const budget = card.budget ?? '';
  if (/월/.test(budget)) return { skip: 'monthly amount' };
  if (/협의/.test(budget)) return { skip: 'budget negotiable' };
  const amount = budget.match(/예상 금액\s*([\d,]+)\s*원/);
  if (!amount) return { skip: 'no budget' };
  const posted = (card.posted ?? '').match(/(\d{4})\.(\d{2})\.(\d{2})/);
  return {
    project: {
      url: new URL(card.href, BASE).href,
      title: card.title,
      priceKRW: toInt(amount[1]),
      status: card.status,
      days: toInt((card.term ?? '').match(/(\d+)\s*일/)?.[1]),
      applicants: card.applicants === '비공개' ? null : toInt(card.applicants),
      postedOn: posted ? posted[1] + '-' + posted[2] + '-' + posted[3] : null,
      field: card.field,
    },
  };
}

// One row per priced project across the pages read. A field with no priced project fails by name.
export async function sample(session, targets, { now = () => new Date(), pages = 2 } = {}) {
  await session.navigate(BASE + '/project/', { settle: 3000 });
  const fields = new Map(await session.evaluate(pageFields));
  const rows = [];
  const errors = [];
  const skipped = [];
  for (const { category } of targets) {
    try {
      const id = fields.get(category);
      if (!id) throw new Error('no project field named ' + category + ' on ' + BASE + '/project/');
      const seen = new Set();
      const counts = {};
      let total = null;
      for (let page = 1; page <= pages && (page === 1 || total > (page - 1) * PER_PAGE); page += 1) {
        const encoded = await session.evaluate(encodeFilter, filterQuery(id, page));
        if (!encoded) throw new Error('the project list no longer offers LZString to encode its filter');
        const url = listUrl(encoded);
        await session.navigate(url, { settle: 3000 });
        const listing = await session.evaluate(pageCards);
        if (page === 1) total = toInt(listing.total);
        const observedAt = now().toISOString();
        for (const card of listing.cards) {
          const { project, skip } = parseCard(card);
          if (skip) counts[skip] = (counts[skip] ?? 0) + 1;
          else if (!seen.has(project.url)) {
            seen.add(project.url);
            rows.push({ platform: 'wishket', category, query: url, rank: seen.size, ...project, listingTotal: total, observedAt });
          }
        }
      }
      for (const [reason, count] of Object.entries(counts)) skipped.push({ category, reason, count });
      if (!seen.size) throw new Error('no project with a stated budget in ' + category);
    } catch (err) {
      errors.push({ category, message: err.message });
    }
  }
  return { rows, errors, skipped };
}
