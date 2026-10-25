// fsw profile build <file-or-dir-or-url>... [--author NAME] [--lang ko|en] [--model M] | fsw profile accept
// build drafts profile.draft.json and profile.review.md beside profile.json and never touches profile.json;
// accept promotes the draft after the operator read it.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, instanceDir, readJson } from '../core/instance.mjs';
import { draftProfile } from '../profile/draft.mjs';
import { buildReview } from '../profile/review.mjs';
import { loadSources } from '../profile/sources.mjs';
import { placeholderFields, validateProfile } from '../profile/validate.mjs';

const USAGE = 'usage: fsw profile build <file-or-folder-or-url>... [--author "<your git name>"] [--lang ko|en] [--model M] | fsw profile accept [--force]';

function parse(argv) {
  const out = { inputs: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--author', '--lang', '--model'].includes(a)) {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value');
      out.flags[a.slice(2)] = argv[++i];
    } else if (a === '--force') out.flags.force = true;
    else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else out.inputs.push(a);
  }
  return out;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

async function build(inputs, flags, ctx) {
  const log = ctx.log ?? console.log;
  const dir = instanceDir(ctx.instanceDir);
  if (!existsSync(dir)) {
    (ctx.error ?? console.error)(`fsw profile: no instance at ${dir}; run fsw init first`);
    return 1;
  }
  const lang = flags.lang ?? 'en';
  if (!['ko', 'en'].includes(lang)) throw new Error('--lang is ko or en');
  const { sources, notes } = await loadSources(inputs, { author: flags.author ?? null, ...(ctx.sourceOptions ?? {}) });
  log(`read ${sources.length} source(s): ${sources.map((s) => `${s.id} ${s.label}`).join(', ')}`);
  const brain = existsSync(join(dir, 'config.json')) ? (readJson(join(dir, 'config.json')).brain ?? {}) : {};
  const result = await draftProfile(sources, { runCodex: ctx.runCodex, model: flags.model ?? brain.model ?? undefined, effort: brain.effort ?? undefined, today: ctx.today });
  const draftFile = join(dir, 'profile.draft.json');
  const reviewFile = join(dir, 'profile.review.md');
  const draft = JSON.stringify(result.profile, null, 2) + '\n';
  // Rebuilding with the same sources must not touch the files, so a diff only shows a real change.
  const same = existsSync(draftFile) && readFileSync(draftFile, 'utf8').replace(/"generatedAt": "[^"]*"/, '') === draft.replace(/"generatedAt": "[^"]*"/, '');
  if (!same) writeFileSync(draftFile, draft);
  writeFileSync(reviewFile, buildReview({ ...result, notes, lang }));
  const checked = result.profile.provenance.length;
  log(`${same ? 'draft unchanged' : 'wrote'} ${draftFile}`);
  log(`wrote ${reviewFile}: ${checked} verified claim(s), ${result.dropped.length} left out, ${result.conflicts.length} conflict(s), ${notes.length} input note(s)`);
  log('profile.json was not touched. Read the review, edit the draft if needed, then run: fsw profile accept');
  return checked ? 0 : 1;
}

function accept(flags, ctx) {
  const log = ctx.log ?? console.log;
  const error = ctx.error ?? console.error;
  const dir = instanceDir(ctx.instanceDir);
  const draftFile = join(dir, 'profile.draft.json');
  if (!existsSync(draftFile)) {
    error(`fsw profile accept: no draft at ${draftFile}; run fsw profile build first`);
    return 1;
  }
  let draft;
  try {
    draft = JSON.parse(readFileSync(draftFile, 'utf8'));
  } catch (err) {
    error(`fsw profile accept: the draft is not valid JSON: ${err.message}`);
    return 1;
  }
  const errors = validateProfile(draft);
  if (errors.length) {
    error('fsw profile accept: the draft is not a valid profile:\n' + errors.map((e) => '  ' + e).join('\n'));
    return 1;
  }
  const placeholders = placeholderFields(draft, readJson(join(exampleDir, 'profile.json')));
  if (placeholders.length && !flags.force) {
    error('fsw profile accept: the draft still holds example values (' + placeholders.join(', ') + '); replace them or pass --force');
    return 1;
  }
  const target = join(dir, 'profile.json');
  if (existsSync(target)) {
    const kept = join(dir, `previous-profile-${stamp()}.json`);
    copyFileSync(target, kept);
    log(`kept the old profile as ${kept}`);
  }
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(draft, null, 2) + '\n');
  renameSync(tmp, target);
  log(`profile.json now holds the accepted draft (${(draft.provenance ?? []).length} cited claims)`);
  return 0;
}

export async function run(argv, ctx = {}) {
  const error = ctx.error ?? console.error;
  const [action, ...rest] = argv;
  let parsed;
  try {
    parsed = parse(rest);
  } catch (err) {
    error(`fsw profile: ${err.message}\n${USAGE}`);
    return 1;
  }
  if (action === 'accept') return accept(parsed.flags, ctx);
  if (action === 'build') {
    try {
      return await build(parsed.inputs, parsed.flags, ctx);
    } catch (err) {
      if (!err.code?.startsWith('FSW_')) throw err;
      error(`fsw profile build: ${err.code}: ${err.message}`);
      return 1;
    }
  }
  error(USAGE);
  return 1;
}
