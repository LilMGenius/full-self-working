#!/usr/bin/env node
// Validates every recipe in recipes/ and fails when a service in services.json has no recipe, a recipe
// names a service that does not exist, or a step names a skill that is not installed on this machine.
import { join } from 'node:path';
import { listRecipes, readRecipeFile, recipeDir, resolveSkill, serviceCatalog } from '../src/jobs/recipe.mjs';

const problems = [];
const services = Object.keys(serviceCatalog());
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
      resolveSkill(step.skill);
      skills++;
    } catch (err) {
      problems.push(rel + ': steps[' + i + '].skill: ' + err.message);
    }
  }
}
for (const p of problems) console.error('check-recipes: ' + p);
console.log('check-recipes: ' + recipes.length + ' recipes, ' + skills + ' skill references resolved, ' + problems.length + ' problems');
process.exit(problems.length ? 1 : 0);
