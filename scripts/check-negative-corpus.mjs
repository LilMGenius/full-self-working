#!/usr/bin/env node
// Keeps docs/NEGATIVE-CORPUS.md tied to what holds each lesson: a held gate, test or note row names a
// file that exists and contains its anchor; a row whose phase is at or before the Phase line is held; a
// note without a holder file names its source. Prints one line per problem; exit 1 on any.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../src/core/instance.mjs';

const KINDS = ['gate', 'test', 'note'];
const PHASE = /^wp([1-9])$/;

export function checkCorpus(text, { root = repoRoot } = {}) {
  const problems = [];
  const phase = text.match(/^Phase: (wp[1-9])$/m)?.[1];
  if (!phase) return ['no "Phase: wpN" line'];
  const rows = text.split(/\r?\n/).filter((l) => /^\| \d+ \|/.test(l)).map((l) => l.slice(1, -1).split('|').map((c) => c.trim()));
  if (!rows.length) return ['no lesson rows'];
  rows.forEach((cells, i) => {
    const at = 'row ' + (cells[0] ?? i + 1);
    if (cells.length !== 8) return problems.push(at + ': ' + cells.length + ' cells, expected 8');
    const [n, lesson, kind, holder, anchor, lands, status, source] = cells;
    if (Number(n) !== i + 1) problems.push(at + ': numbered ' + n + ', expected ' + (i + 1));
    if (!lesson) problems.push(at + ': no lesson');
    if (!KINDS.includes(kind)) problems.push(at + ': kind ' + kind + ' is not gate, test or note');
    if (!PHASE.test(lands)) problems.push(at + ': lands ' + lands + ' is not wp1 to wp9');
    if (!['held', 'pending'].includes(status)) problems.push(at + ': status ' + status + ' is not held or pending');
    if (!source || source === '-') problems.push(at + ': no source');
    if (status === 'pending' && PHASE.test(lands) && Number(lands.slice(2)) <= Number(phase.slice(2))) problems.push(at + ': still pending at ' + phase + ' though it lands in ' + lands);
    if (status !== 'held') return;
    if (holder === '-') {
      if (kind !== 'note') problems.push(at + ': a held ' + kind + ' names no holder file');
      return;
    }
    const file = join(root, holder);
    if (!existsSync(file)) return problems.push(at + ': holder ' + holder + ' does not exist');
    if (!anchor || anchor === '-' || !readFileSync(file, 'utf8').includes(anchor)) problems.push(at + ': ' + holder + ' does not contain "' + anchor + '"');
  });
  return problems;
}

if (import.meta.url === 'file:///' + process.argv[1]?.replace(/\\/g, '/')) {
  const problems = checkCorpus(readFileSync(join(repoRoot, 'docs', 'NEGATIVE-CORPUS.md'), 'utf8'));
  for (const p of problems) console.error('check-negative-corpus: ' + p);
  if (problems.length) process.exit(1);
  console.log('check-negative-corpus: every held lesson names a holder that contains its anchor');
}
