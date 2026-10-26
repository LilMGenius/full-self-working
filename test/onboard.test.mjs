import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { parseArgs, run } from '../src/cli/onboard.mjs';
import { blockOf, dayLabel, humanize, readIdentity, walkWizard } from '../src/platforms/onboarding.mjs';
import { HANDLERS as FREELANCER, STEPS as FREELANCER_STEPS, addSkill, headlineAndSummary, parseSelectedSkills, profileLanguages, resultPattern, skillOfResult, splitLegalName, stepOfUrl as freelancerStep, usDate } from '../src/platforms/freelancer/onboarding.mjs';
import { HANDLERS as UPWORK, employmentEntries, onboard, parseEmploymentCard, parsePeriod, splitTitle, stepOfUrl, upworkSpecialties } from '../src/platforms/upwork/onboarding.mjs';
import { tempDir } from './tmp.mjs';

function instance() {
  const dir = tempDir('fsw-onboard-');
  for (const f of ['profile.json', 'business.json', 'config.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  return loadInstance({ dir });
}

test('onboard arguments are a platform, --apply and one --step id', () => {
  assert.deepEqual(parseArgs(['upwork']), { platform: 'upwork', apply: false, step: null, force: false });
  assert.deepEqual(parseArgs(['upwork', '--step', 'title', '--apply']), { platform: 'upwork', apply: true, step: 'title', force: false });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['upwork', '--step']), /usage/);
});

test('a dry run passes apply false and records nothing; an applied filled step is recorded once', async () => {
  const seen = [];
  const module = { STEPS: [{ id: 'a' }], onboard: async (s, ctx) => (seen.push(ctx.apply), [{ step: 'a', state: 'filled', detail: 'x' }]) };
  const events = [];
  const ctx = { module, instance: instance(), descriptor: { ...loadDescriptor('upwork'), onboardingPacing: {} }, session: {}, ledger: { addEvent: (e) => events.push(e) }, log: () => {} };
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
  const session = { navigate: async () => 'https://www.freelancer.com/login?next=%252Fnew-freelancer%252Fskills', evaluate: async () => ({ url: 'https://www.freelancer.com/login?next=%252Fnew-freelancer%252Fskills', title: 'Log In', text: 'Welcome back' }) };
  const out = await walkWizard(session, { apply: false }, { name: 'freelancer', steps: [], handlers: {}, startUrl: 'x', stepUrl: null, stepOfUrl: () => null, describe: String });
  assert.equal(out.length, 1);
  assert.equal(out[0].state, 'needs-operator');
  assert.match(out[0].detail, /sign in to freelancer/);
});

test('freelancer retypes the last key of a skill when its search list stays empty, and clicks a result with no job count', async () => {
  const typed = [];
  const pressed = [];
  const clicked = [];
  const session = {
    // waitFor asks with the skill name, and the list renders only once the last key is pressed again;
    // typing the whole term a second time leaves it empty, as on the live page.
    evaluate: async (fn, arg) => (typeof arg === 'string' ? pressed.join(',') === 'Backspace,s' : arg?.selector === '.SkillsContent-text' ? new RegExp(arg.spec.re, arg.spec.flags).test('Kubernetes') : true),
    click: async (sel) => { clicked.push(sel); },
    typeKeys: async (_sel, text) => { typed.push(text); },
    press: async (key) => { pressed.push(key); },
  };
  assert.equal(await addSkill(session, 'Kubernetes', { timeoutMs: 30, pauseMs: 0 }), true);
  assert.deepEqual(typed, ['Kubernetes']);
  assert.deepEqual(pressed, ['Backspace', 's']);
  assert.equal(clicked.length, 2);
  assert.ok(resultPattern('Node.js').test('Node.js (1,203 jobs)'));
  assert.ok(!resultPattern('Kubernetes').test('Kubernetes Engine (4 jobs)'));
});

test('freelancer skill results and the selected panel read as plain skill names', () => {
  assert.equal(skillOfResult('Web Scraping  (42 jobs)'), 'Web Scraping');
  assert.equal(skillOfResult('Node.js (1,203 jobs)'), 'Node.js');
  assert.deepEqual(parseSelectedSkills('2 out of 20 skills selected\nWeb Scraping\nNode.js\n'), ['Web Scraping', 'Node.js']);
  assert.deepEqual(parseSelectedSkills('996 jobs matching your skills\nWeb Scraping\nNode.js'), ['Web Scraping', 'Node.js']);
  assert.deepEqual(parseSelectedSkills('0 skills selected\nSelect at least one skill to help us recommend customized jobs for you.'), []);
});

test('freelancer payment verification is the operator\'s unless the setting skips it, and Skip is the only control pressed', async () => {
  const h = FREELANCER['payment-verification'];
  assert.equal(FREELANCER['phone-verification'], h);
  assert.match(h.want({ instance: { config: { onboarding: { freelancer: {} } } } }).message, /adds a card/);
  const want = h.want({ instance: { config: { onboarding: { freelancer: { skipPaymentVerification: true } } } } });
  assert.ok(h.same(await h.read(), want));
  let spec;
  const session = { evaluate: async (_fn, arg) => ((spec = arg.spec), true), click: async () => {} };
  await h.next(session);
  const re = new RegExp(spec.re, spec.flags);
  assert.ok(re.test('Skip') && !re.test('Verify payment method'));
  // The paid membership offer is always declined the same way.
  const m = FREELANCER['membership-offer'];
  assert.ok(m.same(await m.read(), m.want({})));
  await m.next(session);
  const re2 = new RegExp(spec.re, spec.flags);
  assert.ok(re2.test('Skip') && !re2.test('Start your free month'));
});

test('freelancer linked-accounts links nothing and leaves by Skip', async () => {
  const h = FREELANCER['linked-accounts'];
  assert.ok(FREELANCER_STEPS.some((s) => s.id === 'linked-accounts'));
  assert.ok(h.same(await h.read(), h.want({})));
  let spec;
  const clicked = [];
  const session = { evaluate: async (_fn, arg) => ((spec = arg.spec), new RegExp(spec.re, spec.flags).test('Skip')), click: async (sel) => { clicked.push(sel); } };
  assert.equal(await h.next(session), true);
  assert.ok(!new RegExp(spec.re, spec.flags).test('Next'));
  assert.equal(clicked.length, 1);
});

test('freelancer photo-and-name types the legal name as given and family name and leaves the camera photo to the operator', async () => {
  assert.equal(freelancerStep('https://www.freelancer.com/new-freelancer/profile-details/photo-and-name?x=1'), 'profile-details/photo-and-name');
  assert.equal(freelancerStep('https://www.freelancer.com/new-freelancer/skills'), 'skills');
  assert.deepEqual(splitLegalName('GILDONG HONG'), { first: 'Gildong', last: 'Hong' });
  assert.deepEqual(splitLegalName('Mary Ann McKay'), { first: 'Mary Ann', last: 'McKay' });
  assert.equal(splitLegalName('MONONYM'), null);
  const h = FREELANCER['profile-details/photo-and-name'];
  const dir = tempDir('fsw-fl-photo-');
  const identity = join(dir, 'identity.json');
  writeFileSync(identity, JSON.stringify({ person: { legal_name_en: 'GILDONG HONG', date_of_birth: '2000-01-01', phone: '+82 10-0000-0000' }, business: { address_en: { street: 's', city: 'c', postal_code: '1', country: 'KR' } } }));
  const want = h.want({ instance: { config: { onboarding: { identity } } } });
  assert.deepEqual(want, { private: 'legal first and last name', first: 'Gildong', last: 'Hong' });
  const page = { photo: false, first: '', last: '', next: false };
  const typed = [];
  const session = {
    evaluate: async (fn, arg) => (arg?.selector ? true : { ...page }),
    click: async () => {},
    typeKeys: async (sel, text) => { typed.push([sel, text]); page[sel === '#inputFirstName' ? 'first' : 'last'] = text; },
  };
  await h.write(session, want, await h.read(session));
  assert.deepEqual(typed, [['#inputFirstName', 'Gildong'], ['#inputLastName', 'Hong']]);
  assert.ok(h.same(await h.read(session), want));
  // A disabled Next after the names means the page waits for the camera picture.
  assert.match(await h.pending(session), /camera/);
  page.next = true;
  assert.equal(await h.pending(session), null);
});

test('freelancer headline-and-summary takes the configured headline and the profile summary through the gate', async () => {
  const inst = instance();
  const ctx = { instance: inst, descriptor: loadDescriptor('freelancer') };
  const want = headlineAndSummary(ctx);
  assert.equal(want.headline, inst.config.onboarding.freelancer.headline);
  assert.equal(want.summary, inst.profile.summary_en.trim());
  inst.config.onboarding.freelancer.summary = 'Builds web apps \u2014 fast.';
  assert.match(headlineAndSummary(ctx).message, /refused by the gate/);
  inst.config.onboarding.freelancer = { skills: ['x'] };
  assert.match(headlineAndSummary(ctx).message, /onboarding.freelancer.headline/);
  const h = FREELANCER['profile-details/headline-and-summary'];
  const page = { headline: '', summary: '' };
  const session = {
    evaluate: async (fn, arg) => (arg?.selector ? true : { ...page }),
    click: async () => {},
    typeKeys: async (_sel, text) => { page.headline = text; },
    fill: async (_sel, text) => { page.summary = text; },
  };
  await h.write(session, want, await h.read(session));
  assert.ok(h.same(await h.read(session), want));
});

test('freelancer languages-and-birthdate picks each profile language from the list and types the birth date as MM/DD/YYYY', async () => {
  assert.deepEqual(profileLanguages({ languages: ['Korean (native)', 'English (working proficiency)'] }), ['Korean', 'English']);
  assert.deepEqual(profileLanguages({ languages: ['ko', 'en'] }), ['Korean', 'English']);
  assert.equal(usDate('2000-01-31'), '01/31/2000');
  assert.equal(usDate('31.01.2000'), null);
  const h = FREELANCER['profile-details/languages-and-birthdate'];
  const dir = tempDir('fsw-fl-lang-');
  const identity = join(dir, 'identity.json');
  writeFileSync(identity, JSON.stringify({ person: { legal_name_en: 'GILDONG HONG', date_of_birth: '2000-01-31', phone: '+82 10-0000-0000' }, business: { address_en: { street: 's', city: 'c', postal_code: '1', country: 'KR' } } }));
  const want = h.want({ instance: { config: { onboarding: { identity } }, profile: { languages: ['ko', 'en'] } } });
  assert.deepEqual([want.languages, want.birthdate], [['Korean', 'English'], '01/31/2000']);
  assert.ok(!want.private.includes('2000'));
  const page = { languages: [], birthdate: '', typed: [], pressed: [] };
  // The list names Korean with a note in brackets and shows it only after the last key is pressed again.
  const listedNow = () => page.typed.at(-1)?.[1] !== 'Korean' || page.pressed.join(',') === 'Backspace,n';
  const session = {
    evaluate: async (fn, arg) => {
      if (arg?.re) return listedNow();
      if (arg?.spec && arg.selector === '.DropdownItemText') {
        const shown = page.typed.at(-1)[1] === 'Korean' ? 'Korean (Hangul)' : page.typed.at(-1)[1];
        if (!new RegExp(arg.spec.re, arg.spec.flags).test(shown)) return false;
        page.languages.push(page.typed.at(-1)[1]);
        return true;
      }
      // The search input loses its placeholder once a language is chosen, as on the live page.
      if (arg?.selector) return !(page.languages.length && /placeholder/.test(arg.selector));
      return { languages: [...page.languages], birthdate: page.birthdate };
    },
    click: async () => {},
    typeKeys: async (sel, text) => { page.typed.push([sel, text]); if (sel === '#inputBirthdate') page.birthdate = text; },
    press: async (key) => { page.pressed.push(key); },
  };
  await h.write(session, want, await h.read(session));
  assert.deepEqual(page.typed.map(([, text]) => text), ['Korean', 'English', '01/31/2000']);
  assert.deepEqual(page.pressed, ['Backspace', 'n']);
  assert.ok(h.same(await h.read(session), want));
  assert.equal(h.show({ languages: ['Korean'], birthdate: '01/31/2000' }, want), 'read back differs in: languages (read Korean)');
  // A language the list never shows is left out and named, and the rest still counts as the same.
  const want2 = h.want({ instance: { config: { onboarding: { identity } }, profile: { languages: ['ko', 'en'] } } });
  const page2 = { languages: [], birthdate: '' };
  const session2 = {
    evaluate: async (fn, arg) => {
      if (arg?.re) return /English/.test(arg.re);
      if (arg?.spec && arg.selector === '.DropdownItemText') { page2.languages.push('English'); return true; }
      return arg?.selector || typeof arg === 'string' ? true : { languages: [...page2.languages], birthdate: page2.birthdate };
    },
    click: async () => {},
    typeKeys: async (sel, text) => { if (sel === '#inputBirthdate') page2.birthdate = text; },
    press: async () => {},
  };
  await h.write(session2, want2, await h.read(session2));
  assert.deepEqual(want2.unlisted, ['Korean']);
  assert.match(want2.private, /does not list Korean/);
  assert.ok(h.same(await h.read(session2), want2));
});

test('a run within the cooldown of the last one stops before opening the browser, unless forced', async () => {
  let t = 1_000_000;
  const module = { STEPS: [{ id: 'a' }], onboard: async () => [{ step: 'a', state: 'done', detail: '' }] };
  const lines = [];
  const ctx = { module, instance: instance(), descriptor: { ...loadDescriptor('upwork'), onboardingPacing: { cooldownMs: 1_800_000 } }, session: {}, ledger: { addEvent() {} }, log: (l) => lines.push(l), now: () => t };
  assert.equal(await run(['upwork'], ctx), 0);
  t += 600_000;
  assert.equal(await run(['upwork'], ctx), 1);
  assert.match(lines.at(-1), /next may start in 20 min/);
  assert.equal(await run(['upwork', '--force'], ctx), 0);
  t += 1_800_001;
  assert.equal(await run(['upwork'], ctx), 0);
});

test('a humanized session waits a gap in range before every action and paces typed keys', async () => {
  const waits = [];
  const calls = [];
  const base = { click: async (t) => calls.push(['click', t]), typeKeys: async (t, v, o) => calls.push(['type', v, o.keyGapMs]), evaluate: async () => 'kept' };
  const s = humanize(base, { actionGapMs: [2000, 4000], keyGapMs: [100, 200] }, { wait: async (ms) => waits.push(ms), random: () => 0.5 });
  await s.click('#a');
  await s.typeKeys('#b', 'hi');
  assert.deepEqual(waits, [3000, 3000]);
  assert.deepEqual(calls, [['click', '#a'], ['type', 'hi', 150]]);
  assert.equal(await s.evaluate(), 'kept');
});

test('a sign-in or challenge page blocks the walk and an ordinary wizard page does not', () => {
  assert.match(blockOf({ url: 'https://www.upwork.com/ab/account-security/login?redir=x' }, 'upwork'), /sign in to upwork/);
  assert.match(blockOf({ url: 'https://www.freelancer.com/x', title: 'Just a moment...' }, 'freelancer'), /cloudflare challenge/);
  assert.equal(blockOf({ url: 'https://www.upwork.com/nx/create-profile/title', title: 'Add a title', text: 'Log in to see more' }, 'upwork'), null);
});


test('the identity file gives the national number after the country code and names missing fields', () => {
  const dir = tempDir('fsw-id-');
  const file = join(dir, 'identity.json');
  writeFileSync(file, JSON.stringify({ person: { date_of_birth: '1990-01-31', phone: '+82-10-0000-1111', google_login_email: 'seller@example.com' }, business: { address_en: { street: '1 Example Road', unit: '2F', city: 'Example City', region: 'Example Province', postal_code: 12345, country: 'South Korea' } } }));
  const ctx = { instance: { config: { onboarding: { identity: file } } } };
  const id = readIdentity(ctx);
  assert.equal(id.nationalNumber, '1000001111');
  assert.equal(id.countryCode, '82');
  assert.equal(id.address.postalCode, '12345');
  writeFileSync(file, JSON.stringify({ person: { phone: '+82-10-0000-1111' }, business: { address_en: { city: 'Example City' } } }));
  assert.match(readIdentity(ctx).message, /lacks date of birth, street, postal code, country/);
  assert.match(readIdentity({ instance: { config: { onboarding: { identity: null } } } }).message, /set config onboarding.identity/);
});

test('a private step that reads back wrong names the fields and never their values', () => {
  const want = { photo: true, private: 'x', dateOfBirth: '1990-01-31', street: '1 Example Road', unit: '', city: 'Example City', region: 'R', postalCode: '12345', phone: '1000001111' };
  const cur = { ...want, street: '9 Other Road', phone: '' };
  const msg = UPWORK.location.show(cur, want);
  assert.match(msg, /street, phone/);
  assert.doesNotMatch(msg, /Example|Other|1990|12345|1000001111/);
  assert.equal(UPWORK.location.same({ ...want, phone: '821000001111' }, want), true);
});

test('under --apply a sign-in page signs in once and reopens the wizard', async () => {
  const pages = ['https://x.test/login', 'https://x.test/wizard/a'];
  let at = 0;
  const session = { navigate: async () => pages[Math.min(at, 1)], evaluate: async () => ({ url: pages[Math.min(at, 1)], title: '', text: '' }) };
  const signIns = [];
  const wiz = { name: 'x', steps: [{ id: 'a', detect: {} }], handlers: { a: { read: async () => 1, want: () => 1, same: (c, w) => c === w } }, startUrl: 'https://x.test/wizard/a', stepUrl: null, stepOfUrl: (u) => (u.includes('/wizard/') ? 'a' : null), describe: String, signIn: async () => (signIns.push(1), (at = 1)) };
  const out = await walkWizard(session, { apply: true, step: 'a' }, wiz);
  assert.deepEqual(out.map((r) => r.step + ':' + r.state).slice(0, 2), ['sign-in:filled', 'a:done']);
  assert.equal(signIns.length, 1);
  at = 0;
  const dry = await walkWizard(session, { apply: false, step: 'a' }, wiz);
  assert.equal(dry[0].state, 'needs-operator');
  assert.equal(signIns.length, 1);
});


test('a date picker day is found by its full label', () => {
  assert.equal(dayLabel('1990-01-05'), 'January 05, 1990');
  assert.equal(dayLabel('2001-12-31'), 'December 31, 2001');
});

