// The lead supply report (architect D18; 000 amendment: it ships with the hourly job and leads the
// digest). Per enabled platform: listing review states, offered services without request items, inbound
// parked over the last SUPPLY_DAYS by reason, the awaiting_reply count and outbox items waiting for the
// operator. It says why nothing sells before anyone suspects the loop: on 2026-10-25 every live inbound
// item was parked and every kmong gig waited for review (architect F1). The report is the supervisor's
// SupplyReport, its own type: it reads only services from the surface's supply(), which answers 003's
// Supply, and builds the rest from the ledger and the listing review files.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hourKey } from '../core/clock.mjs';
import { pipelineSettings } from '../core/settings.mjs';
import { answeredServices, catalogServicesFor } from '../economics/catalog.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { listingsDir, readPublished } from '../listings/gig.mjs';
import { gigStatus, readReview } from '../listings/review.mjs';
import { openSurface as defaultOpenSurface } from '../surface/index.mjs';
import { awaitingReply } from '../triage/index.mjs';

export const SUPPLY_DAYS = 7;
const DAY_MS = 86_400_000;
const FILE_RE = /^supply-(\d{10})\.json$/;
export const supplyDir = (instance) => join(instance.paths.operator, 'supply');

// Distinct threads parked in the window, by the event kinds the loop writes (src/triage parkEvent).
export function parkedCounts(ledger, platform, now) {
  const since = now.getTime() - SUPPLY_DAYS * DAY_MS;
  const seen = { outOfCatalog: new Set(), stale: new Set(), expired: new Set(), notice: new Set() };
  const rows = ledger.db.prepare("SELECT kind, ref, payload, at FROM events WHERE platform = ? AND kind IN ('thread.operator', 'thread.skipped', 'thread.system')").all(platform);
  for (const e of rows.filter((r) => Date.parse(r.at) >= since && Date.parse(r.at) <= now.getTime())) {
    const reason = String(JSON.parse(e.payload ?? '{}')?.reason ?? '');
    const bucket = e.kind === 'thread.operator' ? 'outOfCatalog' : e.kind === 'thread.system' ? 'notice' : reason.startsWith('expired') ? 'expired' : 'stale';
    seen[bucket].add(e.ref);
  }
  return Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.size]));
}

// Published kmong gigs by the review state the listings job last saw (src/listings/review.mjs codes).
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
    awaitingReply: settings ? ledger.listThreads({ platform }).filter((t) => t.kind !== 'project' && awaitingReply(t, ledger.threadMessages(t.id), { now, settings })).length : null,
    waiting, notes,
  };
  let surface;
  try {
    surface = await openSurface(platform);
    if (typeof surface.supply === 'function') {
      const login = await surface.login();
      if (!login?.loggedIn) throw Object.assign(new Error('not logged in'), { code: 'FSW_SUPPLY_LOGIN' });
      const offered = (await surface.supply()).services ?? [];
      // A platform that matches requests to the items set on each offered service sends an unset one
      // nothing (AGENTS.md rule); a service the instance does not answer there is the operator's own, as in
      // fsw doctor's items check (src/cli/doctor.mjs:186-191 at 14d2f17).
      const answered = answeredServices(instance.config, platform);
      report.services = { offered: offered.length, withoutItems: offered.filter((s) => !s.itemsSet && catalogServicesFor(descriptor, s.name)?.some((sv) => answered.includes(sv))).map((s) => s.name) };
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
export async function writeSupply({ instance, ledger, now = new Date(), openSurface }) {
  const ids = Object.entries(instance.config.platforms ?? {}).filter(([, p]) => p.enabled).map(([id]) => id);
  const reports = [];
  for (const id of ids) reports.push(await supplyReport(id, { instance, ledger, now, ...(openSurface ? { openSurface } : {}) }));
  const dir = supplyDir(instance);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'supply-' + hourKey(now) + '.json');
  writeFileSync(file + '.tmp', JSON.stringify({ hour: hourKey(now), reports }, null, 2) + '\n');
  renameSync(file + '.tmp', file);
  ledger.addEvent({ kind: 'supervisor.supply', payload: { file, reports: reports.map((r) => ({ platform: r.platform, status: r.status, awaitingReply: r.awaitingReply, parked: r.parked })) } });
  return { status: reports.every((r) => r.status === 'ok') ? 'ok' : 'partial', file, reports };
}

export function latestSupply(instance) {
  const dir = supplyDir(instance);
  const name = existsSync(dir) ? readdirSync(dir).filter((f) => FILE_RE.test(f)).sort().at(-1) : null;
  return name ? { file: name, ...JSON.parse(readFileSync(join(dir, name), 'utf8')) } : null;
}

const counts = (m) => Object.entries(m).filter(([, v]) => v).map(([k, v]) => k + ' ' + v).join(', ') || 'none';

// Digest lines, one per platform, plain figures only.
export function supplyLines(supply) {
  if (!supply) return ['- none yet (the hourly job writes it)'];
  if (!supply.reports.length) return ['- no platform is enabled'];
  return supply.reports.map((r) => {
    const parts = [(r.awaitingReply ?? 'unknown') + ' awaiting reply', 'parked in ' + SUPPLY_DAYS + ' days: ' + counts({ 'out of catalog': r.parked.outOfCatalog, stale: r.parked.stale, expired: r.parked.expired, notices: r.parked.notice })];
    if (r.listings) parts.push('gigs: ' + counts(r.listings.byStatus) + ' of ' + r.listings.published);
    if (r.services) parts.push(r.services.withoutItems.length ? 'offered services without request items: ' + r.services.withoutItems.join(', ') : 'every offered service has request items');
    if (r.waiting.awaiting_operator) parts.push(r.waiting.awaiting_operator + ' waiting for your approval');
    if (r.status !== 'ok') parts.push('read failed: ' + r.notes.join('; '));
    return '- ' + r.platform + ': ' + parts.join('; ');
  });
}
