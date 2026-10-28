#!/usr/bin/env node
// Fails when the code reads an instance key that examples/instance does not hold, so a new user who
// runs `fsw init` never meets a missing key. Reads are found statically: `config.a.b`,
// `instance.config?.a?.b`, one alias hop (`const brain = instance.config?.brain ?? {}; brain.model`),
// `profile.x` and `business.x`. A key whose example value is null means "use the built-in default".
// Platform entries (config.platforms.<id>) are keyed by id, so their option names are listed in
// PLATFORM_KEYS and the example must show each on at least one platform.
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defaultsOf, loadSchema, undocumentedKeys } from '../src/core/config.mjs';
import { exampleDir, readJson, repoRoot } from '../src/core/instance.mjs';

// Maps keyed by an id the operator or the catalog chooses, so the segment after them is data, not a key.
const OPEN_MAPS = new Set(['config.platforms', 'profile.serviceFit', 'profile.skills']);
export const PLATFORM_KEYS = ['enabled', 'mode', 'profileEdits', 'maxQuotesPerDay', 'maxCashPerDay', 'services', 'quoteGate'];

const CHAIN = '(?:\\??\\.[A-Za-z_]\\w*)';
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// Returns [{root: 'config'|'profile'|'business', path: ['a','b']}] for one source text.
export function findReads(source) {
  const src = stripComments(source);
  const reads = [];
  // A chain that runs into a file extension (profile.draft.json, config.json) names a file in prose or a path.
  const add = (root, path) => path.length && !path.some((k) => ['json', 'md', 'mjs'].includes(k)) && reads.push({ root, path });
  const chain = (text) => [...text.matchAll(/\??\.([A-Za-z_]\w*)/g)].map((m) => m[1]);
  for (const m of src.matchAll(new RegExp(`(?<![\\w$])(?:instance\\.)?(config|profile|business)((?:\\??\\.[A-Za-z_]\\w*)+)`, 'g'))) {
    add(m[1], chain(m[2]));
  }
  // one alias hop: const brain = instance.config?.brain ?? {};  then brain.model / brain?.model
  for (const m of src.matchAll(new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*(?:\\w+\\.)*(config|profile|business)((?:\\??\\.[A-Za-z_]\\w*)+)`, 'g'))) {
    const [, alias, root, rest] = m;
    const base = chain(rest);
    if (alias === root) continue;
    for (const u of src.matchAll(new RegExp(`(?<![\\w$.])${alias}((?:\\??\\.[A-Za-z_]\\w*)+)`, 'g'))) add(root, [...base, ...chain(u[1])]);
  }
  return reads;
}

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

const hasPath = (obj, path) => {
  let cur = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object' || !(k in cur)) return false;
    cur = cur[k];
  }
  return true;
};

// Missing keys for the given reads against the example documents: [{file, root, key}].
export function missingKeys(readsByFile, example) {
  const missing = [];
  for (const [file, reads] of readsByFile) {
    for (const { root, path } of reads) {
      const doc = example[root];
      // methods and array helpers that follow a data key are not keys
      const keys = [];
      let cur = doc;
      for (const k of path) {
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) break;
        if (OPEN_MAPS.has(root + '.' + keys.join('.'))) break;
        if (!(k in cur)) {
                    keys.push(k);
          missing.push({ file, root, key: keys.join('.') });
          break;
        }
        keys.push(k);
        cur = cur[k];
      }
    }
  }
  const platformEntries = Object.values(example.config.platforms ?? {});
  for (const key of PLATFORM_KEYS) {
    if (!platformEntries.some((p) => key in p)) missing.push({ file: '(PLATFORM_KEYS)', root: 'config', key: `platforms.<id>.${key}` });
  }
  const seen = new Set();
  return missing.filter((m) => !seen.has(m.file + m.root + m.key) && seen.add(m.file + m.root + m.key));
}

export function loadExample() {
  // The config document is the schema's defaults, which gen-example-config writes to examples/instance.
  return { config: defaultsOf(loadSchema()), profile: readJson(join(exampleDir, 'profile.json')), business: readJson(join(exampleDir, 'business.json')) };
}

export function checkExample(root = repoRoot) {
  const reads = new Map();
  for (const dir of ['src', 'scripts', 'bin']) {
    let files = [];
    try {
      files = sourceFiles(join(root, dir));
    } catch {
      continue;
    }
    for (const f of files) reads.set(relative(root, f).replace(/\\/g, '/'), findReads(readFileSync(f, 'utf8')));
  }
  return [...missingKeys(reads, loadExample()), ...undocumentedKeys().map((key) => ({ file: 'src/core/config.schema.json', root: 'schema', key }))];
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const missing = checkExample();
  for (const m of missing) console.error(`check-example: ${m.file} reads ${m.root}.${m.key}, which examples/instance lacks`);
  if (missing.length) process.exit(1);
  console.log('check-example: every config, profile and business key the code reads is in examples/instance');
}
