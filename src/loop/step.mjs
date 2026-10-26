// step(platform, ctx): one platform's pass on one surface session (architect D13): login; sense, each
// list row's money to the deal; triage; read, decide and plan for at most MAX_THREADS_PER_PLATFORM opened
// threads; the deal's effects; the outbox drain; the effects of what the drain observed. Carried from
// runPlatform (src/supervisor/run.mjs:184-251) and processThread (src/pipeline/thread.mjs:117-213) at
// 2c77326. A thread that throws is recorded and the next one still runs. While the Seoul day's budget pays
// no quote, a buyer request on a cash platform is left unread with no model call (b223ed7).
import { createHash } from 'node:crypto';
import { dayKey } from '../core/clock.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { chromeName, pipelineSettings } from '../core/settings.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { openSurface as defaultOpenSurface } from '../surface/index.mjs';
import { fullReason, parkEvent, triage } from '../triage/index.mjs';
import { decide as defaultDecide, loadGateRules, pendingInbound } from '../brain/respond.mjs';
import { authorize, budgetSpent, operatingMode, spendsCash } from '../policy/authorize.mjs';
import { drain, plan, signalOf } from '../outbox/index.mjs';
import { quotaUsage } from '../outbox/usage.mjs';
import { advance, moneyToSignals, readiness, stageOf, unappliedObserved } from '../deal/index.mjs';
import { answeredServices, parkKey } from '../economics/catalog.mjs';
import { latestAllocation, prioritize } from '../economics/priority.mjs';
import { loadRecipe } from '../work/index.mjs';
import { applyEffects } from './effects.mjs';
import { recordOrderCounters } from './orders.mjs';

// One platform opens at most this many threads per tick, so a backlog cannot hold the tick past the next
// 5-minute mark (src/supervisor/run.mjs:22-24).
export const MAX_THREADS_PER_PLATFORM = 10;

const msgText = (m) => String(m.text ?? m.body ?? '');
const msgExternalId = (m) => String(m.externalId ?? m.id ?? createHash('sha1').update((m.at ?? '') + '\n' + msgText(m)).digest('hex').slice(0, 16));

// The outbox payload of one decision (field chains in 030 section 4).
function payloadOf(result, view) {
  const { decision: d, item, priceRow } = result;
  const q = d.quote;
  return {
    text: item.text, amountKRW: q?.amountKRW ?? null, priceType: q?.priceType ?? null, split: q?.split ?? null, scope: q?.scope ?? null, deliveryDays: q?.deliveryDays ?? null,
    costKRW: item.costKRW ?? null, serviceLabel: item.serviceLabel ?? null, service: d.service ?? null, thread: item.thread, decision: d, priceRow: priceRow ?? null, requestId: view.requestId ?? null, customer: view.customer ?? null,
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
  const event = (kind, ref, payload) => ledger.addEvent({ kind, platform, ref, payload });
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
    if (!result.login?.loggedIn) {
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
        for (const s of moneyToSignals({ platform, threadId: row.id, inbound: ib, now })) applyAdvance(s);
      } catch (err) {
        result.errors.push({ ref: String(ib.ref), code: err.code ?? null, message: err.message });
        event('thread.error', String(ib.ref), { code: err.code ?? null, message: err.message, stage: 'money' });
      }
    }
    // The settings every park of this pass is decided under (22fbb4b): a park holds only while they do.
    const key = parkKey(instance.config, descriptor);
    // Open conversations first, then requests by the allocation weight of their service.
    const work = prioritize(inbound, { allocation: latestAllocation(instance), descriptor });
    let opened = 0;
    let done = 0;
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
        event(parkEvent(t.reason), ref, { reason: t.reason, service: ib.service ?? null });
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
      if (t.action === 'open' && mode === 'auto' && spendsCash(descriptor, ib.kind) && budgetSpent(cfg, cashUsage())) {
        bump('threads', 'budget');
        continue;
      }
      // With the hour's read share spent, the item waits for a later poll unread and unparked, so the list
      // loads, the hourly reads and the sends keep their room in the action cap.
      if (readsLeft() <= 0) {
        bump('threads', 'paced');
        continue;
      }
      opened += 1;
      try {
        const thread = await reading(() => surface.read(ref, { willReply: t.action === 'open', kind: ib.kind ?? 'message' }));
        if (thread.notices?.length) for (const s of moneyToSignals({ platform, threadId: row.id, inbound: { requestId: ib.requestId, service: ib.service, quote: ib.quote }, notices: thread.notices, now })) applyAdvance(s);
        for (const m of thread.messages ?? []) if (m.direction === 'in') ledger.addMessage({ threadId: row.id, direction: 'in', body: msgText(m), externalId: msgExternalId(m), at: m.at, attachments: m.attachments });
        // A read remembers the list time it covered under the settings key (meta.settled, e5d20eb), so a list
        // time a platform notice moved past the newest stored message is not decided again every tick; a
        // night read holds only for observe ticks.
        const settled = (by) => ({ at: ib.at ?? null, by, key });
        // A read that went through ends a failure an earlier pass recorded (meta.failed), which would
        // otherwise send the unchanged thread back through triage every tick until something went out.
        const readMeta = (extra) => {
          const { failed, ...meta } = ledger.getThread(row.id).meta ?? {};
          return { ...meta, ...extra };
        };
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
        const r = await (ctx.decide ?? defaultDecide)(view, { instance, descriptor, priceTable, ...(ctx.runCodex ? { runCodex: ctx.runCodex } : {}) });
        const d = r.decision;
        ledger.upsertThread({ platform, externalId: ref, kind: view.kind, service: d.service ?? undefined, language: d.language ?? undefined, status: d.intent, meta: readMeta({ stage, settled: settled('decide') }) });
        event('brain.decision', ref, { intent: d.intent, service: d.service, confidence: d.confidence, modelCalls: r.modelCalls, needsOperator: d.needsOperator, reply: d.reply !== null });
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
        const job = ledger.listJobs({ platform }).filter((j) => j.threadId === row.id).at(-1) ?? null;
        const planned = plan(ledger, { platform, threadId: row.id, jobId: job?.id ?? null, kind: r.item.kind, payload: payloadOf(r, view) });
        bump('threads', planned.inserted ? 'planned' : 'known');
      } catch (err) {
        result.errors.push({ ref, code: err.code ?? null, message: err.message });
        event('thread.error', ref, { code: err.code ?? null, message: err.message });
        // Recorded so triage passes it again while it has passes left and nothing was sent since
        // (THREAD_ATTEMPTS; src/supervisor/run.mjs:247-248 at f600545).
        const failedRow = ledger.getThread(row.id);
        ledger.upsertThread({ platform, externalId: ref, kind: failedRow.kind, meta: { ...(failedRow.meta ?? {}), failed: { count: (failedRow.meta?.failed?.count ?? 0) + 1, at: now.toISOString(), code: err.code ?? null } } });
        if (err.code === 'FSW_PACING_LIMIT' || err.code === 'FSW_CONFIG_MISSING') break;
      }
    }
    result.deferred = work.length - done;
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
