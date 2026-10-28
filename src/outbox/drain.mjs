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
import { mintAuthorization } from '../core/authz.mjs';
import { dayKey } from '../core/clock.mjs';
import { classifyNotice } from '../core/notices.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { transaction } from '../core/tx.mjs';
import { HOLD_RULES, spendsBids, spendsCash } from '../policy/authorize.mjs';
import { loadFx as defaultLoadFx } from '../economics/fx.mjs';
import { BID_NOT_TYPED } from '../surface/freelancer.mjs';
import { NOT_TYPED as FIVERR_NOT_TYPED } from '../surface/fiverr.mjs';
import { NOT_TYPED as KMONG_NOT_TYPED } from '../surface/kmong.mjs';
import { NOT_TYPED as UPWORK_NOT_TYPED } from '../surface/upwork.mjs';
import { NOT_TYPED as WISHKET_NOT_TYPED } from '../surface/wishket.mjs';
import { baseName, keyMatches, setStatus } from './plan.mjs';
import { freeze, removeSendDir, sweepSendLeftovers } from './send-files.mjs';
import { bidUsage, quotaUsage } from './usage.mjs';

const METHOD = { message: 'send', quote: 'quote', pay_request: 'payRequest', delivery: 'send', proposal: 'propose' };
// A surface drains only the kinds it has a method for; the rest wait for a surface that has one (003:
// propose is optional, and kmong gains it in wp4).
export const handles = (surface, kind) => typeof surface?.[METHOD[kind]] === 'function';

// Refusals a surface raises before it touches the page (the 020 contract for the pacing guard): the row
// goes back as it was. Pacing stops this platform's drain for the tick, as the pipeline did
// (src/supervisor/run.mjs:239). The proposal refusals each surface raises before it types anything, read from
// the surface that raises them so a new one cannot be missed (kmong's NOT_TYPED: a spent day quota, a missing
// enterprise profile; freelancer's BID_NOT_TYPED: the balance, the profile steps, no bids left, the unmapped
// form; the unmapped forms of wishket, upwork and fiverr), stop only the proposal rows of this drain: the row
// goes back to planned or approved, counts as no bid, and a customer reply planned after an older proposal
// still goes out.
export const PROPOSAL_NOT_SENT = [...KMONG_NOT_TYPED, ...BID_NOT_TYPED, ...WISHKET_NOT_TYPED, ...UPWORK_NOT_TYPED, ...FIVERR_NOT_TYPED];
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

// What a proposal hands propose besides its text: the amount in the currency the form takes, that currency and
// the delivery period. A row that names no currency is in KRW on a board priced in KRW and in no known currency
// elsewhere or when no descriptor says, and a KRW row states its amountKRW. callSurface sends exactly these and
// authorize judges them.
export function proposalTerms(row, descriptor) {
  const p = row.payload;
  const currency = p.currency ?? (descriptor?.currency === 'KRW' ? 'KRW' : null);
  return { amount: p.amount ?? (currency === 'KRW' ? p.amountKRW ?? null : null), currency, periodDays: p.periodDays ?? p.deliveryDays ?? null };
}

// The item authorize judges, rebuilt from the row so an operator edit is judged as the new text it is, and a
// proposal with the terms propose will receive and the rate they were stated at.
export function itemOf(row, descriptor = null) {
  const p = row.payload;
  return { platform: row.platform, kind: row.kind, text: textOf(row), amountKRW: p.amountKRW, costKRW: p.costKRW ?? null, serviceLabel: p.serviceLabel ?? null, attachments: (p.files ?? []).map(baseName), thread: p.thread ?? { kind: 'message', stage: 'pre_order' }, ...(p.decision ? { decision: p.decision } : {}), ...(p.gate ? { gate: p.gate } : {}), ...(row.kind === 'proposal' ? { ...proposalTerms(row, descriptor), fx: p.fx ?? null } : {}) };
}

// What the page shows after an interrupted send: the outbound bubble for a message or a delivery, the
// platform's request notice for a payment request. A quote has no outbound bubble on a request page, so
// an interrupted quote always goes to the operator. A proposal is read back from the platform's own proposal
// list when the surface has proposalSent(ref, {since}) (wp8, the bidding boards); without it the proposal goes
// the same way as a quote and kmong's projects job reads its status from the proposal list (040).
async function readBack(surface, row) {
  if (row.kind === 'proposal') {
    if (typeof surface.proposalSent !== 'function') return { observed: false, reason: 'an interrupted proposal is not read back here; the projects job reads the proposal list for it', reconciled: true };
    const seen = await surface.proposalSent(row.payload.threadRef, { since: row.updatedAt });
    return seen?.observed === true ? { ...seen, reconciled: true } : { observed: false, reason: seen?.reason ?? 'the interrupted proposal is not in the proposal list', reconciled: true };
  }
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

// Called only after authorize said send for this row (or the operator approved it); the token binds the write
// to this row's key and to every argument the surface receives (src/core/authz.mjs). files: the frozen copies a
// delivery uploads (freeze below), never the paths its payload names.
function callSurface(surface, row, approved, descriptor, files) {
  const p = row.payload;
  const text = textOf(row);
  const write = (method, args) => surface[method](p.threadRef, { ...args, authorized: mintAuthorization(row, args) });
  if (row.kind === 'pay_request') return approved ? write('payRequest', { amountKRW: p.amountKRW, approved }) : surface.payRequest(p.threadRef, { amountKRW: p.amountKRW, approved });
  // customer: soomgo observes the quote from its charge for this customer (e8ea6a6, 7b9524e; 003 Surface).
  if (row.kind === 'quote') return write('quote', { amountKRW: p.amountKRW, priceType: p.priceType ?? 'fixed', text, allowSpendCash: spendsCash(descriptor, p.thread?.kind), customer: p.customer ?? null });
  // The terms authorize judged (proposalTerms): amount in currency, and the delivery period the decision quoted.
  if (row.kind === 'proposal') return write('propose', { text, amountKRW: p.amountKRW, ...proposalTerms(row, descriptor), phases: p.proposal?.phases ?? [], files: p.files ?? [] });
  return write('send', { text, files: row.kind === 'delivery' ? files : [] });
}

export function signalOf(row, receipt, now) {
  const base = { platform: row.platform, threadId: row.threadId, ...(row.jobId ? { jobId: row.jobId } : {}), at: now.toISOString(), ...(row.payload.amountKRW != null ? { amountKRW: row.payload.amountKRW } : {}) };
  if (row.kind === 'quote') return { ...base, type: 'quote_observed', evidence: { outboxId: row.id, service: row.payload.service ?? null, scope: row.payload.scope ?? null, deliveryDays: row.payload.deliveryDays ?? null, split: row.payload.split ?? null, costKRW: row.payload.costKRW ?? null, cashSpentKRW: receipt.cashSpentKRW ?? null } };
  if (row.kind === 'delivery') return { ...base, type: 'delivery_observed', evidence: { outboxId: row.id, files: (row.payload.files ?? []).length } };
  if (row.kind === 'pay_request') return { ...base, type: 'pay_requested', evidence: { outboxId: row.id, part: row.payload.part ?? null, rest: row.payload.rest === true } };
  return null;
}

// A read-back replaces the receipt of an interrupted send. One that observed no cost of its own keeps the cost
// evidence the earlier receipt recorded (the charge, the press and when), so a recorded cost never falls back to
// the planned one in bidUsage, quotaUsage or the deal; only a read-back that itself observes a cost sets it.
const COST_FIELDS = ['cashSpentKRW', 'costKRW', 'pressed', 'pressedAt'];
export function keepCost(earlier, back) {
  if (back.cashSpentKRW != null || back.costKRW != null) return back;
  return { ...back, ...Object.fromEntries(COST_FIELDS.filter((k) => back[k] == null && earlier?.[k] != null).map((k) => [k, earlier[k]])) };
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
      back = keepCost(row.receipt, await readBack(surface, row));
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
  // A proposal that spends bids also gets the month's bid use, read from the outbox rows themselves, which
  // this drain sets observed as each goes out.
  const usage = (row) => {
    const u = quotaUsage(ledger, platform, now);
    return { quotes: u.quotes + spentHere.quotes, cashKRW: u.cashKRW + spentHere.cashKRW, ...(spendsBids(ctx.descriptor, row.kind) ? bidUsage(ledger, platform, now) : {}) };
  };
  let proposalsStopped = false;
  // The day's exchange rate, read once and only for a proposal priced outside KRW. A proposal whose rate is
  // older than it goes stale before anything is judged or sent: its amount no longer states its KRW price. One
  // in a foreign or unknown currency that carries no dated rate is left to authorize, which refuses it
  // (price.terms), so it is never sent.
  let dayFx;
  const fxOfDay = async () => (dayFx ??= await (ctx.loadFx ?? defaultLoadFx)(ctx.instance, { now: () => now }));
  for (const row of ledger.listOutbox({ platform, statuses: ['planned', 'approved'] }).filter((r) => handles(surface, r.kind))) {
    if (proposalsStopped && row.kind === 'proposal') continue;
    if (!keyMatches(row)) {
      const reason = 'payload changed after planning';
      if (!setStatus(ledger, row.id, { from: row.status, to: 'blocked', reason })) {
        moved(row);
        continue;
      }
      await notify({ kind: 'order', title: platform + ' ' + row.kind + ' ' + row.id + ' changed after planning', body: 'The stored payload no longer matches its key; it was not sent.', dedupeKey: 'outbox-tampered:' + row.id });
      out.push({ id: row.id, kind: row.kind, action: 'blocked', reason });
      continue;
    }
    const terms = row.kind === 'proposal' ? proposalTerms(row, ctx.descriptor) : null;
    if (terms && terms.currency !== 'KRW' && row.payload.fx?.date) {
      let today;
      try {
        today = await fxOfDay();
      } catch (err) {
        out.push({ id: row.id, kind: row.kind, action: 'held', reason: "the day's exchange rate could not be read: " + (err.code ? err.code + ' ' : '') + err.message });
        continue;
      }
      if (String(row.payload.fx.date) < String(today.date)) {
        const reason = 'the proposal states ' + row.payload.amount + ' ' + row.payload.currency + ' at the rate of ' + row.payload.fx.date + ', older than the rate of ' + today.date;
        if (setStatus(ledger, row.id, { from: row.status, to: 'stale', reason })) out.push({ id: row.id, kind: row.kind, action: 'stale', reason });
        else moved(row);
        continue;
      }
    }
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
    const verdict = authorize(itemOf(row, ctx.descriptor), { ...ctx, now, approved, priceRow: row.payload.priceRow ?? null, usage: usage(row) });
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
        receipt = await callSurface(surface, row, approved, ctx.descriptor, frozen?.copies ?? []);
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
