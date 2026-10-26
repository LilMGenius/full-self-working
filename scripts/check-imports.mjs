#!/usr/bin/env node
// Module boundaries of docs/DESIGN.md (003 Module paths): reads every static and dynamic import with a
// literal specifier under src/**/*.mjs, maps each file to its module (the first folder under src/, with
// src/browser counting as platforms), and fails a forbidden edge, a module the table does not list, and
// a file-level import cycle. Prints file:line and the edge; exit 1 on any problem. A phase that adds a
// module adds its row here in the same change.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODULES = ['core', 'platforms', 'surface', 'economics', 'policy', 'triage', 'brain', 'outbox', 'deal', 'work', 'render', 'portfolio', 'learning', 'listings', 'projects', 'profile', 'loop', 'supervisor', 'cli', 'site'];

// importer -> what it never imports: a module name, or a repository path for a single file.
export const FORBIDDEN = {
  core: MODULES.filter((m) => m !== 'core'),
  platforms: ['surface', 'triage', 'brain', 'outbox', 'deal', 'work', 'loop', 'supervisor'],
  surface: ['policy', 'brain', 'deal', 'outbox', 'src/core/ledger.mjs'],
  policy: ['surface', 'brain', 'deal'],
  triage: ['surface', 'brain'],
  brain: ['surface', 'deal', 'outbox'],
  outbox: ['brain', 'deal'],
  deal: ['surface', 'brain', 'outbox', 'work'],
  work: ['surface', 'deal', 'outbox'],
};

const ALIAS = { browser: 'platforms' };

// The supervisor runs from a deploy worktree that never runs npm (003 FSW_CODE_DIR), so no file it loads
// from src/cli/run.mjs may import a package; ajv is loaded only inside validateConfig, which fsw settings
// alone calls (A1).
export const DEPLOY_ENTRY = 'src/cli/run.mjs';
const DEPLOY_EXEMPT = { 'src/core/config.mjs': ['ajv'] };
const posix = (p) => p.split(sep).join('/');

// The module of a repository path, or null for a path outside src/, bin/ and site/.
export function moduleOf(rel) {
  const parts = posix(rel).split('/');
  if (parts[0] === 'bin') return 'cli';
  if (parts[0] === 'site') return 'site';
  if (parts[0] !== 'src' || parts.length < 3) return null;
  return ALIAS[parts[1]] ?? parts[1];
}

// [{spec, line, dynamic}] for import ... from, export ... from, bare import and import() with a string literal.
export function importsOf(text) {
  const out = [];
  const lineAt = (i) => text.slice(0, i).split('\n').length;
  const patterns = [
    /(?:^|\n)[ \t]*(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
    /(?:^|\n)[ \t]*import\s*(['"])([^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];
  // A specifier never holds whitespace; a quoted span that does is code inside a string (a probe script).
  patterns.forEach((re, i) => { for (const m of text.matchAll(re)) if (!/\s/.test(m[2])) out.push({ spec: m[2], line: lineAt(m.index + m[0].lastIndexOf(m[2])), dynamic: i === 2 }); });
  return out.sort((a, b) => a.line - b.line);
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : []));
}

const forbids = (from, to, target) => (FORBIDDEN[from] ?? []).some((f) => (f.includes('/') ? f === target : f === to && to !== from));

export function checkImports(root) {
  const problems = [];
  const files = walk(join(root, 'src')).map((f) => posix(relative(root, f))).sort();
  const graph = new Map();
  const bare = new Map();
  for (const file of files) {
    const from = moduleOf(file);
    if (!MODULES.includes(from)) problems.push(file + ':1 module ' + from + ' has no row in the module table');
    const edges = [];
    const packages = [];
    for (const { spec, line, dynamic } of importsOf(readFileSync(join(root, file), 'utf8'))) {
      if (!spec.startsWith('.')) {
        if (!spec.startsWith('node:') && !(dynamic && DEPLOY_EXEMPT[file]?.some((p) => spec === p || spec.startsWith(p + '/')))) packages.push({ spec, line });
        continue;
      }
      const target = posix(relative(root, resolve(root, dirname(file), spec)));
      const to = moduleOf(target);
      if (to && forbids(from, to, target)) problems.push(file + ':' + line + ' ' + from + ' -> ' + (FORBIDDEN[from].includes(target) ? target : to) + ' is forbidden');
      if (files.includes(target)) edges.push({ target, line });
    }
    graph.set(file, edges);
    bare.set(file, packages);
  }
  // Every file the deploy worktree loads, from its entry through static and dynamic relative imports.
  const reach = new Set();
  const queue = files.includes(DEPLOY_ENTRY) ? [DEPLOY_ENTRY] : [];
  while (queue.length) {
    const f = queue.pop();
    if (reach.has(f)) continue;
    reach.add(f);
    for (const e of graph.get(f)) queue.push(e.target);
  }
  for (const f of [...reach].sort()) for (const p of bare.get(f)) problems.push(f + ':' + p.line + ' ' + f + ' imports ' + p.spec + ', which the deploy worktree cannot resolve (no node_modules)');
  // Depth-first search; a back edge closes a cycle, reported once by its smallest file.
  const state = new Map();
  const seen = new Set();
  const stack = [];
  const visit = (file) => {
    state.set(file, 1);
    stack.push(file);
    for (const { target, line } of graph.get(file)) {
      if (state.get(target) === 1) {
        const cycle = stack.slice(stack.indexOf(target));
        const start = cycle.indexOf([...cycle].sort()[0]);
        const key = [...cycle.slice(start), ...cycle.slice(0, start)].join(' -> ');
        if (!seen.has(key)) {
          seen.add(key);
          problems.push(file + ':' + line + ' import cycle ' + cycle.join(' -> ') + ' -> ' + target);
        }
      } else if (!state.has(target)) visit(target);
    }
    stack.pop();
    state.set(file, 2);
  };
  for (const file of files) if (!state.has(file)) visit(file);
  return problems;
}

if (process.argv[1] && import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/')) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const problems = checkImports(root);
  for (const p of problems) console.error('check-imports: ' + p);
  if (problems.length) process.exit(1);
  console.log('check-imports: no forbidden edge or import cycle under src');
}
