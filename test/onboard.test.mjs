import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { parseArgs, run } from '../src/cli/onboard.mjs';
import { walkWizard } from '../src/platforms/onboarding.mjs';
import { parseSelectedSkills, skillOfResult } from '../src/platforms/freelancer/onboarding.mjs';
import { employmentEntries, onboard, parseEmploymentCard, parsePeriod, splitTitle, stepOfUrl, upworkSpecialties } from '../src/platforms/upwork/onboarding.mjs';

function instance() {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-onboard-'));
  for (const f of ['profile.json', 'business.json', 'config.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  return loadInstance({ dir });
}

test('onboard arguments are a platform, --apply and one --step id', () => {
  assert.deepEqual(parseArgs(['upwork']), { platform: 'upwork', apply: false, step: null });
  assert.deepEqual(parseArgs(['upwork', '--step', 'title', '--apply']), { platform: 'upwork', apply: true, step: 'title' });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['upwork', '--step']), /usage/);
});

test('a dry run passes apply false and records nothing; an applied filled step is recorded once', async () => {
  const seen = [];
  const module = { STEPS: [{ id: 'a' }], onboard: async (s, ctx) => (seen.push(ctx.apply), [{ step: 'a', state: 'filled', detail: 'x' }]) };
  const events = [];
  const ctx = { module, instance: instance(), descriptor: loadDescriptor('upwork'), session: {}, ledger: { addEvent: (e) => events.push(e) }, log: () => {} };
  assert.equal(await run(['upwork'], ctx), 0);
  assert.deepEqual(events, []);
  assert.equal(await run(['upwork', '--apply'], ctx), 0);
  assert.deepEqual(seen, [false, true]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'platform.onboarding');
  await assert.rejects(run(['upwork', '--step', 'nope'], ctx), /no step nope/);
});

test('profile periods read as month and year, open to the present or closed', () => {
  assert.deepEqual(parsePeriod('2024.12 to present'), { start: { year: 2024, month: 12 }, end: null, current: true });
  assert.deepEqual(parsePeriod('2021.03 to 2023.02'), { start: { year: 2021, month: 3 }, end: { year: 2023, month: 2 }, current: false });
  assert.deepEqual(parsePeriod('present'), { start: null, end: null, current: true });
});

test('roles become work entries in the card form Upwork shows, and a role without a start month is left out', () => {
  const { entries, skipped } = employmentEntries({ roles: [
    { org: 'Acme', title: 'Engineer', period: '2022.03 to 2024.01' },
    { org: 'Own Studio', title: 'Founder', period: 'present' },
    { org: 'Beta', title: 'Lead', period: '2024.02 to present' },
  ] });
  assert.deepEqual(entries.map((e) => e.dates), ['March 2022 - January 2024', 'February 2024 - Present']);
  assert.deepEqual(skipped, ['Own Studio']);
  assert.deepEqual(parseEmploymentCard('Lead\nBeta | February 2024 - Present'), { title: 'Lead', company: 'Beta', dates: 'February 2024 - Present' });
  assert.deepEqual(parseEmploymentCard('Engineer\nA | B Corp | March 2022 - January 2024'), { title: 'Engineer', company: 'A | B Corp', dates: 'March 2022 - January 2024' });
});

test('specialties follow the answered services by fit, in one category, at most three', () => {
  const services = {
    a: { upworkSpecialty: { category: 'Dev', specialty: 'Web' } },
    b: { upworkSpecialty: { category: 'Dev', specialty: 'AI' } },
    c: { upworkSpecialty: { category: 'Design', specialty: 'Logo' } },
    d: { upworkSpecialty: { category: 'Dev', specialty: 'Scripts' } },
    e: { upworkSpecialty: { category: 'Dev', specialty: 'QA' } },
    f: {},
  };
  const profile = { serviceFit: { a: { strength: 'some' }, b: { strength: 'strong' }, c: { strength: 'strong' }, d: { strength: 'some' }, e: { strength: 'none' }, f: { strength: 'strong' } } };
  const got = upworkSpecialties({ config: { platforms: { upwork: { services: ['a', 'b', 'd', 'e', 'f'] } } }, profile, services });
  assert.deepEqual(got, { category: 'Dev', specialties: ['AI', 'Web', 'Scripts'], services: ['b', 'a', 'd'] });
  assert.equal(upworkSpecialties({ config: { platforms: { upwork: { services: ['f'] } } }, profile, services }), null);
});

test('a work title over the dialog limit moves its parenthetical into the description', () => {
  assert.deepEqual(splitTitle('Pottery teacher (evening classes, weekend workshops and mentoring for two studios)'), { title: 'Pottery teacher', description: 'Evening classes, weekend workshops and mentoring for two studios.' });
  assert.deepEqual(splitTitle('Engineer (backend)'), { title: 'Engineer (backend)', description: '' });
  assert.equal(splitTitle('x'.repeat(80)), null);
});

test('wizard step ids come from the create-profile path only', () => {
  assert.equal(stepOfUrl('https://www.upwork.com/nx/create-profile/skills'), 'skills');
  assert.equal(stepOfUrl('https://www.upwork.com/nx/find-work/'), null);
});

test('a profile text the gate refuses is never typed and names the setting to change', async () => {
  const inst = instance();
  inst.config.onboarding.upwork.title = 'Developer, write to seller@example.com';
  const typed = [];
  const session = {
    navigate: async () => 'https://www.upwork.com/nx/create-profile/title',
    evaluate: async () => true,
    click: async (t) => typed.push(t),
    fill: async (t, v) => typed.push(v),
    typeKeys: async (t, v) => typed.push(v),
  };
  const out = await onboard(session, { instance: inst, descriptor: loadDescriptor('upwork'), apply: true, step: null, log: () => {} });
  assert.equal(out[0].step, 'title');
  assert.equal(out[0].state, 'needs-operator');
  assert.match(out[0].detail, /contact\.email/);
  assert.deepEqual(typed, []);
});


test('a sign-in page stops the walk as the operator\'s to fix, never as a finished wizard', async () => {
  const session = { navigate: async () => 'https://www.freelancer.com/login?next=%252Fnew-freelancer%252Fskills', evaluate: async () => null };
  const out = await walkWizard(session, { apply: false }, { name: 'freelancer', steps: [], handlers: {}, startUrl: 'x', stepUrl: null, stepOfUrl: () => null, describe: String });
  assert.equal(out.length, 1);
  assert.equal(out[0].state, 'needs-operator');
  assert.match(out[0].detail, /sign in to freelancer/);
});

test('freelancer skill results and the selected panel read as plain skill names', () => {
  assert.equal(skillOfResult('Web Scraping  (42 jobs)'), 'Web Scraping');
  assert.equal(skillOfResult('Node.js (1,203 jobs)'), 'Node.js');
  assert.deepEqual(parseSelectedSkills('2 out of 20 skills selected\nWeb Scraping\nNode.js\n'), ['Web Scraping', 'Node.js']);
  assert.deepEqual(parseSelectedSkills('0 skills selected\nSelect at least one skill to help us recommend customized jobs for you.'), []);
});
