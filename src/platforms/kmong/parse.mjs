// Pure parsers for 크몽 seller pages. Input is page text or JSON the adapter extracted from the DOM;
// output is records with customer text cut to redacted snippets. instance.local/platforms/kmong-notes.md
// holds the page anchors these shapes come from.
import { lines, redactDigits, seoulIso, seoulYear, snippet, squash, toInt } from '../kit.mjs';

// "10.16" is this year in Seoul, "25.12.12" is YY.MM.DD; an optional "HH:MM" may follow.
export function parseKmongDate(text, now = new Date()) {
  const m = squash(text).match(/^(?:(\d{2})\.)?(\d{1,2})\.(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const year = m[1] ? 2000 + Number(m[1]) : seoulYear(now);
  return seoulIso(year, Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}

const groupId = (href) => href?.match(/inbox_group_id=(\d+)/)?.[1] ?? null;

// rows: [{href, nickname, time, preview}] from the inbox list; unreadHrefs: rows the 안읽음 tab shows.
export function parseInbox(rows, unreadHrefs = [], now = new Date()) {
  const unread = new Set(unreadHrefs.map(groupId));
  return rows
    .map((r) => ({
      id: groupId(r.href),
      partnerId: r.href?.match(/partner_id=(\d+)/)?.[1] ?? null,
      kind: 'message',
      customer: squash(r.nickname) || null,
      at: parseKmongDate(r.time, now),
      preview: snippet(r.preview),
      unread: unread.has(groupId(r.href)),
    }))
    .filter((t) => t.id);
}

// bubbles: [{text, stamp, outbound}] in page order. The first bubble of a thread opened from a gig
// carries the 문의 서비스 card (title and price) above the buyer's first line.
export function parseThread({ id, url, nickname, gigHrefs = [], bubbles = [], composer = {} }, now = new Date()) {
  const messages = bubbles.map((b, i) => {
    let text = String(b.text ?? '').trim();
    let inquiry = null;
    const card = text.match(/^문의 서비스\n+([^\n]+)\n+([\d,]+원)\n+([\s\S]*)$/);
    if (card) {
      inquiry = { gigTitle: card[1].trim(), priceKRW: toInt(card[2]) };
      text = card[3].trim();
    }
    return { externalId: `${id}:${i}`, direction: b.outbound ? 'out' : 'in', text: redactDigits(text), at: parseKmongDate(b.stamp, now), ...(inquiry ? { inquiry } : {}) };
  });
  const gigId = gigHrefs.map((h) => h.match(/\/gig\/(\d+)/)?.[1]).find(Boolean) ?? null;
  return {
    id,
    url,
    customer: squash(nickname) || null,
    gigId: gigId ? Number(gigId) : null,
    messages,
    canReply: composer.found === true && composer.disabled !== true,
    composer: { found: composer.found === true, disabled: composer.disabled === true, placeholder: composer.placeholder ?? null, sendButton: composer.sendButton === true, fileInput: composer.fileInput === true },
  };
}

const after = (ls, label) => {
  const i = ls.indexOf(label);
  return i >= 0 ? ls[i + 1] ?? null : null;
};

// A money or count label whose next line is the value; the side menu repeats some labels with other text.
const amountAfter = (ls, label, unit) => {
  const i = ls.findIndex((l, j) => l === label && new RegExp(`^[\\d,]+${unit}$`).test(ls[j + 1] ?? ''));
  return i >= 0 ? toInt(ls[i + 1]) : null;
};

// /my-gigs body text. Rows follow the 서비스 상태 안내 label: status, #id, three category lines,
// title, price, 편집하기, then 등록일/수정일/승인 안내 label and value pairs.
export function parseGigList(text) {
  const ls = lines(text);
  const counts = {};
  for (const [key, label] of [['all', '전체'], ['waiting', '승인 전'], ['selling', '판매중'], ['rejected', '비승인'], ['suspended', '판매 중지']]) {
    const i = ls.findIndex((l, j) => l === label && /^\d+$/.test(ls[j + 1] ?? ''));
    counts[key] = i >= 0 ? Number(ls[i + 1]) : null;
  }
  const start = ls.indexOf('서비스 상태 안내');
  const body = start >= 0 ? ls.slice(start + 1) : [];
  const gigs = [];
  body.forEach((l, i) => {
    const id = l.match(/^#(\d+)$/)?.[1];
    if (!id) return;
    // A row ends where the next one starts (its status chip sits just above the next #id line), so a
    // label such as 승인 안내 is never read from the gig below.
    const next = body.findIndex((x, j) => j > i && /^#\d+$/.test(x));
    const row = body.slice(i + 1, next > i ? next - 1 : i + 20);
    const priceAt = row.findIndex((x) => /^[\d,]+원~?$/.test(x));
    if (priceAt < 1) return;
    const dateAfter = (label) => {
      const v = after(row, label);
      return v && /^\d{4}\.\d{2}\.\d{2}$/.test(v) ? v.replace(/\./g, '-') : null;
    };
    gigs.push({
      gigId: Number(id),
      status: body[i - 1] ?? null,
      category: row.slice(0, priceAt - 1),
      title: row[priceAt - 1],
      priceKRW: toInt(row[priceAt]),
      priceFrom: row[priceAt].endsWith('~'),
      url: `https://kmong.com/gig/${id}`,
      registeredAt: dateAfter('등록일'),
      modifiedAt: dateAfter('수정일'),
      approvedAt: dateAfter('승인 안내'),
    });
  });
  return { counts, gigs };
}

export const ORDER_COUNTERS = {
  'ongoing-count': 'ongoing',
  'delivery-count': 'delivered',
  'resolution-problem-count': 'problem',
  'inrevision-count': 'revision',
  'late-delivery-count': 'late',
  'complete-count': 'completed',
  'canceled-count': 'canceled',
};

// counters: {testid: text}; emptyState: whether 조회 기간에 거래 내역이 없어요 shows.
export function parseOrders({ counters = {}, emptyState = false }) {
  const counts = {};
  for (const [testid, key] of Object.entries(ORDER_COUNTERS)) counts[key] = counters[testid] === undefined ? null : toInt(counters[testid]);
  const total = Object.values(counts).reduce((s, n) => s + (n ?? 0), 0);
  // Order rows were never observed (the account has no orders), so a non-empty list is reported as a
  // gap until a row parser is built against a real order.
  return emptyState ? { counts, total, orders: [] } : { counts, total, orders: null, gap: 'order rows present; the row parser is not built yet' };
}

// /seller/dashboard body text, read by label.
export function parseDashboard(text) {
  const ls = lines(text);
  return {
    grade: after(ls, '내 등급'),
    bizmoneyKRW: amountAfter(ls, '비즈머니', '원'),
    monthlyEarningsKRW: amountAfter(ls, '월별 수익금 현황', '원'),
    ongoingOrders: amountAfter(ls, '진행 중인 주문', '건'),
    averageOrderKRW: amountAfter(ls, '평균 객단가', '원'),
    averageResponse: after(ls, '평균 응답 시간'),
    responseRate: after(ls, '응답률'),
    profileCompletion: after(ls, '프로필 완성도'),
  };
}

// Public profile /@nickname body text.
export function parseProfile(text, { nickname = null, url = null } = {}) {
  const ls = lines(text);
  const ratingAt = ls.findIndex((l, i) => /^\d\.\d$/.test(l) && /^\(\d+\)$/.test(ls[i + 1] ?? ''));
  const section = (label, stops) => {
    const i = ls.indexOf(label);
    if (i < 0) return [];
    const out = [];
    for (const l of ls.slice(i + 1)) {
      if (stops.includes(l)) break;
      if (!['필수', '편집'].includes(l)) out.push(l);
    }
    return out;
  };
  const prefixed = (prefix) => ls.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim() ?? null;
  const servicesAt = ls.indexOf('서비스');
  const services = [];
  if (servicesAt >= 0) {
    const rest = ls.slice(servicesAt + 1, servicesAt + 40);
    rest.forEach((l, i) => {
      if (/^[\d,]+원~?$/.test(l) && i > 0) services.push({ title: rest[i - 1], priceKRW: toInt(l) });
    });
  }
  return {
    nickname,
    url,
    rating: ratingAt >= 0 ? Number(ls[ratingAt]) : null,
    reviews: ratingAt >= 0 ? toInt(ls[ratingAt + 1]) : null,
    totalJobs: toInt(after(ls, '총 작업 수')),
    satisfaction: after(ls, '만족도'),
    taxInvoice: ls.find((l) => l.startsWith('세금계산서 발행')) ?? null,
    contactHours: prefixed('연락 가능 시간:'),
    averageResponse: prefixed('평균 응답 시간:'),
    careerTotal: ls.find((l) => /^총 \d+년/.test(l)) ?? null,
    headline: section('소개', ['포트폴리오']).join('\n') || null,
    specialties: section('전문분야∙상세분야', ['보유 기술']).filter((l) => l !== '∙'),
    services,
  };
}

const countIn = (heading) => {
  const m = squash(heading).match(/\((\d+)\/(\d+)\)/);
  return m ? { count: Number(m[1]), max: Number(m[2]) } : null;
};

// The gig edit form as the adapter extracts it: {url, title, headings, counters, editors, packages,
// prices, faqs, keywordInput}. Values are the operator's own listing text.
export function parseListingForm(form) {
  const q = new URL(form.url).searchParams;
  const heading = (name) => (form.headings ?? []).find((h) => squash(h).startsWith(name));
  const [description, process, preparation] = (form.counters ?? []).map((c) => {
    const [n, max] = c.split('/').map(toInt);
    return { length: n, maxChars: max };
  });
  const pkg = form.packages ?? {};
  const tiers = ['STANDARD', 'DELUXE', 'PREMIUM'].map((tier, i) => ({
    tier,
    title: pkg[`0.${i}`] ?? null,
    description: pkg[`1.${i}`] ?? null,
    priceKRW: toInt(form.prices?.[i]),
  }));
  return {
    gigId: Number(form.url.match(/\/my-gigs\/edit\/(\d+)/)?.[1]),
    title: form.title ?? null,
    category: { root: toInt(q.get('rootCategoryId')), sub: toInt(q.get('subCategoryId')), third: toInt(q.get('thirdCategoryId')) },
    sections: (form.headings ?? []).filter((h) => ['상세 정보', '가격 정보', '판매 핵심 정보', '추가 정보'].some((s) => squash(h).startsWith(s))).map((h) => lines(h)[0]),
    description: description ?? null,
    process: process ?? null,
    preparation: preparation ?? null,
    images: { main: countIn(heading('메인 이미지') ?? ''), detail: countIn(heading('상세 이미지') ?? ''), video: countIn(heading('동영상') ?? '') },
    packages: tiers,
    keywords: countIn(heading('검색 키워드') ?? ''),
    faqs: (form.faqs ?? []).map((f) => ({ question: f.question, answer: f.answer })),
    faqCount: countIn(heading('자주 묻는 질문') ?? ''),
    limits: { title: 30, packageTitle: form.limits?.packageTitle ?? null, packageDescription: form.limits?.packageDescription ?? null, faq: form.limits?.faq ?? null, keyword: form.limits?.keyword ?? null },
  };
}
