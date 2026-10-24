#!/usr/bin/env node
// node scripts/probe.mjs <platform> <op> [arg] [--out <dir>]
// Runs one read op live against the operator's signed-in Chrome and prints a short summary: counts,
// field presence and booleans, never customer text. --out also writes the summary as JSON there.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ADAPTERS = {
  kmong: async () => (await import('../src/platforms/kmong/adapter.mjs')).openKmong(),
  soomgo: async () => (await import('../src/platforms/soomgo/adapter.mjs')).openSoomgo(),
};
const READ_OPS = ['login', 'inbox', 'readThread', 'listings', 'orders', 'profile', 'listingForm', 'requests', 'readRequest', 'dryRunSend', 'dryRunQuote'];

// Keeps the shape and drops the words: strings become their presence and length, arrays their count
// plus the field presence of their first rows.
export function summarize(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return `<${value.length} chars>`;
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

async function main() {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const outDir = outAt >= 0 ? args.splice(outAt, 2)[1] : null;
  const [platform, op, arg] = args;
  if (!ADAPTERS[platform] || !READ_OPS.includes(op)) {
    console.error(`usage: node scripts/probe.mjs <${Object.keys(ADAPTERS).join('|')}> <${READ_OPS.join('|')}> [arg] [--out dir]`);
    process.exit(2);
  }
  const adapter = await ADAPTERS[platform]();
  const started = Date.now();
  let summary;
  try {
    let result;
    if (op === 'dryRunSend') result = await adapter.send(arg, { text: 'fsw composer check', gate: { ok: true }, dryRun: true });
    else if (op === 'dryRunQuote') result = await adapter.quote(arg, { amountKRW: 10000, priceType: 'fixed', text: 'fsw quote form check', gate: { ok: true }, dryRun: true });
    else if (op === 'readThread') result = await adapter.readThread(arg, { willReply: false });
    else result = await adapter[op](arg);
    summary = { platform, op, arg: arg ?? null, ok: true, seconds: Math.round((Date.now() - started) / 1000), loads: adapter.session.loads, result: summarize(result) };
  } catch (err) {
    summary = { platform, op, arg: arg ?? null, ok: false, code: err.code ?? null, error: err.message, loads: adapter.session.loads };
    process.exitCode = 1;
  } finally {
    await adapter.stop();
  }
  const json = JSON.stringify(summary, null, 1);
  console.log(json);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${platform}-${op}${arg ? '-' + String(arg).replace(/\W+/g, '_').slice(0, 30) : ''}.json`), json + '\n');
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) await main();
