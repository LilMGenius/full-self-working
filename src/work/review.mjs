// A review of a finished deliverable before the operator approves its delivery: one codex turn on a model family
// other than the one that built the work reads the deliverables and the brief and answers {verdict, findings}
// against REVIEW_SCHEMA. It is independent only across families, so a same-family or unknown pair records verdict
// error instead of running. The turn runs read-only (codex -s read-only, src/brain/codex.mjs) in a scratch copy, and
// the real work folder is hashed before and after as a second guard.
// A read-only turn on Windows cannot open a file itself (every shell call is blocked by policy, measured
// 2026-10-27 with codex-cli 0.164.0), and the Windows sandbox setting that lets it read also lets it write. So the
// review is shown its input: text files in the prompt, images attached, and a file of any other format (xlsx,
// pptx, mp4) is named as unread, which turns a pass into error, since nothing reviewed it.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCodex as defaultRunCodex } from '../brain/codex.mjs';
import { matchFiles } from './accept.mjs';

const FINDING = { type: 'object', additionalProperties: false, required: ['severity', 'file', 'detail'], properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: { type: ['string', 'null'] }, detail: { type: 'string' } } };
export const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict', 'findings'], properties: { verdict: { type: 'string', enum: ['pass', 'fail'] }, findings: { type: 'array', items: FINDING } } };

// The family a model name belongs to, read from its provider prefix or its name; null when neither says.
export function modelFamily(model) {
  const m = String(model ?? '').toLowerCase();
  if (/claude|anthropic/.test(m)) return 'anthropic';
  if (/^openai\/|(^|\/)(gpt|o\d|codex)/.test(m)) return 'openai';
  if (/gemini|^google\//.test(m)) return 'google';
  return null;
}

// The reviewer when jobs.review.model is null: the OpenAI model codex reaches through the ChatGPT login, for work
// another known family built; null for OpenAI-built or unknown work, which needs jobs.review.model set.
export const reviewerFor = (builderModel, { openaiModel }) => {
  const family = modelFamily(builderModel);
  return family && family !== 'openai' ? openaiModel : null;
};

export function hashTree(dir, files) {
  const h = createHash('sha256');
  for (const f of [...files].sort()) h.update(f + '\0' + createHash('sha256').update(readFileSync(join(dir, f))).digest('hex') + '\n');
  return h.digest('hex');
}

// What the review is shown: TEXT files inline up to REVIEW_LIMITS (a longer one is cut and listed as partial),
// IMAGE files attached up to the image limit (the deliverables first, then the QA captures), the rest unread.
const TEXT = /\.(md|txt|csv|srt|json|js|mjs|cjs|py|bas|html?|svg|css)$/i;
const IMAGE = /\.(png|jpe?g)$/i;
const REVIEW_LIMITS = { fileChars: 40_000, totalChars: 160_000, images: 8 };

export function reviewInput(dir, files, captures = []) {
  const texts = [];
  const images = [];
  const partial = [];
  const unread = [];
  let room = REVIEW_LIMITS.totalChars;
  for (const f of files) {
    if (TEXT.test(f)) {
      const body = readFileSync(join(dir, f), 'utf8');
      const shown = body.slice(0, Math.min(REVIEW_LIMITS.fileChars, room));
      room -= shown.length;
      if (shown.length < body.length) partial.push(f);
      texts.push({ file: f, body: shown, cut: shown.length < body.length });
    } else if (IMAGE.test(f) && images.length < REVIEW_LIMITS.images) images.push(join(dir, f));
    else unread.push(f);
  }
  for (const c of captures) if (images.length < REVIEW_LIMITS.images) images.push(c);
  return { texts, images, partial, unread };
}

// codex already held the answer to REVIEW_SCHEMA; this keeps the fields the record stores and refuses anything else.
function parseReview(data) {
  const ok = data && ['pass', 'fail'].includes(data.verdict) && Array.isArray(data.findings) && data.findings.every((f) => f && typeof f.detail === 'string' && ['blocker', 'major', 'minor'].includes(f.severity));
  if (!ok) throw Object.assign(new Error('the review answer is not {verdict, findings}: ' + JSON.stringify(data).slice(0, 300)), { code: 'FSW_REVIEW_BAD_ANSWER' });
  // A blocker is a reason to fail by the prompt's own rule, so a pass that names one is recorded as fail.
  const verdict = data.verdict === 'pass' && data.findings.some((f) => f.severity === 'blocker') ? 'fail' : data.verdict;
  return { verdict, findings: data.findings.map((f) => ({ severity: f.severity, file: typeof f.file === 'string' ? f.file : null, detail: f.detail })) };
}

function reviewPrompt({ brief, files, language, input }) {
  return [
    'You review a freelance deliverable before it is sent to the client. Do not run commands or edit any file: every file you may judge is shown below or attached as an image. Answer with the JSON object the schema asks for: a verdict and your findings.',
    'fail when any blocker exists: the brief is not met, text is in the wrong language (expected ' + language + '), a placeholder or invented fact is present, a file is broken or empty, or the work looks machine-made in a way the client would notice.',
    '', '# Brief', brief, '', '# Files of the delivery', files.join('\n'),
    ...input.texts.flatMap((t) => ['', '## ' + t.file + (t.cut ? ' (first ' + t.body.length + ' characters)' : ''), '```', t.body, '```']),
    ...(input.images.length ? ['', '# Attached images', ...input.images.map((f) => f.split(/[\\/]/).pop())] : []),
    ...(input.unread.length ? ['', '# Not shown (a format this review cannot read)', ...input.unread] : []),
  ].join('\n');
}

// The delivery against its review: changed when a reviewed file is gone or its bytes differ from the reviewed hash
// (a review without its file list cannot be checked and counts as changed); unreviewed lists the delivery files the
// review never read, such as files an operator step added after the run.
export function reviewDrift(review, files) {
  if (!Array.isArray(review?.reviewed) || !review.work) return { changed: true, unreviewed: [...files] };
  const seen = new Set(review.reviewed.map((f) => resolve(review.work, f)));
  const changed = !review.reviewed.every((f) => existsSync(join(review.work, f))) || hashTree(review.work, review.reviewed) !== review.hash;
  return { changed, unreviewed: files.filter((f) => !seen.has(resolve(f))) };
}

// paths: jobPaths of the job; recipe: its deliverables. Returns the review record stored on the job.
export async function reviewDeliverables({ paths, recipe, language = 'ko', builderModel, model, runCodex = defaultRunCodex, timeoutMs = 900_000 }) {
  const captures = paths.qa && existsSync(paths.qa) ? readdirSync(paths.qa).filter((f) => IMAGE.test(f)).sort().map((f) => join(paths.qa, f)) : [];
  const files = [...new Set(recipe.deliverables.flatMap((d) => matchFiles(paths.work, d.path)))];
  const at = new Date().toISOString();
  const built = modelFamily(builderModel);
  const reviewer = modelFamily(model);
  if (!built || !reviewer || built === reviewer) {
    const detail = 'the review model ' + (model ?? 'none') + ' (' + (reviewer ?? 'unknown family') + ') is not independent of the builder ' + builderModel + ' (' + (built ?? 'unknown family') + '); set jobs.review.model to a model of another family';
    return { verdict: 'error', findings: [{ severity: 'blocker', file: null, detail }], model: model ?? null, builderModel, files: files.length, reviewed: files, work: paths.work, hash: hashTree(paths.work, files), durationMs: 0, at };
  }
  const before = hashTree(paths.work, files);
  const scratch = mkdtempSync(join(tmpdir(), 'fsw-review-'));
  const started = Date.now();
  try {
    cpSync(paths.work, scratch, { recursive: true });
    const brief = readFileSync(paths.brief, 'utf8');
    const input = reviewInput(scratch, files, captures);
    let result;
    try {
      const r = await runCodex({ prompt: reviewPrompt({ brief, files, language, input }), schema: REVIEW_SCHEMA, model, cwd: scratch, images: input.images, sandbox: 'read-only', timeoutMs });
      result = parseReview(r.data);
      // A file the review did not see whole was not reviewed: an unread format or a text cut at the limit never passes.
      const unseen = [...(input.unread.length ? ['not reviewed, a format the review cannot read: ' + input.unread.join(', ')] : []), ...(input.partial.length ? ['reviewed only in part, cut at the review limit: ' + input.partial.join(', ')] : [])];
      if (unseen.length) result = { verdict: result.verdict === 'pass' ? 'error' : result.verdict, findings: [...unseen.map((detail) => ({ severity: 'blocker', file: null, detail })), ...result.findings] };
    } catch (err) {
      // A codex failure (timeout, a dead proxy, a refused login) is recorded with its cause, never as a pass.
      result = { verdict: 'error', findings: [{ severity: 'blocker', file: null, detail: (err.code ? err.code + ' ' : '') + err.message }] };
    }
    const after = hashTree(paths.work, files);
    if (after !== before) result = { verdict: 'fail', findings: [{ severity: 'blocker', file: null, detail: 'the work folder changed during the review' }, ...result.findings] };
    return { ...result, model, builderModel, files: files.length, reviewed: files, work: paths.work, images: input.images.length, partial: input.partial, unread: input.unread, hash: before, durationMs: Date.now() - started, at };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
