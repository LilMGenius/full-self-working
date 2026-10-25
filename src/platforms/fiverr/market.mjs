// Fiverr market sampling: the gigs of a keyword search per service (fiverrQuery), read from the
// perseus-initial-props JSON the search page embeds: each gig's starting ("From") price, review count,
// rating and seller level; seller names are not kept. price_i is read as US dollars only while the page's
// display currency is USD at rate 1, the shape the page had when this parser was written (an archived
// search page of 2026-01-28); any other display currency fails the category by name, since the unit of
// price_i is then unverified. On 2026-10-25 Fiverr answered the owned headless browser with a PerimeterX
// challenge, so the first challenge ends Fiverr's reads for the day and is reported by name.
import { fxNote, toKRW } from '../../economics/fx.mjs';
import { ChallengeError, challengeOf, sampleEach } from '../kit.mjs';

const BASE = 'https://www.fiverr.com';

export const searchUrl = (query) => BASE + '/search/gigs?query=' + encodeURIComponent(query);

function pageData() {
  const props = document.getElementById('perseus-initial-props')?.textContent ?? null;
  return { title: document.title, text: props ? '' : (document.body?.innerText ?? '').slice(0, 2000), props };
}

export function parseSearch(props, fx) {
  const data = JSON.parse(props);
  const currency = data?.currency;
  if (currency?.name !== 'USD' || currency?.rate !== 1) {
    throw new Error('display currency ' + (currency?.name ?? 'missing') + ' at rate ' + (currency?.rate ?? 'missing') + '; price_i is read only in USD at rate 1');
  }
  const gigs = (data?.listings?.[0]?.gigs ?? []).filter((g) => g?.gig_url && g.price_i > 0);
  return {
    total: data?.appData?.pagination?.total ?? null,
    gigs: gigs.map((g) => ({
      url: BASE + g.gig_url,
      title: g.title ?? null,
      priceKRW: toKRW(g.price_i, 'USD', fx),
      priceUSD: g.price_i,
      fromPrice: true,
      reviews: Number.isFinite(g.buying_review_rating_count) ? g.buying_review_rating_count : 0,
      rating: g.buying_review_rating ?? null,
      sellerLevel: g.seller_level ?? null,
      pro: g.is_pro === true,
      fx: fxNote('USD', fx),
    })),
  };
}

// One row per gig among the first 30 of each search. A search with no priced gig fails its category.
export async function sample(session, targets, { now = () => new Date(), fx, limit = 30 } = {}) {
  const rows = [];
  const errors = await sampleEach(targets, async ({ category }) => {
    const url = searchUrl(category);
    await session.navigate(url, { settle: 4000 });
    const page = await session.evaluate(pageData);
    const challenge = challengeOf(page);
    if (challenge) throw new ChallengeError(challenge, url);
    if (!page.props) throw new Error('no perseus-initial-props on ' + url);
    const { total, gigs } = parseSearch(page.props, fx);
    if (!gigs.length) throw new Error('no priced gig on ' + url);
    const observedAt = now().toISOString();
    gigs.slice(0, limit).forEach((g, i) => rows.push({ platform: 'fiverr', category, query: url, rank: i + 1, ...g, listingTotal: total, observedAt }));
  });
  return { rows, errors };
}
