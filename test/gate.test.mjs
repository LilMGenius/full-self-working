import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateOutbound } from '../src/policy/gate.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';

const instance = {
  profile: { approvedClaims: [], claimsNotToMake: ['대기업 출신'] },
  business: { payout: { bank: '예시은행', account: '123-456-789012', holder: '홍길동' } },
};
const ko = { stage: 'pre_order', lastInboundText: '랜딩 페이지 제작 가능한가요?' };
const run = (platform, text, { kind = 'message', thread = ko, inst = instance, amountKRW, priceRow, lessonsRules } = {}) =>
  gateOutbound({ platform, kind, text, thread, amountKRW }, { descriptor: loadDescriptor(platform), instance: inst, priceRow, lessonsRules });
const rules = (r) => r.violations.map((v) => v.rule);

test('a phone number with spaces is blocked on kmong before an order', () => {
  const r = run('kmong', '편하게 010 1234 5678 로 연락 주세요');
  assert.equal(r.ok, false);
  assert.ok(rules(r).includes('contact.phone'));
});

test('the payout account without hyphens is blocked on kmong', () => {
  const r = run('kmong', '123456789012 으로 보내 주시면 됩니다', { thread: { ...ko, stage: 'quote_accepted' } });
  assert.deepEqual(rules(r), ['payment.account']);
});

test('the payout account is released on soomgo only after the quote is accepted', () => {
  const text = '예시은행 계좌 123-456-789012 (예금주 홍길동)로 보내 주시면 바로 시작하겠습니다.';
  assert.equal(run('soomgo', text, { thread: { ...ko, stage: 'quote_accepted' } }).ok, true);
  assert.ok(rules(run('soomgo', text)).includes('payment.account'));
});

test('off-platform payment wording is blocked on kmong', () => {
  assert.ok(rules(run('kmong', '계좌이체로 진행하시면 더 저렴합니다')).includes('payment.offplatform'));
  assert.equal(run('kmong', '추가 수수료 없이 수정 2회 포함입니다').ok, true);
});

test('experience claims need an approved entry', () => {
  assert.ok(rules(run('kmong', '10년 경력의 개발자입니다')).includes('claims.unapproved'));
  const approvedInst = { ...instance, profile: { ...instance.profile, approvedClaims: ['10년 경력'] } };
  assert.equal(run('kmong', '10년 경력의 개발자입니다', { inst: approvedInst }).ok, true);
  assert.equal(run('kmong', '선금 50%, 잔금 50%로 진행합니다').ok, true);
  assert.ok(rules(run('kmong', '저는 대기업 출신입니다')).includes('claims.forbidden'));
});

test('a Korean reply to an English inbound is blocked', () => {
  const r = run('kmong', '네, 가능합니다. 일정 알려 주세요.', { thread: { stage: 'pre_order', lastInboundText: 'Hi, can you build a landing page for my store?' } });
  assert.deepEqual(rules(r), ['shape.language']);
});

test('URLs pass only for the platform host', () => {
  assert.equal(run('kmong', '포트폴리오는 https://kmong.com/gig/123 에서 보실 수 있습니다').ok, true);
  assert.ok(rules(run('kmong', '자세한 건 example.com 참고해 주세요')).includes('contact.url'));
  assert.equal(run('kmong', 'Node.js와 ASP.NET 모두 다룹니다').ok, true);
});

test('messenger IDs are blocked while messenger bot services pass', () => {
  assert.ok(rules(run('kmong', '텔레그램 아이디 알려 드릴게요')).includes('contact.messenger'));
  assert.ok(rules(run('kmong', '카톡 아이디 남겨 주세요')).includes('contact.messenger'));
  assert.equal(run('kmong', '텔레그램 봇 개발도 가능합니다').ok, true);
});

test('price, slop, length and learned rules apply', () => {
  const priceRow = { floorKRW: 100000, ceilingKRW: 500000 };
  assert.ok(rules(run('kmong', '견적 드립니다', { kind: 'quote', amountKRW: 50000, priceRow })).includes('price.range'));
  assert.equal(run('kmong', '견적 드립니다', { kind: 'quote', amountKRW: 300000, priceRow }).ok, true);
  assert.ok(rules(run('kmong', '빠르게\u2014정확하게 작업합니다')).includes('slop.em_dash'));
  assert.ok(rules(run('kmong', '가'.repeat(20001), { kind: 'listing' })).includes('shape.length'));
  const lessonsRules = [{ id: 'no-rush', pattern: '당일\\s*완성', reason: 'same-day promises led to revisions', tier: 'floor' }];
  assert.deepEqual(rules(run('kmong', '당일 완성 가능합니다', { lessonsRules })), ['learned.no-rush']);
});

test('wishket blocks the operator names and trade names, and kmong does not', () => {
  const named = {
    ...instance,
    profile: {
      ...instance.profile,
      person: { nameKo: '홍길동', nameEn: 'Gildong Hong', handle: 'gildong' },
      roles: [{ org: 'Example Studio', org_ko: '예시스튜디오 (Example Studio)', title: 'Founder/CEO' }, { org: '예시전자', title: 'AI Engineer' }, { org: 'Independent', org_ko: '프리랜서', title: 'Instructor' }],
    },
    business: { ...instance.business, company: '예시상사' },
  };
  const wishket = (text, attachments) => gateOutbound({ platform: 'wishket', kind: 'proposal', text, attachments, thread: { stage: 'pre_order' } }, { descriptor: loadDescriptor('wishket'), instance: named });
  for (const text of ['안녕하세요, 홍길동입니다.', 'GILDONG HONG drafted this plan.', '깃허브 gildong 계정의 저장소를 참고해 주세요.', '예시상사에서 진행합니다.', '예시스튜디오를 운영하며 쌓은 경험입니다.', 'Example  Studio built the admin.']) {
    assert.ok(rules(wishket(text)).includes('identity.name'), text);
  }
  assert.ok(rules(wishket('첨부를 확인해 주세요.', ['예시상사_포트폴리오.pdf'])).includes('identity.name'), 'an attachment name is scanned too');
  for (const text of ['예시전자 같은 대기업 경험은 적지 않겠습니다.', '프리랜서로 일하며 만든 관리자 화면입니다.', 'gildongs and 길동무 are other words.']) {
    assert.ok(!rules(wishket(text)).includes('identity.name'), text);
  }
  assert.ok(!rules(run('kmong', '안녕하세요, 홍길동입니다.', { inst: named })).includes('identity.name'));
});
