// Fiverr onboarding: the profile planning and the page-text reader on a synthetic instance and text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { STEPS, aboutOf, addSkill, displayName, gateTexts, languagesOf, onboard, parseProfileText, photoSet, skillCandidates, skillLevel, titleOf, unsetFields } from '../src/platforms/fiverr/onboarding.mjs';

test('the generic avatar reads as no picture, so the camera picture is left to the operator', () => {
  assert.equal(photoSet('https://fiverr-res.cloudinary.com/image/upload/f_svg,q_auto/v1/attachments/generic_asset/asset/abc-1764388017226/avatar.svg'), false);
  assert.equal(photoSet(null), false);
  assert.equal(photoSet('https://fiverr-res.cloudinary.com/t_profile_original,q_auto,f_auto/attachments/profile/photo/abc/me.jpg'), true);
});

test('a spent hourly action budget ends the run with a report instead of a crash', async () => {
  const session = {
    guard: { beforeAction() { throw Object.assign(new Error('fiverr: action limit of 60 per hour reached'), { code: 'FSW_PACING_LIMIT' }); } },
    navigate: async () => 'https://www.fiverr.com/seller_onboarding/overview',
    evaluate: async () => ({ url: 'https://www.fiverr.com/seller_onboarding/overview', heading: 'Grow your brand.', text: 'Grow your brand.' }),
  };
  const out = await onboard(session, { apply: true, instance: { profile: {}, config: {} } });
  assert.deepEqual(out.map((r) => [r.step, r.state]), [['start', 'filled']]);
  assert.match(out[0].detail, /hourly action budget/);
});

test('a skill is typed only after its input renders, and an input that never renders adds nothing', async () => {
  // The input shows on the third look after Add new, as it renders about 2 s late on the live page.
  const make = (showsAfter) => {
    let looks = 0;
    const filled = [];
    return {
      filled,
      guard: { beforeAction() {} },
      evaluate: async (fn, arg) => (typeof arg === 'string' && arg.startsWith('input[') ? ++looks > showsAfter : true),
      fill: async (sel, v) => { filled.push(v); },
      press: async () => {},
    };
  };
  const late = make(2);
  assert.equal(await addSkill(late, 'Node.js', 'PRO', { timeoutMs: 5000 }), true);
  assert.deepEqual(late.filled, ['Node.js']);
  const never = make(Infinity);
  assert.equal(await addSkill(never, 'Node.js', 'PRO', { timeoutMs: 50 }), false);
  assert.deepEqual(never.filled, []);
});

const about = 'I build web products and AI tools from the first sketch to deployment. I write the code, ship it, and check it on phone widths before handing it over, and I keep my tools public so the work can be checked.';
const instance = {
  business: {},
  config: { onboarding: { fiverr: { title: 'Web and AI tools developer', skillLevel: 'pro' } } },
  profile: {
    person: { nameEn: 'Gildong Hong' },
    headline_en: 'Founder of Example Co. I build web products.',
    summary_en: about,
    languages: ['Korean (native)', 'English (working proficiency, no certificate)', 'Klingon (basic)'],
    skills: { web: ['Node.js', 'JavaScript and TypeScript', 'Responsive layout for every screen'] },
    claimsNotToMake: [],
  },
};

test('steps start at the overview and end at continue', () => {
  assert.deepEqual(STEPS.map((s) => s.id), ['start', 'profile', 'continue']);
  assert.ok(STEPS[1].detect.heading.test('Review your new profile'));
});

test('display name is the English name when it fits 3 to 15 characters', () => {
  assert.equal(displayName(instance.profile), 'Gildong Hong');
  assert.equal(displayName({ person: { nameEn: 'Maximilian Alexander' } }), null);
});

test('title comes from the setting, else the first headline sentence', () => {
  assert.equal(titleOf(instance), 'Web and AI tools developer');
  assert.equal(titleOf({ ...instance, config: {} }), 'Founder of Example Co');
});

test('languages map to codes and the lower level a phrase allows', () => {
  assert.deepEqual(languagesOf(instance.profile), [
    { code: 'KO', name: 'Korean', level: 'NATIVE_OR_BILINGUAL' },
    { code: 'EN', name: 'English', level: 'CONVERSATIONAL' },
  ]);
});

test('about must fit 150 to 600 characters and pass the gate', () => {
  assert.equal(aboutOf(instance.profile), about);
  assert.equal(aboutOf({ summary_en: 'Too short.' }), null);
  assert.deepEqual(gateTexts([titleOf(instance), about], { descriptor: loadDescriptor('fiverr'), instance }), []);
});

test('skill candidates are short parts, single words first, and the level setting is checked', () => {
  assert.deepEqual(skillCandidates(instance.profile), ['Node.js', 'JavaScript', 'TypeScript']);
  // A configured list replaces the derived one, and a name the profile does not back is dropped.
  assert.deepEqual(skillCandidates(instance.profile, ['TypeScript', 'Rust', 'node.js', 'TypeScript']), ['TypeScript', 'node.js']);
  assert.equal(skillLevel(instance), 'PRO');
  assert.equal(skillLevel({ config: { onboarding: { fiverr: { skillLevel: 'guru' } } } }), 'INTERMEDIATE');
});

test('the profile text reader finds languages, skills, a refused name and the missing list', () => {
  const text = ['Review your new profile', '@someone', 'This name violates our Terms of Service.', 'South Korea', 'Speaks Korean, English', 'About', 'x', 'Skills and expertise', 'Add new', 'Node.js', 'Intermediate', 'React', 'Pro', 'Work experience', '(Optional)', 'You need to add your profile picture and skills to continue.'].join('\n');
  assert.deepEqual(parseProfileText(text), { speaks: ['Korean', 'English'], skills: ['Node.js', 'React'], nameRefused: true, missing: 'your profile picture and skills to continue' });
  assert.deepEqual(parseProfileText('Edit your new profile\nAdd languages'), { speaks: [], skills: [], nameRefused: false, missing: null });
});

test('unset fields name each profile field the page does not hold yet', () => {
  const want = { name: 'Gildong Hong', title: 'Web and AI tools developer', about, languages: languagesOf(instance.profile) };
  const held = { name: 'Gildong Hong', title: 'Web and AI tools developer', about: ' ' + about + ' ' };
  assert.deepEqual(unsetFields(want, held, { speaks: ['Korean', 'English'], nameRefused: false }), []);
  assert.deepEqual(unsetFields(want, { ...held, name: 'Gil', title: '', about: 'x' }, { speaks: ['Korean'], nameRefused: false }), ['display name', 'title', 'languages', 'about']);
  assert.deepEqual(unsetFields(want, held, { speaks: ['Korean', 'English'], nameRefused: true }), ['display name']);
  assert.deepEqual(unsetFields({ ...want, name: null, about: null }, { name: 'x', title: want.title, about: 'x' }, { speaks: ['Korean', 'English'], nameRefused: true }), []);
});
