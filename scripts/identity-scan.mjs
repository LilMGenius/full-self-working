#!/usr/bin/env node
// Before a push and before the takeover: no tracked file and no commit message on the branch holds an
// identity term of the instance (identityNames of src/policy/gate.mjs, plus config.browser.chromeProfile,
// 003 Settings). The two floor hooks name the floor's source repository and are the only allowed hits
// (003 Decisions, identity scan). Prints term indexes, never terms; exit 1 on any other hit.
// node scripts/identity-scan.mjs <repo> [<branch>]   (FSW_INSTANCE names the instance)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInstance } from '../src/core/instance.mjs';
import { identityNames, namePattern } from '../src/policy/gate.mjs';

export const ALLOWED = new Set(['hooks/commit-msg', 'hooks/commit-range.mjs']);

// Pure: identity terms of an instance, as whole-word patterns (mark is not market, as the gate does).
export const identityTerms = (instance) => [...identityNames(instance), instance.config?.browser?.chromeProfile].filter(Boolean).map((t) => namePattern(t));

// Pure: {hits, allowed, lines} over [file, text] pairs.
export function scan(texts, terms) {
  let hits = 0;
  let allowed = 0;
  const lines = [];
  for (const [f, t] of texts) {
    terms.forEach((re, i) => {
      if (!re.test(t)) return;
      if (ALLOWED.has(f)) allowed += 1;
      else hits += 1;
      lines.push((ALLOWED.has(f) ? 'allowed: ' : '') + 'identity term #' + i + ' in ' + f);
    });
  }
  return { hits, allowed, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repo = process.argv[2];
  const branch = process.argv[3] ?? 'HEAD';
  const terms = identityTerms(loadInstance());
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  const texts = files.map((f) => [f, readFileSync(join(repo, f), 'utf8')]).concat([['(commit messages of ' + branch + ')', git('log', '--format=%B', branch)]]);
  const r = scan(texts, terms);
  for (const l of r.lines) console.error(l);
  console.log('identity scan: ' + terms.length + ' terms over ' + files.length + ' files and the messages of ' + branch + ', ' + r.hits + ' hits, ' + r.allowed + ' allowed');
  process.exit(r.hits ? 1 : 0);
}
