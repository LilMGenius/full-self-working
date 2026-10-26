#!/usr/bin/env node
// node scripts/surface-drift.mjs <platform> [--recording <file>] [--baseline <shapes.json>] [--write-baseline]
// Compares the answer shapes of a recording (default: the newest under <instance>/qa/surfaces/<platform>/)
// with the committed baseline (default: test/fixtures/surfaces/<platform>/shapes.json) and names each
// extractor whose answer changed shape, before a send path uses it. --write-baseline merges the
// recording's shapes into the baseline instead; shapes hold keys and types, never page text.
// Exit 0 without drift, 1 with drift, 2 on a usage error or when there is no recording.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { instanceDir, repoRoot } from '../src/core/instance.mjs';
import { driftReport, shapesOf } from '../src/surface/drift.mjs';
import { readRecording } from '../src/surface/recorder.mjs';

function newest(dir) {
  if (!existsSync(dir)) return null;
  const files = [];
  for (const day of readdirSync(dir)) for (const f of existsSync(join(dir, day)) && statSync(join(dir, day)).isDirectory() ? readdirSync(join(dir, day)) : []) if (f.endsWith('.jsonl')) files.push(join(dir, day, f));
  return files.sort().at(-1) ?? null;
}

export function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { recording: { type: 'string' }, baseline: { type: 'string' }, 'write-baseline': { type: 'boolean' } } });
  const [platform] = positionals;
  if (!platform) {
    console.error('usage: surface-drift <platform> [--recording file] [--baseline shapes.json] [--write-baseline]');
    return 2;
  }
  const file = values.recording ?? newest(join(instanceDir(), 'qa', 'surfaces', platform));
  if (!file) {
    console.error('surface-drift: no recording for ' + platform);
    return 2;
  }
  const baselineFile = values.baseline ?? join(repoRoot, 'test', 'fixtures', 'surfaces', platform, 'shapes.json');
  const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : {};
  const current = shapesOf(readRecording(file));
  if (values['write-baseline']) {
    for (const [k, shapes] of Object.entries(current)) baseline[k] = [...(baseline[k] ?? []), ...shapes.filter((s) => !(baseline[k] ?? []).some((b) => JSON.stringify(b) === JSON.stringify(s)))];
    writeFileSync(baselineFile, JSON.stringify(Object.fromEntries(Object.entries(baseline).sort()), null, 1) + '\n');
    console.log('surface-drift: baseline ' + baselineFile + ' holds ' + Object.keys(baseline).length + ' extractors');
    return 0;
  }
  const drift = driftReport(baseline, current);
  for (const d of drift) console.log('drift ' + d.extractor + ' ' + d.path + ': ' + d.before + ' -> ' + d.after);
  console.log('surface-drift: ' + Object.keys(current).length + ' extractors in ' + file + ', ' + drift.length + ' drifted');
  return drift.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/')) process.exitCode = main(process.argv.slice(2));
