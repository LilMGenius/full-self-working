// Every script npm run check calls runs its check when started as a program. Each is started through a junction to
// scripts/, as a skill link or a symlinked checkout starts it, so an entry check that compares the path as typed with
// import.meta.url (which Node sets from the real path) or builds 'file:///' + a POSIX path is a no-op here and the
// script's own output line is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../src/core/instance.mjs';
import { tempDir } from './tmp.mjs';

const CHECKS = [
  ['check-privacy.mjs', [], /^check-privacy: /m],
  ['check-slop.mjs', [], /^check-slop: /m],
  ['check-descriptors.mjs', [], /^check-descriptors: /m],
  ['check-example.mjs', [], /^check-example: /m],
  ['gen-example-config.mjs', ['--check'], /^gen-example-config: /m],
  ['check-recipes.mjs', [], /^check-recipes: /m],
  ['check-imports.mjs', [], /^check-imports: /m],
  ['check-negative-corpus.mjs', [], /^check-negative-corpus: /m],
  ['check-readme.mjs', [], /^AUDIENCE /m],
  ['check-size.mjs', [], /^check-size: /m],
  ['check-code.mjs', [], /^check-code: /m],
];

test('every check script runs and prints its result line when started through a link to scripts/', { timeout: 180000 }, () => {
  const link = join(tempDir('fsw-entry-'), 'scripts');
  symlinkSync(join(repoRoot, 'scripts'), link, process.platform === 'win32' ? 'junction' : 'dir');
  for (const [file, args, line] of CHECKS) {
    const r = spawnSync(process.execPath, [join(link, file), ...args], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, env: { ...process.env, CI: process.env.CI ?? '' } });
    assert.match(r.stdout + r.stderr, line, file + ' printed no result line, so its entry check did not run it:\n' + r.stdout + r.stderr);
    assert.equal(r.status, 0, file + ' failed:\n' + r.stdout + r.stderr);
  }
});
