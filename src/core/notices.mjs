// The one classifier of platform notices, the lines a marketplace writes into a chat itself. A money
// notice (a hire, a payment, a confirmation) changes the order's state and is recorded by
// the deal (src/deal/signals.mjs); a noise notice (a read receipt, a cash refund) needs nothing. Neither is
// a customer message, so neither is answered. Patterns are the texts read from real chats on 2026-10-25;
// the soomgo chat also stamps a message type (SP_ST_002, SB_201, ST_001) that the adapter passes along as
// type. Carried from src/orders/notices.mjs at 2c77326 into core, so triage, the brain, the outbox and the
// deal share one classifier.

// event: what the notice says happened; amount: where the KRW figure sits in that notice's text. The chat
// list prints a platform line without its title, so each pattern also matches the body alone.
export const MONEY_NOTICES = [
  // soomgo hire: the customer hired me (old chats), or the hire I requested was confirmed (SB_201, whose
  // body is the deadline for cancelling it).
  { event: 'hired', re: /고객님께서\s*고수님을\s*고용했어요|고용이\s*확정(?:됐어요|되었습니다)|까지\s*고용을\s*취소할\s*수\s*있습니다/ },
  // soomgo hire withdrawn by the customer or refused; "고용을 취소할 수 있습니다" on a confirmed hire is not one.
  { event: 'hire_cancelled', re: /고용이\s*취소(?:됐|되었)|다시\s*진행을\s*원하시면[\s\S]*고용을\s*요청해/ },
  // soomgo pay: my request reached the customer.
  { event: 'pay_requested', re: /숨고페이[\s\S]*고객에게\s*거래를\s*요청했어요|고객이\s*결제를\s*완료하면\s*서비스를\s*진행해\s*주세요/, amount: /서비스\s*금액\s*:?\s*([\d,]+)/ },
  // soomgo pay: the customer paid and soomgo holds the money (the 결제 완료 state).
  { event: 'paid', re: /고객이\s*결제한\s*금액을\s*숨고가\s*안전하게\s*보관|숨고페이\s*결제(?:가)?\s*완료|협의한\s*날짜와\s*금액이\s*맞는지\s*확인해\s*주세요/, amount: /서비스\s*금액\s*:?\s*([\d,]+)/ },
  // soomgo pay: the customer confirmed the deal (거래확정), which releases the held payment.
  { event: 'confirmed', re: /거래가\s*확정(?:됐어요|되었습니다)|거래\s*확정(?:이)?\s*(?:됐|되었|완료)|원이\s*고수님\s*계좌로\s*안전하게\s*입금됩니다/, amount: /([\d,]+)\s*원이\s*고수님\s*계좌로/ },
  // soomgo pay: the released payment reached the payout account.
  { event: 'remitted', re: /입금\s*완료되었습니다|정산(?:이)?\s*완료되었|다음에\s*또\s*숨고페이를\s*이용해보세요[\s\S]*정산\s*금액/, amount: /정산\s*금액\s*:?\s*([\d,]+)/ },
  { event: 'pay_cancelled', re: /숨고페이\s*결제(?:가)?\s*취소|거래(?:가)?\s*취소(?:됐|되었)/ },
  // kmong order notices (the order chat's own wording; no kmong order was observed yet).
  { event: 'ordered', re: /주문이\s*접수되었/ },
  { event: 'order_cancelled', re: /주문이\s*취소되었/ },
  { event: 'confirmed', re: /구매\s*확정(?:이|을)?\s*(?:되었|하였|했습니다|완료)|주문이\s*완료되었/ },
  { event: 'review', re: /(?:리뷰|후기)가\s*(?:등록|작성)되었/ },
];

// Notices that need no reply and change nothing.
export const NOISE_NOTICES = [
  /고객(?:님)?이\s*\d+\s*시간\s*동안\s*견적(?:서)?[을를]?\s*읽지\s*않/,
  /견적(?:서)?[을를]?\s*(?:읽었어요|읽었습니다|확인했어요|확인했습니다|조회하였습니다)/,
  /견적(?:서)?\s*(?:열람|확인)\s*알림/,
  /(?:채팅|대화)(?:방)?이\s*종료되었/,
  /님이\s*채팅방을\s*나갔습니다/,
  /고객에게\s*고용을\s*요청했어요|고용이\s*확정되면\s*바로\s*알려드릴게요/,
  /리뷰를\s*요청해\s*보세요|리뷰\s*작성이\s*완료되면\s*알려|감사\s*인사와\s*함께\s*리뷰\s*요청하고/,
  /자동\s*(?:견적|응답)\s*(?:으로|이)\s*(?:발송|전송)/,
  // soomgo safety banners and an old escrow prompt.
  /보이스피싱\s*피해가\s*발생할\s*수|직접\s*거래는\s*사기나\s*피싱\s*위험|휴대폰\s*번호\s*또는\s*계좌번호를\s*공유\s*받으셨나요/,
  /서비스\s*마감일과\s*금액을\s*작성해\s*주세요/,
];

// soomgo stamps platform lines with a type code; a plain text bubble has none and a quote card is ST_QUOTE.
export const isPlatformType = (type) => typeof type === 'string' && /^[A-Z]{2}_[A-Z0-9_]+$/.test(type) && type !== 'ST_QUOTE';

export const parseAmount = (s) => {
  const n = Number.parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// {text, type} -> {class: 'money', event, amountKRW} | {class: 'noise'} | null (a person wrote it).
export function classifyNotice({ text, type } = {}) {
  const t = String(text ?? '').trim();
  for (const n of MONEY_NOTICES) {
    if (!n.re.test(t)) continue;
    const m = n.amount ? n.amount.exec(t) : null;
    return { class: 'money', event: n.event, amountKRW: m ? parseAmount(m[1]) : null };
  }
  if (NOISE_NOTICES.some((re) => re.test(t)) || isPlatformType(type)) return { class: 'noise' };
  return null;
}

// Notices the platform writes into the chat itself need no reply; answering one would spend a message
// on nobody. Moved from src/brain/respond.mjs:21-27 so triage, the brain and the outbox share it.
export function isSystemNotice(message) {
  if (message?.system === true) return true;
  const text = String(message?.text ?? message?.body ?? '').trim();
  return text.length > 0 && classifyNotice({ text, type: message?.noticeType }) !== null;
}

