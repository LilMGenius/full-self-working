import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRecipes, loadRecipe, RecipeError, resolveSkill, serviceCatalog, validateRecipe } from '../src/work/recipe.mjs';
import { deliveryOf } from '../src/economics/catalog.mjs';
import { tempDir } from './tmp.mjs';

test('every service the agent delivers has a recipe that validates, and an operator service has none', () => {
  const services = Object.keys(serviceCatalog()).filter((s) => deliveryOf(serviceCatalog()[s]) === 'agent');
  assert.deepEqual(listRecipes(), [...services].sort());
  for (const s of services) assert.equal(loadRecipe(s).service, s);
  const lesson = { ...structuredClone(loadRecipe('landing_page_web')), service: 'lesson_tutoring' };
  assert.ok(validateRecipe(lesson).some((e) => /lesson_tutoring is delivered by the operator/.test(e)));
});

test('mobile and ERP work run as agent recipes, and the builds only the operator can make are his steps after acceptance', () => {
  const mobile = loadRecipe('mobile_app_dev');
  const after = (recipe) => recipe.steps.slice(recipe.steps.findIndex((s) => s.run === 'accept') + 1);
  const handoffs = Object.fromEntries(after(mobile).map((s) => [s.id, s]));
  assert.ok(after(mobile).every((s) => s.type === 'user-handoff'));
  assert.match(handoffs['ios-build'].ask, /Mac/);
  assert.match(handoffs['android-build'].ask, /Android/);
  assert.ok(mobile.deliverables.some((d) => d.path === 'app/app.json'));
  const erp = loadRecipe('erp_dev');
  assert.ok(erp.deliverables.some((d) => d.path === 'notes/admin-guide.md'));
  assert.deepEqual([deliveryOf(serviceCatalog().mobile_app_dev), deliveryOf(serviceCatalog().erp_dev)], ['agent', 'agent']);
});

test('a broken recipe fails with errors naming the file and the path', () => {
  const recipe = structuredClone(loadRecipe('landing_page_web'));
  recipe.hours.standard = 99;
  recipe.steps[0].type = 'invoke-model';
  recipe.steps.push({ id: 'late', type: 'invoke-model-skill', skill: 'omo:frontend', input: 'a', output: 'b', does: 'c' });
  recipe.deliverables[0].path = '../escape.html';
  recipe.payment.beforeDelivery = 'deposit';
  const errors = validateRecipe(recipe, { file: 'recipes/landing_page_web.json' });
  const expect = ['hours.standard', 'steps[0].type', 'steps[' + (recipe.steps.length - 1) + ']', 'deliverables[0].path', 'payment.beforeDelivery'];
  for (const path of expect) assert.ok(errors.some((e) => e.startsWith('recipes/landing_page_web.json: ' + path + ':')), 'no error at ' + path + ' in ' + errors.join(' | '));
});

test('an operator step names the files it produces, and only such a step carries a condition', () => {
  const mobile = loadRecipe('mobile_app_dev');
  const steps = Object.fromEntries(mobile.steps.map((s) => [s.id, s]));
  assert.equal(steps['android-build'].produces.length, 2);
  assert.match(steps['ios-build'].when, /iOS/);
  assert.equal(steps.review.produces, undefined);
  assert.ok(loadRecipe('erp_dev').steps.find((s) => s.id === 'deploy').produces.length);
  const broken = structuredClone(mobile);
  broken.steps[0].produces = ['x'];
  broken.steps.find((s) => s.id === 'review').when = 'always';
  broken.steps.find((s) => s.id === 'android-build').produces = [];
  const errors = validateRecipe(broken, { file: 'recipes/mobile_app_dev.json' });
  const at = (id) => 'steps[' + broken.steps.findIndex((s) => s.id === id) + ']';
  for (const path of ['steps[0].produces', at('review') + '.when', at('android-build') + '.produces']) assert.ok(errors.some((e) => e.startsWith('recipes/mobile_app_dev.json: ' + path + ':')), 'no error at ' + path);
});

test('loadRecipe throws a RecipeError carrying every error', () => {
  const dir = tempDir('fsw-recipe-');
  writeFileSync(join(dir, 'copywriting.json'), JSON.stringify({ service: 'copywriting', version: 0 }));
  assert.throws(() => loadRecipe('copywriting', { dir }), (err) => err instanceof RecipeError && err.errors.length >= 5 && err.errors.every((e) => e.startsWith('recipes/copywriting.json: ')));
  assert.throws(() => loadRecipe('nothing_here', { dir }), { code: 'FSW_RECIPE_MISSING' });
});

test('resolveSkill picks the newest plugin version by number and checks the declared name', () => {
  const home = tempDir('fsw-skills-');
  const skill = (dir, name) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: ' + name + '\n---\n');
  };
  const cache = join(home, '.codex', 'plugins', 'cache', 'sisyphuslabs', 'omo');
  skill(join(cache, '5.1.9', 'skills', 'frontend'), 'frontend');
  skill(join(cache, '5.1.10', 'skills', 'visual-qa'), 'visual-qa');
  assert.match(resolveSkill('omo:visual-qa', { home }).file, /5\.1\.10/);
  assert.throws(() => resolveSkill('omo:frontend', { home }), { code: 'FSW_SKILL_MISSING' });
  skill(join(home, '.agents', 'skills', 'dedash'), 'something-else');
  assert.throws(() => resolveSkill('paperthin:dedash', { home }), /declares name something-else/);
});
