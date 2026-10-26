// Pure parsers for 숨고 pro pages. The request list and chat list expose structured records through
// their components (Vue props on request cards, React props on chat rows); the adapter projects a
// whitelist of fields in the page and these parsers turn them into records with redacted snippets.
import { lines, redactDigits, seoulIso, snippet, squash, toInt } from '../kit.mjs';
import { koreanAmount } from './market.mjs';

// A platform notice kept as money evidence: digits runs redacted and the payout account line dropped,
// so neither a phone number nor account digits reach the ledger.
export const noticeEvidence = (text) => redactDigits(String(text ?? '').split(/\n/).filter((l) => !/정산\s*계좌|입금자명/.test(l)).join('\n').trim()).slice(0, 500);

// Requests: rows projected from RequestItemCard.request plus the card's questionnaire summary text.
// createdAt and expiredAt carry no zone and are Seoul time: a card whose createdAt read 01:13 printed
// "10시간 전" at 12:05 Seoul on 2026-10-25.
export function parseRequests(rows) {
  return rows.map((r) => ({
    id: String(r.id),
    kind: 'request',
    customer: squash(r.customer) || null,
    customerRequestCount: r.customerRequestCount ?? null,
    service: r.service ?? null,
    serviceId: r.serviceId ?? null,
    category: r.category ?? [],
    region: r.address ?? null,
    at: r.createdAt ? r.createdAt.replace(/(\.\d{3})\d*$/, '$1') + '+09:00' : null,
    expiresAt: r.expiredAt ? r.expiredAt.replace(/(\.\d{3})\d*$/, '$1') + '+09:00' : null,
    quoteCount: r.quoteCount ?? null,
    quotable: r.isQuotable !== false,
    unread: r.isRead === false,
    preview: snippet(r.summary, 200),
    url: `https://soomgo.com/requests/received/${r.id}?from=request_list`,
  }));
}

// The buyer's budget from the questionnaire: the answer to a question naming 예산, read as Korean
// amounts. "100만원~200만원" gives both sides, "50만원 미만" or "이하" only a maximum and "1,000만원
// 이상" only a minimum; "100~200만원" carries the unit once, so a bare number takes the answer's 만.
// null when no question names the budget or its answer holds no amount (협의, 미정).
export function budgetFromAnswers(answers) {
  const answer = answers.find((x) => /예산/.test(x.q ?? ''))?.a;
  if (!answer) return null;
  const scale = /만/.test(answer) ? 1e4 : 1;
  const amounts = String(answer).split(/[~∼〜]|에서/).map((part) => {
    const n = koreanAmount(part);
    return n && !/[만억천]/.test(part) ? n * scale : n;
  }).filter((n) => Number.isFinite(n) && n > 0);
  if (!amounts.length) return null;
  if (amounts.length > 1) return { minKRW: Math.min(...amounts), maxKRW: Math.max(...amounts) };
  if (/미만|이하|까지/.test(answer)) return { minKRW: null, maxKRW: amounts[0] };
  if (/이상|초과|부터/.test(answer)) return { minKRW: amounts[0], maxKRW: null };
  return { minKRW: amounts[0], maxKRW: amounts[0] };
}

// The request detail: questionnaire label/value pairs, customer block lines and the quote form.
export function parseRequestDetail({ id, url, pairs = [], customerText = '', service = null, quoteCount = null, form = {} }) {
  const answers = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) answers.push({ q: squash(pairs[i]), a: redactDigits(squash(pairs[i + 1])) });
  const cl = lines(customerText);
  const joined = cl.find((l) => /가입/.test(l)) ?? null;
  const used = cl.find((l) => /숨고 \d+회 이용/.test(l)) ?? null;
  const cost = form.sendLabel?.match(/([\d,]+)\s*캐시로 견적 보내기/);
  return {
    id: String(id),
    url,
    service,
    quoteCount: Number.isInteger(quoteCount) ? quoteCount : null,
    answers,
    budget: budgetFromAnswers(answers),
    customer: { joined, uses: used ? toInt(used.match(/(\d+)회/)[1]) : null },
    quoteCostKRW: cost ? toInt(cost[1]) : null,
    quoteForm: {
      priceInput: form.priceInput === true,
      priceTypes: form.priceTypes ?? [],
      selectedPriceType: form.selectedPriceType ?? null,
      textarea: form.textarea === true,
      textMaxChars: form.textMaxChars ?? null,
      fileInput: form.fileInput === true,
      sendButton: !!form.sendLabel,
      sendDisabled: form.sendDisabled === true,
    },
  };
}

// Chat rows projected from the chat list's chatItem props. updated_at is Seoul wall time without an
// offset: a row stamped 22:39 opens on a line the thread prints as 오후 10:39 (read 2026-10-25).
export function parseChats(rows) {
  return rows.map((c) => ({
    id: String(c.id),
    kind: 'message',
    customer: squash(c.customer) || null,
    service: c.service ?? null,
    region: c.region ?? null,
    at: c.updatedAt ? c.updatedAt.replace(/(\.\d{3})\d*$/, '$1') + '+09:00' : null,
    preview: snippet(c.lastMessage),
    system: c.lastType === 'SYSTEM',
    unread: (c.newMessages ?? 0) > 0,
    unreadCount: c.newMessages ?? 0,
    status: c.status ?? null,
    hired: c.hireStatus ?? null,
    otherProHired: c.otherProHireStatus ?? null,
    safePayment: c.safePaymentId == null && c.safePaymentStatus == null ? null : { id: c.safePaymentId == null ? null : String(c.safePaymentId), status: c.safePaymentStatus ?? null },
    // The full newest platform line, for the money notices classifier; customer text is never kept here.
    notice: c.lastType === 'SYSTEM' ? noticeEvidence(c.lastMessage) : null,
    quote: c.quotePrice == null ? null : { priceKRW: c.quotePrice, unit: c.quoteUnit === 'H' ? 'hour' : 'total', opened: c.quoteOpened ?? null },
    requestId: c.requestObjectId ?? null,
  }));
}

const KO_TIME = /^(오전|오후) (\d{1,2}):(\d{2})$/;

// items: {date} separators ("2026년 09월 23일 수요일") set the day for the "오후 10:42" times after
// them; message items carry kind (text, quote, system), outbound and time.
export function parseChatThread({ id, url, customer, items = [], composer = {} }) {
  let day = null;
  const messages = [];
  for (const it of items) {
    if (it.date) {
      const m = it.date.match(/(\d{4})년 (\d{1,2})월 (\d{1,2})일/);
      if (m) day = [Number(m[1]), Number(m[2]), Number(m[3])];
      continue;
    }
    const t = squash(it.time).match(KO_TIME);
    let at = null;
    if (t && day) {
      const h = (Number(t[2]) % 12) + (t[1] === '오후' ? 12 : 0);
      at = seoulIso(day[0], day[1], day[2], h, Number(t[3]));
    }
    const direction = it.kind === 'system' ? 'system' : it.outbound ? 'out' : 'in';
    const text = direction === 'system' ? noticeEvidence(it.text) : redactDigits(String(it.text ?? '').trim());
    messages.push({ externalId: `${id}:${messages.length}`, direction, type: it.kind ?? 'text', noticeType: it.type ?? null, text, at });
  }
  return {
    id: String(id),
    url,
    customer: squash(customer) || null,
    messages: messages.filter((m) => m.direction !== 'system'),
    systemMessages: messages.filter((m) => m.direction === 'system').length,
    // Platform lines in page order with their times, for src/orders/money.mjs.
    notices: messages.filter((m) => m.direction === 'system').map((m) => ({ type: m.noticeType, text: m.text, at: m.at })),
    canReply: composer.found === true && composer.disabled !== true,
    composer: { found: composer.found === true, disabled: composer.disabled === true, maxChars: composer.maxChars ?? null, fileInput: composer.fileInput === true },
  };
}

const after = (ls, label) => {
  const i = ls.indexOf(label);
  return i >= 0 ? ls[i + 1] ?? null : null;
};

// /profile body text. The completion cards repeat the field labels near the top, so each value is read
// after the label's last occurrence. Business registration, address and payout lines are never returned.
export function parseProfile(text) {
  const ls = lines(text);
  const last = (label) => {
    const i = ls.lastIndexOf(label);
    return i >= 0 ? ls[i + 1] ?? null : null;
  };
  const nameAt = ls.findIndex((l, i) => ls[i + 2] === '리뷰 평점' || ls[i + 1] === '리뷰 평점');
  const headline = nameAt >= 0 && ls[nameAt + 1] !== '리뷰 평점' ? ls[nameAt + 1] : null;
  return {
    nickname: nameAt >= 0 ? ls[nameAt] : null,
    headline,
    rating: Number(after(ls, '리뷰 평점')) || null,
    reviews: toInt(after(ls, '리뷰수')),
    hires: toInt(after(ls, '고용수')),
    completion: ls.find((l) => /^\d+% 완성$/.test(l))?.replace(' 완성', '') ?? null,
    range: last('활동 가능 범위'),
    mainService: last('대표 서비스'),
    services: last('제공 서비스'),
    businessVerified: last('사업자등록증') === '인증',
    identityVerified: last('본인인증') === '인증',
    taxInvoice: last('세금 계산서 발행'),
    paymentMethods: last('결제 수단'),
    media: toInt(last('사진 및 동영상')),
    qna: toInt(last('질문답변')),
  };
}

// 충전/사용 내역 (/mypage/cash-dashboard, read 2026-10-26), newest first: each row is a label
// "<what> - <customer>", a Seoul timestamp to the second and a signed cash amount. A sent quote reads
// "견적 발송 - <customer>" (a smart quote "스마트견적 발송"), a payback "견적 보상 - <customer>".
export function parseCashHistory(text) {
  const ls = lines(text);
  const rows = [];
  for (let i = 0; i + 2 < ls.length; i++) {
    const head = ls[i].match(/^(.+?) - (.+)$/);
    const at = ls[i + 1].match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
    if (!head || !at || !/^-?[\d,]+캐시$/.test(ls[i + 2])) continue;
    rows.push({ what: head[1], customer: head[2], at: at[1] + 'T' + at[2] + '+09:00', amountKRW: toInt(ls[i + 2]) });
    i += 2;
  }
  return rows;
}

// The charge a quote press made: the newest 견적 발송 row at or after the press, less a margin for clock
// drift, and for the customer when the caller names one. The label is matched whole, since the smart quote
// campaign's own charges read 스마트견적 발송 and are never fsw's press.
export function quoteCharge(rows, { since, customer = null, marginMs = 180_000 }) {
  return rows.find((r) => r.what === '견적 발송' && Date.parse(r.at) >= since - marginMs && (!customer || r.customer === squash(customer))) ?? null;
}

// Cash spent on one Seoul day (YYYY-MM-DD) by source, from parseCashHistory rows: quotes are the 견적 발송
// charges (fsw's presses and any the operator sent by hand), smartQuotes the 스마트견적 발송 charges the
// platform's smart quote campaigns make by themselves, other every other charge; credits (paybacks,
// recharges) are not spend. The page lists the newest rows only, so complete says whether a row older
// than the day was read, which proves the day's rows are all there.
export function cashSpend(rows, day) {
  const out = { day, quotesKRW: 0, quotes: 0, smartQuotesKRW: 0, smartQuotes: 0, otherKRW: 0, complete: rows.some((r) => r.at.slice(0, 10) < day) };
  for (const r of rows) {
    if (r.at.slice(0, 10) !== day || r.amountKRW >= 0) continue;
    if (r.what === '견적 발송') {
      out.quotesKRW -= r.amountKRW;
      out.quotes += 1;
    } else if (r.what === '스마트견적 발송') {
      out.smartQuotesKRW -= r.amountKRW;
      out.smartQuotes += 1;
    } else out.otherKRW -= r.amountKRW;
  }
  return out;
}

// Smart quote campaigns from the links on /instant-match (read 2026-10-26): each campaign is a link
// /instant-match/<id> whose text holds 하루 예산 and its amount in 캐시, and may hold 최대 <n>건 (the detail
// page reads "60,000 캐시 / 최대 30건 발송"). name is the link's first line.
export function parseCampaigns(links) {
  return links.flatMap(({ href, text }) => {
    const id = String(href ?? '').match(/^\/instant-match\/([^/?#]+)/)?.[1];
    if (!id) return [];
    const ls = lines(text);
    const tail = String(text).slice(String(text).indexOf('하루 예산'));
    const budget = /하루 예산/.test(text) ? tail.match(/([\d,]+)\s*캐시/) : null;
    const max = tail.match(/최대\s*([\d,]+)\s*건/);
    return [{ id, name: ls.find((l) => !/하루 예산|캐시|최대/.test(l)) ?? null, dailyBudgetKRW: budget ? toInt(budget[1]) : null, maxPerDay: max ? toInt(max[1]) : null }];
  });
}

// /mypage body text: the cash balance sits after 스토어, the payback after 이번 달 페이백.
export function parseCash(text) {
  const ls = lines(text);
  const cash = (label) => {
    const v = after(ls, label);
    return v && /^[\d,]+캐시$/.test(v) ? toInt(v) : null;
  };
  return { balance: cash('스토어'), paybackThisMonth: cash('이번 달 페이백') };
}
