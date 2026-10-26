import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNotice, isSystemNotice } from '../src/core/notices.mjs';

// The soomgo pay lines as an opened chat prints them (2026-10-25), with a made-up amount.
const NOTICE = {
  requested: '숨고페이\n고객에게 거래를 요청했어요\n고객이 요청을 확인하고 있어요. 고객이 결제를 완료하면 서비스를 진행해 주세요.\n\n서비스명: 웹 개발\n서비스 진행일: 2026.10.20(화)\n서비스 금액: 300,000원',
  paid: '숨고페이\n고객이 결제한 금액을 숨고가\n안전하게 보관하고 있어요\n협의한 날짜와 금액이 맞는지 확인해 주세요.\n\n서비스명: 웹 개발\n서비스 금액: 300,000원\n정산 예정 금액: 300,000원',
  confirmed: '숨고페이\n거래가 확정됐어요\n정산정보가 올바른지 확인해 주세요. 고수 인증 후, 1시간 이내에 300,000원이 고수님 계좌로 안전하게 입금됩니다.',
  remitted: '숨고페이\n입금 완료되었습니다\n고객과 거래가 만족스러웠다면 다음에 또 숨고페이를 이용해보세요.\n\n정산계좌: 예시은행 ****0000\n정산금액: 300,000원',
  hired: '숨고 알리미\n고용이 확정됐어요\n10월 24일 (금) 오전 10:00분까지\n고용을 취소할 수 있습니다.',
};

test('money notices are told apart from noise and from customer text, with their amounts', () => {
  assert.deepEqual(classifyNotice({ text: NOTICE.paid }), { class: 'money', event: 'paid', amountKRW: 300000 });
  assert.deepEqual(classifyNotice({ text: NOTICE.requested }), { class: 'money', event: 'pay_requested', amountKRW: 300000 });
  assert.deepEqual(classifyNotice({ text: NOTICE.confirmed }), { class: 'money', event: 'confirmed', amountKRW: 300000 });
  assert.deepEqual(classifyNotice({ text: NOTICE.remitted }), { class: 'money', event: 'remitted', amountKRW: 300000 });
  assert.equal(classifyNotice({ text: NOTICE.hired }).event, 'hired');
  // The list row prints a line without its title.
  assert.equal(classifyNotice({ text: '고객과 거래가 만족스러웠다면 다음에 또 숨고페이를 이용해보세요.\n\n정산금액: 30,000원' }).event, 'remitted');
  assert.equal(classifyNotice({ text: '고객이 48시간 동안 견적을 읽지 않아서 견적 발송에 사용된 1990캐시를 보너스 캐시로 보상해드렸습니다.' }).class, 'noise');
  assert.equal(classifyNotice({ text: '고객님이 견적을 조회하였습니다' }).class, 'noise');
  assert.equal(classifyNotice({ text: '아무 텍스트', type: 'RQ_001' }).class, 'noise');
  assert.equal(classifyNotice({ text: '결제는 언제 하면 될까요?' }), null);
  assert.equal(classifyNotice({ text: '견적 금액 300,000원 괜찮을까요?' }), null);
});

test('an unread-quote notice is a system notice and a customer question is not', () => {
  assert.equal(isSystemNotice({ text: '고객이 48시간 동안 견적을 읽지 않아 숨고캐시를 돌려드렸어요.' }), true);
  assert.equal(isSystemNotice({ text: '견적을 읽었어요' }), true);
  assert.equal(isSystemNotice({ system: true, text: '' }), true);
  assert.equal(isSystemNotice({ text: '수정은 몇 번까지 되나요?' }), false);
  assert.equal(isSystemNotice({ text: '   ' }), false);
});
