// Shared by the platform adapters and parsers: the refusal error, snippets that never carry a phone or
// account number, and Seoul timestamps from the short date forms marketplaces print.

// An adapter declining an operation that would break a rule (opening an unread thread, spending cash
// without permission) or that it cannot complete safely; code names the rule.
export class AdapterRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Eight or more digits in a row, or a phone-shaped group (0504 3799 0704, 010-1234-5678).
const NUMBER_RUN = /(?<!\d)(?:\d{8,}|\d{2,4}[\s.\-]\d{3,4}[\s.\-]\d{4})(?!\d)/g;

export const redactDigits = (text) => String(text ?? '').replace(NUMBER_RUN, '[number]');

export const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function snippet(text, max = 80) {
  const s = redactDigits(squash(text));
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export const toInt = (text) => {
  const digits = String(text ?? '').replace(/[^\d-]/g, '');
  return digits && digits !== '-' ? Number.parseInt(digits, 10) : null;
};

const pad = (n) => String(n).padStart(2, '0');
export const seoulIso = (y, mo, d, h = 0, mi = 0) => `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00+09:00`;

export function seoulYear(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(now));
}

export const lines = (text) => String(text ?? '').split(/\n/).map((l) => l.trim()).filter(Boolean);

// Bot walls seen on public market pages, named by vendor. A sampler stops at the first one, since every
// later load meets the same wall, and the day's report says which wall it was.
const CHALLENGES = [
  ['perimeterx', /px-captcha|PXCR\d|It needs a human touch|Press & Hold/i],
  ['cloudflare', /Just a moment\.\.\.|Attention Required! \| Cloudflare|Sorry, you have been blocked|cf-chl-|Checking your browser before accessing/i],
];

export function challengeOf({ title = '', text = '' } = {}) {
  const page = String(title ?? '') + '\n' + String(text ?? '');
  return CHALLENGES.find(([, re]) => re.test(page))?.[0] ?? null;
}

export class ChallengeError extends Error {
  constructor(challenge, url) {
    super(challenge + ' bot challenge on ' + url);
    this.code = 'FSW_MARKET_CHALLENGE';
    this.challenge = challenge;
  }
}

// Runs fn on each market target in order. A target that throws fails by name, and an error marked final
// (a source with nothing to read today) says a retry would fail the same way; a bot challenge fails it
// and every target after it, none of which loads.
export async function sampleEach(targets, fn) {
  const errors = [];
  for (const [i, target] of targets.entries()) {
    try {
      await fn(target);
    } catch (err) {
      if (!err.challenge) {
        errors.push({ category: target.category, message: err.message, ...(err.final ? { final: true } : {}) });
        continue;
      }
      for (const t of targets.slice(i)) errors.push({ category: t.category, message: err.message, challenge: err.challenge });
      break;
    }
  }
  return errors;
}
