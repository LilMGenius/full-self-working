// Money signals from platform evidence (src/orders/money.mjs:14-45 at 2c77326) and their conversion
// into deal signals (003 Deal). A status read from a list row has no time of its own; it counts only
// when fsw quoted the thread or a hire notice in the same read is fresh (src/orders/money.mjs:179-181),
// which freshHireInBatch carries to advance.
import { seoulParts } from '../core/clock.mjs';
import { classifyNotice } from '../core/notices.mjs';

// A signal older than this is history (the account's past deals), recorded without effect.
export const MONEY_LOOKBACK_DAYS = 7;
const DAY_MS = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');

export const jobIdFor = (platform, externalId) => (platform + '-' + externalId).replace(/[^A-Za-z0-9_-]/g, '_');

// The Seoul minute a platform stamped on a line; a list row and an opened thread print the same line at
// the same minute, which makes the two reads one signal.
export function minuteKey(at) {
  const t = Date.parse(at ?? '');
  if (!Number.isFinite(t)) return null;
  const p = seoulParts(new Date(t));
  return p.year + '-' + pad(p.month) + '-' + pad(p.day) + 'T' + pad(p.hour) + ':' + pad(p.minute);
}

export function moneySignals({ threadRef = {}, notices = [] } = {}) {
  const out = [];
  const add = (c, at, text, source) => c?.class === 'money' && out.push({ event: c.event, amountKRW: c.amountKRW, at: at ?? null, text, source });
  if (threadRef.notice) add(classifyNotice({ text: threadRef.notice }), threadRef.at, threadRef.notice, 'row');
  for (const n of notices) add(classifyNotice(n), n.at, n.text, 'thread');
  out.sort((a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0));
  if (threadRef.status === 'hired') out.push({ event: 'hired', amountKRW: null, at: threadRef.at ?? null, text: 'chat status hired', source: 'row-status' });
  if (['customer_cancelled', 'rejected'].includes(threadRef.hired)) out.push({ event: 'hire_cancelled', amountKRW: null, at: threadRef.at ?? null, text: 'chat hire_status ' + threadRef.hired, source: 'row-status' });
  return out;
}

export const fresh = (at, now) => {
  const t = Date.parse(at ?? '');
  return Number.isFinite(t) && now.getTime() - t <= MONEY_LOOKBACK_DAYS * DAY_MS;
};

// Deal signals for one list row (inbound) or one opened thread (inbound plus its notices).
export function moneyToSignals({ platform, threadId, inbound = {}, notices = [], now = new Date() }) {
  const raw = moneySignals({ threadRef: inbound, notices });
  const freshHire = raw.some((s) => s.event === 'hired' && s.source !== 'row-status' && fresh(s.at, now));
  return raw.map((s) => ({
    type: s.event, platform, threadId, at: s.at, ...(s.amountKRW != null ? { amountKRW: s.amountKRW } : {}),
    evidence: { text: s.text, source: s.source, requestId: inbound.requestId ?? null, label: inbound.service ?? null, rowQuote: inbound.quote ?? null, freshHireInBatch: freshHire },
  }));
}
