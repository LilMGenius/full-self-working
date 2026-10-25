// fsw market: sample the market of every platform the config lists, enabled or not, for the services in
// services.json, then write samples-<day>.jsonl and summary-<day>.json, the files latestSummary and fsw
// price read. A category that fails twice is reported by name. The day's files hold every (platform,
// category) pair read that day: a run replaces the samples of the pairs it read and keeps the rest, so
// sampling one platform by name or retrying one category never erases what an earlier run of the same
// day read.
// Market pages are public, so a platform is sampled before any account exists there, in the owned
// headless browser at the descriptor's page gap; the operator's signed-in Chrome, and with it any seller
// account, takes no part. A platform priced in another currency is sampled only with the day's exchange
// rates (src/economics/fx.mjs); when they cannot be read, its categories fail by name and none of its
// pages load.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPacingGuard } from '../browser/driver.mjs';
import { dayKey } from '../core/clock.mjs';
import { ensureDir, loadInstance } from '../core/instance.mjs';
import { loadFx } from '../economics/fx.mjs';
import { summarizeDay } from '../economics/market.mjs';
import { CATEGORY_FIELD } from '../economics/pricing.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { openRenderer } from '../render/html2png.mjs';
import services from '../economics/services.json' with { type: 'json' };

const SAMPLERS = {
  kmong: '../platforms/kmong/market.mjs',
  soomgo: '../platforms/soomgo/market.mjs',
  freelancer: '../platforms/freelancer/market.mjs',
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

function writeAtomic(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const instance = ctx.instance ?? loadInstance();
  const open = ctx.withPage ?? withOwnedPage;
  const now = ctx.now ?? (() => new Date());
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
    const { sample } = await import(SAMPLERS[platform]);
    let pending = targetsFor(platform);
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
    for (let pass = 1; pass <= 2 && pending.length; pass += 1) {
      let failed;
      try {
        const result = await open(platform, (session) => sample(session, pending, { now, fx }));
        rows.push(...result.rows);
        failed = result.errors;
        // A retried category's counts replace its first-pass counts.
        for (const s of result.skipped ?? []) skipped.set([platform, s.category, s.reason].join('\u0000'), { platform, ...s });
      } catch (err) {
        failed = pending.map(({ category }) => ({ category, message: err.message }));
      }
      if (pass === 2) errors.push(...failed.map((e) => ({ platform, ...e })));
      pending = pending.filter((t) => failed.some((e) => e.category === t.category));
    }
  }
  for (const e of errors) log(`market ${e.platform}/${e.category} failed: ${e.message}`);
  for (const s of skipped.values()) log(`market ${s.platform}/${s.category} skipped ${s.count} (${s.reason})`);
  if (!rows.length) throw Object.assign(new Error('market sampling read no rows'), { code: 'FSW_MARKET_EMPTY', errors });

  const day = ctx.day ?? dayKey(now());
  const dir = ensureDir(instance.paths.market);
  const summaryFile = join(dir, `summary-${day}.json`);
  const samplesFile = join(dir, `samples-${day}.jsonl`);
  const read = new Set(rows.map(pairKey));
  const dayRows = [...readSamples(samplesFile).filter((r) => !read.has(pairKey(r))), ...rows];
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
