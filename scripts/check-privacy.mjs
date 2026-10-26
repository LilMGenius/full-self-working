#!/usr/bin/env node
// Fails when any tracked file holds a sensitive value from the instance (FSW_INSTANCE, default
// <repo>/instance.local). Numbers match with any separators between digits; e-mails match case-insensitively.
// The value itself is never printed, only the field it came from, so CI logs stay clean.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instanceDir } from '../src/core/instance.mjs';

const dir = instanceDir();
if (!existsSync(dir)) {
  console.log('check-privacy: no instance, skipped');
  process.exit(0);
}

const read = (file) => (existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : {});
const business = read('business.json');
const profile = read('profile.json');
const person = profile.person ?? {};
const fields = {
  'business.bizRegNo': business.bizRegNo,
  'business.payout.account': business.payout?.account,
  'business.email': business.email,
  'profile.person.phone': person.phone,
  'profile.person.email': person.email,
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matchers = [];
for (const [field, value] of Object.entries(fields)) {
  if (typeof value !== 'string' || !value.trim()) continue;
  if (value.includes('@')) {
    matchers.push({ field, re: new RegExp(escape(value.trim()), 'i') });
    continue;
  }
  const digits = value.replace(/\D/g, '');
  if (digits.length < 6) continue;
  matchers.push({ field, re: new RegExp('(?<!\\d)' + digits.split('').join('[\\s.\\-]*') + '(?!\\d)') });
}

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const hits = [];
for (const file of files) {
  if (!existsSync(file)) continue;
  const buf = readFileSync(file);
  if (buf.includes(0)) continue;
  buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
    for (const m of matchers) if (m.re.test(line)) hits.push(`${file}:${i + 1} holds ${m.field}`);
  });
}

if (hits.length) {
  for (const h of hits) console.error('check-privacy: ' + h);
  process.exit(1);
}
console.log(`check-privacy: ${matchers.length} values checked across ${files.length} tracked files, clean`);
