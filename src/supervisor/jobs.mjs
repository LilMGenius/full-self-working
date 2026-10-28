// The supervisor's job table (docs/DESIGN.md, Scheduling): the handler of every job id in run/state.json lastRuns,
// and the sign-in the loop step calls when a surface reports no login.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey } from '../core/clock.mjs';
import { logEvent } from '../core/log.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { priceLearningSettings } from '../core/settings.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { readIdentity } from '../platforms/onboarding.mjs';
import { answeredServices } from '../economics/catalog.mjs';
import { latestTable, refreshPriceTable } from '../economics/price-table.mjs';
import { marketPlatforms, sampleMarket } from '../economics/sampling.mjs';
import { SAMPLERS, hasSurface } from '../surface/index.mjs';
import { withMarketPage } from '../surface/owned-page.mjs';
import { applyEffects, step } from '../loop/index.mjs';
import { startAllowed, sweep } from '../deal/index.mjs';
import { startDue } from '../work/index.mjs';
import { writeSupply } from './supply.mjs';

// A platform that signed out is signed in again from the logins file config logins names
// ({<platform>: {method: 'email', email, password}}, kept outside the repository), at most once an hour,
// so a wrong password or a page that asks for a human check cannot lock the account by retrying. The
// values go only into the platform's form; the event records whether the sign-in worked (36400c4). The
// loop step calls it through its ctx when a surface reports no login.
// An entry {method: 'google'} signs in with the operator's Google account, whose email the identity file
// holds (readIdentity); the surface presses its site's Google button with it. A Google sign-in that fails,
// or an identity file without the email, asks the operator once per platform while that notice is open,
// since a board with publicSense sends no login notice of its own.
// The attempt is recorded whether signIn returns or throws, since a throw after the form was sent (a
// click or tool timeout) has already submitted the password; any text the page or tool returns has the
// password cut out before it is stored or thrown on.
// A sign-in that found the account already signed in (alreadySignedIn: the first read was a page still
// rendering, as on 2026-10-26 14:50Z) typed nothing, so it is recorded as platform.login_reread and does
// not hold the next real sign-in for an hour; one that found no form and still signed out counts, since
// a page asking for a human check shows no form either. Every success, that one included, is the
// surface's own login check reading true after the sign-in; any other reading is a failed sign-in.
export const SIGN_IN_GAP_MS = 60 * 60_000;

export async function signInAgain({ id, surface, instance, ledger, now, notify = notifyOperator }) {
  if (typeof surface.signIn !== 'function') return null;
  const file = instance.config?.logins;
  if (!file || !existsSync(file)) return null;
  const entry = JSON.parse(readFileSync(file, 'utf8'))[id];
  const google = entry?.method === 'google';
  if (!google && (entry?.method !== 'email' || !entry.email || !entry.password)) return null;
  const last = ledger.db.prepare("SELECT at FROM events WHERE kind = 'platform.sign_in' AND platform = ? ORDER BY id DESC LIMIT 1").get(id);
  if (last && now.getTime() - Date.parse(last.at) < SIGN_IN_GAP_MS) return null;
  // The surface's login check after a sign-in; one that throws is a reading of no sign-in with its cause, so
  // the attempt is still recorded, counts against the hour and reaches the operator like any failure.
  const recheck = async () => {
    try {
      return await surface.login();
    } catch (err) {
      return { loggedIn: null, code: err.code ?? null, detail: 'the login check threw: ' + err.message };
    }
  };
  const failed = (payload) => {
    ledger.addEvent({ at: now.toISOString(), kind: 'platform.sign_in', platform: id, payload: { ok: false, method: 'google', ...payload } });
    return notify(instance, { kind: 'login', title: id + ' could not sign in with Google', body: (payload.code ? payload.code + ' ' : '') + payload.reason + '\nSign in to ' + id + ' in Chrome once; fsw tries the Google sign-in again at most once an hour.', dedupeKey: 'sign-in:' + id + ':google' });
  };
  if (google) {
    const identity = readIdentity({ instance });
    const email = identity?.googleEmail;
    if (!email) {
      await failed({ code: null, reason: identity?.message ?? 'the identity file has no person.google_login_email' });
      return null;
    }
    let r;
    try {
      r = await surface.signIn({ email });
    } catch (err) {
      await failed({ code: err.code ?? null, reason: err.message });
      throw err;
    }
    if (r?.signedIn === true && r.alreadySignedIn === true) {
      const back = await recheck();
      if (back?.loggedIn !== true) {
        await failed({ code: back?.code ?? null, reason: 'the sign-in found the account signed in, but the login check reads ' + String(back?.loggedIn ?? null) + (back?.detail ? ': ' + back.detail : '') });
        return null;
      }
      ledger.addEvent({ at: now.toISOString(), kind: 'platform.login_reread', platform: id, payload: { ok: true, reason: 'signed in already; nothing was pressed' } });
      return back;
    }
    if (r?.signedIn !== true) {
      await failed({ code: null, reason: r?.reason ?? 'still signed out after the Google sign-in' });
      return null;
    }
    // Only the surface's own login check reading true is a sign-in; a page it cannot read is a failure.
    const back = await recheck();
    if (back?.loggedIn !== true) {
      await failed({ code: back?.code ?? null, reason: 'the Google sign-in finished but the login check reads ' + String(back?.loggedIn ?? null) + (back?.detail ? ': ' + back.detail : '') });
      return null;
    }
    ledger.addEvent({ at: now.toISOString(), kind: 'platform.sign_in', platform: id, payload: { ok: true, method: 'google', reason: r.reason ?? null } });
    return back;
  }
  const login = entry;
  const scrub = (s) => (s == null ? null : String(s).split(login.password).join('[password]'));
  let r;
  try {
    r = await surface.signIn({ email: login.email, password: login.password });
  } catch (err) {
    const message = scrub(err.message);
    ledger.addEvent({ at: now.toISOString(), kind: 'platform.sign_in', platform: id, payload: { ok: false, code: err.code ?? null, reason: message } });
    throw Object.assign(new Error(message), { code: err.code ?? null });
  }
  if (r?.signedIn === true && r.alreadySignedIn === true) {
    const back = await recheck();
    if (back?.loggedIn !== true) {
      ledger.addEvent({ at: now.toISOString(), kind: 'platform.sign_in', platform: id, payload: { ok: false, code: back?.code ?? null, reason: scrub('the sign-in found the account signed in, but the login check reads ' + String(back?.loggedIn ?? null) + (back?.detail ? ': ' + back.detail : '')) } });
      return null;
    }
    ledger.addEvent({ at: now.toISOString(), kind: 'platform.login_reread', platform: id, payload: { ok: true, reason: 'signed in already; nothing was typed' } });
    return back;
  }
  if (r?.signedIn !== true) {
    ledger.addEvent({ at: now.toISOString(), kind: 'platform.sign_in', platform: id, payload: { ok: false, reason: scrub(r?.reason) } });
    return null;
  }
  const back = await recheck();
  const ok = back?.loggedIn === true;
  ledger.addEvent({ at: now.toISOString(), kind: 'platform.sign_in', platform: id, payload: { ok, ...(ok ? {} : { code: back?.code ?? null }), reason: scrub(ok ? r?.reason : 'the sign-in finished but the login check reads ' + String(back?.loggedIn ?? null) + (back?.detail ? ': ' + back.detail : '')) } });
  return ok ? back : null;
}

const latestPriceRows = (instance) => latestTable(instance.paths.pricing)?.table.rows ?? [];

// One market run over the configured platforms of a cadence (config.market.cadence), each through its
// market engine (withMarketPage).
async function marketJob(ctx, cadence) {
  const ids = marketPlatforms(ctx.instance.config, cadence, SAMPLERS);
  if (!ids.length) return { status: 'skipped', detail: 'no platform samples on the ' + cadence + ' cadence' };
  const r = await sampleMarket(ctx.instance, { platforms: ids, samplers: SAMPLERS, withPage: ctx.withPage ?? withMarketPage, log: ctx.log });
  return { status: r.exitCode === 0 ? 'ok' : 'partial', sampled: ids, written: r.written, entries: r.entries.length, errors: r.errors };
}

function pollTargets(instance) {
  return Object.entries(instance.config.platforms ?? {}).filter(([, p]) => p.enabled && (p.mode === 'draft' || p.mode === 'auto')).map(([id]) => id);
}

// One loop step per platform, in parallel, each on its own surface session (architect D13).
async function runPlatforms(ids, ctx) {
  const priceTable = latestPriceRows(ctx.instance);
  const results = await Promise.all(ids.map((id) => step(id, { ...ctx, priceTable, signInAgain: (a) => signInAgain({ ...a, ...(ctx.notify ? { notify: ctx.notify } : {}) }) })));
  for (const r of results) record(ctx, 'supervisor.platform', r.platform, r);
  const failed = results.filter((r) => r.status === 'failed');
  return { status: failed.length ? (failed.length === results.length ? 'failed' : 'partial') : 'ok', platforms: results };
}

// Job handlers print through ctx.log and return {status, ...detail}; status is ok, partial, failed or
// skipped. The ids are the lastRuns keys of run/state.json and never change (D14).
export const JOB_HANDLERS = {
  // Supervisor self-check, the BrowserSkill keeper, the read pass on observe platforms, and the lead
  // supply report (architect D18, shipped here by the 000 amendment).
  async hourly(ctx) {
    const self = { pid: process.pid, uptimeMin: Math.round(process.uptime() / 60), rssMB: Math.round(process.memoryUsage().rss / 1048576), ledgerEvents: ctx.ledger.counts().events };
    // The tick checked the keeper before its first job (runTick, b2ec31d); the hourly job reports that check.
    const browser = ctx.browser ?? { status: 'no keeper' };
    // Observe platforms are not polled every 5 minutes, so their login and read pass runs here.
    const observeIds = Object.entries(ctx.instance.config.platforms ?? {}).filter(([, q]) => q.enabled && q.mode === 'observe').map(([id]) => id);
    const observed = observeIds.length ? await runPlatforms(observeIds, ctx) : { status: 'ok', platforms: [] };
    const supply = await writeSupply({ instance: ctx.instance, ledger: ctx.ledger, now: ctx.now, ...(ctx.openSurface ? { openSurface: ctx.openSurface } : {}), ...(ctx.notify ? { notify: ctx.notify } : {}) });
    const { recordReviews } = await import('../loop/reviews.mjs');
    const reviews = await recordReviews({ instance: ctx.instance, ledger: ctx.ledger, now: ctx.now, ...(ctx.openSurface ? { openSurface: ctx.openSurface } : {}), ...(ctx.notify ? { notify: ctx.notify } : {}) });
    // A daemon busy past its status timeout is wedged on its pipe as far as the platforms can tell.
    const bad = ['daemon start failed', 'no daemon', 'daemon busy', 'keeper check failed'].includes(browser.status) || observed.status !== 'ok' || supply.status !== 'ok' || reviews.some((r) => ['failed', 'unread'].includes(r.status) || r.stop || r.stale);
    return { status: bad ? 'partial' : 'ok', self, browser, observe: observed.platforms.map((q) => ({ platform: q.platform, status: q.status })), supply: { file: supply.file, platforms: supply.reports.map((r) => ({ platform: r.platform, status: r.status, awaitingReply: r.awaitingReply })) }, reviews };
  },
  async poll(ctx) {
    const ids = pollTargets(ctx.instance);
    if (!ids.length) return { status: 'skipped', detail: 'no platform in draft or auto mode' };
    return runPlatforms(ids, ctx);
  },
  // Ledger only, right after the poll: effects a crash lost come back (deal sweep), then paid and
  // revision jobs start within jobs.maxParallel. Delivery planning and closing happen in the deal when the
  // run and the money signals arrive.
  async orders(ctx) {
    const { instance, ledger } = ctx;
    const applied = await applyEffects(sweep(ledger, { instance }), { instance, ledger, spawnJob: ctx.spawnJob, notify: ctx.notify });
    const start = await startDue({ instance, ledger, ...(ctx.spawnJob ? { spawnJob: ctx.spawnJob } : {}), ...(ctx.notify ? { notify: ctx.notify } : {}), startAllowed: (job, recipe) => startAllowed(job, ledger, loadDescriptor(job.platform), recipe) });
    const failed = applied.filter((a) => a.error);
    return { status: failed.length ? 'partial' : 'ok', planned: applied.filter((a) => a.type === 'plan_outbox').length, ...start };
  },
  async projects(ctx) {
    const { projectsJob } = await import('../projects/job.mjs');
    return projectsJob(ctx);
  },
  // The daily market slot samples the day-cadence platforms and the hourly slice the hour-cadence ones.
  async market(ctx) {
    return marketJob(ctx, 'day');
  },
  async 'market-hour'(ctx) {
    return marketJob(ctx, 'hour');
  },
  // Each row's adapter flag says whether this build has a surface for its platform.
  async price(ctx) {
    const r = await refreshPriceTable(ctx.instance, { adapterFor: hasSurface, ledger: ctx.ledger, day: dayKey(ctx.now), log: ctx.log });
    return { status: 'ok', written: r.written, rows: r.rows.length, viable: r.rows.filter((x) => x.viable).length, learned: r.rows.filter((x) => x.learned && x.learned.factor !== 1).length };
  },
  async allocation(ctx) {
    const [{ armStats }, { allocate }, { dayStart, quoteResults }, services] = await Promise.all([
      import('../economics/yield.mjs'),
      import('../economics/allocate.mjs'),
      import('../economics/quote-results.mjs'),
      import('../economics/services.json', { with: { type: 'json' } }).then((m) => m.default),
    ]);
    const enabled = Object.entries(ctx.instance.config.platforms ?? {}).filter(([, q]) => q.enabled).map(([id]) => id);
    const descriptors = Object.fromEntries(enabled.map((id) => [id, loadDescriptor(id)]));
    // A catalog service a platform does not answer (config platforms.<id>.services) gets no arm there (14d2f17).
    // The results, as of the same 00:00 Seoul, that the price job learned from a moment earlier (JOBS order,
    // src/supervisor/schedule.mjs).
    const results = quoteResults(ctx.ledger, { asOf: dayStart(dayKey(ctx.now)), expireAfterDays: priceLearningSettings(ctx.instance.config).expireAfterDays });
    const arms = armStats(ctx.ledger, { descriptors, services, config: ctx.instance.config, results })
      .filter((a) => !(a.service in services) || answeredServices(ctx.instance.config, a.platform, services).includes(a.service));
    const weights = allocate(arms, { priceTable: latestPriceRows(ctx.instance), config: ctx.instance.config });
    const file = join(ctx.instance.paths.pricing, 'allocation-' + dayKey(ctx.now) + '.json');
    mkdirSync(ctx.instance.paths.pricing, { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify({ at: ctx.now.toISOString(), weights }, null, 2) + '\n');
    renameSync(file + '.tmp', file);
    return { status: 'ok', file, arms: weights.filter((w) => w.weight > 0).length };
  },
  // The day's reach and quality (read once per Seoul day) and README captures for repository items with no
  // media, then the ranked save. Items with neither media nor a repository are told to the operator once.
  async portfolio(ctx) {
    const [{ syncPortfolio, loadItems, itemsFromProfile }, { readSignals }, { captureRepoMedia }, { openRenderer }] = await Promise.all([
      import('../portfolio/store.mjs'), import('../portfolio/signals.mjs'), import('../portfolio/media.mjs'), import('../render/html2png.mjs'),
    ]);
    const open = ctx.openRenderer ?? openRenderer;
    const saved = loadItems(ctx.instance);
    // Today's contribution marks come from the profile, so a saved item made before this unit is marked too.
    const marked = new Map(itemsFromProfile(ctx.instance.profile).map((i) => [i.id, i.contribution]));
    const items = (saved.length ? saved : itemsFromProfile(ctx.instance.profile)).map((i) => ({ ...i, contribution: marked.get(i.id) ?? i.contribution ?? false }));
    const signals = await readSignals(ctx.instance, items, { fetch: ctx.fetch ?? fetch, openRenderer: open, now: ctx.now });
    const renderer = await open();
    let captured;
    try {
      captured = await captureRepoMedia(items, { renderer, dir: join(ctx.instance.paths.portfolio, 'media'), reach: signals.reach });
    } finally {
      await renderer.close();
    }
    if (captured.missing.length) await (ctx.notify ?? notifyOperator)(ctx.instance, { kind: 'portfolio', title: captured.missing.length + ' portfolio items have no media', body: 'Add an image to profile.projects[].media for: ' + captured.missing.map((id) => id + (captured.reasons[id] ? ' (' + captured.reasons[id] + ')' : '')).join(', '), dedupeKey: 'portfolio-media:' + captured.missing.join(',') });
    const shown = syncPortfolio(ctx.instance, ctx.ledger, { signals, media: captured.media });
    return { status: 'ok', shown: shown.length, withFame: shown.filter((i) => i.reach?.fame != null).length, missingMedia: captured.missing.length };
  },
  // Cases into lessons, then the playbook and learned gate rules (src/cli/learn.mjs:6-16 at 2c77326 folded in).
  async learn(ctx) {
    const [{ writeLessons }, { refreshPlaybook }] = await Promise.all([import('../learning/lessons.mjs'), import('../learning/playbook.mjs')]);
    const lessons = await writeLessons(ctx.instance, ctx.runCodex ? { runCodex: ctx.runCodex } : {});
    const pb = await refreshPlaybook(ctx.instance, ctx.runCodex ? { runCodex: ctx.runCodex } : {});
    return { status: 'ok', lessons: lessons.lessons.length, newCases: lessons.newCases, rules: pb.rules.length, refused: pb.rejected.length, playbookChanged: pb.playbookChanged };
  },
  async digest(ctx) {
    const { writeDigest } = await import('./digest.mjs');
    const d = await writeDigest({ instance: ctx.instance, ledger: ctx.ledger, now: ctx.now, ...(ctx.notify ? { notify: ctx.notify } : {}) });
    return { status: 'ok', file: d.file, notified: d.notified };
  },
  // Hourly: reads /my-gigs for every published gig; a gig on sale is announced once, a rejected one is
  // recorded as a learning case and rebuilt from kmong's notice.
  async listings(ctx) {
    const { listingsWatch } = await import('../listings/watch.mjs');
    return listingsWatch(ctx);
  },
  // Daily after the portfolio job: rebuilds a gig on sale whose top portfolio items changed.
  async 'listings-refresh'(ctx) {
    const { listingsRefresh } = await import('../listings/watch.mjs');
    return listingsRefresh(ctx);
  },
};

export function record(ctx, kind, ref, payload) {
  const platform = payload.platform ?? null;
  ctx.ledger.addEvent({ kind, platform, ref, payload });
  logEvent(ctx.instance, kind, { ref, ...payload });
}
