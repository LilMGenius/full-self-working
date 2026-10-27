// The price table file (moved from src/cli/price.mjs:19-77 at 2c77326): rebuilt from the newest market
// summary, the profile's service fit and the review count of each service on each platform, and written only when a row
// changed. Every platform with summary entries is priced, enabled or not; a platform without a state file
// is priced as a new seller (0 reviews), and each row says whether this build has a surface for its
// platform, which the allocation requires. A platform that is not enabled and cannot be priced is listed
// under skipped by name; an enabled one that cannot be priced fails the run and keeps the previous table.
// adapterFor is passed in, so economics no longer imports the supervisor (the 2c77326 cycle
// src/cli/price.mjs:41 <-> src/supervisor/run.mjs).
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dayKey } from '../core/clock.mjs';
import { ensureDir } from '../core/instance.mjs';
import { priceLearningSettings } from '../core/settings.mjs';
import { listDescriptors, loadDescriptor } from '../platforms/registry.mjs';
import { catalog } from './catalog.mjs';
import { EconomicsError } from './errors.mjs';
import { latestSummary } from './market.mjs';
import { learnPriceRows } from './price-learning.mjs';
import { buildPriceTable } from './pricing.mjs';
import { dayStart, quoteResults } from './quote-results.mjs';

const TABLE_RE = /^price-table-(\d{8})\.json$/;

// The review count comes from the platform state a surface last captured. A state showing zero
// completed jobs means zero reviews; any other state without a count fails by name until the
// surface's profile read records one, since a guessed count would move every price on that platform.
export function sellerStatsFrom(state, platform) {
  if (typeof state?.reviews?.count === 'number') return { reviews: state.reviews.count };
  if (state?.account?.totalJobs === 0) return { reviews: 0 };
  throw new EconomicsError('FSW_SELLER_STATS_MISSING', 'no review count in the ' + platform + ' state', { platform });
}

// Reviews the ledger ties to each service on a platform: every review row joined to its job's service. A review
// with no job names no service; without a ledger nothing is tied.
export function serviceReviews(ledger, platform) {
  if (!ledger) return {};
  const rows = ledger.db.prepare('SELECT j.service AS service, COUNT(*) AS n FROM reviews r JOIN jobs j ON j.id = r.job_id WHERE j.platform = ? AND j.service IS NOT NULL GROUP BY j.service ORDER BY j.service').all(platform);
  return Object.fromEntries(rows.map((r) => [r.service, Number(r.n)]));
}

// The newest price-table-YYYYMMDD.json in dir as {file, table}, or null.
export function latestTable(dir) {
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).filter((f) => TABLE_RE.test(f)).sort().at(-1);
  return file ? { file: join(dir, file), table: JSON.parse(readFileSync(join(dir, file), 'utf8')) } : null;
}

// adapterFor(platform) resolves truthy when this build can work that platform. ledger is the replay source
// of price learning and of the reviews per service; without one (a test of the market part alone) rows stay on
// the market and no review is tied to an agent-delivered service. The
// table counts the quotes sent before 00:00 Seoul of its day, with their status as the ledger holds it now:
// a rerun the same day writes the same rows unless a quote was decided in between (quote-results.mjs).
export async function refreshPriceTable(instance, { adapterFor, ledger = null, day, log = () => {} } = {}) {
  if (typeof adapterFor !== 'function') throw new TypeError('refreshPriceTable needs adapterFor');
  const summary = latestSummary(instance);
  const tableDay = day ?? dayKey(new Date());
  const asOf = dayStart(tableDay);
  const learning = priceLearningSettings(instance.config);
  const results = ledger && learning.enabled ? quoteResults(ledger, { asOf, expireAfterDays: learning.expireAfterDays }) : null;
  const enabled = Object.entries(instance.config.platforms ?? {}).filter(([, p]) => p.enabled).map(([id]) => id);
  const known = new Set(listDescriptors());
  const ids = [...new Set([...enabled, ...summary.entries.map((e) => e.platform)])].filter((id) => known.has(id));
  const sellerStats = {};
  const rows = [];
  const skipped = [];
  for (const id of ids) {
    try {
      const statePath = join(instance.paths.platforms, id + '-state.json');
      if (existsSync(statePath)) sellerStats[id] = { ...sellerStatsFrom(JSON.parse(readFileSync(statePath, 'utf8')), id), byService: serviceReviews(ledger, id) };
      else if (!enabled.includes(id)) sellerStats[id] = { reviews: 0, basis: 'no account state: priced as a new seller', byService: serviceReviews(ledger, id) };
      const descriptor = loadDescriptor(id);
      const built = buildPriceTable({ summary, services: catalog, profile: instance.profile, sellerStats, config: instance.config, descriptors: { [id]: descriptor } });
      const priced = results ? learnPriceRows(built, results, { settings: learning, descriptors: { [id]: descriptor }, asOf }) : built;
      const adapter = Boolean(await adapterFor(id));
      rows.push(...priced.map((r) => ({ ...r, adapter })));
    } catch (err) {
      if (enabled.includes(id)) throw err;
      skipped.push({ platform: id, code: err.code ?? null, message: err.message });
    }
  }
  for (const s of skipped) log('price ' + s.platform + ' skipped: ' + s.message);
  for (const r of rows) if (r.learned && r.learned.factor !== 1) log('price learned ' + r.platform + '/' + r.service + ': x' + r.learned.factor + ' from ' + r.learned.priced + ' priced of ' + r.learned.cases + ' decided quotes' + (r.learned.capped ? ', capped' : ''));
  const dir = instance.paths.pricing;
  const previous = latestTable(dir);
  if (previous && JSON.stringify(previous.table.rows) === JSON.stringify(rows)) {
    log('price table unchanged: ' + basename(previous.file));
    return { written: false, file: previous.file, rows };
  }
  ensureDir(dir);
  const file = join(dir, 'price-table-' + tableDay + '.json');
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify({ summaryFile: basename(summary.file), observedAt: summary.observedAt, sellerStats, skipped, rows }, null, 2) + '\n');
  renameSync(tmp, file);
  const viable = rows.filter((r) => r.viable);
  log('price table written: ' + basename(file) + ' (' + rows.length + ' rows, ' + viable.length + ' viable, ' + rows.filter((r) => r.pricedAtFloor).length + ' raised to the cost floor)');
  return { written: true, file, rows };
}
