// The client's answer to the portfolio question the delivery message asks (deliveryText,
// src/deal/delivery-text.mjs). The brain classifies the reply; code accepts a grant only when the quote is a
// whole sentence (or the whole text) of an inbound message sent after the delivery was observed, and neither
// that message nor a later one says no, because a grant publishes the client's work. Every doubt keeps the
// work private; the step records the reason (permission.unverified, permission.refusal_unapplied) and
// notifies the operator. A refusal needs no quote: hiding work is the safe side.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// A sentence without its closing marks, since the model may keep or drop the final period.
const bare = (s) => norm(s).replace(/[\s.!?？。…~]+$/u, '');
// The sentences of one message with their closing marks: split after a closing mark followed by a space,
// or at a line break.
const sentencesOf = (text) => String(text ?? '').split(/(?<=[.!?？。…~])\s+|\n+/u).map(norm).filter(Boolean);
// The whole text and each sentence of a message, any of which a quote may be.
const unitsOf = (text) => [norm(text), ...sentencesOf(text)];
const msgText = (m) => String(m.text ?? m.body ?? '');
// Words that turn an answer into a no or a condition, in Korean and English. A false match only keeps the
// work private until the operator records the answer.
const NEGATION = /않|못|말아|말고|마세요|마시고|마십시오|싫|아니|거절|불가|곤란|어렵|비공개|삼가|자제|내부|(?:^|[\s,.!?])안(?=\s|돼|되|됩)|\b(?:no|not|never|don'?t|rather not|private|confidential)\b|n't\b/iu;
// A yes with a condition is the operator's to scope. Leaving part of the work out or covering it narrows
// what may be shown wherever the client says it, so those words hold a grant in any sentence of the quoted
// message or a later one. Words of time and condition (after, once, 다음에) also close common sign-offs
// (다음에도 잘 부탁드려요, thanks once again), so they hold a grant only in the quoted sentence or in a
// sentence that also speaks about posting or showing the work.
const SCOPE = /빼고|빼서|빼주|빼\s+주|제외|만\s*올려|가려|가리|모자이크|\b(?:except|without|blur|hide)\b/iu;
const TIMING = /후에|이후|다음에|\b(?:only if|as long as|after|once(?!\s+again))\b/iu;
const POSTING = /올려|올리|게시|공개|포트폴리오|사용|써|쓰|\b(?:post|portfolio|publish|share|show|use)/iu;
// A Korean question often drops its question mark: a sentence ending in 나요, 가요, 까요 or a 지요 after a
// syllable closed by ㄴ (는지요, 인지요, 한지요) asks rather than answers.
const endsWithBatchimN = (s) => {
  const c = s.codePointAt(s.length - 1) - 0xac00;
  return c >= 0 && c < 11172 && c % 28 === 4;
};
const isQuestion = (u) => /[?？]$/u.test(u) || /(?:나요|가요|까요)$/u.test(bare(u)) || (/지요$/u.test(bare(u)) && endsWithBatchimN(bare(u).slice(0, -2)));

// jobs: every job of the thread, oldest first. Returns the deal signals to apply, or a reason the answer was
// not applied, with the job it concerns.
export function permissionSignal({ thread, jobs, decision, at = new Date().toISOString() }) {
  const job = jobs.at(-1) ?? null;
  const none = (reason) => ({ signals: [], reason, jobId: job?.id ?? null });
  if (decision?.permissionIssue) return none(decision.permissionIssue);
  const answer = decision?.portfolioPermission ?? null;
  if (!answer) return none(null);
  const signal = (type, j, evidence) => ({ type, platform: thread.platform, threadId: j.threadId, jobId: j.id, at, evidence: { ...evidence, source: 'brain' } });
  // A refusal cannot say which of the thread's works it means, so it holds on every job delivered once (an
  // older closed one, a revision or a rerun included): hiding work is the safe side.
  if (answer === 'refused') {
    const delivered = jobs.filter((j) => j.deliveredAt);
    // Nothing delivered means no job the operator could record it on yet.
    if (!delivered.length) return { signals: [], reason: 'refusal on a thread whose job was never delivered', jobId: null };
    // The client's own sentence is kept for the operator when the page holds it; a refusal applies either way.
    const said = bare(decision.permissionQuote);
    const from = said.length >= 2 ? (thread.messages ?? []).find((m) => m.direction === 'in' && unitsOf(msgText(m)).some((u) => bare(u) === said)) : null;
    const evidence = from ? { quote: norm(decision.permissionQuote), quoteAt: from.at ?? null } : { quote: null };
    return { signals: delivered.map((j) => signal('permission_refused', j, evidence)), reason: null, jobId: job.id };
  }
  if (!job || !['delivered', 'closed'].includes(job.status)) return none(null);
  const after = Date.parse(job.deliveredAt ?? '');
  const inbound = (thread.messages ?? []).filter((m) => m.direction === 'in' && Number.isFinite(Date.parse(m.at ?? '')) && Date.parse(m.at) > after);
  // A denial stands until the operator lifts it, and a grant already recorded needs nothing more.
  const prior = job.meta?.portfolio ?? {};
  if (prior.permission === 'denied') return none('the client refused before; only the operator lifts it with fsw deal ' + job.id + ' permission granted');
  if (prior.permission === 'granted') return none(null);
  // The quote must be newer than the last recorded answer as well as the delivery.
  const since = prior.answeredAt ? Date.parse(prior.answeredAt) : -Infinity;
  const fresh = inbound.filter((m) => Date.parse(m.at) > since);
  const quote = bare(decision.permissionQuote);
  const i = quote.length >= 2 ? fresh.findIndex((m) => unitsOf(msgText(m)).some((u) => bare(u) === quote)) : -1;
  if (i < 0) return none('grant whose quote is not a whole sentence of an inbound message after the delivery');
  // My own words echoed back, or a question, answer nothing.
  const mine = (thread.messages ?? []).filter((m) => m.direction === 'out').flatMap((m) => unitsOf(msgText(m)).map(bare));
  if (mine.includes(quote)) return none('grant quoting a sentence of my own message');
  if (unitsOf(msgText(fresh[i])).some((u) => bare(u) === quote && isQuestion(u))) return none('grant quoted from a question');
  if (fresh.slice(i).some((m) => NEGATION.test(msgText(m)))) return none('grant quoted from a message that says no, or followed by one');
  // A quote of one sentence is the answer itself; a quote of a whole message is judged sentence by sentence.
  const quoted = sentencesOf(decision.permissionQuote);
  const quotedSentence = quoted.length === 1 ? bare(quoted[0]) : null;
  const conditional = (u) => SCOPE.test(u) || (TIMING.test(u) && (bare(u) === quotedSentence || POSTING.test(u)));
  if (fresh.slice(i).some((m) => sentencesOf(msgText(m)).some(conditional))) return none('grant with a condition, for the operator to scope');
  return { signals: [signal('permission_granted', job, { quote: norm(decision.permissionQuote), quoteAt: fresh[i].at })], reason: null, jobId: job.id };
}
