// The page-side extractors src/platforms/soomgo/adapter.mjs serialises into 숨고 pages; each closes over no
// module value, since it runs in the browser.
export function pageLogin() {
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

export function pageRequests() {
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

export function pageRequestDetail(id) {
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

export function pageChats() {
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

export async function pageScrollChats() {
  const as = document.querySelectorAll('a[href^="/pro/chats/"]');
  as[as.length - 1]?.scrollIntoView();
  await new Promise((r) => setTimeout(r, 2500));
  return document.querySelectorAll('a[href^="/pro/chats/"]').length;
}

export function pageOpenChat(id) {
  const a = document.querySelector(`a[href^="/pro/chats/${id}?"]`);
  if (!a) return false;
  a.click();
  return true;
}

export function pageChatThread() {
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

export function pageText() {
  return document.body.innerText;
}

// An announcement modal soomgo opens over a page (서비스 점검 사전 안내, read 2026-10-29 on every request
// page) holds focus, so no field under it can be typed into. One that shows and holds no field, only buttons,
// is closed by its 닫기 button; a modal with a field, such as the 숨고페이 dialog, is never touched.
export function pageCloseNotice() {
  const modal = [...document.querySelectorAll('.modal.show')].find((m) => m.getBoundingClientRect().height > 0 && !m.querySelector('input:not([type=checkbox]), textarea, select'));
  const close = modal && [...modal.querySelectorAll('button')].find((b) => b.innerText.trim() === '닫기');
  if (!close) return null;
  close.click();
  return modal.innerText.split('\n')[0].trim();
}

// The smart quote campaign links on /instant-match, as href and text only.
export function pageCampaignLinks() {
  return [...document.querySelectorAll('a[href^="/instant-match/"]')].map((a) => ({ href: a.getAttribute('href'), text: a.innerText }));
}

// The 숨고페이 요청 dialog (a Bootstrap modal .safe-payment-modal, read 2026-10-25): a tel amount input
// (maxLength 11) mirrored into a hidden safePaymentAmount, date radios, a Close button and the confirm
// 거래 요청하기, disabled until an amount is typed.
export function pagePayDialog() {
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

export function pageOpenPayDialog() {
  const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '숨고페이 요청');
  if (!b) return false;
  b.click();
  return true;
}
