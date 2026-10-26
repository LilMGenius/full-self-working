// 크몽 seller conversations on the operator's signed-in Chrome. Reads never change state: the inbox unread
// check flips the client-side 안읽음 filter, and a thread opens only when it is already read or the
// caller will reply in the same tick. send() types gated text, presses 전송 and reports success only
// when the thread shows the text as the newest outbound message. The conversation half of
// src/platforms/kmong/adapter.mjs at 2c77326 (:511-587, :593-605, :748-751); src/platforms/kmong/listing.mjs
// holds the gig half.
import { openSession } from '../../browser/driver.mjs';
import { loadDescriptor } from '../registry.mjs';
import { AdapterRefusal, squash } from '../kit.mjs';
import { parseDashboard, parseInbox, parseOrders, parseProfile, parseThread, ORDER_COUNTERS } from './parse.mjs';
import { pageLogin, pageInboxRows, pageSelectTab, pageOpenRow, pageThread, pageOrders } from './page.mjs';

const BASE = 'https://kmong.com';
const INBOX = `${BASE}/inboxes?inbox_group_id=&partner_id=`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openKmongConversation({ session } = {}) {
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

    stop: () => s.stop(),
  };
  return adapter;
}
