import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addService, pageItemModal, pageServiceRows, planItems, readServices, setServiceItems } from '../src/platforms/soomgo/services.mjs';

// Synthetic snapshot text in the shape the BrowserSkill snapshot printed for /profile/services and the
// item modal. The reads are DOM queries now; these fixtures are replayed as a page model (pageOf below)
// whose buttons, headings, checkboxes and labels are the elements the snapshot named, so the DOM reads must
// give what the snapshot parse gave.
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

// A minimal document: elements with the selectors the page functions use.
function el(tagName, { text = '', id = null, checked = false, disabled = false, role = null, htmlFor = null, children = [] } = {}) {
  const e = { tagName, id, checked, disabled, role, htmlFor, children, attrs: {}, parentElement: null, clicks: 0 };
  e.innerText = text || children.map((c) => c.innerText).filter(Boolean).join('\n');
  for (const c of children) c.parentElement = e;
  e.getBoundingClientRect = () => ({ width: 40, height: 20 });
  e.setAttribute = (k, v) => { e.attrs[k] = v; };
  e.getAttribute = (k) => e.attrs[k] ?? null;
  e.click = () => { e.clicks += 1; };
  const all = () => e.children.flatMap((c) => [c, ...c.all()]);
  e.all = all;
  e.querySelectorAll = (selector) => all().filter((c) => selector.split(',').some((s) => matches(c, s.trim())));
  e.querySelector = (selector) => e.querySelectorAll(selector)[0] ?? null;
  return e;
}
function matches(e, s) {
  if (s === '[role=heading]') return e.role === 'heading';
  if (s === '[role=button]') return e.role === 'button';
  if (s === 'input[type=checkbox]') return e.tagName === 'INPUT';
  const label = s.match(/^label\[for="(.*)"\]$/);
  if (label) return e.tagName === 'LABEL' && e.htmlFor === label[1];
  const mark = s.match(/^\[([a-z-]+)="(.*)"\]$/);
  if (mark) return e.attrs[mark[1]] === mark[2];
  return e.tagName === s.toUpperCase();
}

// The snapshot fixture as elements: a modal layer becomes one box, the occluded page behind it another.
function pageOf(snapshot) {
  const layers = [];
  let box = null;
  for (const line of snapshot.split('\n')) {
    if (/^L\d+ /.test(line)) {
      box = [];
      layers.push(box);
      continue;
    }
    if (!box) continue;
    const h = line.match(/^\s*heading "(.+)"\s*$/);
    const b = line.match(/^\s*@e\d+ button(?: "(.+?)")?( \[disabled\])?\s*$/);
    const c = line.match(/^\s*@e(\d+) checkbox "(.+?)"(?: \[ctx:.*?\])? \[(checked|unchecked)\]/);
    if (h) box.push(el('H2', { text: h[1] }));
    else if (c) box.push(el('INPUT', { id: 'cb' + c[1], checked: c[3] === 'checked' }), el('LABEL', { text: c[2], htmlFor: 'cb' + c[1] }));
    else if (b) box.push(el('BUTTON', { text: b[1] ?? '', disabled: Boolean(b[2]) }));
  }
  return el('BODY', { children: layers.map((children) => el('DIV', { children })) });
}

// A session whose page is a document model (s.doc when a step swaps it); a whole-page snapshot throws, so
// no read can take one.
function sessionOn(doc) {
  const s = {
    clicks: [],
    navigate: async () => {},
    snapshot: async () => { throw new Error('a soomgo read took a whole-page snapshot'); },
    click: async (ref) => { s.clicks.push(ref); },
    evaluate: async (fn, arg) => {
      globalThis.document = s.doc ?? doc;
      globalThis.CSS = { escape: (v) => v };
      try { return fn(arg); } finally { delete globalThis.document; delete globalThis.CSS; }
    },
  };
  return s;
}

test('service rows read every offered service with its item state by DOM query and skip the unlabeled icons', async () => {
  const doc = pageOf(PAGE);
  const rows = await readServices(sessionOn(doc));
  assert.deepEqual(rows.map(({ name, itemsSet }) => ({ name, itemsSet })), [
    { name: '프로그래밍/코딩 레슨', itemsSet: true },
    { name: '웹 개발', itemsSet: false },
  ]);
  assert.deepEqual(rows.map((r) => doc.querySelector(r.ref)?.innerText), ['프로그래밍/코딩 레슨 세부 항목 설정됨', '웹 개발 항목 미설정'], 'each ref selects the row\'s own button');
});

test('a row drawn as a role button with an aria-label reads the same, and a page with no row is a refusal', async () => {
  const row = el('DIV', { role: 'button', text: '웹 개발\n편집' });
  row.attrs['aria-label'] = '웹 개발 항목 미설정';
  assert.deepEqual((await readServices(sessionOn(el('BODY', { children: [row] })))).map(({ name, itemsSet }) => [name, itemsSet]), [['웹 개발', false]]);
  await assert.rejects(readServices(sessionOn(el('BODY', { children: [el('BUTTON', { text: '서비스 추가' })] }))), { code: 'FSW_SERVICES_UNREAD' });
});

test('the item modal groups checkboxes under their headings and leaves the occluded page out', async () => {
  const s = sessionOn(pageOf(MODAL));
  const modal = await s.evaluate(pageItemModal);
  assert.equal(modal.title, '챗봇 개발');
  assert.deepEqual(modal.groups.map((g) => [g.heading, g.options.map((o) => [o.label, o.checked])]), [
    ['어떤 플랫폼에서 사용하실 건가요?', [['카카오톡', true], ['텔레그램', false]]],
    ['챗봇 형태를 선택해주세요.', [['텍스트형', false], ['고수와 상담 후 결정할게요.', false]]],
  ]);
  assert.equal(modal.save.disabled, true);
  assert.equal(await sessionOn(pageOf(PAGE)).evaluate(pageItemModal), null);
});

test('a dry run of the service items opens the row by its marked button and reads the modal without a snapshot', async () => {
  const page = pageOf(PAGE);
  const modal = pageOf(MODAL.replace('heading "챗봇 개발"', 'heading "웹 개발"'));
  const s = sessionOn(page);
  s.navigate = async () => { s.doc = page; };
  s.click = async (ref) => { s.clicks.push(ref); s.doc = modal; };
  const r = await setServiceItems(s, '웹 개발', { '어떤 플랫폼에서 사용하실 건가요?': ['카카오톡'] }, { dryRun: true, wait: async () => {} });
  assert.deepEqual(r, { name: '웹 개발', wasSet: false, ticked: 0, saved: false, dryRun: true });
  assert.deepEqual(s.clicks, ['[data-fsw-service="1"]']);
});

// The item modal of a snapshot fixture, read by DOM query.
const modalOf = (snapshot) => {
  globalThis.document = pageOf(snapshot);
  globalThis.CSS = { escape: (v) => v };
  try { return pageItemModal(); } finally { delete globalThis.document; delete globalThis.CSS; }
};

test('the plan ticks only unchecked wanted items and names every wanted item the modal lacks', () => {
  const modal = modalOf(MODAL);
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
  const modal = modalOf(MODAL.replace('"텍스트형"', '"카카오톡"'));
  const plan = planItems(modal, { '챗봇 형태를 선택해주세요.': ['카카오톡'] });
  assert.deepEqual(plan.clicks, [{ heading: '챗봇 형태를 선택해주세요.', label: '카카오톡' }]);
});

// A page model of the add-service modal as measured on 2026-10-25: a service button only marks the
// service, and 등록하기 registers every marked one. Page functions run against a minimal document.
function addServicePage(offered) {
  const state = { offered: [...offered], modal: null, marked: new Set() };
  const button = (label, click) => ({ innerText: label, disabled: false, getBoundingClientRect: () => ({ width: 40, height: 20 }), setAttribute: () => {}, getAttribute: () => null, click });
  const buttons = () => {
    if (!state.modal) return [...state.offered.map((name) => button(name + ' 항목 미설정', () => {})), button('서비스 추가', () => { state.modal = 'tabs'; })];
    if (state.modal === 'tabs') return [button('외주', () => { state.modal = '외주'; })];
    return [
      button('데이터 크롤링', () => state.marked.add('데이터 크롤링')),
      button('등록하기', () => { state.offered.push(...state.marked); state.marked.clear(); state.modal = null; }),
    ];
  };
  const session = {
    navigate: async () => { state.modal = null; state.marked.clear(); },
    snapshot: async () => { throw new Error('a soomgo read took a whole-page snapshot'); },
    evaluate: async (fn, arg) => {
      globalThis.document = { querySelectorAll: (selector) => (selector.split(',').includes('button') ? buttons() : []) };
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
