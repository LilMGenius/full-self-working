import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addService, parseItemModal, parseServiceRows, planItems } from '../src/platforms/soomgo/services.mjs';

// Synthetic snapshot text in the shape the BrowserSkill snapshot prints for /profile/services.
const PAGE = [
  'L1 page',
  '  RootWebArea "services"',
  '    main "offered services"',
  '      heading "제공 서비스"',
  '        listitem "프로그래밍/코딩 레슨 세부 항목 설정됨"',
  '          @e13 button "프로그래밍/코딩 레슨 세부 항목 설정됨"',
  '          @e14 button',
  '          @e15 button',
  '        listitem "웹 개발 항목 미설정"',
  '          @e16 button "웹 개발 항목 미설정"',
  '          @e17 button',
  '      @e40 button "서비스 추가"',
].join('\n');

const MODAL = [
  '@layers 2 focus=L1',
  'L1 modal cover=100%',
  '  heading "챗봇 개발"',
  '  @e1 button',
  '  heading "세부 항목을 선택해 주세요"',
  '  heading "어떤 플랫폼에서 사용하실 건가요?"',
  '  @e2 checkbox "카카오톡" [ctx: 어떤 플랫폼에서 사용하실 건가요?] [checked] ="1"',
  '  LabelText "카카오톡"',
  '    @e3 button "카카오톡"',
  '  @e4 checkbox "텔레그램" [ctx: 어떤 플랫폼에서 사용하실 건가요?] [unchecked] ="2"',
  '  heading "챗봇 형태를 선택해주세요."',
  '  @e18 checkbox "텍스트형" [unchecked] ="1"',
  '  @e22 checkbox "고수와 상담 후 결정할게요." [unchecked] ="3"',
  '  @e24 button "저장하기" [disabled]',
  'L2 page … occluded by L1 (~175 nodes, not actionable)',
  '  @e90 checkbox "숨은 항목" [unchecked]',
].join('\n');

test('service rows read every offered service with its item state and skip the unlabeled icons', () => {
  assert.deepEqual(parseServiceRows(PAGE), [
    { ref: '@e13', name: '프로그래밍/코딩 레슨', itemsSet: true },
    { ref: '@e16', name: '웹 개발', itemsSet: false },
  ]);
});

test('the item modal groups checkboxes under their headings and stops at the next layer', () => {
  const modal = parseItemModal(MODAL);
  assert.equal(modal.title, '챗봇 개발');
  assert.deepEqual(modal.groups.map((g) => [g.heading, g.options.map((o) => [o.label, o.checked])]), [
    ['어떤 플랫폼에서 사용하실 건가요?', [['카카오톡', true], ['텔레그램', false]]],
    ['챗봇 형태를 선택해주세요.', [['텍스트형', false], ['고수와 상담 후 결정할게요.', false]]],
  ]);
  assert.deepEqual(modal.save, { ref: '@e24', disabled: true });
  assert.equal(parseItemModal(PAGE), null);
});

test('the plan ticks only unchecked wanted items and names every wanted item the modal lacks', () => {
  const modal = parseItemModal(MODAL);
  const plan = planItems(modal, {
    '어떤 플랫폼에서 사용하실 건가요?': ['카카오톡', '텔레그램', '라인'],
    '챗봇 형태를 선택해주세요.': ['고수와 상담 후 결정할게요.'],
    '없는 질문': ['아무거나'],
  });
  assert.deepEqual(plan.clicks, [
    { heading: '어떤 플랫폼에서 사용하실 건가요?', label: '텔레그램' },
    { heading: '챗봇 형태를 선택해주세요.', label: '고수와 상담 후 결정할게요.' },
  ]);
  assert.deepEqual(plan.missing, [
    { heading: '어떤 플랫폼에서 사용하실 건가요?', label: '라인' },
    { heading: '없는 질문', label: '아무거나' },
  ]);
});

test('a label repeated in two groups is matched only inside the wanted group', () => {
  const modal = parseItemModal(MODAL.replace('"텍스트형"', '"카카오톡"'));
  const plan = planItems(modal, { '챗봇 형태를 선택해주세요.': ['카카오톡'] });
  assert.deepEqual(plan.clicks, [{ heading: '챗봇 형태를 선택해주세요.', label: '카카오톡' }]);
});

// A page model of the add-service modal as measured on 2026-10-25: a service button only marks the
// service, and 등록하기 registers every marked one. Page functions run against a minimal document.
function addServicePage(offered) {
  const state = { offered: [...offered], modal: null, marked: new Set() };
  const button = (label, click) => ({ innerText: label, disabled: false, getBoundingClientRect: () => ({ width: 40, height: 20 }), click });
  const buttons = () => {
    if (!state.modal) return [button('서비스 추가', () => { state.modal = 'tabs'; })];
    if (state.modal === 'tabs') return [button('외주', () => { state.modal = '외주'; })];
    return [
      button('데이터 크롤링', () => state.marked.add('데이터 크롤링')),
      button('등록하기', () => { state.offered.push(...state.marked); state.marked.clear(); state.modal = null; }),
    ];
  };
  const session = {
    navigate: async () => { state.modal = null; state.marked.clear(); },
    snapshot: async () => state.offered.map((name, i) => '@e' + (i + 1) + ' button "' + name + ' 항목 미설정"').join('\n'),
    evaluate: async (fn, arg) => {
      globalThis.document = { querySelectorAll: (selector) => (selector === 'button' ? buttons() : []) };
      try { return fn(arg); } finally { delete globalThis.document; }
    },
  };
  return { state, session };
}

test('adding a service marks it and registers it, and a dry run registers nothing', async () => {
  const wait = async () => {};
  const dry = addServicePage(['웹 개발']);
  assert.deepEqual(await addService(dry.session, '데이터 크롤링', { dryRun: true, wait }), { name: '데이터 크롤링', changed: true, saved: false, dryRun: true });
  assert.deepEqual(dry.state.offered, ['웹 개발']);
  const real = addServicePage(['웹 개발']);
  assert.deepEqual(await addService(real.session, '데이터 크롤링', { wait }), { name: '데이터 크롤링', changed: true, saved: true });
  assert.deepEqual(real.state.offered, ['웹 개발', '데이터 크롤링']);
  assert.deepEqual(await addService(real.session, '데이터 크롤링', { wait }), { name: '데이터 크롤링', changed: false });
});

