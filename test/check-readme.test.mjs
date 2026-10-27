import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../src/core/instance.mjs';
import { tempDir } from './tmp.mjs';

const audit = (dir) => spawnSync(process.execPath, [join(repoRoot, 'scripts', 'check-readme.mjs'), dir], { encoding: 'utf8' });

test('check-readme fails a README that holds a check command with R1, and passes a clean README beside an AGENTS.md', () => {
  const red = tempDir('fsw-readme-');
  writeFileSync(join(red, 'README.md'), '# Tool\n\nRun `npm run check` before you open a pull request.\n');
  writeFileSync(join(red, 'AGENTS.md'), '# Agents\n\nRun npm run check before every commit.\n');
  const r = audit(red);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL R1 L3/);

  const green = tempDir('fsw-readme-');
  writeFileSync(join(green, 'README.md'), '# Tool\n\nTool answers your customers while you sleep.\n');
  writeFileSync(join(green, 'AGENTS.md'), '# Agents\n\nRun npm run check before every commit.\n');
  const g = audit(green);
  assert.equal(g.status, 0, g.stdout + g.stderr);
  assert.match(g.stdout, /AUDIENCE GREEN/);
});
