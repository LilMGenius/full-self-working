#!/usr/bin/env node
// node scripts/probe.mjs <platform> <op> [ref] [--kind message|request] [--out <dir>] [--record] [--now]
// One read operation of a surface on the operator's signed-in Chrome, printed as counts and field
// presence, never customer text. ops: login, sense, read (refuses a ref the list shows unread, since
// opening it would mark it read under the live supervisor), orders, supply. It starts inside the probe
// window: after the live supervisor recorded its tick for the current 5-minute mark, and at least a
// minute before the next one, so it never shares the BrowserSkill extension with a poll; --now skips the
// wait. --record writes every call to <instance>/qa/surfaces/<platform>/<day>/. Exit 0 when the operation
// ran, 1 when it failed or was refused, 2 on a usage error.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { nextMark } from '../src/core/clock.mjs';
import { instanceDir } from '../src/core/instance.mjs';
import { recordingPath } from '../src/surface/recorder.mjs';
import { hasSurface, openSurface } from '../src/surface/index.mjs';

export const READ_OPS = ['login', 'sense', 'read', 'orders', 'supply'];
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

export async function probe(argv, { now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), open = openSurface, log = console.log } = {}) {
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: true, options: { kind: { type: 'string', default: 'message' }, out: { type: 'string' }, record: { type: 'boolean' }, now: { type: 'boolean' } } });
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  const [platform, op, ref] = args.positionals;
  const { kind, out, record } = args.values;
  if (!hasSurface(platform) || !READ_OPS.includes(op) || (op === 'read' && !ref)) {
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
