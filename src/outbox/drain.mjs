// drain(ledger, {platform, surface, authorize, ctx}) -> Result[]: one platform's outbox on one surface
// session (architect D5). It first settles rows an interrupted drain left in sending by reading the thread
// back, never by sending again; then it screens planned rows (operator -> awaiting_operator with an
// approval id, refuse -> blocked) and sends the planned or approved rows authorize lets go now, each
// marked sending by a compare-and-set before the surface is called, so of two drains on one row only one
// sends. A row is observed only on an observed receipt; only then is the outbound message written and the
// deal signal returned. Replaces act and flushApprovals (src/pipeline/thread.mjs:99-115, :215-243),
// sendPayRequest (src/orders/requests.mjs:54-77) and sendDelivery (src/orders/delivery.mjs:96-149) at
// 2c77326. A cash quote held only by the day's caps waits as a planned row that asks nobody, and the rows
// go oldest first, so the first one the day cannot pay holds every newer cash quote (b223ed7).
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dayKey } from '../core/clock.mjs';
import { classifyNotice } from '../core/notices.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { copiesHash } from '../core/reviewed.mjs';
import { transaction } from '../core/tx.mjs';
import { HOLD_RULES, spendsCash } from '../policy/authorize.mjs';
import { baseName, setStatus } from './plan.mjs';
import { quotaUsage } from './usage.mjs';

const METHOD = { message: 'send', quote: 'quote', pay_request: 'payRequest', delivery: 'send', proposal: 'propose' };
// A surface drains only the kinds it has a method for; the rest wait for a surface that has one (003:
// propose is optional, and kmong gains it in wp4).
export const handles = (surface, kind) => typeof surface?.[METHOD[kind]] === 'function';

// Refusals a surface raises before it touches the page (the 020 contract for the pacing guard): the row
// goes back as it was. Pacing stops this platform's drain for the tick, as the pipeline did
// (src/supervisor/run.mjs:239). kmong's proposal refusals (its NOT_TYPED), a spent day quota and a
// missing enterprise profile, stop only the proposal rows of this drain, so a customer reply planned
// after an older proposal still goes out.
export const PROPOSAL_NOT_SENT = ['FSW_KMONG_QUOTA_SPENT', 'FSW_KMONG_ENTERPRISE_PROFILE'];
export const NOT_SENT = ['FSW_PACING_LIMIT', ...PROPOSAL_NOT_SENT];
// Refusals that make the item itself moot with nothing sent or charged (kmong's PROJECT_CLOSED, a soomgo
// request that already has its quota of quotes): the row goes back from sending and on to stale with the
// surface's reason, and the drain goes on.
export const STALE_NOT_SENT = ['FSW_KMONG_PROJECT_CLOSED', 'FSW_SOOMGO_REQUEST_FULL'];
// The clock drift allowed between the machine and a platform's line times when reading a send back.
export const READBACK_MARGIN_MS = 60_000;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// What leaves the machine: the operator's edit when there is one, else the planned text (003 Outbox).
const textOf = (row) => row.operator?.finalText ?? row.payload.text ?? '';
export const newApprovalId = (platform, now = new Date()) => dayKey(now) + '-' + platform + '-' + randomBytes(4).toString('hex');

// The item authorize judges, rebuilt from the row so an operator edit is judged as the new text it is.
export function itemOf(row) {
  const p = row.payload;
  return { platform: row.platform, kind: row.kind, text: textOf(row), amountKRW: p.amountKRW, costKRW: p.costKRW ?? null, serviceLabel: p.serviceLabel ?? null, attachments: (p.files ?? []).map(baseName), thread: p.thread ?? { kind: 'message', stage: 'pre_order' }, ...(p.decision ? { decision: p.decision } : {}) };
}

// What the page shows after an interrupted send: the outbound bubble for a message or a delivery, the
// platform's request notice for a payment request. A quote has no outbound bubble on a request page, so
// an interrupted quote always goes to the operator; a proposal is listed on a page read cannot open, so
// it goes the same way and the projects job reads its status from the proposal list (040).
async function readBack(surface, row) {
  if (row.kind === 'proposal') return { observed: false, reason: 'an interrupted proposal is not read back here; the projects job reads the proposal list for it', reconciled: true };
  if (row.kind === 'quote') return { observed: false, reason: 'the interrupted quote is not on the page', reconciled: true };
  const thread = await surface.read(row.payload.threadRef, { willReply: true });
  // Only lines at or after the claim (updatedAt of the sending row), less a minute of clock drift, can be
  // this send; an older bubble with the same text is an earlier message.
  const since = Date.parse(row.updatedAt) - READBACK_MARGIN_MS;
  const afterClaim = (at) => Date.parse(at ?? '') >= since;
  if (row.kind === 'pay_request') {
    const hit = (thread.notices ?? []).find((n) => {
      const c = classifyNotice(n);
      return c?.event === 'pay_requested' && c.amountKRW === row.payload.amountKRW && afterClaim(n.at);
    });
    return hit ? { observed: true, snippet: String(hit.text).slice(0, 160), reconciled: true } : { observed: false, reason: 'no request notice for ' + row.payload.amountKRW + ' KRW after the interrupted send', reconciled: true };
  }
  const want = norm(textOf(row));
  // A message whose bubble carries no time is matched by text alone; a delivery, which carries files and the
  // balance, needs a time after the claim and otherwise goes to the operator.
  const out = (thread.messages ?? []).find((m) => m.direction === 'out' && want && norm(m.text).includes(want) && (m.at ? afterClaim(m.at) : row.kind !== 'delivery'));
  return out ? { observed: true, externalId: out.externalId ?? null, text: out.text, reconciled: true } : { observed: false, reason: 'the interrupted ' + row.kind + ' is not on the page', reconciled: true };
}

// Known gap (003 Surface): verdict is the authorize result itself and is bound to no outbox row or text,
// so in-process code could build one by hand and pass authorizedSend. The token stays unbound until wp9's
// src/core/authz.mjs, which signs {key, digest, mac} over row.key and the text sent here and checks it in
// authorizedSend.
// files: the frozen copies a delivery uploads (freeze below), never the paths its payload names.
function callSurface(surface, row, verdict, approved, descriptor, files) {
  const p = row.payload;
  const text = textOf(row);
  // customer: soomgo observes the quote from its charge for this customer (e8ea6a6, 7b9524e; 003 Surface).
  if (row.kind === 'quote') return surface.quote(p.threadRef, { amountKRW: p.amountKRW, priceType: p.priceType ?? 'fixed', text, authorized: verdict, allowSpendCash: spendsCash(descriptor, p.thread?.kind), customer: p.customer ?? null });
  if (row.kind === 'pay_request') return surface.payRequest(p.threadRef, { amountKRW: p.amountKRW, approved, authorized: verdict });
  if (row.kind === 'proposal') return surface.propose(p.threadRef, { text, amountKRW: p.amountKRW, phases: p.proposal?.phases ?? [], files: p.files ?? [], authorized: verdict });
  return surface.send(p.threadRef, { text, files: row.kind === 'delivery' ? files : [], authorized: verdict });
}

// A delivery uploads copies of its files taken once, before the claim: the surface reads them only later (soomgo
// sets the file input after it opens the chat and types), so uploading the original paths would send whatever they
// hold by then, and the approved hash would have been checked against other bytes. Each copy sits in its own
// numbered folder under its own name, as the platform shows it; a file gone before the copy has none, which hashes
// as missing. The caller removes the folder once the send settles.
const SEND_PREFIX = 'fsw-send-';
function freeze(files) {
  const dir = mkdtempSync(join(tmpdir(), SEND_PREFIX));
  try {
    const copies = files.map((f, i) => {
      const to = join(dir, String(i), baseName(f));
      mkdirSync(join(dir, String(i)));
      try {
        copyFileSync(f, to);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return to;
    });
    return { dir, copies, hash: copiesHash(files, copies) };
  } catch (err) {
    const left = removeSendDir(dir);
    if (left) err.message += '; the send folder ' + dir + ' stays for a later drain to remove (' + (left.code ?? left.message) + ')';
    throw err;
  }
}

// Removes a send folder, retrying one Windows still reports busy (EBUSY, EPERM while a scanner or an upload holds a
// copy), and returns the error that outlasted the retries, or null: the caller records it, so a failed removal never
// takes the place of a send's result.
function removeSendDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return null;
  } catch (err) {
    return err;
  }
}

// Send folders a removal left behind (the event send.cleanup_failed names each): a drain removes those older than an
// hour, which no upload takes, judged by the machine's clock that stamped them. One that still resists is a result
// line of every drain until it goes.
const SEND_LEFTOVER_MS = 60 * 60_000;
function sweepSendLeftovers(out) {
  const root = tmpdir();
  for (const name of readdirSync(root)) {
    if (!name.startsWith(SEND_PREFIX)) continue;
    const dir = join(root, name);
    let age;
    try {
      age = Date.now() - statSync(dir).mtimeMs;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (age < SEND_LEFTOVER_MS) continue;
    const left = removeSendDir(dir);
    if (left) out.push({ id: null, kind: 'delivery', action: 'leftover', reason: 'the send folder ' + dir + ' could not be removed: ' + (left.code ?? left.message) });
  }
}

export function signalOf(row, receipt, now) {
  const base = { platform: row.platform, threadId: row.threadId, ...(row.jobId ? { jobId: row.jobId } : {}), at: now.toISOString(), ...(row.payload.amountKRW != null ? { amountKRW: row.payload.amountKRW } : {}) };
  if (row.kind === 'quote') return { ...base, type: 'quote_observed', evidence: { outboxId: row.id, service: row.payload.service ?? null, scope: row.payload.scope ?? null, deliveryDays: row.payload.deliveryDays ?? null, split: row.payload.split ?? null, costKRW: row.payload.costKRW ?? null, cashSpentKRW: receipt.cashSpentKRW ?? null } };
  if (row.kind === 'delivery') return { ...base, type: 'delivery_observed', evidence: { outboxId: row.id, files: (row.payload.files ?? []).length } };
  if (row.kind === 'pay_request') return { ...base, type: 'pay_requested', evidence: { outboxId: row.id, part: row.payload.part ?? null, rest: row.payload.rest === true } };
  return null;
}

// observed: the status and the outbound message in one transaction, so a crash leaves both or neither.
// null when another drain settled the row first; then nothing is written.
function observe(ledger, row, receipt, verdict) {
  return transaction(ledger, () => {
    const done = setStatus(ledger, row.id, { from: 'sending', to: 'observed', receipt });
    if (done && row.kind !== 'pay_request') {
      const body = typeof receipt.text === 'string' && receipt.text ? receipt.text : textOf(row);
      ledger.addMessage({ threadId: row.threadId, direction: 'out', body, externalId: receipt.externalId ?? null, attachments: (row.payload.files ?? []).map(baseName), gate: verdict ?? null });
    }
    return done;
  });
}

export async function drain(ledger, { platform, surface, authorize, ctx }) {
  const now = ctx.now ?? new Date();
  const notify = (msg) => (ctx.notify ?? notifyOperator)(ctx.instance, msg);
  const out = [];
  sweepSendLeftovers(out);
  const moved = (row) => out.push({ id: row.id, kind: row.kind, action: 'moved' });
  const cashQuote = (row) => row.kind === 'quote' && spendsCash(ctx.descriptor, row.payload.thread?.kind);
  // A cash quote that reached sending may have spent its cash although nothing confirmed it (an interrupted
  // drain, a surface that threw after the click, a press whose charge was not found), so unless the receipt
  // says pressed: false it counts as pressed, at the cost the page reported or else the planned one, until
  // the operator settles it.
  const mayHaveSpent = (row, receipt, at) => (cashQuote(row) && receipt?.pressed !== false ? { ...(receipt ?? {}), pressed: true, costKRW: receipt?.costKRW ?? row.payload.costKRW ?? null, pressedAt: receipt?.pressedAt ?? at } : receipt);
  // An unobserved row gets an approval id when it has none, so the operator can settle it by name
  // (fsw approve <id> --sent or --reject is the only way out of unobserved, 7b9524e); a pressed quote keeps
  // the press time, which quotaUsage counts against the day's caps.
  const unobserved = async (row, reason, receipt) => {
    const approvalId = row.approvalId ?? newApprovalId(platform, now);
    const kept = receipt?.pressed ? { ...receipt, pressedAt: receipt.pressedAt ?? now.toISOString() } : receipt;
    if (!setStatus(ledger, row.id, { from: 'sending', to: 'unobserved', reason, receipt: kept, approvalId })) {
      moved(row);
      return;
    }
    ledger.addEvent({ kind: 'send.unobserved', platform, ref: row.payload.threadRef, payload: { outboxId: row.id, kind: row.kind, reason, approvalId, pressed: kept?.pressed === true } });
    await notify({ kind: 'order', title: platform + ' ' + row.kind + ' in thread ' + row.payload.threadRef + ' was not observed', body: reason + '\nCheck the chat before sending again; fsw never resends it by itself.\nsettle: fsw approve ' + approvalId + ' --sent [--cost <KRW>] if it went out, fsw approve ' + approvalId + ' --reject if it did not', dedupeKey: 'outbox-unobserved:' + row.id });
    out.push({ id: row.id, kind: row.kind, action: 'unobserved', reason });
  };
  // 1. Interrupted sends.
  for (const row of ledger.listOutbox({ platform, statuses: ['sending'] }).filter((r) => handles(surface, r.kind))) {
    let back;
    try {
      back = await readBack(surface, row);
    } catch (err) {
      await notify({ kind: 'order', title: platform + ' outbox item ' + row.id + ' could not be read back', body: (err.code ? err.code + ' ' : '') + err.message + '\nIt stays in sending and holds its thread; the next drain reads it again.', dedupeKey: 'outbox-reconcile:' + row.id });
      out.push({ id: row.id, kind: row.kind, action: 'reconcile_failed', reason: err.message });
      continue;
    }
    if (back.observed) {
      if (observe(ledger, row, back, row.verdict)) out.push({ id: row.id, kind: row.kind, action: 'observed', reconciled: true, signal: signalOf(row, back, now) });
      else moved(row);
    } else await unobserved(row, back.reason, mayHaveSpent(row, back, row.updatedAt));
  }
  // 2. Screen and send, oldest first.
  let cashHeld = null;
  // Quotes this drain saw go out: the deal writes their quote rows only after the drain returns, so the
  // caps count them here until then.
  const spentHere = { quotes: 0, cashKRW: 0 };
  const usage = () => {
    const u = quotaUsage(ledger, platform, now);
    return { quotes: u.quotes + spentHere.quotes, cashKRW: u.cashKRW + spentHere.cashKRW };
  };
  let proposalsStopped = false;
  for (const row of ledger.listOutbox({ platform, statuses: ['planned', 'approved'] }).filter((r) => handles(surface, r.kind))) {
    if (proposalsStopped && row.kind === 'proposal') continue;
    const ready = ctx.hold ? await ctx.hold(row) : null;
    if (ready?.stale || ready?.block) {
      const to = ready.stale ? 'stale' : 'blocked';
      if (!setStatus(ledger, row.id, { from: row.status, to, reason: ready.stale ?? ready.block })) {
        moved(row);
        continue;
      }
      if (to === 'blocked') await notify({ kind: 'order', title: platform + ' ' + row.kind + ' for job ' + (row.jobId ?? '-') + ' is blocked', body: ready.block, dedupeKey: 'outbox-blocked:' + row.id });
      out.push({ id: row.id, kind: row.kind, action: to, reason: ready.stale ?? ready.block });
      continue;
    }
    const approved = row.status === 'approved';
    const verdict = authorize(itemOf(row), { ...ctx, now, approved, priceRow: row.payload.priceRow ?? null, usage: usage() });
    if (verdict.verdict === 'refuse') {
      const reason = verdict.violations.map((v) => v.rule + ' ' + v.detail).join('; ');
      if (!setStatus(ledger, row.id, { from: row.status, to: 'blocked', verdict, reason })) {
        moved(row);
        continue;
      }
      await notify({ kind: 'order', title: platform + ' ' + row.kind + ' blocked by the gate', body: reason, dedupeKey: 'outbox-blocked:' + row.id });
      out.push({ id: row.id, kind: row.kind, action: 'blocked', reason });
      continue;
    }
    if (verdict.verdict === 'operator') {
      // An approved row comes back here only when no day's budget can pay it (budget.unpayable): it stays
      // approved without holding newer quotes, and the operator rejects it or changes the caps.
      if (approved) {
        const reason = verdict.reasons.map((r) => r.detail).join('; ');
        await notify({ kind: 'approval', title: platform + ' approved ' + row.kind + ' cannot be sent', body: reason + '\nreject: fsw approve ' + row.approvalId + ' --reject, or change the cash caps', dedupeKey: 'outbox-unpayable:' + row.id });
        out.push({ id: row.id, kind: row.kind, action: 'operator', approvalId: row.approvalId, reason });
        continue;
      }
      // An imported row keeps the id of the approval file it came from (fsw approve <id> stays the same).
      const approvalId = row.approvalId ?? newApprovalId(platform, now);
      const reason = verdict.reasons.filter((r) => !HOLD_RULES.includes(r.rule)).map((r) => r.detail).join('; ');
      if (!setStatus(ledger, row.id, { from: 'planned', to: 'awaiting_operator', verdict, reason, approvalId })) {
        moved(row);
        continue;
      }
      const text = textOf(row);
      await notify({
        kind: 'approval',
        title: platform + ' ' + row.kind + ' needs approval',
        body: ['platform: ' + platform + ', thread ' + row.payload.threadRef, 'reason: ' + reason, ...(row.payload.amountKRW != null ? ['amount: ' + row.payload.amountKRW + ' KRW'] : []), ...(text ? ['draft: ' + text] : []), ...(verdict.violations.length ? ['violations: ' + verdict.violations.map((v) => v.rule).join(', ')] : []), 'resolve: fsw approve ' + approvalId + ' [--text "..."] | fsw approve ' + approvalId + ' --reject'].join('\n'),
        dedupeKey: 'approval:' + approvalId,
      });
      out.push({ id: row.id, kind: row.kind, action: 'awaiting_operator', approvalId, reason });
      continue;
    }
    const cash = verdict.reasons.find((r) => r.rule === 'budget.cash')?.detail ?? null;
    const hold = ready?.hold ?? verdict.reasons.find((r) => HOLD_RULES.includes(r.rule))?.detail ?? (cashHeld && cashQuote(row) ? cashHeld : null);
    if (hold) {
      if (cash) cashHeld = cash;
      // An approved quote waiting for the budget tells the operator once a day; a planned one deferred by
      // the caps alone asks nobody (b223ed7).
      if (cash && approved) await notify({ kind: 'order', title: platform + ' approved quote waits for the cash budget', body: hold, dedupeKey: 'outbox-held:' + row.id + ':' + dayKey(now) });
      out.push({ id: row.id, kind: row.kind, action: 'held', reason: hold });
      continue;
    }
    // A delivery is frozen before the claim (freeze above) and uploads those copies; an approved one goes out only as
    // the bytes the operator approved (resolve stamps operator.filesHash), so one whose copies differ, or one approved
    // without the stamp, is blocked for the operator. The folder goes once the send settles, on every path out.
    const frozen = row.kind === 'delivery' ? freeze(row.payload.files ?? []) : null;
    let receipt;
    try {
      if (approved && frozen && row.operator?.filesHash !== frozen.hash) {
        const reason = 'the delivery files changed since the operator approved it; nothing was sent: ' + (row.payload.files ?? []).map(baseName).join(', ');
        if (!setStatus(ledger, row.id, { from: 'approved', to: 'blocked', reason })) {
          moved(row);
          continue;
        }
        await notify({ kind: 'order', title: platform + ' delivery for job ' + (row.jobId ?? '-') + ' is blocked', body: reason + '\nCheck the files, then plan the delivery again.', dedupeKey: 'outbox-blocked:' + row.id });
        out.push({ id: row.id, kind: row.kind, action: 'blocked', reason });
        continue;
      }
      // The claim: a second drain on this row (a second process on the instance, which the pid lock fsw run and fsw tick share keeps out) finds it moved and skips it.
      if (!setStatus(ledger, row.id, { from: row.status, to: 'sending', verdict })) {
        moved(row);
        continue;
      }
      try {
        receipt = await callSurface(surface, row, verdict, approved, ctx.descriptor, frozen?.copies ?? []);
      } catch (err) {
        if (STALE_NOT_SENT.includes(err.code)) {
          // receipt.refused keeps the platform's refusal code on the row, where src/economics/quote-results.mjs
          // reads a refused quote; nothing was sent or charged, so no other receipt field applies.
          if (transaction(ledger, () => setStatus(ledger, row.id, { from: 'sending', to: row.status, reason: err.message }) && setStatus(ledger, row.id, { from: row.status, to: 'stale', reason: err.message, receipt: { refused: err.code, at: now.toISOString() } }))) out.push({ id: row.id, kind: row.kind, action: 'stale', code: err.code, reason: err.message });
          else moved(row);
          continue;
        }
        if (NOT_SENT.includes(err.code)) {
          setStatus(ledger, row.id, { from: 'sending', to: row.status, reason: err.message });
          ledger.addEvent({ kind: 'send.deferred', platform, ref: row.payload.threadRef, payload: { outboxId: row.id, kind: row.kind, code: err.code, reason: err.message } });
          out.push({ id: row.id, kind: row.kind, action: 'deferred', code: err.code, reason: err.message });
          if (PROPOSAL_NOT_SENT.includes(err.code) && row.kind === 'proposal') {
            proposalsStopped = true;
            continue;
          }
          break;
        }
        receipt = mayHaveSpent(row, { observed: false, reason: (err.code ? err.code + ' ' : '') + err.message }, now.toISOString());
      }
    } finally {
      // A folder that will not go is recorded and left to the sweep above; the send's result stands.
      const left = frozen ? removeSendDir(frozen.dir) : null;
      if (left) ledger.addEvent({ kind: 'send.cleanup_failed', platform, ref: row.payload.threadRef, payload: { outboxId: row.id, dir: frozen.dir, code: left.code ?? null, reason: left.message } });
    }
    if (receipt?.observed === true) {
      if (observe(ledger, row, receipt, verdict)) {
        if (row.kind === 'quote') {
          spentHere.quotes += 1;
          spentHere.cashKRW += receipt.cashSpentKRW ?? row.payload.costKRW ?? 0;
        }
        out.push({ id: row.id, kind: row.kind, action: 'observed', signal: signalOf(row, receipt, now) });
      } else moved(row);
    } else await unobserved(row, receipt?.reason ?? 'the surface did not observe the ' + row.kind, mayHaveSpent(row, receipt ?? { observed: false }, now.toISOString()));
  }
  return out;
}
