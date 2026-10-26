// Market sampling for every platform the config lists, enabled or not (moved from src/cli/market.mjs:81-147
// at 2c77326). The day's files hold every (platform, category) pair read that day: a run replaces the
// samples of the pairs it read and keeps the rest, so sampling one platform by name or retrying one
// category never erases what an earlier run of the same day read. A new day's first run starts from the
// newest earlier samples for the pairs it cannot read when they are at most CARRY_DAYS old, and carried
// samples keep their own observedAt. A platform priced in another currency is sampled only with the
// day's exchange rates; without them its categories fail by name and none of its pages load. The page
// opener and the per-platform samplers are passed in, so economics never imports a browser or a surface.
// The market engines, the per-run category bound and the cadence are src/cli/market.mjs:83-129 of
// 9101c1c (e5bc34f, 9601886, cd38a71, 9101c1c): a platform is read through
// config.market.engines.<platform>, else the descriptor's market.engine, else owned, and withPage opens
// that engine; config.market.categoriesPerRun.<platform> (else the descriptor's, else all) bounds one
// run, stalest first, and the rest keep the samples the day carries; config.market.cadence.<platform>
// (else the descriptor's, else day) puts a platform in the daily market job or the hourly slice.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey } from '../core/clock.mjs';
import { ensureDir } from '../core/instance.mjs';
import { loadDescriptor, MARKET_CADENCES, MARKET_ENGINES } from '../platforms/registry.mjs';
import { targetsFor } from './catalog.mjs';
import { EconomicsError } from './errors.mjs';
import { loadFx } from './fx.mjs';
import { summarizeDay } from './market.mjs';

export const CARRY_DAYS = 7;

// A sampler reads through owned and attached unless it lists its engines; archive needs one that keeps
// the capture time, or an old copy would be dated today.
const DEFAULT_SAMPLER_ENGINES = ['owned', 'attached'];

export function marketEngine(platform, config, descriptor = loadDescriptor(platform)) {
  const engine = config?.market?.engines?.[platform] ?? descriptor.market?.engine ?? 'owned';
  if (!MARKET_ENGINES.includes(engine)) throw new EconomicsError('FSW_MARKET_ENGINE_UNKNOWN', 'market engine ' + JSON.stringify(engine) + ' for ' + platform + ' is not one of ' + MARKET_ENGINES.join(', '), { platform });
  return engine;
}

export function categoriesPerRun(platform, config, descriptor = loadDescriptor(platform)) {
  const n = config?.market?.categoriesPerRun?.[platform] ?? descriptor.market?.categoriesPerRun ?? Infinity;
  if (n !== Infinity && !(Number.isInteger(n) && n > 0)) throw new EconomicsError('FSW_MARKET_BUDGET_INVALID', 'market categoriesPerRun for ' + platform + ' must be a positive integer, got ' + JSON.stringify(n), { platform });
  return n;
}

export function marketCadence(platform, config, descriptor = loadDescriptor(platform)) {
  const cadence = config?.market?.cadence?.[platform] ?? descriptor.market?.cadence ?? 'day';
  if (!MARKET_CADENCES.includes(cadence)) throw new EconomicsError('FSW_MARKET_CADENCE_UNKNOWN', 'market cadence ' + JSON.stringify(cadence) + ' for ' + platform + ' is not one of ' + MARKET_CADENCES.join(', '), { platform });
  return cadence;
}

// The configured platforms with a sampler whose cadence is the given one, in config order.
export const marketPlatforms = (config, cadence, samplers) => Object.keys(config?.platforms ?? {}).filter((id) => id in samplers && marketCadence(id, config) === cadence);

// The targets one run reads: the limit stalest by their newest observedAt in known, never-read first,
// catalog order among equals.
export function stalestFirst(platform, targets, known, limit) {
  const newest = new Map();
  for (const r of known) if (r.platform === platform && (newest.get(r.category) ?? '') < r.observedAt) newest.set(r.category, r.observedAt);
  return targets.map((t, i) => ({ t, i, at: newest.get(t.category) ?? '' })).sort((a, b) => a.at.localeCompare(b.at) || a.i - b.i).slice(0, limit).map(({ t }) => t);
}

const withoutTime = (entries) => JSON.stringify(entries.map(({ observedAt, ...rest }) => rest));
const pairKey = (row) => row.platform + '\u0000' + row.category;
const readSamples = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// The newest samples file of a day before this one, or [] when there is none.
function previousSamples(dir, day) {
  const file = readdirSync(dir).filter((f) => /^samples-\d{8}\.jsonl$/.test(f) && f < 'samples-' + day + '.jsonl').sort().at(-1);
  return file ? readSamples(join(dir, file)) : [];
}

function writeAtomic(file, body) {
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

// samplers: {[platform]: () => Promise<{sample(session, targets, {now, fx}), engines?}>};
// withPage(platform, fn, {engine}) opens a page session through that engine and calls fn with it.
// platforms defaults to every platform the config lists.
export async function sampleMarket(instance, { platforms, samplers, withPage, loadFx: readFx = loadFx, now = () => new Date(), day, log = () => {} } = {}) {
  if (!samplers || typeof withPage !== 'function') throw new TypeError('sampleMarket needs samplers and withPage');
  const asked = platforms?.length ? platforms : Object.keys(instance.config.platforms ?? {});
  const ids = asked.filter((id) => id in samplers);
  if (!ids.length) throw new EconomicsError('FSW_MARKET_NO_SAMPLER', 'no market sampler for ' + (asked.join(', ') || 'any configured platform'));
  let rates;
  const ratesForRun = () => (rates ??= readFx(instance, { now }));
  const key = day ?? dayKey(now());
  const dir = ensureDir(instance.paths.market);
  const summaryFile = join(dir, 'summary-' + key + '.json');
  const samplesFile = join(dir, 'samples-' + key + '.jsonl');
  let known;
  const knownSamples = () => (known ??= [...previousSamples(dir, key), ...readSamples(samplesFile)]);

  const rows = [];
  const errors = [];
  const skipped = new Map();
  for (const platform of ids) {
    const { sample, engines = DEFAULT_SAMPLER_ENGINES } = await samplers[platform]();
    let pending = targetsFor(platform);
    let engine;
    try {
      engine = marketEngine(platform, instance.config);
      if (!engines.includes(engine)) throw new Error('the ' + platform + ' sampler cannot read through the ' + engine + ' engine (it reads through ' + engines.join(', ') + ')');
      const limit = categoriesPerRun(platform, instance.config);
      if (limit < pending.length) {
        const all = pending.length;
        pending = stalestFirst(platform, pending, knownSamples(), limit);
        log('market ' + platform + ': reading the ' + limit + ' stalest of ' + all + ' categories (categoriesPerRun)');
      }
    } catch (err) {
      errors.push(...pending.map(({ category }) => ({ platform, category, message: err.message })));
      continue;
    }
    let fx = null;
    if (loadDescriptor(platform).currency !== 'KRW') {
      try {
        fx = await ratesForRun();
      } catch (err) {
        errors.push(...pending.map(({ category }) => ({ platform, category, message: 'fx unavailable: ' + err.message })));
        continue;
      }
    }
    // The second pass retries what the first could not read, since one slow load fails a category.
    // A bot challenge or a final error is not retried: a retry would only load the same answer again.
    for (let pass = 1; pass <= 2 && pending.length; pass += 1) {
      let failed;
      try {
        const result = await withPage(platform, (session) => sample(session, pending, { now, fx }), { engine });
        rows.push(...result.rows.map((r) => ({ ...r, engine })));
        failed = result.errors;
        // A retried category's counts replace its first-pass counts.
        for (const s of result.skipped ?? []) skipped.set([platform, s.category, s.reason].join('\u0000'), { platform, ...s });
      } catch (err) {
        failed = pending.map(({ category }) => ({ category, message: err.message, ...(err.challenge ? { challenge: err.challenge } : {}) }));
      }
      errors.push(...failed.filter((e) => pass === 2 || e.challenge || e.final).map((e) => ({ platform, engine, ...e })));
      pending = pending.filter((t) => failed.some((e) => e.category === t.category && !e.challenge && !e.final));
    }
  }
  for (const e of errors) log('market ' + e.platform + '/' + e.category + ' failed' + (e.engine ? ' (' + e.engine + ' engine)' : '') + ': ' + e.message);
  for (const s of skipped.values()) log('market ' + s.platform + '/' + s.category + ' skipped ' + s.count + ' (' + s.reason + ')');
  if (!rows.length) throw new EconomicsError('FSW_MARKET_EMPTY', 'market sampling read no rows', { errors });

  const read = new Set(rows.map(pairKey));
  const fresh = (r) => now().getTime() - Date.parse(r.observedAt) <= CARRY_DAYS * 86_400_000;
  const carried = existsSync(samplesFile) ? [] : previousSamples(dir, key).filter((r) => !read.has(pairKey(r)) && fresh(r));
  if (carried.length) log('market carried ' + new Set(carried.map(pairKey)).size + ' pairs this run could not read from an earlier day');
  const dayRows = [...carried, ...readSamples(samplesFile).filter((r) => !read.has(pairKey(r))), ...rows];
  const entries = summarizeDay(dayRows);
  const unchanged = existsSync(summaryFile) && withoutTime(JSON.parse(readFileSync(summaryFile, 'utf8'))) === withoutTime(entries);
  if (unchanged) log('market unchanged: summary-' + key + '.json');
  else {
    writeAtomic(samplesFile, dayRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeAtomic(summaryFile, JSON.stringify(entries, null, 2) + '\n');
    log('market written: summary-' + key + '.json (' + entries.length + ' entries from ' + dayRows.length + ' samples, ' + rows.length + ' read now)');
  }
  return { written: !unchanged, summaryFile, samplesFile, entries, errors, skipped: [...skipped.values()], exitCode: errors.length ? 1 : 0 };
}
