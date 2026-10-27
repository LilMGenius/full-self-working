// The lead supply report (architect D18; 000 amendment: it ships with the hourly job and leads the
// digest). Per enabled platform: listing review states, offered services without request items, inbound
// parked over the last SUPPLY_DAYS by reason, the awaiting_reply count and outbox items waiting for the
// operator. It says why nothing sells before anyone suspects the loop: on 2026-10-25 every live inbound
// item was parked and every kmong gig waited for review (architect F1). The report is the supervisor's
// SupplyReport, its own type: it reads only services from the surface's supply(), which answers 003's
// Supply, and builds the rest from the ledger and the listing review files.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey, hourKey } from '../core/clock.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { pipelineSettings } from '../core/settings.mjs';
import { answeredServices, catalogServicesFor } from '../economics/catalog.mjs';
import { dayStart, quoteFunnel } from '../economics/quote-results.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { listingsDir, readPublished } from '../listings/gig.mjs';
import { gigStatus, readReview } from '../listings/review.mjs';
import { openSurface as defaultOpenSurface } from '../surface/index.mjs';
import { awaitingReply } from '../triage/index.mjs';

export const SUPPLY_DAYS = 7;
export const CANDIDATES_SHOWN = 5;
const DAY_MS = 86_400_000;
const FILE_RE = /^supply-(\d{10})\.json$/;
export const supplyDir = (instance) => join(instance.paths.operator, 'supply');

// Distinct threads parked in the window, by the event kinds the loop writes (src/triage parkEvent). A park
// whose reason starts "gate: " is the quote value gate's (src/loop/step.mjs) and counts apart from stale.
export function parkedCounts(ledger, platform, now) {
  const since = now.getTime() - SUPPLY_DAYS * DAY_MS;
  const seen = { outOfCatalog: new Set(), stale: new Set(), expired: new Set(), notice: new Set(), gate: new Set() };
  const rows = ledger.db.prepare("SELECT kind, ref, payload, at FROM events WHERE platform = ? AND kind IN ('thread.operator', 'thread.skipped', 'thread.system')").all(platform);
  for (const e of rows.filter((r) => Date.parse(r.at) >= since && Date.parse(r.at) <= now.getTime())) {
    const reason = String(JSON.parse(e.payload ?? '{}')?.reason ?? '');
    const bucket = e.kind === 'thread.operator' ? 'outOfCatalog' : e.kind === 'thread.system' ? 'notice' : reason.startsWith('expired') ? 'expired' : reason.startsWith('gate: ') ? 'gate' : 'stale';
    seen[bucket].add(e.ref);
  }
  return Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.size]));
}

// The platform labels behind the out-of-catalog count that the catalog still covers with no service, by
// distinct threads parked under each in the window, the most first: the queue of services to add
// (AGENTS.md, the catalog rule). A label mapped since its park drops out, and a label parked because the
// instance does not answer its service is a setting, so neither is a candidate.
export function expansionCandidates(ledger, descriptor, now, limit = CANDIDATES_SHOWN) {
  const since = now.getTime() - SUPPLY_DAYS * DAY_MS;
  const byLabel = new Map();
  const rows = ledger.db.prepare("SELECT ref, payload, at FROM events WHERE platform = ? AND kind = 'thread.operator'").all(descriptor.id);
  for (const e of rows.filter((r) => Date.parse(r.at) >= since && Date.parse(r.at) <= now.getTime())) {
    const { reason, service: label } = JSON.parse(e.payload ?? '{}') ?? {};
    if (!label || !String(reason ?? '').startsWith('catalog:') || catalogServicesFor(descriptor, label)?.length !== 0) continue;
    if (!byLabel.has(label)) byLabel.set(label, new Set());
    byLabel.get(label).add(e.ref);
  }
  return [...byLabel].map(([label, refs]) => ({ label, threads: refs.size })).sort((a, b) => b.threads - a.threads || a.label.localeCompare(b.label)).slice(0, limit);
}

// The Seoul day's quote verdicts (quote.judged, one per distinct request and reason) and the requests held
// back by the pace (quote.pace_held, which the step writes once a request a day). A reason prints without
// its "gate: " prefix, and an expiry by its first word.
export function judgedCounts(ledger, platform, now) {
  const day = dayKey(now);
  const from = dayStart(day).getTime();
  const inDay = (r) => Date.parse(r.at) >= from && Date.parse(r.at) <= now.getTime();
  const pairs = new Map();
  for (const e of ledger.db.prepare("SELECT ref, payload, at FROM events WHERE platform = ? AND kind = 'quote.judged'").all(platform).filter(inDay)) {
    const reason = String(JSON.parse(e.payload ?? '{}')?.reason ?? 'unknown');
    pairs.set(e.ref + ' ' + reason, reason.startsWith('gate: ') ? reason.slice(6) : reason.split(':')[0]);
  }
  const byReason = {};
  for (const key of pairs.values()) byReason[key] = (byReason[key] ?? 0) + 1;
  const paceHeld = new Set(ledger.db.prepare("SELECT ref, at FROM events WHERE platform = ? AND kind = 'quote.pace_held'").all(platform).filter(inDay).map((r) => r.ref)).size;
  return { day, byReason, paceHeld };
}

// Published kmong gigs by the review state the listings job last saw (src/listings/review.mjs codes).
// Requests that waited for the hourly read share (thread.paced) over the window, and those of them parked
// stale or expired without ever being read (a park event marked paced).
export function pacedCounts(ledger, platform, now) {
  const since = now.getTime() - SUPPLY_DAYS * DAY_MS;
  const inWindow = (r) => Date.parse(r.at) >= since && Date.parse(r.at) <= now.getTime();
  const waited = new Set(ledger.db.prepare("SELECT ref, at FROM events WHERE platform = ? AND kind = 'thread.paced'").all(platform).filter(inWindow).map((r) => r.ref));
  const parkedUnread = new Set(ledger.db.prepare("SELECT ref, at, payload FROM events WHERE platform = ? AND kind = 'thread.skipped'").all(platform).filter((r) => inWindow(r) && JSON.parse(r.payload ?? '{}')?.paced === true).map((r) => r.ref));
  return { waited: waited.size, parkedUnread: parkedUnread.size };
}

export function listingStates(instance) {
  const published = readPublished(instance);
  if (!published.length) return null;
  const byStatus = {};
  for (const p of published) {
    const s = readReview(listingsDir(instance), p.service).lastStatus ?? gigStatus(p.status);
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  return { published: published.length, byStatus };
}

export async function supplyReport(platform, { instance, ledger, now = new Date(), openSurface = defaultOpenSurface }) {
  const descriptor = loadDescriptor(platform);
  const notes = [];
  let settings = null;
  try {
    settings = pipelineSettings(instance.config);
  } catch (err) {
    notes.push(err.message);
  }
  const waiting = Object.fromEntries(['awaiting_operator', 'approved'].map((s) => [s, ledger.listOutbox({ platform, statuses: [s] }).length]));
  const report = {
    platform, hour: hourKey(now), at: now.toISOString(), status: 'ok',
    listings: platform === 'kmong' ? listingStates(instance) : null,
    services: null,
    parked: parkedCounts(ledger, platform, now),
    paced: pacedCounts(ledger, platform, now),
    judged: judgedCounts(ledger, platform, now),
    candidates: expansionCandidates(ledger, descriptor, now),
    funnel: quoteFunnel(ledger, { platform, now, days: SUPPLY_DAYS }),
    awaitingReply: settings ? ledger.listThreads({ platform }).filter((t) => t.kind !== 'project' && awaitingReply(t, ledger.threadMessages(t.id), { now, settings })).length : null,
    waiting, notes,
  };
  let surface;
  try {
    surface = await openSurface(platform);
    if (typeof surface.supply === 'function') {
      const login = await surface.login();
      if (!login?.loggedIn) throw Object.assign(new Error('not logged in'), { code: 'FSW_SUPPLY_LOGIN' });
      // A platform without request items on its services (kmong) answers services null, and its report has none.
      const offered = (await surface.supply()).services;
      // A platform that matches requests to the items set on each offered service sends an unset one
      // nothing (AGENTS.md rule); a service the instance does not answer there is the operator's own, as in
      // fsw doctor's items check (src/cli/doctor.mjs:186-191 at 14d2f17).
      const answered = answeredServices(instance.config, platform);
      if (offered) report.services = { offered: offered.length, withoutItems: offered.filter((s) => !s.itemsSet && catalogServicesFor(descriptor, s.name)?.some((sv) => answered.includes(sv))).map((s) => s.name) };
      // What the platform spends on the account by itself beside fsw's own quotes (AGENTS.md rule): the
      // day's charges by source and each automatic campaign's daily budget against platformSpendMaxPerDay.
      if (typeof surface.spend === 'function') {
        const { today, campaigns } = await surface.spend({ now });
        const limitKRW = instance.config.platforms?.[platform]?.platformSpendMaxPerDay ?? null;
        report.spend = { today, campaigns, limitKRW, over: limitKRW == null ? [] : campaigns.filter((c) => c.dailyBudgetKRW == null || c.dailyBudgetKRW > limitKRW) };
      }
    }
  } catch (err) {
    report.status = 'partial';
    notes.push((err.code ? err.code + ' ' : '') + err.message);
  } finally {
    if (surface?.stop) await surface.stop().catch((err) => notes.push('stop: ' + err.message));
  }
  return report;
}

// The hourly job's write: one file per Seoul hour, the period it covers (roundClockSchedules).
export async function writeSupply({ instance, ledger, now = new Date(), openSurface, notify = notifyOperator }) {
  const ids = Object.entries(instance.config.platforms ?? {}).filter(([, p]) => p.enabled).map(([id]) => id);
  const reports = [];
  for (const id of ids) reports.push(await supplyReport(id, { instance, ledger, now, ...(openSurface ? { openSurface } : {}) }));
  const dir = supplyDir(instance);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'supply-' + hourKey(now) + '.json');
  writeFileSync(file + '.tmp', JSON.stringify({ hour: hourKey(now), reports }, null, 2) + '\n');
  renameSync(file + '.tmp', file);
  ledger.addEvent({ kind: 'supervisor.supply', payload: { file, reports: reports.map((r) => ({ platform: r.platform, status: r.status, awaitingReply: r.awaitingReply, parked: r.parked })) } });
  for (const r of reports.filter((x) => x.spend?.over.length)) {
    await notify(instance, { kind: 'operator', title: r.platform + ' automatic sending may spend more than platformSpendMaxPerDay', body: [...campaignLines(r.spend.over), 'platformSpendMaxPerDay: ' + krw(r.spend.limitKRW), 'Lower the campaign budget on the platform or change the setting (fsw settings set platforms.' + r.platform + '.platformSpendMaxPerDay <KRW>).'].join('\n'), dedupeKey: 'platform-spend:' + r.platform + ':' + dayKey(now) });
  }
  return { status: reports.every((r) => r.status === 'ok') ? 'ok' : 'partial', file, reports };
}

export function latestSupply(instance) {
  const dir = supplyDir(instance);
  const name = existsSync(dir) ? readdirSync(dir).filter((f) => FILE_RE.test(f)).sort().at(-1) : null;
  return name ? { file: name, ...JSON.parse(readFileSync(join(dir, name), 'utf8')) } : null;
}

const counts = (m) => Object.entries(m).filter(([, v]) => v).map(([k, v]) => k + ' ' + v).join(', ') || 'none';
const krw = (n) => Number(n).toLocaleString('en-US') + ' KRW';
const campaignLines = (campaigns) => campaigns.map((c) => 'campaign ' + (c.name ?? c.id) + ': ' + (c.dailyBudgetKRW == null ? 'daily budget unread' : krw(c.dailyBudgetKRW) + ' a day') + (c.maxPerDay != null ? ', at most ' + c.maxPerDay + ' quotes' : ''));

// The spend part of a platform's line: the day's charges by source, then each automatic campaign.
function spendParts(s) {
  const t = s.today;
  const parts = ['cash spent ' + t.day + ': quotes ' + krw(t.quotesKRW) + ' (' + t.quotes + '), smart quotes ' + krw(t.smartQuotesKRW) + ' (' + t.smartQuotes + '), other ' + krw(t.otherKRW) + (t.complete ? '' : ', more rows than the page lists')];
  parts.push(s.campaigns.length ? campaignLines(s.campaigns).join(', ') : 'no smart quote campaign');
  if (s.over.length) parts.push(s.over.length + ' over platformSpendMaxPerDay ' + krw(s.limitKRW));
  return parts;
}

// Digest lines, one per platform, plain figures only.
export function supplyLines(supply) {
  if (!supply) return ['- none yet (the hourly job writes it)'];
  if (!supply.reports.length) return ['- no platform is enabled'];
  return supply.reports.map((r) => {
    const parts = [(r.awaitingReply ?? 'unknown') + ' awaiting reply', 'parked in ' + SUPPLY_DAYS + ' days: ' + counts({ 'out of catalog': r.parked.outOfCatalog, stale: r.parked.stale, expired: r.parked.expired, 'value gate': r.parked.gate, notices: r.parked.notice })];
    // The quote funnel (U7.Q): what customers did with the quotes of the last SUPPLY_DAYS days.
    const f = r.funnel;
    if (f && (f.sent || f.unlinked)) parts.push('quotes in ' + f.days + ' days: ' + f.sent + ' sent, ' + (f.opensKnown ? f.opened + ' opened' : 'opens not recorded yet') + ', ' + f.hiredUs + ' hired us, ' + f.hiredOther + ' hired another pro, ' + f.noAnswer + ' no answer yet' + (f.unlinked ? ', ' + f.unlinked + ' chats not linked to an fsw quote' : ''));
    if (r.candidates?.length) parts.push('labels no service covers yet: ' + r.candidates.map((c) => c.label + ' ' + c.threads).join(', '));
    if (r.paced?.waited) parts.push(r.paced.waited + ' requests waited for the hourly read share' + (r.paced.parkedUnread ? ', ' + r.paced.parkedUnread + ' of them parked unread' : ''));
    if (r.listings) parts.push('gigs: ' + counts(r.listings.byStatus) + ' of ' + r.listings.published);
    // The value gate's day (src/economics/quote-gate.mjs): verdicts by reason, then requests the pace held back.
    const j = r.judged;
    if (j && (Object.keys(j.byReason).length || j.paceHeld)) parts.push('quote gate ' + j.day + ': ' + counts({ ...j.byReason, 'pace held': j.paceHeld }));
    if (r.services) parts.push(r.services.withoutItems.length ? 'offered services without request items: ' + r.services.withoutItems.join(', ') : 'every offered service has request items');
    if (r.spend) parts.push(...spendParts(r.spend));
    if (r.waiting.awaiting_operator) parts.push(r.waiting.awaiting_operator + ' waiting for your approval');
    if (r.status !== 'ok') parts.push('read failed: ' + r.notes.join('; '));
    return '- ' + r.platform + ': ' + parts.join('; ');
  });
}
