// Recipes: one typed skill graph per service in recipes/<service>.json (docs/DESIGN.md, Jobs), in the
// shape paperthin:re0-workflow recommends. loadRecipe reads and validates one; validateRecipe returns every
// error with the file and the JSON path it sits at; resolveSkill finds the SKILL.md a step names on this
// machine, through the newest plugin version directory at call time (a plugin update replaces the old one).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { repoRoot } from '../core/instance.mjs';

export const recipeDir = join(repoRoot, 'recipes');
const servicesFile = join(repoRoot, 'src', 'economics', 'services.json');

export const STEP_TYPES = ['invoke-model-skill', 'script', 'user-handoff'];
// Script steps are deterministic actions src/jobs/run.mjs runs after the model turn; accept is the
// acceptance phase itself and every recipe declares it once.
export const SCRIPTS = ['render', 'accept'];
// image accepts PNG or JPEG, for deliverables whose format depends on the source (a cutout keeps alpha).
export const FORMATS = ['html', 'png', 'jpeg', 'image', 'svg', 'pdf', 'md', 'txt', 'csv', 'srt', 'json', 'js', 'py', 'bas', 'xlsx', 'xlsm', 'pptx', 'docx', 'zip', 'mp4'];
export const IMAGE_FORMATS = ['png', 'jpeg', 'image'];
export const TEXT_FORMATS = ['html', 'svg', 'md', 'txt', 'csv', 'srt', 'json', 'js', 'py', 'bas'];
export const LINT_FORMATS = ['html', 'md', 'txt', 'srt', 'csv'];
export const CHECKS = ['files', 'image', 'sloplint', 'viewports', 'command'];
export const PAYMENT_LEVELS = ['none', 'deposit', 'full'];
const CONSTRAINT_KEYS = ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'];
// notes lists the local tools a recipe relies on and how each was installed, so a new machine can be set up.
const TOP_KEYS = ['service', 'version', 'executor', 'notes', 'hours', 'steps', 'deliverables', 'acceptance', 'payment'];
// Which coding agent runs the model steps: codex (codex exec, sandboxed) or jwc (jawcode, src/brain/jwc.mjs).
export const EXECUTORS = ['codex', 'jwc'];
const PACKAGES = ['standard', 'deluxe', 'premium'];

// Where each skill namespace lives. agents: ~/.agents/skills/<name>; plugin: the newest version of a
// Codex plugin cache entry; strip removes the prefix a plugin adds to its folder names in the skill name.
export const SKILL_SOURCES = {
  paperthin: { kind: 'agents' },
  noslopdesign: { kind: 'agents' },
  omo: { kind: 'plugin', path: ['sisyphuslabs', 'omo'] },
  codexclaw: { kind: 'plugin', path: ['codexclaw', 'codexclaw'], strip: 'cxc-' },
  presentations: { kind: 'plugin', path: ['openai-primary-runtime', 'presentations'] },
  spreadsheets: { kind: 'plugin', path: ['openai-primary-runtime', 'spreadsheets'] },
  documents: { kind: 'plugin', path: ['openai-primary-runtime', 'documents'] },
  pdf: { kind: 'plugin', path: ['openai-primary-runtime', 'pdf'] },
};
const SKILL_RE = /^(?:([a-z0-9-]+):)?([A-Za-z0-9-]+)$/;

export class RecipeError extends Error {
  constructor(message, { code = 'FSW_RECIPE_INVALID', errors = [], file } = {}) {
    super(message);
    this.name = 'RecipeError';
    this.code = code;
    this.errors = errors;
    this.file = file;
  }
}

let servicesCache;
export function serviceCatalog() {
  servicesCache ??= Object.fromEntries(Object.entries(JSON.parse(readFileSync(servicesFile, 'utf8'))).filter(([k]) => !k.startsWith('_')));
  return servicesCache;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isRelPath = (v) => isText(v) && !isAbsolute(v) && !/^[a-zA-Z]:/.test(v) && !v.split(/[\\/]/).includes('..');

export function validateRecipe(recipe, { file = 'recipe', services = serviceCatalog() } = {}) {
  const errors = [];
  const err = (path, detail) => errors.push(file + ': ' + path + ': ' + detail);
  if (!isObj(recipe)) {
    err('$', 'must be an object');
    return errors;
  }
  for (const k of Object.keys(recipe)) if (!TOP_KEYS.includes(k)) err(k, 'unknown key');

  const service = services[recipe.service];
  if (!service) err('service', 'unknown service ' + JSON.stringify(recipe.service));
  else if (file !== 'recipe' && basename(file, '.json') !== recipe.service) err('service', 'must match the file name ' + basename(file));
  if (!isPosInt(recipe.version)) err('version', 'must be a positive integer');
  if (recipe.executor !== undefined && !EXECUTORS.includes(recipe.executor)) err('executor', 'must be one of ' + EXECUTORS.join(', '));
  if (recipe.notes !== undefined && !(Array.isArray(recipe.notes) && recipe.notes.length && recipe.notes.every(isText))) err('notes', 'must be a non-empty array of strings');

  if (!isObj(recipe.hours)) err('hours', 'must be an object with standard, deluxe and premium');
  else {
    for (const p of PACKAGES) {
      if (typeof recipe.hours[p] !== 'number' || !(recipe.hours[p] > 0)) err('hours.' + p, 'must be a positive number');
      // services.json owns the hour estimate the price table reads; a recipe that disagrees has drifted.
      else if (service && service.agentHours?.[p] !== recipe.hours[p]) err('hours.' + p, 'is ' + recipe.hours[p] + ' but services.json agentHours.' + p + ' is ' + service.agentHours?.[p]);
    }
  }

  const steps = Array.isArray(recipe.steps) ? recipe.steps : null;
  if (!steps || !steps.length) err('steps', 'must be a non-empty array');
  const ids = new Set();
  for (const [i, s] of (steps ?? []).entries()) {
    const at = 'steps[' + i + ']';
    if (!isObj(s)) {
      err(at, 'must be an object');
      continue;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(s.id ?? '')) err(at + '.id', 'must be lowercase kebab case');
    else if (ids.has(s.id)) err(at + '.id', 'duplicate id ' + s.id);
    else ids.add(s.id);
    if (!STEP_TYPES.includes(s.type)) err(at + '.type', 'must be one of ' + STEP_TYPES.join(', '));
    if (!isText(s.input)) err(at + '.input', 'must name what the step reads');
    if (!isText(s.output)) err(at + '.output', 'must name what the step writes');
    // A model step names the skill it follows; one without a skill is plain model work (a video cut, a
    // translation) and says so by leaving skill out.
    if (s.skill !== undefined) {
      const m = SKILL_RE.exec(s.skill ?? '');
      if (!m) err(at + '.skill', 'must be a skill name like omo:visual-qa');
      else if (m[1] && !SKILL_SOURCES[m[1]]) err(at + '.skill', 'unknown namespace ' + m[1]);
      if (s.type !== 'invoke-model-skill') err(at + '.skill', 'only invoke-model-skill steps name a skill');
    }
    if (s.type === 'invoke-model-skill' && !isText(s.does)) err(at + '.does', 'must say what the step makes');
    if (s.type === 'script') {
      if (!SCRIPTS.includes(s.run)) err(at + '.run', 'must be one of ' + SCRIPTS.join(', '));
      if (s.run === 'render') validateRenderArgs(s, at, err);
    }
    if (s.type === 'user-handoff' && !isText(s.ask)) err(at + '.ask', 'must say what the person decides');
  }
  const acceptAt = (steps ?? []).findIndex((s) => s?.type === 'script' && s.run === 'accept');
  if (steps && steps.filter((s) => s?.type === 'script' && s.run === 'accept').length !== 1) err('steps', 'must hold exactly one script step with run accept');
  // runJob runs every model and render step, then acceptance, and stops; a person takes over from there.
  for (const [i, s] of (steps ?? []).entries()) {
    if (acceptAt < 0 || !isObj(s)) continue;
    if (s.type === 'user-handoff' && i < acceptAt) err('steps[' + i + ']', 'a user-handoff step comes after the accept step');
    if (s.type !== 'user-handoff' && i > acceptAt) err('steps[' + i + ']', 'only user-handoff steps follow the accept step');
  }

  const deliverables = Array.isArray(recipe.deliverables) ? recipe.deliverables : null;
  if (!deliverables || !deliverables.length) err('deliverables', 'must be a non-empty array');
  for (const [i, d] of (deliverables ?? []).entries()) {
    const at = 'deliverables[' + i + ']';
    if (!isObj(d)) {
      err(at, 'must be an object');
      continue;
    }
    if (!isRelPath(d.path)) err(at + '.path', 'must be a glob relative to work/ without ..');
    if (!FORMATS.includes(d.format)) err(at + '.format', 'must be one of ' + FORMATS.join(', '));
    if (d.constraints !== undefined) {
      if (!IMAGE_FORMATS.includes(d.format)) err(at + '.constraints', 'only image deliverables carry constraints');
      else if (!isObj(d.constraints) || !Object.keys(d.constraints).length) err(at + '.constraints', 'must be an object');
      else {
        for (const [k, v] of Object.entries(d.constraints)) {
          if (!CONSTRAINT_KEYS.includes(k)) err(at + '.constraints.' + k, 'unknown constraint');
          else if (!isPosInt(v)) err(at + '.constraints.' + k, 'must be a positive integer');
        }
      }
    }
  }

  const acceptance = Array.isArray(recipe.acceptance) ? recipe.acceptance : null;
  if (!acceptance || !acceptance.length) err('acceptance', 'must be a non-empty array');
  const formats = new Set((deliverables ?? []).map((d) => d?.format));
  for (const [i, c] of (acceptance ?? []).entries()) {
    const at = 'acceptance[' + i + ']';
    if (!isObj(c) || !CHECKS.includes(c.check)) {
      err(at + '.check', 'must be one of ' + CHECKS.join(', '));
      continue;
    }
    if (c.check === 'image' && !(deliverables ?? []).some((d) => d?.constraints)) err(at, 'image check needs a deliverable with constraints');
    if (c.check === 'sloplint') {
      if (c.lang !== undefined && !['ko', 'en'].includes(c.lang)) err(at + '.lang', 'must be ko or en');
      // paths narrows the lint to the files that carry our copy, since scraped data or a customer's own
      // text is not ours to rewrite.
      if (c.paths !== undefined && !(Array.isArray(c.paths) && c.paths.length && c.paths.every(isRelPath))) err(at + '.paths', 'must list globs relative to work/');
      else if (c.paths === undefined && ![...formats].some((f) => LINT_FORMATS.includes(f))) err(at, 'sloplint needs an ' + LINT_FORMATS.join(', ') + ' deliverable');
    }
    if (c.check === 'viewports') {
      if (!formats.has('html')) err(at, 'viewports needs an html deliverable');
      if (c.widths !== undefined && !(Array.isArray(c.widths) && c.widths.length && c.widths.every(isPosInt))) err(at + '.widths', 'must list positive integer widths');
    }
    if (c.check === 'command') {
      if (!isText(c.run)) err(at + '.run', 'must be the command to run');
      if (c.cwd !== undefined && !isRelPath(c.cwd)) err(at + '.cwd', 'must be relative to work/ without ..');
      if (c.timeoutMs !== undefined && !isPosInt(c.timeoutMs)) err(at + '.timeoutMs', 'must be a positive integer');
    }
  }
  if (acceptance && !acceptance.some((c) => c?.check === 'files')) err('acceptance', 'must include a files check');

  const pay = recipe.payment;
  if (!isObj(pay)) err('payment', 'must be an object with beforeStart and beforeDelivery');
  else {
    if (!PAYMENT_LEVELS.includes(pay.beforeStart)) err('payment.beforeStart', 'must be one of ' + PAYMENT_LEVELS.join(', '));
    // The finished result leaves the machine only once the whole price is held or paid.
    if (pay.beforeDelivery !== 'full') err('payment.beforeDelivery', 'must be full');
  }
  return errors;
}

// render turns each HTML or SVG file matching input into an image at output, where {stem} is the source
// file name without its extension. An SVG is fitted into width x height on a white page. size "page" takes
// the size from the page's own <meta name="fsw-size" content="1280x720">, for briefs that name sizes.
function validateRenderArgs(s, at, err) {
  const a = s.args;
  if (!isObj(a)) return err(at + '.args', 'render needs args {width, height?, fullPage?, format} or {size: "page", format}');
  if (!isRelPath(s.input)) err(at + '.input', 'render input must be a glob relative to work/');
  if (!isRelPath(s.output) || !s.output.includes('{stem}')) err(at + '.output', 'render output must be a relative pattern holding {stem}');
  if (a.size !== undefined) {
    if (a.size !== 'page') err(at + '.args.size', 'must be page');
    if (a.width !== undefined || a.height !== undefined) err(at + '.args', 'size page reads width and height from the page');
  } else {
    if (!isPosInt(a.width)) err(at + '.args.width', 'must be a positive integer');
    if (a.height !== undefined && !isPosInt(a.height)) err(at + '.args.height', 'must be a positive integer');
  }
  if (a.fullPage !== undefined && typeof a.fullPage !== 'boolean') err(at + '.args.fullPage', 'must be a boolean');
  if (!['png', 'jpeg'].includes(a.format)) err(at + '.args.format', 'must be png or jpeg');
}

export function listRecipes(dir = recipeDir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => basename(f, '.json')).sort();
}

export function readRecipeFile(file, rel = file) {
  let recipe;
  try {
    recipe = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new RecipeError(rel + ': not JSON: ' + e.message, { file: rel, errors: [rel + ': ' + e.message] });
  }
  const errors = validateRecipe(recipe, { file: rel });
  if (errors.length) throw new RecipeError(errors.join('\n'), { file: rel, errors });
  return recipe;
}

export function loadRecipe(service, { dir = recipeDir } = {}) {
  const file = join(dir, service + '.json');
  const rel = 'recipes/' + service + '.json';
  if (!existsSync(file)) throw new RecipeError('no recipe for service ' + service + ' (' + rel + ')', { code: 'FSW_RECIPE_MISSING', file: rel });
  return readRecipeFile(file, rel);
}

const SKILL_FILE = 'SKILL.md';

// Version directories compare by their numeric parts (5.1.45 after 5.1.44, build suffixes ignored);
// mtime cannot order them, since an installer touches the old directory while it removes it.
const versionParts = (name) => name.split(/[+-]/)[0].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return a.localeCompare(b);
}

function newestVersionDir(dir) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  names.sort(compareVersions);
  return names.length ? join(dir, names.at(-1)) : null;
}

function frontmatterName(file) {
  const head = readFileSync(file, 'utf8').slice(0, 2000);
  return /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(head)?.[1] ?? null;
}

// Returns {name, file} for an installed skill, or throws FSW_SKILL_MISSING naming where it looked. The
// frontmatter name must match, so a folder holding a different skill under the same name is refused.
export function resolveSkill(name, { home = process.env.FSW_SKILL_HOME ?? homedir() } = {}) {
  const m = SKILL_RE.exec(name ?? '');
  if (!m) throw new RecipeError('not a skill name: ' + name, { code: 'FSW_SKILL_MISSING' });
  const [, ns, skill] = m;
  const candidates = [];
  if (!ns) {
    candidates.push(join(home, '.agents', 'skills', skill, SKILL_FILE), join(home, '.codex', 'skills', '.system', skill, SKILL_FILE));
  } else {
    const src = SKILL_SOURCES[ns];
    if (!src) throw new RecipeError('unknown skill namespace ' + ns, { code: 'FSW_SKILL_MISSING' });
    const folder = (src.strip && skill.startsWith(src.strip) ? skill.slice(src.strip.length) : skill).toLowerCase();
    if (src.kind === 'agents') candidates.push(join(home, '.agents', 'skills', folder, SKILL_FILE));
    else {
      const root = join(home, '.codex', 'plugins', 'cache', ...src.path);
      candidates.push(join(newestVersionDir(root) ?? join(root, '<no version>'), 'skills', folder, SKILL_FILE));
    }
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const declared = frontmatterName(file);
    if (declared?.toLowerCase() !== skill.toLowerCase()) {
      throw new RecipeError('skill ' + name + ' resolved to ' + file + ' which declares name ' + declared, { code: 'FSW_SKILL_MISSING' });
    }
    return { name, file };
  }
  throw new RecipeError('skill ' + name + ' is not installed (looked in ' + candidates.join(', ') + ')', { code: 'FSW_SKILL_MISSING' });
}
