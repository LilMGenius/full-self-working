#!/usr/bin/env node
// node scripts/probe.mjs <platform> <op> [ref] [--kind message|request] [--out <dir>] [--record] [--now]
// One read operation of a surface on the operator's signed-in Chrome, printed as counts and field
// presence, never customer text. ops: login, sense, read (refuses a ref the list shows unread, since
// opening it would mark it read under the live supervisor), orders, supply, reviews, and frontier (kmong
// only: the top cards of each published gig's category and their cover images, saved under
// <instance>/qa/frontier/<day>/ as the reference set our listing images are judged against). It starts inside the probe
// window: after the live supervisor recorded its tick for the current 5-minute mark, and at least a
// minute before the next one, so it never shares the BrowserSkill extension with a poll; --now skips the
// wait. --record writes every call to <instance>/qa/surfaces/<platform>/<day>/. Exit 0 when the operation
// ran, 1 when it failed or was refused, 2 on a usage error.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dayKey, nextMark } from '../src/core/clock.mjs';
import { instanceDir } from '../src/core/instance.mjs';
import { catalog, targetsFor } from '../src/economics/catalog.mjs';
import { CATEGORY_FIELD } from '../src/economics/pricing.mjs';
import { readPublished } from '../src/listings/gig.mjs';
import { recordingPath } from '../src/surface/recorder.mjs';
import { hasSurface, openSurface } from '../src/surface/index.mjs';

export const READ_OPS = ['login', 'sense', 'read', 'orders', 'supply', 'reviews', 'frontier'];
// Ops that exist on one platform only.
const ONLY_ON = { frontier: 'kmong' };
export const FRONTIER_PER_CATEGORY = 3;
const MARK_MS = 5 * 60_000;
export const CLOSE_MS = 60_000;
export const FALLBACK_OPEN_MS = 150_000;

// Keeps the shape and drops the words: strings become their presence and length, arrays their count
// plus the field presence of their first rows. (scripts/probe.mjs:14-29 at 2c77326)
export function summarize(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return '<' + value.length + ' chars>';
  if (Array.isArray(value)) {
    const fields = {};
    for (const row of value.slice(0, 50)) {
      if (row && typeof row === 'object') for (const [k, v] of Object.entries(row)) fields[k] = (fields[k] ?? 0) + (v === null || v === undefined || v === '' ? 0 : 1);
    }
    return { count: value.length, ...(Object.keys(fields).length ? { fieldsPresent: fields } : {}) };
  }
  if (depth > 3) return '{…}';
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarize(v, depth + 1)]));
}

// When the probe may start: {wait: ms before asking again, reason}. lastTickAt is the live supervisor's
// run/state.json lastTick.at. A supervisor that ticked within the last two marks is live, and the window
// opens once it recorded the tick of the current mark; without one it opens FALLBACK_OPEN_MS after the
// mark. The window closes CLOSE_MS before the next mark.
export function probeWindow(now, lastTickAt) {
  const t = now.getTime();
  const next = nextMark(now, 5).getTime();
  const mark = next - MARK_MS;
  const closes = next - CLOSE_MS;
  const last = lastTickAt == null ? null : Date.parse(lastTickAt);
  const live = last != null && last >= mark - 2 * MARK_MS;
  const opens = !live ? mark + FALLBACK_OPEN_MS : last >= mark ? mark : null;
  if (t >= closes) return { wait: next - t, reason: 'too close to the next mark' };
  if (opens == null) return { wait: Math.min(30_000, closes - t), reason: 'waiting for the live tick of this mark' };
  if (t < opens) return { wait: opens - t, reason: 'no live supervisor; waiting ' + FALLBACK_OPEN_MS / 1000 + ' s after the mark' };
  return { wait: 0, reason: live ? 'the live tick of this mark is recorded' : 'no live supervisor and ' + FALLBACK_OPEN_MS / 1000 + ' s past the mark' };
}

const lastTick = (dir) => {
  const file = join(dir, 'run', 'state.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).lastTick?.at ?? null : null;
};

// The kmong targets of the services with a submitted gig, one per category, each listing every published
// service in that category, since two services can share one kmong category and each needs its entries.
export function frontierTargets(dir, list = catalog) {
  const published = new Set(readPublished({ dir }).map((p) => p.service));
  const subset = Object.fromEntries(Object.entries(list).filter(([id]) => published.has(id)));
  const field = CATEGORY_FIELD.kmong;
  return targetsFor('kmong', subset).map((t) => ({ ...t, services: Object.keys(subset).filter((id) => subset[id][field] === t.category) }));
}

const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

// Fetches one cover and returns {bytes, ext}; a placeholder, a failed answer or a body the host did not
// call an image (a block page answers 200 with HTML) throws, so nothing but an image is ever saved.
async function fetchCover(img, fetchImage) {
  if (!img) throw new Error('the card showed no cover image');
  if (img.startsWith('data:')) throw new Error('the card showed only a placeholder, no cover image');
  const res = await fetchImage(img);
  if (!res.ok) throw new Error('cover image answered ' + res.status);
  const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error('cover image answered ' + (type || 'no content type') + ', not an image');
  return { bytes: Buffer.from(await res.arrayBuffer()), ext: IMAGE_EXT[type] ?? (type.slice(6).replace(/[^a-z0-9]/g, '') || 'img') };
}

// Reads each category's top cards and saves their cover images to <instance>/qa/frontier/<day>/
// <service>-<rank>.<ext>, named by the category's first service, beside frontier.json (one entry per
// service and rank: category, rank, gig URL, rating, review count, file; no seller name, since the rows
// stay in the instance and kmong forbids redistribution). A category is skipped once every service in it
// has entries and every entry has a file, so a later run the same day reads again a category the window
// cut short or a rank whose cover failed. open() is asked before every category load and ends the op once
// the probe window closes.
export async function captureFrontier(surface, { dir, day, open = () => true, fetchImage = fetch, perCategory = FRONTIER_PER_CATEGORY, list = catalog } = {}) {
  const folder = join(dir, 'qa', 'frontier', day);
  mkdirSync(folder, { recursive: true });
  const index = join(folder, 'frontier.json');
  const entries = existsSync(index) ? JSON.parse(readFileSync(index, 'utf8')) : [];
  const save = () => {
    writeFileSync(index + '.tmp', JSON.stringify(entries, null, 1) + '\n');
    renameSync(index + '.tmp', index);
  };
  // stoppedByWindow is a flag, since the printed summary keeps numbers and booleans and drops words.
  const out = { categories: 0, skipped: 0, saved: 0, missing: 0, errors: [], stoppedByWindow: false };
  for (const target of frontierTargets(dir, list)) {
    const own = (service) => entries.filter((e) => e.service === service);
    if (target.services.every((s) => own(s).length && own(s).every((e) => e.file))) {
      out.skipped++;
      continue;
    }
    if (!open()) {
      out.stoppedByWindow = true;
      break;
    }
    const { rows, errors } = await surface.frontier([target], { perCategory });
    out.categories++;
    const name = target.services[0];
    for (const e of errors) out.errors.push(target.category + ': ' + e.message);
    for (const row of rows) {
      let file = null;
      let error = null;
      try {
        const cover = await fetchCover(row.img, fetchImage);
        file = name + '-' + row.rank + '.' + cover.ext;
        writeFileSync(join(folder, file), cover.bytes);
        out.saved++;
      } catch (err) {
        error = err.message;
        out.missing++;
      }
      for (const service of target.services) {
        const entry = { service, category: row.category, rank: row.rank, url: row.url, rating: row.rating, reviews: row.reviews, file, error };
        const at = entries.findIndex((e) => e.service === service && e.rank === row.rank);
        if (at >= 0) entries[at] = entry;
        else entries.push(entry);
      }
    }
    save();
  }
  return out;
}

export async function probe(argv, { now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), open = openSurface, log = console.log, fetchImage = fetch } = {}) {
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: true, options: { kind: { type: 'string', default: 'message' }, out: { type: 'string' }, record: { type: 'boolean' }, now: { type: 'boolean' } } });
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  const [platform, op, ref] = args.positionals;
  const { kind, out, record } = args.values;
  if (!hasSurface(platform) || !READ_OPS.includes(op) || (op === 'read' && !ref) || (ONLY_ON[op] && ONLY_ON[op] !== platform)) {
    console.error('usage: probe <kmong|soomgo> <' + READ_OPS.join('|') + '> [ref] [--kind message|request] [--out dir] [--record] [--now]');
    return 2;
  }
  const dir = instanceDir();
  for (let w = probeWindow(now(), lastTick(dir)); !args.values.now && w.wait > 0; w = probeWindow(now(), lastTick(dir))) {
    log('probe window: ' + w.reason + ', waiting ' + Math.ceil(w.wait / 1000) + ' s');
    await sleep(Math.min(w.wait, 30_000));
  }
  const started = now();
  const surface = await open(platform, record ? { record: recordingPath(dir, platform, op, started) } : {});
  let summary;
  let code = 0;
  try {
    let result;
    if (op === 'read') {
      const row = (await surface.sense()).find((r) => r.ref === String(ref) && r.kind === kind);
      if (!row) throw Object.assign(new Error(kind + ' ' + ref + ' is not in the list'), { code: 'FSW_THREAD_NOT_LISTED' });
      if (row.unread) throw Object.assign(new Error(kind + ' ' + ref + ' is unread; a probe never opens it'), { code: 'FSW_PROBE_UNREAD' });
      result = await surface.read(String(ref), { willReply: false, kind });
    } else if (op === 'frontier') {
      const inWindow = () => args.values.now || probeWindow(now(), lastTick(dir)).wait === 0;
      result = await captureFrontier(surface, { dir, day: dayKey(started), open: inWindow, fetchImage });
    } else result = await surface[op]();
    summary = { platform, op, ref: ref ?? null, ok: true, seconds: Math.round((now() - started) / 1000), loads: surface.session.loads ?? null, result: summarize(result) };
  } catch (err) {
    summary = { platform, op, ref: ref ?? null, ok: false, code: err.code ?? null, error: err.message, loads: surface.session.loads ?? null };
    code = 1;
  } finally {
    await surface.stop();
  }
  const json = JSON.stringify(summary, null, 1);
  log(json);
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, platform + '-' + op + (ref ? '-' + String(ref).replace(/\W+/g, '_').slice(0, 30) : '') + '.json'), json + '\n');
  }
  return code;
}

if (process.argv[1] && import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/')) process.exitCode = await probe(process.argv.slice(2));
