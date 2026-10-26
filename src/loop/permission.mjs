// The client's answer to the portfolio question the delivery message asks (deliveryText,
// src/deal/delivery-text.mjs). The brain classifies the reply; code accepts a grant only when the quote is a
// whole sentence (or the whole text) of an inbound message sent after the delivery was observed, and neither
// that message nor a later one says no, because a grant publishes the client's work. Every doubt keeps the
// work private and goes to the operator as permission.unverified. A refusal needs no quote: hiding work is
// the safe side.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// A sentence without its closing marks, since the model may keep or drop the final period.
const bare = (s) => norm(s).replace(/[\s.!?。…~]+$/u, '');
// The sentences of one message: split after a closing mark followed by a space, or at a line break.
const sentencesOf = (text) => String(text ?? '').split(/(?<=[.!?。…~])\s+|\n+/u).map(bare).filter(Boolean);
const msgText = (m) => String(m.text ?? m.body ?? '');
// Words that turn an answer into a no or a condition, in Korean and English. A false match only keeps the
// work private until the operator records the answer.
const NEGATION = /않|못|말아|말고|마세요|마시고|마십시오|싫|아니|거절|불가|곤란|어렵|비공개|삼가|(?:^|[\s,.!?])안(?=\s|돼|되|됩)|\b(?:no|not|never|don'?t|rather not)\b|n't\b/iu;

export function permissionSignal({ thread, job, decision, at = new Date().toISOString() }) {
  if (decision?.permissionIssue) return { signal: null, reason: decision.permissionIssue };
  const answer = decision?.portfolioPermission ?? null;
  if (!answer) return { signal: null, reason: null };
  const signal = (type, evidence) => ({ signal: { type, platform: thread.platform, threadId: job.threadId, jobId: job.id, at, evidence: { ...evidence, source: 'brain' } }, reason: null });
  // A refusal holds on any job delivered once, a revision or a rerun included.
  if (answer === 'refused') return job?.deliveredAt ? signal('permission_refused', { quote: null }) : { signal: null, reason: 'refusal on a thread whose job was never delivered' };
  if (!job || !['delivered', 'closed'].includes(job.status)) return { signal: null, reason: null };
  const after = Date.parse(job.deliveredAt ?? '');
  const inbound = (thread.messages ?? []).filter((m) => m.direction === 'in' && Number.isFinite(Date.parse(m.at ?? '')) && Date.parse(m.at) > after);
  // A denial stands until the operator lifts it, and a grant already recorded needs nothing more.
  const prior = job.meta?.portfolio ?? {};
  if (prior.permission === 'denied') return { signal: null, reason: 'the client refused before; only the operator lifts it with fsw deal ' + job.id + ' permission granted' };
  if (prior.permission === 'granted') return { signal: null, reason: null };
  // The quote must be newer than the last recorded answer as well as the delivery.
  const since = prior.answeredAt ? Date.parse(prior.answeredAt) : -Infinity;
  const fresh = inbound.filter((m) => Date.parse(m.at) > since);
  const quote = bare(decision.permissionQuote);
  const i = quote.length >= 2 ? fresh.findIndex((m) => bare(msgText(m)) === quote || sentencesOf(msgText(m)).includes(quote)) : -1;
  if (i < 0) return { signal: null, reason: 'grant whose quote is not a whole sentence of an inbound message after the delivery' };
  if (fresh.slice(i).some((m) => NEGATION.test(msgText(m)))) return { signal: null, reason: 'grant quoted from a message that says no, or followed by one' };
  return signal('permission_granted', { quote: norm(decision.permissionQuote), quoteAt: fresh[i].at });
}
