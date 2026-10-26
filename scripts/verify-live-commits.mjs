#!/usr/bin/env node
// Fidelity gate for the takeover (003 "Live-commit manifest"): every commit old main gained after the
// manifest's base is listed exactly once by its full id, each owner commit is an ancestor of the target,
// and every path the commit touched that v0 carries (its own path, or its pathMap entry) exists at the
// owner commit and at the target. One line per finding; exit 1 on any, 2 on a usage error.
// node scripts/verify-live-commits.mjs --repo <old checkout> --old <old tip> --target <v0 commit> [--v0 <v0 checkout>] [--manifest docs/live-commits.json] [--fill <doc> --at <commit>]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const FULL = /^[0-9a-f]{40}$/;
const short = (id) => String(id).slice(0, 7);

// Pure: findings for a manifest against the live commits and two git predicates.
export function check(manifest, { liveIds, isAncestor, existsAt, target }) {
  const findings = [];
  const byId = new Map();
  for (const e of manifest.entries ?? []) {
    if (!FULL.test(e.commit ?? '')) {
      findings.push('not a full 40-character commit id: ' + e.commit);
      continue;
    }
    if (byId.has(e.commit)) findings.push('listed twice: ' + e.commit);
    byId.set(e.commit, e);
  }
  for (const id of liveIds) if (!byId.has(id)) findings.push('live commit missing from the manifest: ' + id);
  for (const id of byId.keys()) if (!liveIds.includes(id)) findings.push('manifest names a commit that is not on old main after the base: ' + id);
  const moved = new Map((manifest.pathMap ?? []).map((m) => [m.old, m.v0]));
  for (const e of byId.values()) {
    if (!e.owner?.length) findings.push(short(e.commit) + ' names no owner doc');
    if (!FULL.test(e.ownerCommit ?? '')) {
      findings.push(short(e.commit) + ' has no owner commit');
      continue;
    }
    if (!isAncestor(e.ownerCommit, target)) findings.push(short(e.commit) + ': owner ' + short(e.ownerCommit) + ' is not an ancestor of the target ' + short(target));
    for (const p of e.paths ?? []) {
      const v0 = moved.has(p) ? moved.get(p) : p;
      if (v0 === null) continue;
      for (const [at, name] of [[e.ownerCommit, 'owner'], [target, 'target']]) if (!existsAt(at, v0)) findings.push(short(e.commit) + ': ' + v0 + ' is missing at the ' + name + ' ' + short(at));
    }
  }
  return findings;
}

// Pure: the manifest with ownerCommit set to at for every entry whose last owner doc is doc and which has none.
export function fill(manifest, doc, at) {
  if (!FULL.test(at)) throw new RangeError('--at needs a full commit id');
  return { ...manifest, entries: manifest.entries.map((e) => (e.ownerCommit == null && e.owner?.at(-1) === doc ? { ...e, ownerCommit: at } : e)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: a } = parseArgs({ options: { repo: { type: 'string' }, old: { type: 'string' }, target: { type: 'string' }, v0: { type: 'string', default: process.cwd() }, manifest: { type: 'string', default: 'docs/live-commits.json' }, fill: { type: 'string' }, at: { type: 'string' } } });
  const file = resolve(a.v0, a.manifest);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (a.fill) {
    writeFileSync(file, JSON.stringify(fill(manifest, a.fill, a.at), null, 2) + '\n');
    process.exit(0);
  }
  if (!a.repo || !a.old || !a.target) {
    console.error('usage: verify-live-commits.mjs --repo <old checkout> --old <old tip> --target <v0 commit> [--v0 <dir>] [--manifest <file>] [--fill <doc> --at <commit>]');
    process.exit(2);
  }
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const target = git(a.v0, 'rev-parse', a.target);
  const liveIds = git(a.repo, 'rev-list', '--reverse', manifest.base + '..' + a.old).split(/\s+/).filter(Boolean);
  const isAncestor = (x, y) => spawnSync('git', ['-C', a.v0, 'merge-base', '--is-ancestor', x, y]).status === 0;
  const existsAt = (at, p) => spawnSync('git', ['-C', a.v0, 'cat-file', '-e', at + ':' + p]).status === 0;
  const findings = check(manifest, { liveIds, isAncestor, existsAt, target });
  for (const f of findings) console.log(f);
  console.log('verify-live-commits: ' + liveIds.length + ' live commits, ' + manifest.entries.length + ' entries, ' + findings.length + ' finding(s)');
  process.exit(findings.length ? 1 : 0);
}
