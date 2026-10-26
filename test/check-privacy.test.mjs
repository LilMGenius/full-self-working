import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../src/core/instance.mjs';
import { tempDir } from './tmp.mjs';

const script = join(repoRoot, 'scripts', 'check-privacy.mjs');

function setup(trackedText) {
  const root = tempDir('fsw-priv-');
  const repo = join(root, 'repo');
  const inst = join(root, 'inst');
  mkdirSync(repo);
  mkdirSync(inst);
  writeFileSync(join(inst, 'business.json'), JSON.stringify({ bizRegNo: '987-65-43210', email: 'owner@corp.test', payout: { bank: 'Bank', account: '111-2222-333333' } }));
  writeFileSync(join(inst, 'profile.json'), JSON.stringify({ person: { nameKo: 'x' } }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'notes.md'), trackedText);
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', 'notes.md'], { cwd: repo });
  const run = (instanceDir) => spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8', env: { ...process.env, FSW_INSTANCE: instanceDir } });
  return { root, inst, run };
}

test('check-privacy fails on a planted payout account written with other separators', () => {
  const s = setup('first line\npay to 111 2222 333333 please\n');
  try {
    const r = s.run(s.inst);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /notes\.md:2 holds business\.payout\.account/);
    assert.doesNotMatch(r.stderr, /333333/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('check-privacy passes on a clean repo and skips without an instance', () => {
  const s = setup('nothing personal here, 000-00-00000\n');
  try {
    const clean = s.run(s.inst);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /3 values checked/);
    const none = s.run(join(s.root, 'missing'));
    assert.equal(none.status, 0);
    assert.match(none.stdout, /no instance, skipped/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
