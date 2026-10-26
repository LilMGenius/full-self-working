// The career a listing or a profile may print, in whole months, from the profile's dated roles (003
// Decisions of 20:30). Core, so the kmong listings pass (wp4) and the onboarding profile steps (wp8, through
// src/brain/identity.mjs) read one function. Every coarse period takes the lower value: a start that names
// only a year starts in its December, a start month counts from its last day, an end that names only a year
// ends in its January and an end month counts to its first day; an ongoing role ends now, and overlapping
// roles count once. null when there is no role or any role's period does not parse, so the figure is
// hidden, never guessed. A period reads "2023.01 - 2024.03", "2022-2024", "2023.09 ~ 현재" or, as the
// resume writes it, "2024.12 to present".
const PERIOD = /^\s*(\d{4})(?:[./-](\d{1,2}))?\s*(?:[-~–]|to)\s*(?:(\d{4})(?:[./-](\d{1,2}))?|(현재|재직\s*중|present|now|current))\s*$/i;
const DAY = 86_400_000;

function spanOf(period, now) {
  const m = PERIOD.exec(String(period ?? ''));
  if (!m) return null;
  const [, y1, m1, y2, m2, ongoing] = m;
  if ((m1 && (Number(m1) < 1 || Number(m1) > 12)) || (m2 && (Number(m2) < 1 || Number(m2) > 12))) return null;
  const start = Date.UTC(Number(y1), m1 ? Number(m1) : 12, 0);
  const end = ongoing ? now.getTime() : Date.UTC(Number(y2), (m2 ? Number(m2) : 1) - 1, 1);
  return end > start ? [start, end] : [start, start];
}

const monthsBetween = (a, b) => {
  const x = new Date(a);
  const y = new Date(b);
  return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth()) - (y.getUTCDate() < x.getUTCDate() ? 1 : 0);
};

export function careerMonths(profile, now = new Date()) {
  const roles = profile?.roles ?? [];
  if (!roles.length) return null;
  const spans = roles.map((r) => spanOf(r.period, now));
  if (spans.some((s) => s === null)) return null;
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s[0] <= last[1] + DAY) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  return merged.reduce((n, [a, b]) => n + Math.max(0, monthsBetween(a, b)), 0);
}

// The figure as listings print it in Korean, or null when careerMonths is null.
export const careerLabel = (months) => (months == null ? null : (months >= 12 ? Math.floor(months / 12) + '년' : '') + (months % 12 ? (months >= 12 ? ' ' : '') + (months % 12) + '개월' : months < 12 ? '0개월' : ''));
