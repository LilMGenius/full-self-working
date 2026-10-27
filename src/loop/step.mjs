// step(platform, ctx): one platform's pass on one surface session (architect D13): login; sense, each
// list row's money to the deal; triage; read, decide and plan for at most MAX_THREADS_PER_PLATFORM opened
// threads; the deal's effects; the outbox drain; the effects of what the drain observed. Carried from
// runPlatform (src/supervisor/run.mjs:184-251) and processThread (src/pipeline/thread.mjs:117-213) at
// 2c77326. A thread that throws is recorded and the next one still runs. While the Seoul day's budget pays
// no quote, a buyer request on a cash platform is left unread with no model call (b223ed7).
import { createHash } from 'node:crypto';
import { dayKey } from '../core/clock.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { chromeName, pipelineSettings, priceLearningSettings } from '../core/settings.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { openSurface as defaultOpenSurface } from '../surface/index.mjs';
import { fullReason, parkEvent, triage } from '../triage/index.mjs';
import { decide as defaultDecide, loadGateRules, pendingInbound } from '../brain/respond.mjs';
import { authorize, budgetSpent, operatingMode, spendsCash } from '../policy/authorize.mjs';
import { drain, plan, signalOf } from '../outbox/index.mjs';
import { quotaUsage } from '../outbox/usage.mjs';
import { advance, jobsOfThread, moneyToSignals, readiness, stageOf, unappliedObserved } from '../deal/index.mjs';
import { answeredServices, parkKey } from '../economics/catalog.mjs';
import { latestAllocation, prioritize } from '../economics/priority.mjs';
import { armCounts, gateSettings, judgeQuote, paceSpent } from '../economics/quote-gate.mjs';
import { dayStart, quoteResults } from '../economics/quote-results.mjs';
import { loadRecipe } from '../work/index.mjs';
import { applyEffects } from './effects.mjs';
import { recordFunnel } from './funnel.mjs';
import { recordOrderCounters } from './orders.mjs';
import { permissionSignal } from './permission.mjs';
import { reviewPosted } from './reviews.mjs';

// One platform opens at most this many threads per tick, so a backlog cannot hold the tick past the next
// 5-minute mark (src/supervisor/run.mjs:22-24).
export const MAX_THREADS_PER_PLATFORM = 10;

const msgText = (m) => String(m.text ?? m.body ?? '');
const msgExternalId = (m) => String(m.externalId ?? m.id ?? createHash('sha1').update((m.at ?? '') + '\n' + msgText(m)).digest('hex').slice(0, 16));

// The outbox payload of one decision (field chains in 030 section 4).
// gate: the value gate's send verdict on a paid request quote (judgeQuote below), which authorize requires before
// such a quote leaves unapproved.
function payloadOf(result, view, gate = null) {
  const { decision: d, item, priceRow } = result;
  const q = d.quote;
  return {
    text: item.text, amountKRW: q?.amountKRW ?? null, priceType: q?.priceType ?? null, split: q?.split ?? null, scope: q?.scope ?? null, deliveryDays: q?.deliveryDays ?? null,
    costKRW: item.costKRW ?? null, serviceLabel: item.serviceLabel ?? null, service: d.service ?? null, thread: item.thread, decision: d, priceRow: priceRow ?? null, requestId: view.requestId ?? null, customer: view.customer ?? null,
    // A proposal on a board priced outside KRW: its price in the board's currency and the rate it used (wp8).
    ...(item.currency ? { currency: item.currency, amount: item.amount, fx: item.fx } : {}),
    ...(gate ? { gate } : {}),
  };
}

export async function step(platform, ctx) {
  const { instance, ledger, now = new Date(), forceMode = null, priceTable = [], readOnly = false } = ctx;
  const cfg = instance.config.platforms?.[platform];
  const result = { platform, configMode: cfg?.mode ?? null, mode: null, status: 'ok', login: null, inbound: 0, threads: {}, outbox: {}, transitions: 0, deferred: 0, errors: [] };
  if (!cfg?.enabled) return { ...result, status: 'skipped', error: 'not enabled' };
  // The forced mode and the outbound hours come from the policy's one function (003 Policy), the same
  // predicate authorize holds sends with.
  let { mode } = operatingMode(cfg.mode, { forceMode, now, instance });
  result.mode = mode;
  // A platform id no descriptor names fails this platform's step alone; the poll's other steps still run.
  let descriptor;
  try {
    descriptor = loadDescriptor(platform);
  } catch (err) {
    return { ...result, status: 'failed', error: err.message, code: err.code ?? null };
  }
  const load = ctx.loadRecipe ?? ((service) => loadRecipe(service));
  const dealCtx = { instance, descriptor, now, loadRecipe: load };
  const effCtx = { instance, ledger, notify: ctx.notify, spawnJob: ctx.spawnJob, loadRecipe: load };
  const effects = [];
  const bump = (bucket, key) => (result[bucket][key] = (result[bucket][key] ?? 0) + 1);
  // Every event the step writes carries the step's now: the supply report counts parks and paced waits in a
  // window ending at its own now, and a time from the machine clock (the ledger's default) falls outside it on
  // a replay or a test whose clock is injected.
  const event = (kind, ref, payload) => ledger.addEvent({ kind, platform, ref, payload, at: now.toISOString() });
  // The day's cash use as the drain will see it: what went out today plus the cash quotes still waiting to
  // go, which the drain sends oldest first before any request planned now (b223ed7 sent them before the
  // lists were read).
  const cashUsage = () => {
    const u = quotaUsage(ledger, platform, now);
    // A waiting quote no day's budget can pay (an unread cost, or one above maxCashPerDay; budget.unpayable)
    // never goes out, so it takes none of today's room.
    const payable = (r) => typeof r.payload.costKRW === 'number' && r.payload.costKRW <= (cfg.maxCashPerDay ?? -1);
    const waiting = ledger.listOutbox({ platform, statuses: ['planned', 'approved'], kinds: ['quote'] }).filter((r) => spendsCash(descriptor, r.payload.thread?.kind) && payable(r));
    return { quotes: u.quotes + waiting.length, cashKRW: u.cashKRW + waiting.reduce((s, r) => s + (r.payload.costKRW ?? 0), 0) };
  };
  const applyAdvance = (signal) => {
    const r = advance(ledger, signal, dealCtx);
    result.transitions += r.transitions.length;
    effects.push(...r.effects);
    return r;
  };
  // A notice's money signals go to the deal, except the posted-review notice, which names no job and is
  // recorded and told to the operator (reviewPosted).
  const applyNotice = (signal, row) => (signal.type === 'review' ? effects.push(...reviewPosted(ledger, { platform, thread: ledger.getThread(row.id), signal, now })) : applyAdvance(signal));
  // One signal that throws is recorded against its outbox row and the rest still apply; the operator is told
  // once per row (the dedupe key holds while the notice stays open), since the sweep retries it every tick.
  const failedSignals = [];
  const applySent = (signal, ref) => {
    try {
      applyAdvance(signal);
    } catch (err) {
      result.errors.push({ ref, code: err.code ?? null, message: err.message });
      event('deal.signal_failed', ref, { type: signal.type, outboxId: signal.evidence?.outboxId ?? null, code: err.code ?? null, message: err.message });
      failedSignals.push({ signal, err });
    }
  };
  const reportFailedSignals = async () => {
    for (const { signal, err } of failedSignals.splice(0)) {
      const id = signal.evidence?.outboxId ?? null;
      await (ctx.notify ?? notifyOperator)(instance, { kind: 'order', title: platform + ' ' + signal.type + ' for outbox item ' + id + ' could not be recorded', body: (err.code ? err.code + ' ' : '') + err.message + '\nThe send went out; the deal is retried on every tick until it records it.', dedupeKey: 'deal-signal-failed:' + id });
    }
  };
  let surface;
  try {
    surface = await (ctx.openSurface ?? defaultOpenSurface)(platform, ctx.surfaceOptions ?? {});
    result.login = await surface.login();
    // A platform that signed out is signed in again from the operator's logins file, at most once an hour
    // (the supervisor's signInAgain, 36400c4), before the operator is asked. A forced observe pass (a
    // rehearsal on a copy of the instance) never signs in, so it cannot open a second session on the
    // account beside the live supervisor; a platform configured observe still does.
    if (!result.login?.loggedIn && ctx.signInAgain && forceMode !== 'observe') result.login = (await ctx.signInAgain({ id: platform, surface, instance, ledger, now })) ?? result.login;
    // A board whose lists read signed out (003 publicSense) keeps sensing in observe mode, so it sends
    // nothing until the operator's session is signed in again.
    if (!result.login?.loggedIn && surface.publicSense === true) result.mode = mode = 'observe';
    else if (!result.login?.loggedIn) {
      await (ctx.notify ?? notifyOperator)(instance, { kind: 'login', title: platform + ' needs a login', body: 'Sign in to ' + descriptor.name + ' in ' + chromeName(instance.config) + '; the supervisor reads it again on the next tick.', dedupeKey: 'login:' + platform + ':' + dayKey(now) });
      return { ...result, status: 'failed', error: 'not logged in' };
    }
    if (readOnly) return result;
    // A missing pipeline setting fails here, before anything is opened (src/pipeline/thread.mjs:36-43).
    // settings.answered is the catalog list this instance answers here (config platforms.<id>.services).
    const settings = mode === 'observe' ? null : { ...pipelineSettings(instance.config), answered: answeredServices(instance.config, platform) };
    const inbound = await surface.sense();
    result.inbound = inbound.length;
    if (typeof surface.orders === 'function') result.ordersChanged = (await recordOrderCounters({ ledger, instance, platform, orders: await surface.orders(), ...(ctx.notify ? { notify: ctx.notify } : {}) })).rises;
    const known = new Map(ledger.listThreads({ platform }).map((t) => [t.externalId, t]));
    const rows = new Map();
    for (const ib of inbound) {
      const row = ledger.upsertThread({ platform, externalId: String(ib.ref), kind: ib.kind ?? 'message', customer: ib.customer ?? undefined });
      rows.set(String(ib.ref), row);
      // One row whose money signal throws is that row's error, never the whole platform's every tick.
      try {
        for (const s of moneyToSignals({ platform, threadId: row.id, inbound: ib, now })) applyNotice(s, row);
      } catch (err) {
        result.errors.push({ ref: String(ib.ref), code: err.code ?? null, message: err.message });
        event('thread.error', String(ib.ref), { code: err.code ?? null, message: err.message, stage: 'money' });
      }
    }
    // The quote funnel from the same rows, opened or not (U7.Q, src/loop/funnel.mjs): change-only, so an unchanged
    // poll writes nothing. A funnel write that throws is that pass's error, never the platform's.
    try {
      const funnel = recordFunnel(ledger, { platform, inbound, rows, now, refundHours: descriptor.bidCost?.unreadRefundHours ?? null });
      result.funnel = funnel.written;
      effects.push(...funnel.effects);
    } catch (err) {
      result.errors.push({ ref: null, code: err.code ?? null, message: err.message });
      event('thread.error', null, { code: err.code ?? null, message: err.message, stage: 'funnel' });
    }
    // The settings every park of this pass is decided under (22fbb4b): a park holds only while they do.
    const key = parkKey(instance.config, descriptor);
    // The replayed quote results the value gate reads an arm's outcomes from, computed at most once a pass.
    let results = null;
    const learning = () => priceLearningSettings(instance.config);
    const resultsOnce = () => (results ??= quoteResults(ledger, { asOf: now, expireAfterDays: learning().expireAfterDays }));
    // Open conversations first, then requests by the allocation weight of their service.
    const work = prioritize(inbound, { allocation: latestAllocation(instance), descriptor });
    let opened = 0;
    let done = 0;
    let paced = 0;
    // The session's pacing guard keeps a share of the hour's actions for thread reads (descriptor
    // pacing.readActionsPerHour); a replay or scripted session has none, and reads are not limited there.
    const guard = surface.session?.guard;
    const readsLeft = () => (typeof guard?.readRoom === 'function' ? guard.readRoom() : Infinity);
    const reading = (fn) => (typeof guard?.reading === 'function' ? guard.reading(fn) : fn());
    for (const ib of work) {
      if (opened >= MAX_THREADS_PER_PLATFORM) break;
      done += 1;
      const ref = String(ib.ref);
      const row = rows.get(ref);
      const t = triage(ib, known.get(ref) ?? null, { mode, now, settings, descriptor, parkKey: key, openOutbox: ledger.listOutbox({ platform, threadId: row.id }) });
      if (t.action === 'wait') {
        if (t.reason !== 'unchanged') event('thread.wait', ref, { reason: t.reason });
        continue;
      }
      if (t.action === 'park') {
        // Parked from its list row with the list time and the settings key it was parked under; it waits for
        // a newer message or a settings change.
        ledger.upsertThread({ platform, externalId: ref, kind: ib.kind ?? 'message', meta: { ...(ledger.getThread(row.id).meta ?? {}), skipped: { at: ib.at ?? null, reason: t.reason, key } } });
        // An item parked while it was still waiting for the read share was never read; the park says so,
        // and the supply report lists it, instead of a silent stale or expired park.
        event(parkEvent(t.reason), ref, { reason: t.reason, service: ib.service ?? null, ...(ledger.getThread(row.id).meta?.paced ? { paced: true } : {}) });
        bump('threads', 'parked');
        const quoted = t.reason === 'expired' ? ledger.listJobs({ platform, status: 'quoted' }).find((j) => j.threadId === row.id) : null;
        if (quoted) applyAdvance({ type: 'expired', platform, threadId: row.id, jobId: quoted.id, at: now.toISOString(), evidence: { reason: t.reason } });
        continue;
      }
      if (t.action === 'observe' && ib.unread !== false) {
        event('thread.observed', ref, { unread: true, preview: ib.preview ?? null });
        bump('threads', 'observed');
        continue;
      }
      // While the day's budget can pay for no quote, a buyer request stays unread on the platform with no
      // read, park, event or model call, and every tick checks again, so the first ticks of the next Seoul
      // day pick requests by the allocation priority (b223ed7).
      if (t.action === 'open' && mode === 'auto' && spendsCash(descriptor, ib.kind)) {
        const usage = cashUsage();
        if (budgetSpent(cfg, usage)) {
          bump('threads', 'budget');
          continue;
        }
        // While the day's quote cash runs ahead of the elapsed share of the Seoul day (platforms.<id>.quoteGate
        // pace even), the request waits unread the same way, so one burst of requests cannot spend the morning on
        // whatever arrived first. The first hold of a request in a Seoul day is an event the supply report counts.
        if (paceSpent(cfg, usage, now)) {
          bump('threads', 'pace');
          const heldToday = ledger.db.prepare("SELECT 1 FROM events WHERE kind = 'quote.pace_held' AND platform = ? AND ref = ? AND at >= ? LIMIT 1").get(platform, ref, dayStart(dayKey(now)).toISOString());
          if (!heldToday) event('quote.pace_held', ref, { service: ib.service ?? null, cashKRW: usage.cashKRW, maxCashPerDay: cfg.maxCashPerDay });
          continue;
        }
      }
      // With the hour's read share spent, a request waits for a later poll unread and unparked, keeping its
      // place in the order, so the list loads, the hourly reads and the sends keep their room in the action
      // cap. A customer chat is never held: its page loads still count toward the share. The wait is an event
      // and a mark on the thread, which the supply report reads.
      if (ib.kind === 'request' && readsLeft() <= 0) {
        paced += 1;
        bump('threads', 'paced');
        event('thread.paced', ref, { kind: ib.kind, service: ib.service ?? null });
        const pacedMeta = ledger.getThread(row.id).meta ?? {};
        if (!pacedMeta.paced) ledger.upsertThread({ platform, externalId: ref, kind: ib.kind, meta: { ...pacedMeta, paced: { at: now.toISOString() } } });
        continue;
      }
      opened += 1;
      // The pass ends a failure an earlier pass recorded (meta.failed) only when every step of it went
      // through, read, decide, deal and plan alike; a step that throws every tick then still reaches
      // THREAD_ATTEMPTS instead of restarting the count, and an unchanged thread waits for a newer list time.
      let threw = false;
      try {
        const thread = await reading(() => surface.read(ref, { willReply: t.action === 'open', kind: ib.kind ?? 'message' }));
        if (thread.notices?.length) for (const s of moneyToSignals({ platform, threadId: row.id, inbound: { requestId: ib.requestId, service: ib.service, quote: ib.quote }, notices: thread.notices, now })) applyNotice(s, row);
        for (const m of thread.messages ?? []) if (m.direction === 'in') ledger.addMessage({ threadId: row.id, direction: 'in', body: msgText(m), externalId: msgExternalId(m), at: m.at, attachments: m.attachments });
        // A read remembers the list time it covered under the settings key (meta.settled, e5d20eb), so a list
        // time a platform notice moved past the newest stored message is not decided again every tick; a
        // night read holds only for observe ticks.
        const settled = (by) => ({ at: ib.at ?? null, by, key });
        const readMeta = (extra) => ({ ...(ledger.getThread(row.id).meta ?? {}), ...extra });
        if (t.action === 'observe') {
          event('thread.observed', ref, { unread: false, messages: (thread.messages ?? []).length });
          ledger.upsertThread({ platform, externalId: ref, kind: ib.kind ?? 'message', meta: readMeta({ settled: settled('observe') }) });
          bump('threads', 'observed');
          continue;
        }
        // The request page can count more quotes than the list row did; a full request parks before the model.
        const full = fullReason({ kind: ib.kind, quoteCount: thread.quoteCount ?? ib.quoteCount }, descriptor);
        if (full) {
          ledger.upsertThread({ platform, externalId: ref, kind: ib.kind ?? 'message', meta: readMeta({ skipped: { at: ib.at ?? null, reason: full, key } }) });
          event(parkEvent(full), ref, { reason: full, service: ib.service ?? null });
          bump('threads', 'parked');
          continue;
        }
        const stage = stageOf({ page: thread.stage ?? ib.stage, kind: ib.kind }, ledger, platform, row.id);
        const view = { ...thread, platform, ref, kind: ib.kind ?? 'message', stage, serviceLabel: ib.service ?? null, requestId: ib.requestId ?? null, customer: thread.customer ?? ib.customer ?? null, quoteCostKRW: thread.quoteCostKRW ?? ib.quoteCostKRW ?? null };
        const quoteCount = [thread.quoteCount, ib.quoteCount].find(Number.isInteger) ?? null;
        const r = await (ctx.decide ?? defaultDecide)(view, { instance, descriptor, priceTable, ...(ctx.runCodex ? { runCodex: ctx.runCodex } : {}) });
        const d = r.decision;
        // A value-gate park this pass decided again is over; the gate below writes a new one if it drops again.
        const decidedMeta = readMeta({ stage, settled: settled('decide') });
        if (String(decidedMeta.skipped?.reason).startsWith('gate: ')) delete decidedMeta.skipped;
        // The request as it stood when it was decided, which the value gate judged it on: the quotes already on it,
        // the cash a quote costs and the budget the buyer stated. It is rewritten only when one of them moves, so
        // readAt is when that snapshot was first read.
        if (view.kind === 'request') {
          const snapshot = { quoteCount, quoteCostKRW: view.quoteCostKRW, budget: thread.budget ?? null };
          const prev = decidedMeta.request;
          if (!prev || JSON.stringify([prev.quoteCount, prev.quoteCostKRW, prev.budget]) !== JSON.stringify([snapshot.quoteCount, snapshot.quoteCostKRW, snapshot.budget])) decidedMeta.request = { ...snapshot, readAt: now.toISOString() };
        }
        ledger.upsertThread({ platform, externalId: ref, kind: view.kind, service: d.service ?? undefined, language: d.language ?? undefined, status: d.intent, meta: decidedMeta });
        event('brain.decision', ref, { intent: d.intent, service: d.service, confidence: d.confidence, modelCalls: r.modelCalls, needsOperator: d.needsOperator, reply: d.reply !== null });
        // The client's portfolio answer (wp6) lands before a change request in the same message moves the job:
        // a grant only with their own sentence after the delivery, a refusal on every job delivered once. An
        // answer that is not applied is an event and an operator notice naming the fsw deal verb, once per job
        // and answer while the notice stays open, since the same block repeats on every read.
        const perm = permissionSignal({ thread: view, jobs: jobsOfThread(ledger, platform, row.id), decision: d, at: now.toISOString() });
        for (const s of perm.signals) applyAdvance(s);
        if (perm.reason) {
          // A grant dropped by the parser (no client sentence) is reported as the granted claim it was.
          const answer = d.portfolioPermission ?? 'granted';
          event(answer === 'refused' ? 'permission.refusal_unapplied' : 'permission.unverified', ref, { reason: perm.reason, jobId: perm.jobId, jobIds: perm.jobIds });
          const verb = perm.jobIds.length ? perm.jobIds.map((id) => '\nRecord the client answer with: fsw deal ' + id + ' permission granted (or denied)').join('') : '\nNo job on this thread was delivered, so there is nothing to record yet.';
          // A grant claim on a denied or conditional job is keyed by the time of the client message it quotes,
          // so a newer answer opens its own entry while an older one is still open.
          const key = 'portfolio-answer-check:' + (perm.jobId ?? platform + ':' + ref) + ':' + answer + (answer === 'granted' && perm.claimAt ? ':' + perm.claimAt : '');
          effects.push({ type: 'notify', note: { kind: 'order', title: platform + ' ' + (perm.jobIds.length ? perm.jobIds.join(', ') : 'thread ' + ref) + ': a portfolio answer was not applied', body: 'The model read the client as ' + answer + ' on thread ' + ref + ', and it was not applied: ' + perm.reason + '.\nQuote: ' + (d.permissionQuote ?? 'none') + verb, dedupeKey: key } });
        }
        // A change request on delivered work reopens its job whatever happens to the reply.
        const delivered = d.intent === 'revision' ? ledger.listJobs({ platform, status: 'delivered' }).find((j) => j.threadId === row.id) : null;
        if (delivered) applyAdvance({ type: 'revision_requested', platform, threadId: row.id, jobId: delivered.id, at: now.toISOString(), evidence: { text: pendingInbound(view).map(msgText).join('\n') } });
        // A buyer request answered only through a paid quote that the brain rules unsupported is left for
        // the operator's own app and counted for the digest, as a service outside the catalog is; planning it
        // would only ask the operator to reject a quote nobody should pay for (426cb9d). Chats still plan a
        // holding reply, which authorize sends to the operator.
        if (d.intent === 'unsupported' && spendsCash(descriptor, view.kind)) {
          event('thread.operator', ref, { reason: 'unsupported: ' + (d.operatorReason ?? 'not in the catalog or profile'), service: d.service ?? null });
          bump('threads', 'operator');
          continue;
        }
        if (d.reply === null || !r.item) {
          bump('threads', 'none');
          continue;
        }
        // A quote that costs cash goes out only when the request clears the fit floor and a positive expected
        // value at the share-blended win chance (src/economics/quote-gate.mjs, docs/DESIGN.md Decisions). Chat quotes
        // ask no fit and cost nothing, and a bidding board answers with a proposal, so only a paid request quote is
        // judged. A drop parks under this pass's key, so it holds until the list time or the settings move. A send
        // is stamped on the planned payload, and authorize refuses an unapproved paid quote without that stamp.
        let gate = null;
        if (r.item.kind === 'quote' && spendsCash(descriptor, view.kind)) {
          const judged = judgeQuote({
            fit: d.fit ?? null, quoteCount, quoteCostKRW: view.quoteCostKRW, amountKRW: d.quote?.amountKRW ?? null, pricing: d.quote?.pricing ?? null,
            row: r.priceRow, descriptor, arm: armCounts(resultsOnce(), platform, d.service), settings: { minFit: gateSettings(cfg).minFit, minCases: learning().minCases },
          });
          event('quote.judged', ref, { ...judged, fit: d.fit ?? null, fitReason: d.fitReason ?? null, service: d.service ?? null, amountKRW: d.quote?.amountKRW ?? null, quoteCount, quoteCostKRW: view.quoteCostKRW });
          if (judged.verdict === 'drop') {
            ledger.upsertThread({ platform, externalId: ref, kind: view.kind, meta: readMeta({ skipped: { at: ib.at ?? null, reason: judged.reason, key } }) });
            event(parkEvent(judged.reason), ref, { reason: judged.reason, service: ib.service ?? null });
            bump('threads', 'parked');
            continue;
          }
          gate = { verdict: judged.verdict, evKRW: judged.evKRW, p: judged.p, at: now.toISOString() };
        }
        const job = ledger.listJobs({ platform }).filter((j) => j.threadId === row.id).at(-1) ?? null;
        const planned = plan(ledger, { platform, threadId: row.id, jobId: job?.id ?? null, kind: r.item.kind, payload: payloadOf(r, view, gate) });
        bump('threads', planned.inserted ? 'planned' : 'known');
      } catch (err) {
        threw = true;
        result.errors.push({ ref, code: err.code ?? null, message: err.message });
        event('thread.error', ref, { code: err.code ?? null, message: err.message });
        // Recorded so triage passes it again while it has passes left and nothing was sent since
        // (THREAD_ATTEMPTS; src/supervisor/run.mjs:247-248 at f600545).
        const failedRow = ledger.getThread(row.id);
        ledger.upsertThread({ platform, externalId: ref, kind: failedRow.kind, meta: { ...(failedRow.meta ?? {}), failed: { count: (failedRow.meta?.failed?.count ?? 0) + 1, at: now.toISOString(), code: err.code ?? null } } });
        if (err.code === 'FSW_PACING_LIMIT' || err.code === 'FSW_CONFIG_MISSING') break;
      } finally {
        const meta = ledger.getThread(row.id).meta ?? {};
        if (!threw && (meta.failed || meta.paced)) {
          const { failed, paced: wasPaced, ...rest } = meta;
          ledger.upsertThread({ platform, externalId: ref, kind: ledger.getThread(row.id).kind, meta: rest });
        }
      }
    }
    // Items the per-tick cap did not reach, and requests that waited for the read share.
    result.deferred = work.length - done + paced;
    await applyEffects(effects.splice(0), effCtx);
    if (mode !== 'observe') {
      // Sends observed in an earlier pass whose deal signal was lost (a stop between the drain's commit and
      // advance) get it now, dated by when they were observed.
      for (const row of unappliedObserved(ledger, { platform })) applySent(signalOf(row, row.receipt ?? {}, new Date(row.updatedAt)), 'outbox ' + row.id);
      const drained = await drain(ledger, { platform, surface, authorize, ctx: { descriptor, instance, lessonsRules: loadGateRules(instance), mode, now, notify: ctx.notify, hold: (row) => readiness(ledger, row, dealCtx) } });
      for (const x of drained) {
        bump('outbox', x.action);
        if (x.signal) applySent(x.signal, 'outbox ' + x.id);
      }
      await reportFailedSignals();
    }
    if (result.errors.length) result.status = 'partial';
    return result;
  } catch (err) {
    return { ...result, status: 'failed', error: err.message, code: err.code ?? null };
  } finally {
    // Effects a failure left behind still run; the orders job's sweep re-derives any a crash lost.
    if (effects.length) await applyEffects(effects.splice(0), effCtx).catch((err) => result.errors.push({ ref: 'effects', message: err.message }));
    if (surface?.stop) await surface.stop().catch((err) => result.errors.push({ ref: 'stop', message: err.message }));
  }
}
