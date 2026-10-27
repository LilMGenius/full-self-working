// The only ordering of portfolio items (docs/DESIGN.md, Portfolio); the site and every listing
// generator import it. Pure: no I/O, input items are not mutated.
//
// Eligible: a background project, or a paid job (paidAt set) whose client granted portfolio use.
// Never shown: any item rated below 4 of 5 or marked disliked. The founder's order: satisfaction, fame,
// quality, volume, recency. Tier A (liked, or rated 4.5 or more) orders by liked, fame, quality, volume;
// tier B by fame, quality, volume. Fame is a client's fame, else the item's public reach that day
// (src/portfolio/signals.mjs). Volume compares the price first and the hours second. Ties fall to the
// newest paidAt, then id. Missing values sort last.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Descending with missing values after present ones.
function desc(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

const time = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

export function isEligible(item) {
  const rating = num(item?.satisfaction?.rating);
  if (rating !== null && rating < 4) return false;
  if (item?.satisfaction?.liked === false) return false;
  if (item?.source === 'background') return true;
  return item?.source === 'job' && Boolean(item.paidAt) && item.permission === 'granted';
}

export function isTierA(item) {
  const rating = num(item?.satisfaction?.rating);
  return item?.satisfaction?.liked === true || (rating !== null && rating >= 4.5);
}

// An item's fame as the ordering reads it: a client's fame for a paid job (operator-entered), else the item's public
// reach that day (signals.mjs). The listing refresh reads the same figure to tell a near tie from a real move.
export const itemFame = (i) => num(i.client?.fame) ?? num(i.reach?.fame);
// The keys the ordering reads before fame (the tier, then liked inside tier A), as one value: two items whose values
// differ are ordered by those keys, never by fame, so the listing refresh treats no swap between them as a near tie.
export const aboveFame = (i) => (isTierA(i) ? 'A' : 'B') + (i?.satisfaction?.liked === true ? ':liked' : '');

const keys = {
  liked: (i) => (i.satisfaction?.liked === true ? 1 : null),
  fame: itemFame,
  quality: (i) => num(i.quality),
  price: (i) => num(i.volume?.priceKRW),
  hours: (i) => num(i.volume?.hours),
  paidAt: (i) => time(i.paidAt),
};
const ORDER_A = ['liked', 'fame', 'quality', 'price', 'hours', 'paidAt'];
const ORDER_B = ['fame', 'quality', 'price', 'hours', 'paidAt'];

const compareBy = (order) => (a, b) => {
  for (const k of order) {
    const c = desc(keys[k](a), keys[k](b));
    if (c !== 0) return c;
  }
  return String(a.id).localeCompare(String(b.id));
};

export function rankPortfolio(items) {
  const eligible = items.filter(isEligible);
  const tierA = eligible.filter(isTierA).sort(compareBy(ORDER_A));
  const tierB = eligible.filter((i) => !isTierA(i)).sort(compareBy(ORDER_B));
  return [...tierA.map((i) => ({ ...i, tier: 'A' })), ...tierB.map((i) => ({ ...i, tier: 'B' }))];
}
