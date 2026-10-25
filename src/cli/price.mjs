// fsw price: rebuild the price table from the newest market summary, the profile's service fit and
// each platform's review count, and write a new table only when a row changed. Every platform with
// summary entries is priced, enabled or not, so a market sampled before any login shows what that
// login would pay. A platform without a state file is priced as a new seller (0 reviews), and each row
// says whether this build has an adapter for its platform, which the allocation requires. A platform
// that is not enabled and cannot be priced (fees unknown, say) is listed under skipped by name, so it
// never blocks the enabled platforms' rows; an enabled platform that cannot be priced still fails the
// run and keeps the previous table.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensureDir, loadInstance } from '../core/instance.mjs';
import { dayKey } from '../core/clock.mjs';
import { latestSummary } from '../economics/market.mjs';
import { buildPriceTable } from '../economics/pricing.mjs';
import { EconomicsError } from '../economics/errors.mjs';
import { listDescriptors, loadDescriptor } from '../platforms/registry.mjs';
import services from '../economics/services.json' with { type: 'json' };

const TABLE_RE = /^price-table-(\d{8})\.json$/;

// The review count comes from the platform state an adapter last captured. A state showing zero
// completed jobs means zero reviews; any other state without a count fails by name until the
// adapter's profile() read records one, since a guessed count would move every price on that platform.
export function sellerStatsFrom(state, platform) {
  if (typeof state?.reviews?.count === 'number') return { reviews: state.reviews.count };
  if (state?.account?.totalJobs === 0) return { reviews: 0 };
  throw new EconomicsError('FSW_SELLER_STATS_MISSING', 'no review count in the ' + platform + ' state', { platform });
}

export function latestTable(dir) {
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).filter((f) => TABLE_RE.test(f)).sort().at(-1);
  return file ? { file: join(dir, file), table: JSON.parse(readFileSync(join(dir, file), 'utf8')) } : null;
}

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const instance = ctx.instance ?? loadInstance(ctx.instanceDir ? { dir: ctx.instanceDir } : {});
  // The supervisor's loader owns what counts as an adapter; it is imported here only, so the modules
  // that read latestTable stay light.
  const adapterFor = ctx.loadAdapter ?? (await import('../supervisor/run.mjs')).loadAdapter;
  const summary = latestSummary(instance);
  const enabled = Object.entries(instance.config.platforms ?? {}).filter(([, p]) => p.enabled).map(([id]) => id);
  const known = new Set(listDescriptors());
  const ids = [...new Set([...enabled, ...summary.entries.map((e) => e.platform)])].filter((id) => known.has(id));
  const sellerStats = {};
  const rows = [];
  const skipped = [];
  for (const id of ids) {
    try {
      const statePath = join(instance.paths.platforms, id + '-state.json');
      if (existsSync(statePath)) sellerStats[id] = sellerStatsFrom(JSON.parse(readFileSync(statePath, 'utf8')), id);
      else if (!enabled.includes(id)) sellerStats[id] = { reviews: 0, basis: 'no account state: priced as a new seller' };
      const built = buildPriceTable({ summary, services, profile: instance.profile, sellerStats, config: instance.config, descriptors: { [id]: loadDescriptor(id) } });
      const adapter = Boolean(await adapterFor(id));
      rows.push(...built.map((r) => ({ ...r, adapter })));
    } catch (err) {
      if (enabled.includes(id)) throw err;
      skipped.push({ platform: id, code: err.code ?? null, message: err.message });
    }
  }
  for (const s of skipped) log('price ' + s.platform + ' skipped: ' + s.message);
  const dir = instance.paths.pricing;
  const previous = latestTable(dir);
  if (previous && JSON.stringify(previous.table.rows) === JSON.stringify(rows)) {
    log('price table unchanged: ' + basename(previous.file));
    return { written: false, file: previous.file, rows };
  }
  ensureDir(dir);
  const file = join(dir, 'price-table-' + (ctx.day ?? dayKey(new Date())) + '.json');
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify({ summaryFile: basename(summary.file), observedAt: summary.observedAt, sellerStats, skipped, rows }, null, 2) + '\n');
  renameSync(tmp, file);
  const viable = rows.filter((r) => r.viable);
  log('price table written: ' + basename(file) + ' (' + rows.length + ' rows, ' + viable.length + ' viable, ' + rows.filter((r) => r.pricedAtFloor).length + ' raised to the cost floor)');
  return { written: true, file, rows };
}
