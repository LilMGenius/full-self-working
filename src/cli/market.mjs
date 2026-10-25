// fsw market: sample the market of every platform the config lists, enabled or not, for the services in
// services.json, then write samples-<day>.jsonl and summary-<day>.json, the files latestSummary and fsw
// price read. A category that fails twice is reported by name. The day's files hold every (platform,
// category) pair read that day: a run replaces the samples of the pairs it read and keeps the rest, so
// sampling one platform by name or retrying one category never erases what an earlier run of the same
// day read. A new day's first run starts from the newest earlier samples for the pairs it cannot read,
// when they are at most CARRY_DAYS old, so one failed sampling day does not empty a platform's price
// rows; carried samples keep their own observedAt, which the summary and the price table show.
// Market pages are public, so a platform is sampled before any account exists there, at the
// descriptor's page gap, through its market engine: config.market.engines.<platform>, else the
// descriptor's market.engine, else owned. owned is a headless browser with a fresh profile; attached is
// the operator's Chrome through BrowserSkill, for a host whose bot wall stops the owned browser, and it
// reads only public pages; archive is the newest Wayback capture, loaded in the owned browser, for a
// sampler that keeps the capture time. A platform priced in another currency is sampled only with the
// day's exchange rates (src/economics/fx.mjs); when they cannot be read, its categories fail by name and
// none of its pages load.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { archiveSession } from '../browser/archive.mjs';
import { createPacingGuard, withSession } from '../browser/driver.mjs';
import { dayKey } from '../core/clock.mjs';
import { ensureDir, loadInstance } from '../core/instance.mjs';
import { loadFx } from '../economics/fx.mjs';
import { summarizeDay } from '../economics/market.mjs';
import { CATEGORY_FIELD } from '../economics/pricing.mjs';
import { loadDescriptor, MARKET_ENGINES } from '../platforms/registry.mjs';
import { openRenderer } from '../render/html2png.mjs';
import services from '../economics/services.json' with { type: 'json' };

const SAMPLERS = {
  kmong: '../platforms/kmong/market.mjs',
  soomgo: '../platforms/soomgo/market.mjs',
  freelancer: '../platforms/freelancer/market.mjs',
  wishket: '../platforms/wishket/market.mjs',
  fiverr: '../platforms/fiverr/market.mjs',
  // upwork has none: its public job search needs a login and answered the owned browser with a
  // Cloudflare block on 2026-10-25, so its market waits for the signed-in adapter.
};

// One target per distinct category label, since several services can share one.
export function targetsFor(platform, catalog = services) {
  const field = CATEGORY_FIELD[platform];
  const byCategory = new Map();
  for (const [id, def] of Object.entries(catalog)) {
    if (!id.startsWith('_') && def[field] && !byCategory.has(def[field])) byCategory.set(def[field], { category: def[field], def });
  }
  return [...byCategory.values()];
}

const withoutTime = (entries) => JSON.stringify(entries.map(({ observedAt, ...rest }) => rest));
const pairKey = (row) => row.platform + '\u0000' + row.category;
const readSamples = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

export const CARRY_DAYS = 7;

// The newest samples file of a day before this one, or [] when there is none.
function previousSamples(dir, day) {
  const file = readdirSync(dir).filter((f) => /^samples-\d{8}\.jsonl$/.test(f) && f < `samples-${day}.jsonl`).sort().at(-1);
  return file ? readSamples(join(dir, file)) : [];
}

async function withOwnedPage(platform, fn) {
  const renderer = await openRenderer();
  try {
    const page = await renderer.page();
    const guard = createPacingGuard(platform, loadDescriptor(platform).pacing);
    return await fn({
      async navigate(url, opts) {
        await guard.beforeLoad();
        return page.navigate(url, opts);
      },
      evaluate: page.evaluate,
    });
  } finally {
    await renderer.close();
  }
}

const withAttachedPage = (platform, fn) =>
  withSession('market-' + platform, (s) => fn({ navigate: s.navigate, evaluate: s.evaluate }), { platform, pacing: loadDescriptor(platform).pacing });

const withArchivePage = (platform, fn, { now }) => withOwnedPage(platform, (page) => fn(archiveSession(page, { now, maxAgeDays: CARRY_DAYS })));

const OPENERS = { owned: withOwnedPage, attached: withAttachedPage, archive: withArchivePage };

// A sampler reads through owned and attached unless it lists its engines; archive needs one that keeps
// the capture time, or an old copy would be dated today.
const DEFAULT_SAMPLER_ENGINES = ['owned', 'attached'];

export function marketEngine(platform, config, descriptor = loadDescriptor(platform)) {
  const engine = config?.market?.engines?.[platform] ?? descriptor.market?.engine ?? 'owned';
  if (!MARKET_ENGINES.includes(engine)) {
    throw Object.assign(new Error(`market engine ${JSON.stringify(engine)} for ${platform} is not one of ${MARKET_ENGINES.join(', ')}`), { code: 'FSW_MARKET_ENGINE_UNKNOWN' });
  }
  return engine;
}

function writeAtomic(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const instance = ctx.instance ?? loadInstance();
  const now = ctx.now ?? (() => new Date());
  const open = ctx.withPage ?? ((platform, fn, { engine }) => OPENERS[engine](platform, fn, { now }));
  const named = argv.filter((a) => !a.startsWith('-'));
  const asked = named.length ? named : Object.keys(instance.config.platforms ?? {});
  const platforms = asked.filter((id) => id in SAMPLERS);
  if (!platforms.length) throw Object.assign(new Error(`no market sampler for ${asked.join(', ') || 'any configured platform'}`), { code: 'FSW_MARKET_NO_SAMPLER' });
  let rates;
  const ratesForRun = () => (rates ??= (ctx.loadFx ?? loadFx)(instance, { now }));

  const rows = [];
  const errors = [];
  const skipped = new Map();
  for (const platform of platforms) {
    const { sample, engines = DEFAULT_SAMPLER_ENGINES } = await import(SAMPLERS[platform]);
    let pending = targetsFor(platform);
    let engine;
    try {
      engine = marketEngine(platform, instance.config);
      if (!engines.includes(engine)) throw new Error(`the ${platform} sampler cannot read through the ${engine} engine (it reads through ${engines.join(', ')})`);
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
        const result = await open(platform, (session) => sample(session, pending, { now, fx }), { engine });
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
  for (const e of errors) log(`market ${e.platform}/${e.category} failed${e.engine ? ` (${e.engine} engine)` : ''}: ${e.message}`);
  for (const s of skipped.values()) log(`market ${s.platform}/${s.category} skipped ${s.count} (${s.reason})`);
  if (!rows.length) throw Object.assign(new Error('market sampling read no rows'), { code: 'FSW_MARKET_EMPTY', errors });

  const day = ctx.day ?? dayKey(now());
  const dir = ensureDir(instance.paths.market);
  const summaryFile = join(dir, `summary-${day}.json`);
  const samplesFile = join(dir, `samples-${day}.jsonl`);
  const read = new Set(rows.map(pairKey));
  const fresh = (r) => now().getTime() - Date.parse(r.observedAt) <= CARRY_DAYS * 86_400_000;
  const carried = existsSync(samplesFile) ? [] : previousSamples(dir, day).filter((r) => !read.has(pairKey(r)) && fresh(r));
  if (carried.length) log(`market carried ${new Set(carried.map(pairKey)).size} pairs this run could not read from an earlier day`);
  const dayRows = [...carried, ...readSamples(samplesFile).filter((r) => !read.has(pairKey(r))), ...rows];
  const entries = summarizeDay(dayRows);
  const unchanged = existsSync(summaryFile) && withoutTime(JSON.parse(readFileSync(summaryFile, 'utf8'))) === withoutTime(entries);
  if (unchanged) log(`market unchanged: summary-${day}.json`);
  else {
    writeAtomic(samplesFile, dayRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    writeAtomic(summaryFile, JSON.stringify(entries, null, 2) + '\n');
    log(`market written: summary-${day}.json (${entries.length} entries from ${dayRows.length} samples, ${rows.length} read now)`);
  }
  return { written: !unchanged, summaryFile, samplesFile, entries, errors, skipped: [...skipped.values()], exitCode: errors.length ? 1 : 0 };
}
