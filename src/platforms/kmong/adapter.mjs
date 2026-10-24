// 크몽 seller adapter on the operator's signed-in Chrome. Reads never change state: the inbox unread
// check flips the client-side 안읽음 filter, and a thread opens only when it is already read or the
// caller will reply in the same tick. send() types gated text, presses 전송 and reports success only
// when the thread shows the text as the newest outbound message.
import { openSession } from '../../browser/driver.mjs';
import { loadDescriptor } from '../registry.mjs';
import { AdapterRefusal, squash } from '../kit.mjs';
import { parseDashboard, parseGigList, parseInbox, parseListingForm, parseOrders, parseProfile, parseThread, ORDER_COUNTERS } from './parse.mjs';

const BASE = 'https://kmong.com';
const INBOX = `${BASE}/inboxes?inbox_group_id=&partner_id=`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- page-side extractors (serialised into the page; no closure over module scope) ----

function pageLogin() {
  const nickLink = [...document.querySelectorAll('a[href^="/@"]')].find((a) => a.innerText.includes('프로필 완성도'));
  return {
    url: location.href,
    avatar: !!document.querySelector('[data-testid=avatar]'),
    authSection: !!document.querySelector('[data-testid=authenticate-section]'),
    loginButton: [...document.querySelectorAll('a,button')].some((e) => e.innerText.trim() === '로그인'),
    sellerMode: document.querySelector('input[aria-label="전문가 모드"]')?.checked ?? null,
    profileHref: nickLink?.getAttribute('href') ?? null,
  };
}

function pageInboxRows() {
  return [...document.querySelectorAll('a[href*="inbox_group_id="]')].filter((a) => /inbox_group_id=\d+/.test(a.getAttribute('href'))).map((a) => ({
    href: a.getAttribute('href'),
    nickname: a.querySelector('.font-bold')?.innerText ?? '',
    time: a.querySelector('p[class*="typo-12"]')?.innerText ?? '',
    preview: a.querySelector('.truncate')?.innerText ?? '',
  }));
}

async function pageSelectTab(label) {
  const tab = [...document.querySelectorAll('button[aria-selected]')].find((b) => b.innerText.trim() === label);
  if (!tab) return { ok: false, reason: 'no tab ' + label };
  if (tab.getAttribute('aria-selected') !== 'true') tab.click();
  for (let i = 0; i < 20 && tab.getAttribute('aria-selected') !== 'true'; i++) await new Promise((r) => setTimeout(r, 150));
  await new Promise((r) => setTimeout(r, 1500));
  return { ok: tab.getAttribute('aria-selected') === 'true', empty: document.body.innerText.includes('안 읽은 메시지가 없어요') };
}

function pageOpenRow(id) {
  const a = document.querySelector(`a[href*="inbox_group_id=${id}&"]`);
  if (!a) return false;
  a.click();
  return true;
}

function pageThread() {
  const stamps = [...document.querySelectorAll('p')].filter((p) => /^\d{2}\.\d{2}\.\d{2}\s+\d{2}:\d{2}$/.test(p.innerText.trim()));
  const bubbles = stamps.map((p) => {
    const row = p.closest('div.relative.flex');
    const all = row ? row.innerText : '';
    const stamp = p.innerText;
    const text = all.endsWith(stamp) ? all.slice(0, -stamp.length) : all.replace(stamp, '');
    return { text: text.trim(), stamp: stamp.replace(/\s+/g, ' '), outbound: !!row?.classList.contains('flex-row-reverse') };
  });
  const ta = document.querySelector('textarea');
  const send = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '전송');
  if (ta) ta.setAttribute('data-fsw', 'composer');
  if (send) send.setAttribute('data-fsw', 'send');
  return {
    url: location.href,
    gigHrefs: [...document.querySelectorAll('a[href^="/gig/"]')].map((a) => a.getAttribute('href')),
    bubbles,
    // An unreachable counterpart renders a read-only textarea (placeholder 대화할 수 없는 회원입니다).
    composer: { found: !!ta, disabled: !!ta && (ta.disabled || ta.readOnly), placeholder: ta?.placeholder ?? null, value: ta?.value ?? '', sendButton: !!send, sendDisabled: !!send?.disabled, fileInput: !!document.querySelector('[data-testid=dropzone-layout] input[type=file]') },
  };
}

function pageOrders(testids) {
  const counters = {};
  for (const id of testids) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el) counters[id] = el.innerText;
  }
  return { counters, emptyState: document.body.innerText.includes('조회 기간에 거래 내역이 없어요') };
}

function pageOpenGigEdit(gigId) {
  const tag = [...document.querySelectorAll('*')].find((e) => !e.children.length && e.innerText?.trim() === '#' + gigId);
  let n = tag;
  while (n && ![...n.querySelectorAll('button')].some((b) => b.innerText.trim() === '편집하기')) n = n.parentElement;
  const button = n && [...n.querySelectorAll('button')].find((b) => b.innerText.trim() === '편집하기');
  if (!button) return false;
  button.click();
  return true;
}

function pageListingForm() {
  const labelOf = (el) => {
    let n = el.parentElement;
    for (let i = 0; i < 3 && n; i++, n = n.parentElement) {
      const l = n.querySelector(':scope > label, :scope > div > label');
      if (l) return l.innerText.trim();
    }
    return '';
  };
  const texts = [...document.querySelectorAll('input[type=text]')];
  const packages = {};
  let packageTitle = null;
  let packageDescription = null;
  for (const t of document.querySelectorAll('textarea[name^="PACKAGE_OPTION_GROUP.valueData.packages."]')) {
    const m = t.name.match(/packages\.(\d+)\.values\.(\d+)\./);
    packages[m[1] + '.' + m[2]] = t.value;
    if (m[1] === '0') packageTitle = t.maxLength;
    if (m[1] === '1') packageDescription = t.maxLength;
  }
  const questions = texts.filter((i) => labelOf(i).startsWith('질문'));
  const answers = [...document.querySelectorAll('textarea[name^="FAQ.valueData.faqs."]')];
  const keyword = texts.find((i) => i.placeholder === '키워드를 입력해 주세요');
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,label')].map((e) => e.innerText.trim()).filter(Boolean);
  return {
    url: location.href,
    title: headings[0] ?? null,
    headings,
    counters: [...document.querySelectorAll('*')].filter((e) => !e.children.length && /^\d+\s*\/\s*[\d,]+$/.test(e.innerText?.trim() ?? '')).map((e) => e.innerText.trim()),
    packages,
    prices: texts.filter((i) => labelOf(i).startsWith('금액')).map((i) => i.value),
    faqs: questions.map((q, i) => ({ question: q.value, answer: answers[i]?.value ?? null })),
    limits: { packageTitle, packageDescription, faq: questions[0]?.maxLength ?? null, keyword: keyword?.maxLength ?? null },
  };
}

// ---- adapter ----

export async function openKmong({ session } = {}) {
  const s = session ?? (await openSession('kmong', { platform: 'kmong', pacing: loadDescriptor('kmong').pacing }));

  const unreadHrefs = async () => {
    const tab = await s.evaluate(pageSelectTab, '안읽음');
    if (!tab.ok) throw new AdapterRefusal('FSW_UNREAD_UNKNOWN', 'the 안읽음 filter did not switch, so unread threads cannot be told apart');
    const rows = tab.empty ? [] : (await s.evaluate(pageInboxRows)).map((r) => r.href);
    await s.evaluate(pageSelectTab, '전체');
    return rows;
  };

  // Opens a thread from the list after the unread check; never navigates to a thread URL directly.
  const openThread = async (id, { willReply = false } = {}) => {
    await s.navigate(INBOX);
    const rows = await s.evaluate(pageInboxRows);
    const row = rows.find((r) => r.href.includes(`inbox_group_id=${id}&`));
    if (!row) throw new AdapterRefusal('FSW_THREAD_NOT_LISTED', `thread ${id} is not in the inbox list`);
    const unread = (await unreadHrefs()).some((h) => h.includes(`inbox_group_id=${id}&`));
    if (unread && !willReply) throw new AdapterRefusal('FSW_UNREAD_REFUSED', `thread ${id} is unread; open it only with willReply`);
    if (!(await s.evaluate(pageOpenRow, String(id)))) throw new AdapterRefusal('FSW_THREAD_NOT_LISTED', `thread ${id} row vanished`);
    await wait(5000);
    return { row, unread, page: await s.evaluate(pageThread) };
  };

  const adapter = {
    platform: 'kmong',
    session: s,

    async login() {
      await s.navigate(`${BASE}/seller/dashboard`);
      const p = await s.evaluate(pageLogin);
      const nickname = p.profileHref ? decodeURIComponent(p.profileHref.slice(2)) : null;
      return { loggedIn: p.avatar && p.authSection && !p.loginButton, sellerMode: p.sellerMode, nickname, url: p.url };
    },

    async inbox() {
      await s.navigate(INBOX);
      const rows = await s.evaluate(pageInboxRows);
      return parseInbox(rows, await unreadHrefs());
    },

    async readThread(id, { willReply = false } = {}) {
      const { row, unread, page } = await openThread(id, { willReply });
      return { ...parseThread({ id: String(id), url: page.url, nickname: row.nickname, gigHrefs: page.gigHrefs, bubbles: page.bubbles, composer: page.composer }), wasUnread: unread, stage: 'pre_order' };
    },

    // dryRun types into the composer, confirms the send button, then clears the composer.
    async send(id, { text, files = [], gate, dryRun = false } = {}) {
      if (gate?.ok !== true) return { sent: false, observed: false, reason: 'gate result missing or not ok' };
      if (!squash(text)) return { sent: false, observed: false, reason: 'empty text' };
      const { page } = await openThread(id, { willReply: true });
      const c = page.composer;
      if (!c.found || c.disabled) return { sent: false, observed: false, reason: `composer unavailable${c.placeholder ? ': ' + c.placeholder : ''}` };
      if (!c.sendButton) return { sent: false, observed: false, reason: 'send button 전송 not found' };
      if (!dryRun) s.guard.beforeMessage();
      await s.fill('[data-fsw=composer]', text);
      if (files.length) await s.setFiles('[data-testid=dropzone-layout] input[type=file]', files);
      const typed = await s.evaluate(pageThread);
      if (squash(typed.composer.value) !== squash(text)) {
        await s.fill('[data-fsw=composer]', '');
        return { sent: false, observed: false, reason: 'the composer did not hold the typed text' };
      }
      if (dryRun) {
        await s.fill('[data-fsw=composer]', '');
        const cleared = await s.evaluate(pageThread);
        return { sent: false, observed: false, dryRun: true, typed: true, sendButton: true, sendDisabled: typed.composer.sendDisabled, cleared: cleared.composer.value === '' };
      }
      if (typed.composer.sendDisabled) return { sent: false, observed: false, reason: 'send button disabled after typing' };
      await s.click('[data-fsw=send]');
      await wait(4000);
      const after = await s.evaluate(pageThread);
      const last = after.bubbles.filter((b) => b.outbound).at(-1);
      const observed = !!last && squash(last.text).includes(squash(text).slice(0, 60));
      const snip = last ? squash(last.text).slice(0, 80) : null;
      return observed ? { sent: true, observed: true, observedSnippet: snip, text } : { sent: false, observed: false, reason: 'the sent text was not observed in the thread', observedSnippet: snip };
    },

    async listings() {
      await s.navigate(`${BASE}/my-gigs`);
      return parseGigList(await s.evaluate(() => document.body.innerText));
    },

    async orders() {
      await s.navigate(`${BASE}/seller/order-list`);
      return parseOrders(await s.evaluate(pageOrders, Object.keys(ORDER_COUNTERS)));
    },

    async profile() {
      const login = await adapter.login();
      const dashboard = parseDashboard(await s.evaluate(() => document.body.innerText));
      if (!login.nickname) return { dashboard, profile: null };
      const url = `${BASE}/@${encodeURIComponent(login.nickname)}`;
      await s.navigate(url);
      return { dashboard, profile: parseProfile(await s.evaluate(() => document.body.innerText), { nickname: login.nickname, url }) };
    },

    // Reads the gig edit form without saving: the edit page is reached through 편집하기 on /my-gigs,
    // since the bare /my-gigs/edit/<id> URL redirects back without category ids.
    async listingForm(gigId) {
      await s.navigate(`${BASE}/my-gigs`);
      if (!(await s.evaluate(pageOpenGigEdit, String(gigId)))) throw new AdapterRefusal('FSW_GIG_NOT_FOUND', `gig ${gigId} has no 편집하기 button on /my-gigs`);
      await wait(8000);
      const form = await s.evaluate(pageListingForm);
      if (!form.url.includes(`/my-gigs/edit/${gigId}`)) throw new AdapterRefusal('FSW_GIG_FORM', `edit form for ${gigId} did not open (at ${form.url})`);
      return parseListingForm(form);
    },

    stop: () => s.stop(),
  };
  return adapter;
}
