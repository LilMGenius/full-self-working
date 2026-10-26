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
const NEGATION = /않|못|말아|말고|마세요|마시고|마십시오|싫|아니|거절|불가|곤란|어렵|비공개|삼가|자제|내부|보류|(?:^|[\s,.!?])안(?=\s|돼|되|됩)|\b(?:no|not|never|don'?t|rather not|private|confidential)\b|n't\b/iu;
// A yes with a condition is the operator's to scope. A held yes costs the operator one notice; a granted
// conditional yes publishes work against the client's word. Scope words leave part of the work out, cover
// it or set a condition; timing words put the posting off.
const SCOPE = /빼[는고서주]|빼\s+주|제외|만\s*(?:올려|보여|공개)|에만|만\s*요|가려|가리|모자이크|지워|지우|삭제|노출|가명|익명|흐리게|바꿔|교체|\b(?:except|without|blur|hide|only|as long as|remove|removed|redact\w*|anonymi\w*|rename\w*|swap\w*|replace\w*|placeholder)\b/iu;
const TIMING = /후에|이후|다음에|나서|까지|기다려|(?:하|나|되)면|때(?!문)[^.!?]*?(?:올려|올리|게시|공개|보여)|\b(?:after|once|until|wait|when)\b/iu;
// A sentence that speaks about posting or showing the work.
const POSTING = /올려|올리|게시|공개|보여|포트폴리오|\b(?:post|share|show|publish|portfolio|use it)\b/iu;
// A sentence that talks about the work itself (a version, a page, the logo) or states a preference about
// it: beside a yes it may say which work or how, so it must itself be a plain yes.
const WORK = /시안|버전|로고|이미지|페이지|\b(?:versions?|themes?|logos?|images?|screenshots?|pages?)\b/iu;
const PREFERENCE = /나을|좋겠|선호|\b(?:prefer\w*|rather|should|better)\b/iu;
// A plain yes in Korean or English.
const YES = /네|예|좋아요|좋습니다|괜찮|돼요|됩니다|되요|물론|\b(?:yes|yeah|sure|ok|okay|of course|go ahead|fine|feel free)\b/iu;
// Delivery and payment logistics; a sentence about them that says nothing about showing the work is neutral.
const LOGISTICS = /세금계산서|계산서|정산|입금|파일|원본|\b(?:invoice|receipt|source|download|payment)\b/iu;
// A sentence that opens with a bare imperative verb asks for something.
const IMPERATIVE = /^(?:use|show|post|put|keep|remove|make)\b/iu;
// Whole thank-you and sign-off phrases that carry a timing word (or, for can't wait, a negation) and set no
// condition. They are taken out only of a sentence that does not speak about posting, never as bare word
// pairs, so 보고 나서 올려 주세요 stays a condition.
const SIGNOFF = /(?:다음에|이후로)도?\s*(?:또\s*|계속\s*)?잘\s*부탁|다음에\s*또\s*(?:맡기|맡길|부탁|의뢰)|(?:지금|끝)까지\s*(?:신경|감사|고생|수고)|기다려\s*주셔서\s*(?:감사|고맙)|(?:감사|고맙)\S*\s*기다려\s*주셔서|보고\s*나서\s*(?:너무|정말|진짜)?\s*좋|\bonce\s+again\b|\bcan'?t\s+wait\s+to\s+(?:see|share)\b|후에\s*연락/giu;
// Short thank-you words, taken out of a sentence like the sign-offs.
const THANKS = /감사(?:합니다|해요|했습니다|드려요|드립니다)?|고맙(?:습니다|어요)?|고마워요|수고(?:하셨습니다|하셨어요|많으셨어요)?|좋네요|\b(?:thanks|thank you|great|looks good)\b/giu;
// The forms of a request or a reservation: a sentence that asks for something, or qualifies a yes.
const REQUEST = /주세요|주시|부탁|해\s*줘|해줘|바랍니다|원해요|다만|대신|으로\s*(?:바꿔|해|올려|올리|써)|\b(?:please|just|but|instead|rather)\b/iu;
// A Korean question often drops its question mark: a sentence ending in 나요, 가요, 까요 or a 지요 after a
// syllable closed by ㄴ (는지요, 인지요, 한지요) asks rather than answers.
const endsWithBatchimN = (s) => {
  const c = s.codePointAt(s.length - 1) - 0xac00;
  return c >= 0 && c < 11172 && c % 28 === 4;
};
const isQuestion = (u) => /[?？]$/u.test(u) || /(?:나요|가요|까요)$/u.test(bare(u)) || (/지요$/u.test(bare(u)) && endsWithBatchimN(bare(u).slice(0, -2)));

// jobs: every job of the thread, oldest first. Returns the deal signals to apply, or a reason the answer was
// not applied, with the jobs it concerns (jobId: the newest of them; jobIds: all of them) and, for a grant
// claim on a job that is denied or conditional, the time of the quoted client message (claimAt).
export function permissionSignal({ thread, jobs, decision, at = new Date().toISOString() }) {
  const job = jobs.at(-1) ?? null;
  const none = (reason, extra = {}) => ({ signals: [], reason, jobId: job?.id ?? null, jobIds: job ? [job.id] : [], ...extra });
  if (decision?.permissionIssue) return none(decision.permissionIssue);
  const answer = decision?.portfolioPermission ?? null;
  if (!answer) return none(null);
  const signal = (type, j, evidence) => ({ type, platform: thread.platform, threadId: j.threadId, jobId: j.id, at, evidence: { ...evidence, source: 'brain' } });
  // The client's own sentence and its time, when the page holds it.
  const saidEvidence = () => {
    const said = bare(decision.permissionQuote);
    const from = said.length >= 2 ? (thread.messages ?? []).find((m) => m.direction === 'in' && unitsOf(msgText(m)).some((u) => bare(u) === said)) : null;
    return from ? { quote: norm(decision.permissionQuote), quoteAt: from.at ?? null } : { quote: null };
  };
  // A consent the model read as conditional never grants. Like a refusal it cannot say which of the
  // thread's works it means, so it is recorded on every job delivered once (an older granted one included),
  // except one already denied or conditional: a condition never replaces a denial. Each such job then refuses
  // a later model grant, and the operator is told once and scopes it.
  if (answer === 'conditional') {
    const delivered = jobs.filter((j) => j.deliveredAt);
    if (!delivered.length) return { signals: [], reason: 'the client set a condition on showing the work, but no job on this thread was delivered', jobId: null, jobIds: [] };
    const open = delivered.filter((j) => !['denied', 'conditional'].includes(j.meta?.portfolio?.permission));
    return { signals: open.map((j) => signal('permission_conditional', j, saidEvidence())), reason: 'the client set a condition on showing the work, for the operator to scope', jobId: delivered.at(-1).id, jobIds: (open.length ? open : delivered).map((j) => j.id) };
  }
  // A refusal cannot say which of the thread's works it means, so it holds on every job delivered once (an
  // older closed one, a revision or a rerun included): hiding work is the safe side.
  if (answer === 'refused') {
    const delivered = jobs.filter((j) => j.deliveredAt);
    // Nothing delivered means no job the operator could record it on yet.
    if (!delivered.length) return { signals: [], reason: 'refusal on a thread whose job was never delivered', jobId: null, jobIds: [] };
    // The client's own sentence is kept for the operator when the page holds it; a refusal applies either way.
    return { signals: delivered.map((j) => signal('permission_refused', j, saidEvidence())), reason: null, jobId: job.id, jobIds: delivered.map((j) => j.id) };
  }
  if (!job || !['delivered', 'closed'].includes(job.status)) return none(null);
  // The window starts at the latest delivery: the deal moves deliveredAt on every redelivery, so a change
  // request handled before it is read no more.
  const after = Date.parse(job.deliveredAt ?? '');
  const inbound = (thread.messages ?? []).filter((m) => m.direction === 'in' && Number.isFinite(Date.parse(m.at ?? '')) && Date.parse(m.at) > after);
  // A denial or a condition stands until the operator lifts it, and a grant already recorded needs nothing
  // more. A grant claim on a blocked job carries the time of the client message it quotes, so a newer client
  // answer reaches the operator as its own notice.
  const prior = job.meta?.portfolio ?? {};
  const claimAt = () => saidEvidence().quoteAt ?? null;
  if (prior.permission === 'denied') return none('the client refused before; only the operator lifts it with fsw deal ' + job.id + ' permission granted', { claimAt: claimAt() });
  if (prior.permission === 'conditional') return none('the client set a condition before; only the operator lifts it with fsw deal ' + job.id + ' permission granted', { claimAt: claimAt() });
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
  // The model judges conditions first (a conditional answer never reaches this point); this check is the
  // backstop. Every client message since the latest delivery is read, sentence by sentence, and an unknown
  // sentence holds the grant (fail-safe: a held yes costs the operator one notice, a granted conditional yes
  // publishes work against the client's word). The quoted sentence must be an unconditional yes on its own:
  // no negation, scope, restriction or timing word (a question was refused above). A sentence about
  // logistics that says nothing about showing the work is neutral. A sentence that talks about the work or
  // states a preference must itself be a plain yes. Every other sentence must be a known sign-off or
  // thank-you, or carry no negation, scope, timing or request form once those phrases are taken out, and ask
  // nothing. A sentence that speaks about posting keeps its words: no sign-off is taken out of it.
  // Residual risk: a condition stated in words none of these lists knows passes only when the model also
  // labelled the answer granted; the lists are not chased further, and the operator can deny with fsw deal.
  const quoted = new Set(sentencesOf(decision.permissionQuote).map(bare));
  const isQuoted = (u) => quoted.size === 1 && quoted.has(bare(u));
  const read = (u) => {
    if (LOGISTICS.test(u) && !POSTING.test(u) && !SCOPE.test(u)) return { rest: '', request: false };
    const strict = POSTING.test(u) || isQuoted(u);
    const rest = strict ? u : u.replace(SIGNOFF, ' ').replace(THANKS, ' ');
    const notPlainYes = !YES.test(u) || PREFERENCE.test(u);
    const request = !isQuoted(u) && (REQUEST.test(rest) || IMPERATIVE.test(u) || isQuestion(u) || ((WORK.test(u) || PREFERENCE.test(u)) && notPlainYes));
    return { rest, request };
  };
  const sentences = inbound.flatMap((m) => sentencesOf(msgText(m))).map(read);
  if (sentences.some((s) => NEGATION.test(s.rest))) return none('grant quoted from a message that says no, or followed by one');
  if (sentences.some((s) => s.request || SCOPE.test(s.rest) || TIMING.test(s.rest))) return none('grant with a condition, for the operator to scope');
  return { signals: [signal('permission_granted', job, { quote: norm(decision.permissionQuote), quoteAt: fresh[i].at })], reason: null, jobId: job.id };
}
