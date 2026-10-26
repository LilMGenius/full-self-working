// 숨고 pro adapter on the operator's signed-in Chrome. The account is established, so reads never
// change state beyond what a pro normally does: request details may be opened (that marks the request
// read, as browsing does), but a chat opens only when its row shows no new messages or the caller will
// reply in the same tick. Writes take an already gated text; quote() also needs allowSpendCash and
// reports the 숨고캐시 cost read from the page before it presses send.
import { openSession } from '../../browser/driver.mjs';
import { loadDescriptor } from '../registry.mjs';
import { AdapterRefusal, squash } from '../kit.mjs';
import { cashSpend, parseCampaigns, parseCash, parseCashHistory, parseChats, parseChatThread, parseProfile, parseRequestDetail, parseRequests, quoteCharge } from './parse.mjs';
import { readServices } from './services.mjs';

const BASE = 'https://soomgo.com';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- page-side extractors (serialised into the page; no closure over module scope) ----

function pageLogin() {
  const buttons = [...document.querySelectorAll('button,a')].map((e) => e.innerText.trim());
  return {
    url: location.href,
    // /mypage renders without the GNB user menu, so the signed-in proof is the pro chat link, the
    // profile link and the 고수님 greeting, with no 로그인 control anywhere.
    loginButton: !!document.querySelector('[data-testid=login-btn]') || buttons.some((t) => /^로그인/.test(t)),
    proChat: !!document.querySelector('a[href="/pro/chats"]'),
    profileLink: !!document.querySelector('a[href="/profile"]'),
    proGreeting: /고수님/.test(document.body.innerText),
  };
}

function pageRequests() {
  return [...document.querySelectorAll('div.request-item-card-wrapper')].map((card) => {
    const r = card.__vue__?.$props?.request;
    if (!r) return null;
    const info = r.serviceInfo ?? {};
    return {
      id: r.id,
      createdAt: r.createdAt,
      expiredAt: r.expiredAt,
      quoteCount: r.quoteCount,
      isQuotable: r.isQuotable,
      isRead: r.isRead,
      customer: r.user?.name ?? '',
      customerRequestCount: r.user?.requestCount ?? null,
      service: info.service?.name ?? null,
      serviceId: info.service?.id ?? null,
      category: [info.category1?.name, info.category2?.name].filter(Boolean),
      address: r.address ?? null,
      summary: card.querySelector('.request-item-card-remainder')?.innerText ?? '',
    };
  }).filter(Boolean);
}

function pageRequestDetail(id) {
  const card = [...document.querySelectorAll('div.request-item-card-wrapper')].find((c) => c.__vue__?.$props?.request?.id === id);
  const spans = [...document.querySelectorAll('.request-view-text-keyword-questions span')].filter((s) => /body1[46]/.test(s.className));
  const price = document.querySelector('input[placeholder="금액을 입력해 주세요."]');
  const box = document.querySelector('.received-request-quote-send');
  const ta = box?.querySelector('textarea');
  const send = [...document.querySelectorAll('button')].find((b) => /캐시로 견적 보내기/.test(b.innerText));
  const types = [...document.querySelectorAll('button')].filter((b) => ['총 비용', '시간 당'].includes(b.innerText.trim()));
  if (price) price.setAttribute('data-fsw', 'quote-price');
  if (ta) ta.setAttribute('data-fsw', 'quote-text');
  if (send) send.setAttribute('data-fsw', 'quote-send');
  types.forEach((b) => b.setAttribute('data-fsw', b.innerText.trim() === '총 비용' ? 'price-total' : 'price-hourly'));
  const save = document.querySelector('input[name=save-template]');
  return {
    url: location.href,
    service: card?.__vue__?.$props?.request?.serviceInfo?.service?.name ?? null,
    quoteCount: card?.__vue__?.$props?.request?.quoteCount ?? null,
    // The line soomgo shows instead of taking a quote on a request that already has its quota of quotes.
    full: document.body.innerText.match(/이미 \d+개 이상 견적을 받은 요청입니다\.?/)?.[0] ?? null,
    pairs: spans.map((s) => s.innerText),
    customerText: document.querySelector('section[data-section=customer-profile]')?.innerText ?? '',
    form: {
      priceInput: !!price,
      priceValue: price?.value ?? '',
      priceTypes: types.map((b) => b.innerText.trim()),
      selectedPriceType: types.find((b) => b.classList.contains('selected'))?.innerText.trim() ?? null,
      textarea: !!ta,
      textValue: ta?.value ?? '',
      textMaxChars: ta?.maxLength ?? null,
      fileInput: !!document.querySelector('input.file-uploader-input[type=file]'),
      saveTemplateChecked: save?.checked ?? null,
      sendLabel: send?.innerText.trim() ?? null,
      sendDisabled: !!send?.disabled,
    },
  };
}

function pageChats() {
  const fiberKey = (el) => Object.keys(el).find((k) => k.startsWith('__reactFiber'));
  return [...document.querySelectorAll('a[href^="/pro/chats/"]')].map((a) => {
    let c = null;
    for (let f = a[fiberKey(a)], i = 0; f && i < 4 && !c; f = f.return, i++) c = f.memoizedProps?.chatItem ?? null;
    if (!c) return null;
    const addr = c.request?.address ?? {};
    return {
      id: c.id,
      customer: c.user?.name ?? '',
      service: c.service?.title ?? null,
      region: [addr.address1, addr.address2, addr.address3].filter(Boolean).join(' ') || null,
      updatedAt: c.updated_at,
      lastMessage: c.last_message ?? '',
      lastType: c.last_message_type,
      newMessages: c.new_message_count,
      status: c.status,
      hireStatus: c.hire_status,
      otherProHireStatus: c.other_provider_hire_status,
      safePaymentId: c.safe_payment?.safe_payment_id ?? null,
      safePaymentStatus: c.safe_payment?.safe_payment_status ?? null,
      quotePrice: c.quote?.price ?? null,
      quoteUnit: c.quote?.unit ?? null,
      quoteOpened: c.quote?.is_opened ?? null,
      requestObjectId: c.request?.object_id ?? null,
    };
  }).filter(Boolean);
}

async function pageScrollChats() {
  const as = document.querySelectorAll('a[href^="/pro/chats/"]');
  as[as.length - 1]?.scrollIntoView();
  await new Promise((r) => setTimeout(r, 2500));
  return document.querySelectorAll('a[href^="/pro/chats/"]').length;
}

function pageOpenChat(id) {
  const a = document.querySelector(`a[href^="/pro/chats/${id}?"]`);
  if (!a) return false;
  a.click();
  return true;
}

function pageChatThread() {
  const items = [];
  for (const li of document.querySelectorAll('.chat-messages li')) {
    const date = li.querySelector('.date');
    if (date) {
      items.push({ date: date.innerText.trim() });
      continue;
    }
    const box = li.querySelector('.message-box');
    const type = box?.getAttribute('data-message-type') ?? '';
    // Platform lines carry a type code (ST_001 hire, SB_201 hire confirmed, SP_ST_002 숨고페이); a text
    // bubble has none and a quote card is ST_QUOTE.
    const systemish = !box || li.querySelector('.benefit-system-message, .hire-inducement-message, .notice-text-box, .system-button-reminder') || (/^[A-Z]{2}_/.test(type) && type !== 'ST_QUOTE');
    const kind = type === 'ST_QUOTE' ? 'quote' : systemish ? 'system' : 'text';
    const content = box?.querySelector('[data-name=content]');
    items.push({
      kind,
      type: type || null,
      outbound: !!box?.classList.contains('my-message'),
      text: (content ?? box ?? li).innerText.replace(/\s*전체보기\s*$/, ''),
      time: (li.querySelector('[data-name=created-at]') ?? li.querySelector('.message-time'))?.innerText ?? '',
    });
  }
  const ta = document.querySelector('textarea.message-input');
  if (ta) ta.setAttribute('data-fsw', 'composer');
  // The send control is an image (img.btn-submit) in the column after the textarea, not a button.
  const send = ta?.closest('.message-input-form')?.querySelector('img.btn-submit') ?? null;
  if (send) send.setAttribute('data-fsw', 'send');
  return {
    url: location.href,
    items,
    composer: { found: !!ta, disabled: !!ta && (ta.disabled || ta.readOnly), maxChars: ta?.maxLength ?? null, value: ta?.value ?? '', fileInput: !!document.querySelector('input.file-input-hidden[type=file]'), sendButton: !!send, sendDisabled: false },
  };
}

function pageText() {
  return document.body.innerText;
}

// The smart quote campaign links on /instant-match, as href and text only.
function pageCampaignLinks() {
  return [...document.querySelectorAll('a[href^="/instant-match/"]')].map((a) => ({ href: a.getAttribute('href'), text: a.innerText }));
}

const seoulDay = (d) => new Intl.DateTimeFormat('sv', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// The 숨고페이 요청 dialog (a Bootstrap modal .safe-payment-modal, read 2026-10-25): a tel amount input
// (maxLength 11) mirrored into a hidden safePaymentAmount, date radios, a Close button and the confirm
// 거래 요청하기, disabled until an amount is typed.
function pagePayDialog() {
  const modal = document.querySelector('.modal.safe-payment-modal.show') ?? document.querySelector('.modal.safe-payment-modal');
  const shown = !!modal && modal.classList.contains('show') && modal.getBoundingClientRect().height > 0;
  if (!shown) return { open: false };
  const amount = modal.querySelector('input[type=tel]');
  const hidden = modal.querySelector('input[name=safePaymentAmount]');
  const confirm = [...modal.querySelectorAll('button')].find((b) => b.innerText.trim() === '거래 요청하기');
  const close = modal.querySelector('button.close, button[aria-label=Close]');
  if (amount) amount.setAttribute('data-fsw', 'pay-amount');
  if (confirm) confirm.setAttribute('data-fsw', 'pay-confirm');
  if (close) close.setAttribute('data-fsw', 'pay-close');
  return {
    open: true,
    title: modal.querySelector('.modal-body')?.innerText.split('\n')[0]?.trim() ?? null,
    amountInput: !!amount,
    amountValue: amount?.value ?? '',
    hiddenAmount: hidden?.value ?? null,
    confirmFound: !!confirm,
    confirmDisabled: !confirm || confirm.disabled || confirm.classList.contains('disabled'),
    closeFound: !!close,
  };
}

function pageOpenPayDialog() {
  const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '숨고페이 요청');
  if (!b) return false;
  b.click();
  return true;
}

// ---- adapter ----

// 숨고페이 takes 15,000 to 5,000,000 KRW per payment (descriptor splitMechanism).
export const PAY_REQUEST_RANGE = [15_000, 5_000_000];
// quote() returns this code when soomgo refused the press because the request already has its quota of quotes.
export const REQUEST_FULL = 'FSW_SOOMGO_REQUEST_FULL';

export async function openSoomgo({ session, sleep = wait } = {}) {
  const s = session ?? (await openSession('soomgo', { platform: 'soomgo', pacing: loadDescriptor('soomgo').pacing }));

  const listChats = async ({ pages = 0, until } = {}) => {
    await s.navigate(`${BASE}/pro/chats`);
    let rows = await s.evaluate(pageChats);
    for (let i = 0; i < pages && !(until && rows.some(until)); i++) {
      const before = rows.length;
      await s.evaluate(pageScrollChats);
      rows = await s.evaluate(pageChats);
      if (rows.length === before) break;
    }
    return rows;
  };

  // Opens a chat from the list, which carries its new-message count; never by URL alone.
  const openChat = async (id, { willReply = false } = {}) => {
    const rows = await listChats({ pages: 5, until: (r) => String(r.id) === String(id) });
    const row = rows.find((r) => String(r.id) === String(id));
    if (!row) throw new AdapterRefusal('FSW_THREAD_NOT_LISTED', `chat ${id} is not in the first ${rows.length} rows, so its unread state is unknown`);
    const unread = (row.newMessages ?? 0) > 0;
    if (unread && !willReply) throw new AdapterRefusal('FSW_UNREAD_REFUSED', `chat ${id} has ${row.newMessages} new messages; open it only with willReply`);
    if (!(await s.evaluate(pageOpenChat, String(id)))) throw new AdapterRefusal('FSW_THREAD_NOT_LISTED', `chat ${id} row vanished`);
    await wait(6000);
    return { row, unread, page: await s.evaluate(pageChatThread) };
  };

  const adapter = {
    platform: 'soomgo',
    session: s,

    async login() {
      await s.navigate(`${BASE}/mypage`);
      const p = await s.evaluate(pageLogin);
      const text = await s.evaluate(() => document.body.innerText);
      const onMypage = new URL(p.url).pathname === '/mypage';
      return { loggedIn: onMypage && !p.loginButton && p.profileLink && p.proGreeting, proMode: p.proChat && p.proGreeting, url: p.url, cash: parseCash(text) };
    },

    async requests() {
      await s.navigate(`${BASE}/requests/received`);
      return parseRequests(await s.evaluate(pageRequests));
    },

    // Opening a request detail marks it read, which is normal pro browsing.
    async readRequest(id) {
      await s.navigate(`${BASE}/requests/received/${encodeURIComponent(id)}?from=request_list`);
      const page = await s.evaluate(pageRequestDetail, String(id));
      const detail = parseRequestDetail({ id, ...page });
      return { ...detail, title: detail.service, text: null, kind: 'request' };
    },

    // dryRun fills the form, confirms the send button and its cost, then clears the form.
    async quote(id, { amountKRW, priceType = 'fixed', text, gate, allowSpendCash = false, dryRun = false, customer = null } = {}) {
      // Every return before the send button is pressed says pressed: false, so the drain does not count the
      // refused quote against the day's cash cap while it waits for the operator.
      if (gate?.ok !== true) return { sent: false, observed: false, pressed: false, reason: 'gate result missing or not ok' };
      if (!dryRun && allowSpendCash !== true) return { sent: false, observed: false, pressed: false, reason: 'quote spends 숨고캐시; allowSpendCash was not given' };
      if (!Number.isInteger(amountKRW) || amountKRW <= 0) return { sent: false, observed: false, pressed: false, reason: 'amountKRW must be a positive integer' };
      if (!squash(text)) return { sent: false, observed: false, pressed: false, reason: 'empty text' };
      await s.navigate(`${BASE}/requests/received/${encodeURIComponent(id)}?from=request_list`);
      const before = await s.evaluate(pageRequestDetail, String(id));
      const detail = parseRequestDetail({ id, ...before });
      const f = detail.quoteForm;
      if (!f.priceInput || !f.textarea || !f.sendButton) return { sent: false, observed: false, pressed: false, reason: 'quote form incomplete', form: f };
      if (detail.quoteCostKRW == null) return { sent: false, observed: false, pressed: false, reason: 'quote cost not readable from the send button' };
      if (before.form.saveTemplateChecked) return { sent: false, observed: false, pressed: false, reason: '자주 쓰는 견적에 추가 is checked; refusing to change templates' };
      const wanted = priceType === 'hourly' ? 'price-hourly' : 'price-total';
      if (before.form.selectedPriceType !== (priceType === 'hourly' ? '시간 당' : '총 비용')) await s.click(`[data-fsw=${wanted}]`);
      // The price input reformats with thousand separators as it types, which fill() cannot follow.
      await s.typeKeys('[data-fsw=quote-price]', String(amountKRW));
      await s.fill('[data-fsw=quote-text]', text);
      const typed = await s.evaluate(pageRequestDetail, String(id));
      const priceOk = (typed.form.priceValue ?? '').replace(/\D/g, '') === String(amountKRW);
      const textOk = squash(typed.form.textValue) === squash(text);
      const clear = async () => {
        await s.typeKeys('[data-fsw=quote-price]', '');
        await s.fill('[data-fsw=quote-text]', '');
        return s.evaluate(pageRequestDetail, String(id));
      };
      if (dryRun || !priceOk || !textOk) {
        const cleared = await clear();
        // An emptied price input falls back to "0".
        const report = { costKRW: detail.quoteCostKRW, priceTyped: priceOk, textTyped: textOk, sendEnabledWhenFilled: !typed.form.sendDisabled, cleared: !cleared.form.priceValue.replace(/[0,]/g, '') && !cleared.form.textValue };
        return dryRun ? { sent: false, observed: false, pressed: false, dryRun: true, ...report } : { sent: false, observed: false, pressed: false, reason: 'the form did not hold the typed values', ...report };
      }
      if (typed.form.sendDisabled) return { sent: false, observed: false, pressed: false, reason: 'send button disabled after filling', costKRW: detail.quoteCostKRW };
      s.guard.beforeMessage();
      const pressedAt = Date.now();
      await s.click('[data-fsw=quote-send]');
      await sleep(5000);
      // Observable result: 충전/사용 내역 lists the charge as "견적 발송 - <customer>" to the second, with
      // its exact cost. 보낸견적 is not the record: on 2026-10-26 it listed one of three quotes sent that
      // minute, and it prints today's rows with a time where a date was expected. A free quote leaves no
      // charge, so it counts when the request page no longer offers the send button.
      const after = await s.evaluate(pageRequestDetail, String(id));
      let rows = [];
      let charge = null;
      for (let i = 0; i < 4 && detail.quoteCostKRW > 0 && !charge; i++) {
        if (i) await sleep(2000);
        await s.navigate(`${BASE}/mypage/cash-dashboard`);
        rows = parseCashHistory(await s.evaluate(pageText));
        charge = quoteCharge(rows, { since: pressedAt, customer });
      }
      if (charge) return { sent: true, observed: true, cashSpentKRW: -charge.amountKRW, text, observedSnippet: charge.at + ' ' + charge.customer };
      if (detail.quoteCostKRW === 0 && !after.form.sendLabel) return { sent: true, observed: true, cashSpentKRW: 0, text, observedSnippet: 'send button gone' };
      // A request that already holds its quota of quotes shows a notice with a 확인 button in place of taking
      // the quote, with no charge (observed 2026-10-26). The same line can follow a
      // quote that went out as the tenth, so it counts only when the cash history shows no charge for this
      // press; otherwise the press stays unobserved and counted on the day.
      if (after.full) return { sent: false, observed: false, pressed: false, code: REQUEST_FULL, reason: 'soomgo took no quote: ' + after.full + ' and 충전/사용 내역 shows no charge for it' };
      const top = rows[0];
      return { sent: false, observed: false, pressed: true, reason: 'the quote charge was not observed in 충전/사용 내역: ' + (top ? 'newest row ' + [top.what, top.customer, top.at].join(' ') : 'no dated row'), costKRW: detail.quoteCostKRW };
    },

    async inbox({ pages = 0 } = {}) {
      return parseChats(await listChats({ pages }));
    },

    async readThread(id, { willReply = false } = {}) {
      const { row, unread, page } = await openChat(id, { willReply });
      return { ...parseChatThread({ id: String(id), url: page.url, customer: row.customer, items: page.items, composer: page.composer }), wasUnread: unread };
    },

    // dryRun types into the composer, looks for the send button, then clears the composer.
    async send(id, { text, files = [], gate, dryRun = false } = {}) {
      if (gate?.ok !== true) return { sent: false, observed: false, reason: 'gate result missing or not ok' };
      if (!squash(text)) return { sent: false, observed: false, reason: 'empty text' };
      const { page } = await openChat(id, { willReply: true });
      if (!page.composer.found || page.composer.disabled) return { sent: false, observed: false, reason: 'composer unavailable' };
      if (!dryRun) s.guard.beforeMessage();
      await s.fill('[data-fsw=composer]', text);
      if (files.length) await s.setFiles('input.file-input-hidden[type=file]', files);
      const typed = await s.evaluate(pageChatThread);
      const textOk = squash(typed.composer.value) === squash(text);
      if (dryRun || !textOk || !typed.composer.sendButton) {
        await s.fill('[data-fsw=composer]', '');
        const cleared = await s.evaluate(pageChatThread);
        const report = { typed: textOk, sendButton: typed.composer.sendButton, sendDisabled: typed.composer.sendDisabled, cleared: cleared.composer.value === '' };
        return dryRun ? { sent: false, observed: false, dryRun: true, ...report } : { sent: false, observed: false, reason: textOk ? 'send button not found' : 'the composer did not hold the typed text', ...report };
      }
      await s.click('[data-fsw=send]');
      await wait(4000);
      const after = await s.evaluate(pageChatThread);
      const last = after.items.filter((m) => m.kind === 'text' && m.outbound).at(-1);
      const observed = !!last && squash(last.text).includes(squash(text).slice(0, 60));
      const snip = last ? squash(last.text).slice(0, 80) : null;
      return observed ? { sent: true, observed: true, observedSnippet: snip, text } : { sent: false, observed: false, reason: 'the sent text was not observed in the chat', observedSnippet: snip };
    },

    // 숨고 has no order list; a hire shows as the chat's status.
    async orders({ pages = 0 } = {}) {
      return (await adapter.inbox({ pages })).filter((c) => c.status === 'hired' || c.hired);
    },

    // 숨고페이 요청: opens the dialog from the chat header, types the amount and checks that the dialog holds
    // it and enables 거래 요청하기. dryRun (and any mismatch) closes the dialog with its Close button and
    // reports whether it closed. A real request needs approved true, the operator's approval of this
    // exact amount, and is observed only when the chat shows the 거래를 요청했어요 line with that amount.
    // A dry run opens only a chat with no new messages.
    async payRequest(id, { amountKRW, approved = false, dryRun = false } = {}) {
      if (!Number.isInteger(amountKRW) || amountKRW < PAY_REQUEST_RANGE[0] || amountKRW > PAY_REQUEST_RANGE[1]) {
        return { sent: false, observed: false, reason: 'amountKRW must be an integer from ' + PAY_REQUEST_RANGE.join(' to ') };
      }
      if (!dryRun && approved !== true) return { sent: false, observed: false, reason: '숨고페이 요청 asks the customer for money; it needs an approved operator item' };
      const { page: before } = await openChat(id, { willReply: !dryRun });
      const priorNotices = parseChatThread({ id: String(id), items: before.items }).notices.length;
      if (!(await s.evaluate(pageOpenPayDialog))) return { sent: false, observed: false, reason: 'the chat header has no 숨고페이 요청 button' };
      await wait(3000);
      const opened = await s.evaluate(pagePayDialog);
      if (!opened.open || !opened.amountInput || !opened.confirmFound) return { sent: false, observed: false, reason: 'the 숨고페이 dialog did not show its amount input and confirm control', dialog: opened };
      // The amount input reformats with separators as it types, which fill() cannot follow, and the
      // dialog validates on blur: 거래 요청하기 stays disabled until focus leaves the input.
      await s.typeKeys('[data-fsw=pay-amount]', String(amountKRW));
      await s.press('Tab');
      await wait(1500);
      const typed = await s.evaluate(pagePayDialog);
      const amountOk = typed.amountValue.replace(/\D/g, '') === String(amountKRW) && String(typed.hiddenAmount ?? '').replace(/\D/g, '') === String(amountKRW);
      const report = { title: opened.title, confirmDisabledEmpty: opened.confirmDisabled, amountTyped: amountOk, hiddenAmount: typed.hiddenAmount, confirmEnabledFilled: !typed.confirmDisabled };
      if (dryRun || !amountOk || typed.confirmDisabled) {
        await s.click('[data-fsw=pay-close]');
        await wait(1500);
        const closed = !(await s.evaluate(pagePayDialog)).open;
        const out = { sent: false, observed: false, ...report, closed };
        return dryRun ? { ...out, dryRun: true } : { ...out, reason: amountOk ? 'the confirm control stayed disabled' : 'the dialog did not hold the typed amount' };
      }
      s.guard.beforeMessage();
      await s.click('[data-fsw=pay-confirm]');
      await wait(5000);
      // Observable result: a new platform line saying the request reached the customer, with this amount.
      // Gap: no real request has been sent yet, so whether 숨고 shows a second confirm step after
      // 거래 요청하기 is unknown; a dialog still open here is reported as unobserved for the operator.
      const after = await s.evaluate(pageChatThread);
      const dialog = await s.evaluate(pagePayDialog);
      const fresh = parseChatThread({ id: String(id), items: after.items }).notices.slice(priorNotices);
      const line = fresh.find((n) => /거래를\s*요청했어요/.test(n.text) && n.text.replace(/\D/g, '').includes(String(amountKRW)));
      return line
        ? { sent: true, observed: true, ...report, observedSnippet: line.text.slice(0, 120) }
        : { sent: false, observed: false, ...report, reason: dialog.open ? 'the dialog is still open after 거래 요청하기' : 'no 거래 요청 line with the amount appeared in the chat', dialogOpen: dialog.open };
    },

    async profile() {
      await s.navigate(`${BASE}/profile`);
      const profile = parseProfile(await s.evaluate(() => document.body.innerText));
      const login = await adapter.login();
      return { profile, cash: login.cash };
    },

    // Offered services with whether their request items are set (src/platforms/soomgo/services.mjs).
    services: () => readServices(s),

    // Every path soomgo spends the account's cash on, one page each: today's charges by source from
    // 충전/사용 내역 and each smart quote campaign with its daily budget from /instant-match.
    async spend({ now = new Date() } = {}) {
      await s.navigate(`${BASE}/mypage/cash-dashboard`);
      const today = cashSpend(parseCashHistory(await s.evaluate(pageText)), seoulDay(now));
      await s.navigate(`${BASE}/instant-match`);
      return { today, campaigns: parseCampaigns(await s.evaluate(pageCampaignLinks)) };
    },

    stop: () => s.stop(),
  };
  return adapter;
}
