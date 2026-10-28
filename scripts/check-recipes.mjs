#!/usr/bin/env node
// Validates every recipe in recipes/ and fails when a service the agent delivers has no recipe, a recipe
// names a service that does not exist or that the operator delivers, or a step names a skill that is not
// installed on this machine. A CI runner holds none of the operator's skills (process.env.CI, set by GitHub
// Actions), so there a step's skill is checked only for a known namespace, and the run says so.
import { join } from 'node:path';
import { deliveryOf } from '../src/economics/catalog.mjs';
import { listRecipes, readRecipeFile, recipeDir, resolveSkill, serviceCatalog, SKILL_SOURCES } from '../src/work/recipe.mjs';

const onCi = process.env.CI === 'true';
const knownNamespace = (name) => {
  const ns = /^(?:([a-z0-9-]+):)?[A-Za-z0-9-]+$/.exec(name)?.[1];
  if (ns === undefined && !/^[A-Za-z0-9-]+$/.test(name)) throw new Error('not a skill name: ' + name);
  if (ns && !SKILL_SOURCES[ns]) throw new Error('unknown skill namespace ' + ns);
};
const problems = [];
const services = Object.entries(serviceCatalog()).filter(([, def]) => deliveryOf(def) === 'agent').map(([id]) => id);
const recipes = listRecipes();
for (const s of services) if (!recipes.includes(s)) problems.push('recipes/' + s + '.json: missing for service ' + s);
let skills = 0;
for (const id of recipes) {
  const rel = 'recipes/' + id + '.json';
  let recipe;
  try {
    recipe = readRecipeFile(join(recipeDir, id + '.json'), rel);
  } catch (err) {
    problems.push(...(err.errors?.length ? err.errors : [err.message]));
    continue;
  }
  for (const [i, step] of recipe.steps.entries()) {
    if (!step.skill) continue;
    try {
      if (onCi) knownNamespace(step.skill);
      else resolveSkill(step.skill);
      skills++;
    } catch (err) {
      problems.push(rel + ': steps[' + i + '].skill: ' + err.message);
    }
  }
}
for (const p of problems) console.error('check-recipes: ' + p);
console.log('check-recipes: ' + recipes.length + ' recipes, ' + skills + ' skill references ' + (onCi ? 'named (not installed on CI, so not resolved)' : 'resolved') + ', ' + problems.length + ' problems');
process.exit(problems.length ? 1 : 0);
