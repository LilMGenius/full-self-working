// The 09:00 Seoul operator digest: what happened on the previous Seoul day, written to
// operator/digest-YYYYMMDD.md and announced through notifyOperator. Every figure is counted from a
// record: the ledger for activity and for what waits in the outbox, the market summary, price-table
// and allocation files the daily jobs wrote, and lessons.jsonl. A source that does not exist yet prints
// as "none".
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dayKey } from '../core/clock.mjs';
import { ensureDir } from '../core/instance.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { latestSummary } from '../economics/market.mjs';
import { CATEGORY_FIELD } from '../economics/pricing.mjs';
import { readLessons } from '../learning/lessons.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { latestSupply, supplyLines } from './supply.mjs';
import catalog from '../economics/services.json' with { type: 'json' };

const DAY_MS = 86_400_000;
const krw = (n) => Math.round(n).toLocaleString('en-US') + ' KRW';
const inDay = (iso, day) => iso != null && dayKey(new Date(iso)) === day;

function latestFiles(dir, re, n) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => re.test(f)).sort().slice(-n).map((f) => ({ file: f, data: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}

// Rows of the two newest price tables whose base or viability differ. learned: the row's price factor from
// quote results (src/economics/price-learning.mjs) when it moved the base.
export function priceChanges(pricingDir) {
  const tables = latestFiles(pricingDir, /^price-table-\d{8}\.json$/, 2);
  const cur = tables.at(-1) ?? null;
  const prev = tables.length === 2 ? tables[0] : null;
  if (!cur) return { table: null, changes: [] };
  if (!prev) return { table: cur.file, changes: [], first: true };
  const key = (r) => r.platform + '/' + r.service;
  const before = new Map(prev.data.rows.map((r) => [key(r), r]));
  const changes = cur.data.rows
    .filter((r) => !before.has(key(r)) || before.get(key(r)).baseKRW !== r.baseKRW || before.get(key(r)).viable !== r.viable)
    .map((r) => ({ row: key(r), from: before.get(key(r))?.baseKRW ?? null, to: r.baseKRW, viable: r.viable, learned: r.learned && r.learned.factor !== 1 ? { factor: r.learned.factor, cases: r.learned.cases, priced: r.learned.priced, capped: r.learned.capped } : null }));
  return { table: cur.file, previous: prev.file, changes };
}

// What a summary figure measures, since a client's budget, a gig's starting price and a guide's average
// are not the same number: price-guide entries carry an average, and listing entries are budgets on a
// bidding platform and starting prices on a storefront.
function figureOf(entry) {
  if (typeof entry.median !== 'number') return typeof entry.avgKRW === 'number' ? { valueKRW: entry.avgKRW, basis: 'guide avg' } : null;
  const models = [loadDescriptor(entry.platform).model].flat();
  return { valueKRW: entry.median, basis: models.includes('bidding') && !models.includes('storefront') ? 'budget' : 'from price', n: entry.n };
}

// Each catalog service's market on every sampled platform, from the newest summary, in the platform
// order of CATEGORY_FIELD, so the overseas figures sit next to the domestic ones and show which login
// would pay. null when no summary exists yet.
export function marketMedians(instance, services = catalog) {
  let summary;
  try {
    summary = latestSummary(instance);
  } catch (err) {
    if (err.code === 'FSW_MARKET_NO_SUMMARY') return null;
    throw err;
  }
  const rows = [];
  for (const [service, def] of Object.entries(services)) {
    if (service.startsWith('_')) continue;
    const cells = [];
    for (const [platform, field] of Object.entries(CATEGORY_FIELD)) {
      const entry = def[field] ? summary.entries.find((e) => e.platform === platform && e.category === def[field]) : null;
      const figure = entry ? figureOf(entry) : null;
      if (figure) cells.push({ platform, ...figure });
    }
    if (cells.length) rows.push({ service, cells });
  }
  return { file: basename(summary.file), services: rows };
}

export function digestNumbers({ instance, ledger, now = new Date() }) {
  const day = dayKey(new Date(now.getTime() - DAY_MS));
  const q = (sql) => ledger.db.prepare(sql).all();
  const threads = q('SELECT platform, kind, created_at FROM threads').filter((t) => inDay(t.created_at, day));
  const outbound = q("SELECT t.platform AS platform, m.at AS at FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.direction = 'out'").filter((m) => inDay(m.at, day));
  const quotes = q('SELECT platform, amount_krw, cost_krw, at FROM quotes').filter((x) => inDay(x.at, day));
  const orders = q('SELECT platform, started_at FROM jobs').filter((j) => inDay(j.started_at, day));
  const payments = q('SELECT amount_krw, received_at FROM payments').filter((p) => inDay(p.received_at, day));
  const events = q('SELECT kind, platform, ref, payload, at FROM events').filter((e) => inDay(e.at, day));
  const errors = {};
  const parked = {};
  const bump = (platform, what) => {
    const k = platform ?? 'supervisor';
    errors[k] ??= {};
    errors[k][what] = (errors[k][what] ?? 0) + 1;
  };
  for (const e of events) {
    const payload = e.payload ? JSON.parse(e.payload) : {};
    if (e.kind === 'thread.error') bump(e.platform, 'thread error');
    else if (e.kind === 'thread.operator') parked[e.platform] = (parked[e.platform] ?? 0) + 1;
    else if (e.kind === 'send.unobserved') bump(e.platform, 'unobserved send');
    else if (e.kind === 'supervisor.platform' && payload.status === 'failed') bump(e.platform, payload.error ?? 'failed');
    else if (e.kind === 'supervisor.job' && payload.status === 'failed') bump(null, e.ref + ' job failed');
  }
  const byPlatform = (rows) => rows.reduce((m, r) => ((m[r.platform] = (m[r.platform] ?? 0) + 1), m), {});
  const allocation = latestFiles(instance.paths.pricing, /^allocation-\d{8}\.json$/, 1)[0] ?? null;
  return {
    day,
    supply: latestSupply(instance),
    leads: { total: threads.length, byPlatform: byPlatform(threads) },
    repliesSent: { total: outbound.length, byPlatform: byPlatform(outbound) },
    quotesSent: { total: quotes.length, amountKRW: quotes.reduce((s, x) => s + (x.amount_krw ?? 0), 0), cashSpentKRW: quotes.reduce((s, x) => s + (x.cost_krw ?? 0), 0) },
    approvalsWaiting: ledger.listOutbox({ statuses: ['awaiting_operator'] }).length,
    // Deliveries waiting for the operator by review verdict; a delivery without one counts as error, as resolve reads it.
    deliveriesWaiting: ledger.listOutbox({ statuses: ['awaiting_operator'], kinds: ['delivery'] }).reduce((m, r) => ((m[r.payload.review?.verdict ?? 'error'] += 1), m), { pass: 0, fail: 0, error: 0 }),
    leftForOperator: { total: Object.values(parked).reduce((a, b) => a + b, 0), byPlatform: parked },
    ordersStarted: orders.length,
    payments: { count: payments.length, amountKRW: payments.reduce((s, p) => s + p.amount_krw, 0) },
    prices: priceChanges(instance.paths.pricing),
    market: marketMedians(instance),
    allocation: allocation ? { file: allocation.file, weights: allocation.data.weights.filter((w) => w.weight > 0).map((w) => ({ arm: w.platform + '/' + w.service, weight: w.weight })) } : null,
    errors,
    lessons: readLessons(instance).length,
  };
}

const counts = (m) => Object.entries(m).map(([k, v]) => k + ' ' + v).join(', ');
const cell = (c) => c.platform + ' ' + krw(c.valueKRW) + ' ' + c.basis + (c.n != null ? ' (n ' + c.n + ')' : '');

export function renderDigest(n) {
  const lines = [
    '# Digest for ' + n.day.slice(0, 4) + '-' + n.day.slice(4, 6) + '-' + n.day.slice(6),
    '',
    '## Lead supply' + (n.supply ? ' (' + n.supply.file + ')' : ''),
    '',
    ...supplyLines(n.supply),
    '',
    '## Activity',
    '',
    '- leads: ' + n.leads.total + (n.leads.total ? ' (' + counts(n.leads.byPlatform) + ')' : ''),
    '- replies sent: ' + n.repliesSent.total + (n.repliesSent.total ? ' (' + counts(n.repliesSent.byPlatform) + ')' : ''),
    '- quotes sent: ' + n.quotesSent.total + ', quoted ' + krw(n.quotesSent.amountKRW) + ', cash spent ' + krw(n.quotesSent.cashSpentKRW),
    '- approvals waiting now: ' + n.approvalsWaiting,
    '- deliveries waiting: review pass ' + n.deliveriesWaiting.pass + ', fail ' + n.deliveriesWaiting.fail + ', error ' + n.deliveriesWaiting.error,
    '- left unread for you (service outside the catalog): ' + n.leftForOperator.total + (n.leftForOperator.total ? ' (' + counts(n.leftForOperator.byPlatform) + ')' : ''),
    '- orders started: ' + n.ordersStarted,
    '- payments recorded: ' + n.payments.count + ', ' + krw(n.payments.amountKRW),
    '- lessons: ' + n.lessons,
    '',
    '## Price table',
    '',
    !n.prices.table ? '- none' : n.prices.first ? '- ' + n.prices.table + ' is the first table' : n.prices.changes.length ? n.prices.changes.map((c) => '- ' + c.row + ': ' + (c.from == null ? 'new' : krw(c.from)) + ' to ' + krw(c.to) + (c.viable ? '' : ' (not viable)') + (c.learned ? ' (learned x' + c.learned.factor + ' from ' + c.learned.priced + ' priced of ' + c.learned.cases + ' decided quotes' + (c.learned.capped ? ', capped' : '') + ')' : '')).join('\n') : '- no change from ' + n.prices.previous,
    '',
    '## Market medians',
    '',
    !n.market ? '- none' : ['- from ' + n.market.file, ...n.market.services.map((s) => '- ' + s.service + ': ' + s.cells.map(cell).join(', '))].join('\n'),
    '',
    '## Allocation',
    '',
    !n.allocation ? '- none' : n.allocation.weights.length ? n.allocation.weights.map((w) => '- ' + w.arm + ' ' + (w.weight * 100).toFixed(1) + '%').join('\n') : '- every arm at 0 (' + n.allocation.file + ')',
    '',
    '## Errors',
    '',
    Object.keys(n.errors).length ? Object.entries(n.errors).map(([p, m]) => '- ' + p + ': ' + counts(m)).join('\n') : '- none',
    '',
  ];
  return lines.join('\n');
}

export async function writeDigest({ instance, ledger, now = new Date(), notify = notifyOperator }) {
  const numbers = digestNumbers({ instance, ledger, now });
  const text = renderDigest(numbers);
  const dir = ensureDir(instance.paths.operator);
  const file = join(dir, 'digest-' + dayKey(now) + '.md');
  writeFileSync(file + '.tmp', text);
  renameSync(file + '.tmp', file);
  const errorCount = Object.values(numbers.errors).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
  const supply = supplyLines(numbers.supply).map((l) => l.slice(2)).join(' | ');
  const body = supply + '\n' + ['leads ' + numbers.leads.total, 'replies ' + numbers.repliesSent.total, 'quotes ' + numbers.quotesSent.total, 'approvals waiting ' + numbers.approvalsWaiting, 'payments ' + numbers.payments.count, 'errors ' + errorCount].join(', ');
  const notified = await notify(instance, { kind: 'digest', title: 'Daily digest ' + numbers.day, body: body + '\n' + file, dedupeKey: 'digest:' + dayKey(now) });
  return { file, numbers, notified: notified.written };
}
