// The delivery message, carried verbatim from src/orders/delivery.mjs:29-44 at 2c77326. It asks the
// client for portfolio permission (architect D4 row delivery_observed).
export function deliveryText({ language, files }) {
  const names = files.map((f) => f.split('/').pop());
  if (language === 'en') {
    return [
      'Hello. The finished work is attached: ' + names.join(', ') + '.',
      'Please look it over and tell me if anything should change.',
      'May I show this work in my portfolio? I would show the result only, without your name or details. If you would rather not, just say so.',
    ].join('\n');
  }
  return [
    '안녕하세요. 요청하신 작업 결과물을 첨부해 드립니다.',
    '첨부 파일: ' + names.join(', '),
    '확인해 보시고 고칠 부분이 있으면 말씀해 주세요.',
    '이번 작업물을 제 포트폴리오에 소개해도 괜찮을까요? 고객님 정보는 빼고 결과물만 보여 드립니다. 원하지 않으시면 편하게 말씀해 주세요.',
  ].join('\n');
}
