// Synthetic instances only: no value here comes from an operator instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityTerms, scan } from '../scripts/identity-scan.mjs';

const instance = (chromeProfile) => ({
  profile: { person: { nameEn: 'Alex Sample', handle: 'samplehandle' }, roles: [{ org: 'Sample Labs', title: 'Founder' }, { org: 'Big Employer', title: 'Engineer' }] },
  business: { company: 'Sample Works', payout: { holder: 'Alex Sample' } },
  config: { browser: { instance: null, chromeProfile } },
});

test('a term in a tracked file is a hit, the same term in a floor hook is allowed, and only its index is printed', () => {
  const terms = identityTerms(instance(null));
  const r = scan([['src/x.mjs', 'built by samplehandle'], ['hooks/commit-msg', 'see samplehandle/floor'], ['README.md', 'a sampler handles samples']], terms);
  assert.equal(r.hits, 1);
  assert.equal(r.allowed, 1);
  const index = terms.findIndex((re) => re.test('samplehandle'));
  assert.deepEqual(r.lines, ['identity term #' + index + ' in src/x.mjs', 'allowed: identity term #' + index + ' in hooks/commit-msg']);
  assert.ok(r.lines.every((l) => !l.includes('samplehandle')));
});

test('a founded organisation is a term and an employer is not, matched as whole words', () => {
  const terms = identityTerms(instance(null));
  assert.ok(terms.some((re) => re.test('Sample Labs')));
  assert.ok(!terms.some((re) => re.test('Big Employer')));
  assert.equal(scan([['src/a.mjs', 'Sample Worksheet']], terms).hits, 0);
});

test('the operator Chrome profile is a term only when the config sets it', () => {
  assert.ok(identityTerms(instance('ProfileX')).some((re) => re.test('Chrome (profile ProfileX)')));
  assert.ok(!identityTerms(instance(null)).some((re) => re.test('ProfileX')));
  assert.equal(identityTerms(instance('ProfileX')).length, identityTerms(instance(null)).length + 1);
});
