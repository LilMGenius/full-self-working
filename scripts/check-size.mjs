#!/usr/bin/env node
// Fails on any tracked source file over MAX_LINES lines; a test file is listed but does not fail the check, since
// it grows with the cases it pins. The limit is v0's split rule (wp9). JSON files are data, so only .mjs and .js
// count.
//   node scripts/check-size.mjs   exit 1 on a source file over the limit
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_LINES = 400;
const ROOTS = ['src/', 'scripts/', 'bin/', 'test/'];

const countLines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// [{file, lines, test}] for every .mjs or .js file in files over MAX_LINES; read(file) returns its text.
export function oversized(files, read = (f) => readFileSync(f, 'utf8')) {
  return files
    .filter((f) => /\.m?js$/.test(f))
    .map((f) => ({ file: f, lines: countLines(read(f)), test: f.startsWith('test/') }))
    .filter((r) => r.lines > MAX_LINES);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '-z', ...ROOTS], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const over = oversized(files);
  for (const r of over) (r.test ? console.log : console.error)('check-size: ' + r.file + ' ' + r.lines + ' lines' + (r.test ? ' (test, not failing)' : ''));
  const failing = over.filter((r) => !r.test).length;
  console.log('check-size: ' + files.length + ' files, ' + failing + ' source files over ' + MAX_LINES + ' lines');
  process.exit(failing ? 1 : 0);
}
