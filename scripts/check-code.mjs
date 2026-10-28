#!/usr/bin/env node
// Two honesty checks over tracked JavaScript (AGENTS.md honestCode): an export nothing imports, and a catch that
// swallows an error without handling it or saying why. Regex-based over this codebase's style (named exports,
// static and dynamic imports, re-exports through a module's index).
//   node scripts/check-code.mjs   exit 1 on an unused export or a silent catch
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = ['src/', 'scripts/', 'bin/', 'test/'];
// Exports a host loads by name, so no import names them.
export const ALLOW = [
  { file: /^src\/cli\/[^/]+\.mjs$/, name: 'run', why: 'bin/fsw.mjs loads the verb module by name' },
  { file: /^src\/platforms\/[^/]+\/onboarding\.mjs$/, name: 'onboard', why: 'src/cli/onboard.mjs loads it by platform' },
  { file: /^src\/platforms\/[^/]+\/onboarding\.mjs$/, name: 'STEPS', why: 'src/cli/onboard.mjs reads the steps of the module it loads by platform' },
];

const EXPORT_RES = [/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm, /^export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm];
const EXPORT_LIST = /^export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/gm;
const EXPORT_ALL = /^export\s*\*\s*from\s*['"]([^'"]+)['"]/gm;
const IMPORT_RE = /import\s*(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}|\*\s*as\s+[\w$]+)?\s*from\s*['"]([^'"]+)['"]/g;
const NAMESPACE_RE = /import\s*\*\s*as\s+[\w$]+\s*from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_ANY = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
// An empty catch block, a catch holding only a short comment, or a promise catch that returns nothing.
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\/[^\n]*\n\s*)?\}/g;
const EMPTY_PROMISE_CATCH = /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\{\s*\}|null|undefined)\s*\)/g;
// A reason is a comment of four or more words on the catch or the line above it.
const REASON = /\/\/\s*\S+(?:\s+\S+){3,}/;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const resolveFrom = (file, spec) => (spec.startsWith('.') ? normalize(join(dirname(file), spec)).split('\\').join('/') : null);
const imported = (list) => list.split(',').map((s) => s.trim().split(/\s+as\s+/)[0].split(/\s*:\s*/)[0].trim()).filter(Boolean);

export function exportsOf(text) {
  const out = new Set();
  for (const re of EXPORT_RES) for (const m of text.matchAll(re)) out.add(m[1]);
  for (const m of text.matchAll(EXPORT_LIST)) for (const n of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean)) out.add(n);
  return out;
}

// files: {path: text}. Returns [{file, name, internal}] for exports of non-test, non-bin files that no other file
// imports by name and whose module is never imported whole (a namespace import, export * from, or a dynamic
// import that does not destructure); internal: the name is still used inside its own file. A re-export
// (export {x} from) counts as a use of x in its source. ALLOW lists the exports a host loads by name.
export function deadExports(files, allow = ALLOW) {
  const used = new Map();
  const whole = new Set();
  const mark = (target, n) => {
    if (!target) return;
    if (!used.has(target)) used.set(target, new Set());
    used.get(target).add(n);
  };
  for (const [file, text] of Object.entries(files)) {
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolveFrom(file, m[3]);
      if (m[1]) mark(target, 'default');
      if (m[2]) for (const n of imported(m[2])) mark(target, n);
    }
    for (const m of text.matchAll(EXPORT_LIST)) if (m[2]) for (const n of imported(m[1])) mark(resolveFrom(file, m[2]), n);
    for (const m of text.matchAll(EXPORT_ALL)) whole.add(resolveFrom(file, m[1]));
    for (const m of text.matchAll(NAMESPACE_RE)) whole.add(resolveFrom(file, m[1]));
    const destructured = new Set();
    for (const m of text.matchAll(DYNAMIC_RE)) {
      destructured.add(m[2]);
      for (const n of imported(m[1])) mark(resolveFrom(file, m[2]), n);
    }
    for (const m of text.matchAll(DYNAMIC_ANY)) if (!destructured.has(m[1])) whole.add(resolveFrom(file, m[1]));
  }
  const out = [];
  for (const [file, text] of Object.entries(files)) {
    if (whole.has(file) || file.startsWith('test/') || file.startsWith('bin/')) continue;
    for (const name of exportsOf(text)) {
      if (used.get(file)?.has(name) || allow.some((a) => a.file.test(file) && a.name === name)) continue;
      const inFile = text.split(new RegExp('(?<![\\w$])' + name.replace(/\$/g, '\\$') + '(?![\\w$])')).length - 1;
      out.push({ file, name, internal: inFile > 1 });
    }
  }
  return out;
}

export function silentCatches(file, text) {
  const out = [];
  for (const re of [EMPTY_CATCH, EMPTY_PROMISE_CATCH]) {
    for (const m of text.matchAll(re)) {
      const line = lineOf(text, m.index);
      const context = text.split('\n').slice(Math.max(0, line - 2), line).join('\n');
      if (REASON.test(m[0]) || REASON.test(context)) continue;
      out.push({ file, line, excerpt: m[0].replace(/\s+/g, ' ').slice(0, 60) });
    }
  }
  return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const list = execFileSync('git', ['ls-files', '-z', ...ROOTS], { encoding: 'utf8' }).split('\0').filter((f) => /\.m?js$/.test(f));
  const files = Object.fromEntries(list.map((f) => [f, readFileSync(f, 'utf8')]));
  const found = deadExports(files);
  const dead = found.filter((d) => !d.internal);
  const internal = found.filter((d) => d.internal);
  const catches = list.filter((f) => !f.startsWith('test/')).flatMap((f) => silentCatches(f, files[f]));
  for (const d of dead) console.error('check-code: unused export ' + d.file + ' ' + d.name);
  for (const c of catches) console.error('check-code: silent catch ' + c.file + ':' + c.line + ' ' + c.excerpt);
  console.log('check-code: ' + list.length + ' files, ' + dead.length + ' unused exports, ' + catches.length + ' silent catches; ' + internal.length + ' exports used only inside their own file (a note, not a failure)');
  process.exit(dead.length || catches.length ? 1 : 0);
}
