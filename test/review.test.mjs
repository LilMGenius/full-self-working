// The review of finished work (070 U7.7): one read-only codex turn on a model family other than the builder's
// reviews a copy of the deliverables. A failure is recorded as error with its cause, never as a pass, and a
// same-family or unknown pair never counts as independent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexArgs } from '../src/brain/codex.mjs';
import { REVIEW_SCHEMA, hashTree, modelFamily, reviewDeliverables, reviewInput, reviewerFor } from '../src/work/review.mjs';
import { tempDir } from './tmp.mjs';

function job() {
  const dir = tempDir('fsw-review-job-');
  const paths = { dir, brief: join(dir, 'brief.md'), work: join(dir, 'work') };
  mkdirSync(join(paths.work, 'copy'), { recursive: true });
  writeFileSync(join(paths.work, 'copy', 'variant-a.md'), '# 빵집\n\n매일 아침 굽습니다.\n');
  writeFileSync(join(paths.work, 'copy', 'variant-b.md'), '# 빵집\n\n동네 빵입니다.\n');
  writeFileSync(paths.brief, '# Brief\n\n빵집 소개 문구 2종\n');
  return paths;
}
const recipe = { deliverables: [{ path: 'copy/*.md', format: 'md' }] };
const FILES = ['copy/variant-a.md', 'copy/variant-b.md'];
const BUILDER = 'cpa/claude-opus-5-5';
const REVIEWER = 'gpt-6.1-sol';

function stub(answer) {
  const calls = [];
  const fn = async (opts) => {
    calls.push({ ...opts, sawFiles: FILES.map((f) => existsSync(join(opts.cwd, f))) });
    return typeof answer === 'function' ? answer(opts) : { data: answer, durationMs: 3 };
  };
  fn.calls = calls;
  return fn;
}

test('a passed review runs read-only in a scratch copy against REVIEW_SCHEMA and records the reviewer and the hash', async () => {
  const paths = job();
  const runCodex = stub({ verdict: 'pass', findings: [] });
  const r = await reviewDeliverables({ paths, recipe, language: 'ko', builderModel: BUILDER, model: REVIEWER, runCodex });
  assert.deepEqual([r.verdict, r.findings, r.model, r.builderModel, r.files, r.images, r.unread], ['pass', [], REVIEWER, BUILDER, 2, 0, []]);
  assert.equal(r.hash, hashTree(paths.work, FILES));
  assert.equal(runCodex.calls.length, 1);
  const call = runCodex.calls[0];
  assert.deepEqual([call.sandbox, call.schema, call.model], ['read-only', REVIEW_SCHEMA, REVIEWER]);
  assert.notEqual(call.cwd, paths.work);
  assert.deepEqual(call.sawFiles, [true, true]);
  assert.equal(existsSync(call.cwd), false, 'the scratch copy is removed');
  assert.match(call.prompt, /빵집 소개 문구 2종/);
  assert.match(call.prompt, /copy\/variant-a\.md\ncopy\/variant-b\.md/);
  assert.match(call.prompt, /expected ko/);
  assert.match(call.prompt, /## copy\/variant-b\.md\n```\n# 빵집\n\n동네 빵입니다\./);
  assert.deepEqual(call.images, []);
  assert.ok(r.durationMs >= 0 && !Number.isNaN(Date.parse(r.at)));
});

test('a failed review keeps its findings, with a missing file read as null', async () => {
  const r = await reviewDeliverables({ paths: job(), recipe, builderModel: BUILDER, model: REVIEWER, runCodex: stub({ verdict: 'fail', findings: [{ severity: 'blocker', file: 'copy/variant-a.md', detail: 'only one variant meets the brief' }, { severity: 'minor', file: null, detail: 'title repeats' }] }) });
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.findings, [{ severity: 'blocker', file: 'copy/variant-a.md', detail: 'only one variant meets the brief' }, { severity: 'minor', file: null, detail: 'title repeats' }]);
});

test('a review run that throws, or answers outside the schema, is verdict error with its cause', async () => {
  const thrown = await reviewDeliverables({ paths: job(), recipe, builderModel: BUILDER, model: REVIEWER, runCodex: stub(() => { throw Object.assign(new Error('codex exec timed out after 900000 ms'), { code: 'FSW_CODEX_TIMEOUT' }); }) });
  assert.equal(thrown.verdict, 'error');
  assert.match(thrown.findings[0].detail, /^FSW_CODEX_TIMEOUT codex exec timed out/);
  const odd = await reviewDeliverables({ paths: job(), recipe, builderModel: BUILDER, model: REVIEWER, runCodex: stub({ verdict: 'maybe', findings: [] }) });
  assert.equal(odd.verdict, 'error');
  assert.match(odd.findings[0].detail, /^FSW_REVIEW_BAD_ANSWER/);
});

test('a review turn that writes into the work folder fails the review, naming the changed folder first', async () => {
  const paths = job();
  const before = hashTree(paths.work, FILES);
  const runCodex = stub(() => {
    writeFileSync(join(paths.work, 'copy', 'variant-a.md'), 'rewritten by the reviewer\n');
    return { data: { verdict: 'pass', findings: [] }, durationMs: 3 };
  });
  const r = await reviewDeliverables({ paths, recipe, builderModel: BUILDER, model: REVIEWER, runCodex });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.findings[0].detail, 'the work folder changed during the review');
  assert.equal(r.hash, before);
});

test('reviewerFor picks the OpenAI model for work another family built, and none for OpenAI-built or unknown work', () => {
  assert.equal(reviewerFor(BUILDER, { openaiModel: REVIEWER }), REVIEWER);
  assert.equal(reviewerFor('anthropic/claude-sonnet-5-5', { openaiModel: REVIEWER }), REVIEWER);
  assert.equal(reviewerFor(REVIEWER, { openaiModel: REVIEWER }), null);
  assert.equal(reviewerFor('openai/gpt-5.6-sol', { openaiModel: REVIEWER }), null);
  assert.equal(reviewerFor('test-model', { openaiModel: REVIEWER }), null);
  assert.deepEqual([BUILDER, REVIEWER, 'openai/gpt-5.6-sol', 'gemini-3-pro', 'test-model', null].map(modelFamily), ['anthropic', 'openai', 'openai', 'google', null, null]);
});

test('a same-family, unknown or missing reviewer records error and never calls the model', async () => {
  for (const [builderModel, model, family] of [[REVIEWER, REVIEWER, /builder gpt-6\.1-sol \(openai\)/], ['test-model', REVIEWER, /unknown family/], [BUILDER, null, /review model none/], [BUILDER, 'cpa/claude-sonnet-5-5', /\(anthropic\) is not independent/]]) {
    const runCodex = stub({ verdict: 'pass', findings: [] });
    const r = await reviewDeliverables({ paths: job(), recipe, builderModel, model, runCodex });
    assert.equal(r.verdict, 'error', builderModel + ' / ' + model);
    assert.match(r.findings[0].detail, family);
    assert.match(r.findings[0].detail, /set jobs\.review\.model/);
    assert.equal(runCodex.calls.length, 0);
  }
});

// A read-only codex turn on Windows cannot open a file (every shell call is blocked), so the review is shown its
// input: text inline, images attached, any other format named as unread, and an unread file never passes.
test('the review shows text files in the prompt, attaches images and QA captures, and a format it cannot read turns a pass into error', async () => {
  const paths = job();
  paths.qa = join(paths.dir, 'qa');
  mkdirSync(join(paths.work, 'export'), { recursive: true });
  mkdirSync(paths.qa, { recursive: true });
  writeFileSync(join(paths.work, 'export', 'banner.png'), 'png bytes');
  writeFileSync(join(paths.work, 'export', 'deck.xlsx'), 'xlsx bytes');
  writeFileSync(join(paths.qa, 'index.html@320x568.jpg'), 'jpg bytes');
  const mixed = { deliverables: [...recipe.deliverables, { path: 'export/*.png', format: 'png' }, { path: 'export/*.xlsx', format: 'xlsx' }] };
  const runCodex = stub({ verdict: 'pass', findings: [] });
  const r = await reviewDeliverables({ paths, recipe: mixed, builderModel: BUILDER, model: REVIEWER, runCodex });
  const call = runCodex.calls[0];
  assert.match(call.prompt, /## copy\/variant-a\.md\n```\n# 빵집\n\n매일 아침 굽습니다\./);
  assert.match(call.prompt, /# Not shown \(a format this review cannot read\)\nexport\/deck\.xlsx/);
  assert.deepEqual(call.images.map((f) => f.split(/[\\/]/).slice(-2).join('/')), ['export/banner.png', 'qa/index.html@320x568.jpg']);
  assert.deepEqual([r.verdict, r.images, r.unread, r.partial], ['error', 2, ['export/deck.xlsx'], []]);
  assert.match(r.findings[0].detail, /not reviewed, a format the review cannot read: export\/deck\.xlsx/);
  const failed = await reviewDeliverables({ paths, recipe: mixed, builderModel: BUILDER, model: REVIEWER, runCodex: stub({ verdict: 'fail', findings: [{ severity: 'major', file: null, detail: 'x' }] }) });
  assert.deepEqual([failed.verdict, failed.findings.length], ['fail', 2]);
});

test('a long text is cut at the per-file limit and listed as partial', () => {
  const dir = tempDir('fsw-review-long-');
  writeFileSync(join(dir, 'long.md'), 'a'.repeat(50_000));
  writeFileSync(join(dir, 'short.md'), 'b');
  const input = reviewInput(dir, ['long.md', 'short.md']);
  assert.deepEqual([input.texts.map((t) => t.body.length), input.partial, input.unread], [[40_000, 1], ['long.md'], []]);
});

test('codexArgs attaches each image with --image', () => {
  const args = codexArgs({ schemaFile: 's', outFile: 'o', images: ['C:/q/a.png', 'C:/q/b.jpg'] });
  assert.deepEqual(args.filter((a) => a.startsWith('--image')), ['--image=C:/q/a.png', '--image=C:/q/b.jpg']);
  assert.equal(codexArgs({ schemaFile: 's', outFile: 'o' }).some((a) => a.startsWith('--image')), false);
});
