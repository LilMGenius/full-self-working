#!/usr/bin/env node
// Lints tracked customer-facing sources (examples, playbooks, recipes, site) with the slop gate.
// Floor findings fail the check; reflex findings are listed as warnings.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { lintText } from '../src/policy/slop.mjs';

const ROOTS = ['examples/', 'playbooks/', 'recipes/', 'site/'];
const files = execFileSync('git', ['ls-files', '-z', ...ROOTS], { encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && /\.(md|json|html)$/.test(f) && !f.startsWith('site/dist/') && existsSync(f));

let floor = 0;
let reflex = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const f of lintText(text)) {
    const line = text.slice(0, f.index).split('\n').length;
    const where = `${file}:${line} ${f.rule} "${f.excerpt}"`;
    if (f.tier === 'floor') {
      floor++;
      console.error('check-slop: floor ' + where);
    } else {
      reflex++;
      console.log('check-slop: reflex ' + where);
    }
  }
}
console.log(`check-slop: ${files.length} files, ${floor} floor, ${reflex} reflex`);
process.exit(floor ? 1 : 0);
