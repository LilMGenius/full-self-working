// The client's answer to the portfolio question the delivery message asks (deliveryText,
// src/deal/delivery-text.mjs). The brain classifies the reply; code accepts a grant only when the quoted
// sentence is really in an inbound message sent after the delivery was observed, because a grant publishes
// the client's work. A refusal needs no quote: hiding work is the safe side.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function permissionSignal({ thread, job, decision, at = new Date().toISOString() }) {
  if (decision?.permissionIssue) return { signal: null, reason: decision.permissionIssue };
  const answer = decision?.portfolioPermission ?? null;
  if (!answer || !job || !['delivered', 'closed'].includes(job.status)) return { signal: null, reason: null };
  const after = Date.parse(job.deliveredAt ?? '');
  const inbound = (thread.messages ?? []).filter((m) => m.direction === 'in' && Number.isFinite(Date.parse(m.at ?? '')) && Date.parse(m.at) > after);
  const quote = norm(decision.permissionQuote);
  const quoted = quote.length >= 2 && inbound.some((m) => norm(m.text ?? m.body).includes(quote));
  if (answer === 'granted' && !quoted) return { signal: null, reason: 'grant without a quote found in an inbound message after the delivery' };
  return {
    signal: { type: answer === 'granted' ? 'permission_granted' : 'permission_refused', platform: thread.platform, threadId: job.threadId, jobId: job.id, at, evidence: { quote: quoted ? quote : null, source: 'brain' } },
    reason: null,
  };
}
