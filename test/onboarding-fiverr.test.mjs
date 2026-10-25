// Fiverr onboarding: the profile planning and the page-text reader on a synthetic instance and text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { STEPS, aboutOf, displayName, gateTexts, languagesOf, parseProfileText, skillCandidates, skillLevel, titleOf } from '../src/platforms/fiverr/onboarding.mjs';

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
  assert.equal(skillLevel(instance), 'PRO');
  assert.equal(skillLevel({ config: { onboarding: { fiverr: { skillLevel: 'guru' } } } }), 'INTERMEDIATE');
});

test('the profile text reader finds languages, skills, a refused name and the missing list', () => {
  const text = ['Review your new profile', '@someone', 'This name violates our Terms of Service.', 'South Korea', 'Speaks Korean, English', 'About', 'x', 'Skills and expertise', 'Add new', 'Node.js', 'Intermediate', 'React', 'Pro', 'Work experience', '(Optional)', 'You need to add your profile picture and skills to continue.'].join('\n');
  assert.deepEqual(parseProfileText(text), { speaks: ['Korean', 'English'], skills: ['Node.js', 'React'], nameRefused: true, missing: 'your profile picture and skills to continue' });
  assert.deepEqual(parseProfileText('Edit your new profile\nAdd languages'), { speaks: [], skills: [], nameRefused: false, missing: null });
});

