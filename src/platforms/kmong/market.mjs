// 크몽 market sampling: prices, ratings and review counts of the first gig cards on each service's
// listing, one page per service per day. services.json maps a service to a category page by
// kmongCategoryId; a service without one is searched by its kmongCategory label. The site footer
// forbids copying, redistributing or scraping its gig information, so rows keep what pricing needs,
// stay in the instance and are never republished; seller names are not kept.
import { lines, toInt } from '../kit.mjs';

const BASE = 'https://kmong.com';
const PRICE = /^([\d,]+)원(~?)$/;

export const listingUrl = (def) =>
  def.kmongCategoryId ? `${BASE}/category/${def.kmongCategoryId}` : `${BASE}/search?type=gig&keyword=${encodeURIComponent(def.kmongCategory)}`;

// Cards render on the client a few seconds after load, and search pages reuse the GigCard testid in
// side blocks, so parseListing dedupes by href.
function pageCards() {
  const total = (document.body.innerText.match(/([\d,]+)개의 서비스/) || [])[1] ?? null;
  return { total, cards: [...document.querySelectorAll('a[data-testid=GigCard]')].map((a) => ({ href: a.getAttribute('href'), text: a.innerText })) };
}

// Card lines: title, an optional rating (4.9) and review count ((85)), the price ("99,000원~", where the
// tilde marks a starting price), the seller, then badges such as 빠른 응답 and 세금계산서.
export function parseCard({ href, text }) {
  const l = lines(text);
  const at = l.findIndex((x) => PRICE.test(x));
  if (at < 1) return null;
  const [, digits, tilde] = l[at].match(PRICE);
  let rating = null;
  let reviews = 0;
  for (const x of l.slice(1, at)) {
    if (/^\d\.\d$/.test(x)) rating = Number(x);
    else if (/^\([\d,]+\)$/.test(x)) reviews = toInt(x);
  }
  return { href, title: l[0], seller: l[at + 1] ?? null, priceKRW: toInt(digits), fromPrice: tilde === '~', rating, reviews, badges: l.slice(at + 2) };
}

export function parseListing({ total, cards }, { limit = 30 } = {}) {
  const seen = new Set();
  const kept = [];
  for (const card of cards) {
    if (kept.length === limit) break;
    if (!card.href || seen.has(card.href)) continue;
    seen.add(card.href);
    const parsed = parseCard(card);
    if (parsed) kept.push(parsed);
  }
  return { total: toInt(total), cards: kept };
}

// One row per kept card. A listing with no priced card fails its category, since an empty grid far
// more often means the page did not render than a market with no sellers.
export async function sample(session, targets, { now = () => new Date(), limit = 30 } = {}) {
  const rows = [];
  const errors = [];
  for (const { category, def } of targets) {
    const url = listingUrl(def);
    try {
      await session.navigate(url, { settle: 3500 });
      const { total, cards } = parseListing(await session.evaluate(pageCards), { limit });
      if (!cards.length) throw new Error(`no priced gig card on ${url}`);
      const observedAt = now().toISOString();
      cards.forEach((c, i) => rows.push({ platform: 'kmong', category, url: BASE + c.href, query: url, rank: i + 1, title: c.title, priceKRW: c.priceKRW, fromPrice: c.fromPrice, rating: c.rating, reviews: c.reviews, badges: c.badges, listingTotal: total, observedAt }));
    } catch (err) {
      errors.push({ category, message: err.message });
    }
  }
  return { rows, errors };
}
