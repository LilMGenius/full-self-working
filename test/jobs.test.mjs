import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { imageSize, runAcceptance } from '../src/jobs/accept.mjs';
import { deliveryAllowed, runJob } from '../src/jobs/run.mjs';
import { loadRecipe } from '../src/jobs/recipe.mjs';
import { run as runCli } from '../src/cli/job.mjs';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';

// A real PNG of the given size (white, 8-bit grey), so the header parser reads what a renderer writes.
function png(width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function workDir(files) {
  const job = mkdtempSync(join(tmpdir(), 'fsw-accept-'));
  const work = join(job, 'work');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), body);
  }
  return { job, work };
}

const recipe = (deliverables, acceptance) => ({ deliverables, acceptance });
const page = (body, css = '') => '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font-family:system-ui,sans-serif}' + css + '</style></head><body>' + body + '</body></html>';

test('the image check fails a PNG of the wrong size and passes the right one', async () => {
  const { work } = workDir({ 'logo/a.png': png(800, 600), 'logo/b.png': png(1024, 1024) });
  const r = await runAcceptance(work, recipe([{ path: 'logo/*.png', format: 'png', constraints: { width: 1024, height: 1024 } }], [{ check: 'files' }, { check: 'image' }]));
  assert.equal(r.ok, false);
  const image = r.results.find((x) => x.check === 'image');
  assert.equal(image.ok, false);
  assert.match(image.detail, /logo\/a\.png: width 800 is not 1024, height 600 is not 1024/);
  assert.doesNotMatch(image.detail, /logo\/b\.png/);
  assert.equal(r.results.find((x) => x.check === 'files').ok, true);
  assert.deepEqual(imageSize(png(3, 2)), { type: 'png', width: 3, height: 2 });
});

test('the files check fails a missing deliverable and a file whose bytes are not its format', async () => {
  const { work } = workDir({ 'export/a.png': 'not really a png' });
  const r = await runAcceptance(work, recipe([{ path: 'export/*.png', format: 'png' }, { path: 'site/index.html', format: 'html' }], [{ check: 'files' }]));
  assert.equal(r.ok, false);
  assert.match(r.results[0].detail, /export\/a\.png: not a PNG/);
  assert.match(r.results[0].detail, /site\/index\.html: no file/);
});

test('sloplint fails a floor phrase in HTML text, including one written as an entity', async () => {
  const { work } = workDir({ 'site/index.html': page('<h1>빵집 &mdash; 매일 아침</h1><p>갓 구운 빵을 드립니다.</p>') });
  const r = await runAcceptance(work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'sloplint' }]));
  assert.equal(r.ok, false);
  assert.match(r.results[0].detail, /site\/index\.html em_dash/);
  const clean = workDir({ 'site/index.html': page('<h1>빵집, 매일 아침</h1><style>p::before{content:"\\2014"}</style>') });
  assert.equal((await runAcceptance(clean.work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'sloplint' }]))).ok, true);
});

test('viewports fails a page that overflows at phone width and writes JPEG captures under qa/', { timeout: 120000 }, async () => {
  const wide = page('<main><h1>오늘의 빵</h1><div class="strip">가로로 넘치는 띠</div></main>', '.strip{width:900px;background:#eee}');
  const { job, work } = workDir({ 'site/index.html': wide });
  const r = await runAcceptance(work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'viewports', widths: [390, 1440] }]));
  const v = r.results[0];
  assert.equal(v.ok, false, v.detail);
  assert.match(v.detail, /site\/index\.html@390: horizontal overflow 900 > 390 \(div\.strip\)/);
  assert.doesNotMatch(v.detail, /@1440/);
  for (const name of ['site_index-390.jpg', 'site_index-1440.jpg', 'site_index-390-full.jpg']) {
    const file = join(job, 'qa', name);
    assert.ok(existsSync(file), name);
  }
});

test('a check that cannot run is a failure with its cause', async () => {
  const { work } = workDir({ 'site/index.html': page('<p>안녕하세요</p>') });
  const noChrome = async () => {
    throw Object.assign(new Error('Chrome not found at nowhere'), { code: 'FSW_RENDER_NO_CHROME' });
  };
  const r = await runAcceptance(work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'viewports' }, { check: 'command', run: 'node -e "process.exit(3)"' }, { check: 'command', run: 'node -e ""', cwd: 'missing' }]), { openRenderer: noChrome });
  assert.equal(r.ok, false);
  assert.match(r.results[0].detail, /renderer did not start: FSW_RENDER_NO_CHROME/);
  assert.match(r.results[1].detail, /exited 3/);
  assert.match(r.results[2].detail, /directory missing does not exist/);
});

// A throwaway instance from examples/instance with toast and webhook off.
function makeInstance() {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-jobs-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  config.jobs = { maxParallel: 2, model: 'test-model', effort: 'low' };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

// A copywriting job: its acceptance (files and sloplint over copy/*.md) runs without a browser.
function seedJob(ledger, { platform = 'soomgo', priceKRW = 300000 } = {}) {
  const thread = ledger.upsertThread({ platform, externalId: 'th-' + platform, kind: 'message', customer: 'c1', service: 'copywriting', language: 'ko' });
  ledger.addMessage({ threadId: thread.id, direction: 'in', body: '동네 빵집 소개 문구 두 가지가 필요합니다.', externalId: 'm1' });
  ledger.addQuote({ threadId: thread.id, platform, service: 'copywriting', amountKRW: priceKRW, scope: ['소개 문구 2종', '수정 1회'], deliveryDays: 3, status: 'accepted' });
  return ledger.upsertJob({ id: 'job-' + platform, threadId: thread.id, platform, service: 'copywriting', title: '빵집 소개 문구', priceKRW, status: 'ordered' });
}

const noCodex = async () => {
  throw new Error('the model must not be called');
};
const quiet = async () => ({ written: false });

// Writes the given files into the working directory per call, in order.
function fakeCodex(writes) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(opts);
    const files = writes.shift();
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(opts.cwd, rel)), { recursive: true });
      writeFileSync(join(opts.cwd, rel), body);
    }
    return { data: { summary: 'wrote copy', files: Object.keys(files), openQuestions: [] }, durationMs: 5 };
  };
  fn.calls = calls;
  return fn;
}

test('runJob refuses to start without the payment the recipe and platform require', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const soomgo = seedJob(ledger, { platform: 'soomgo' });
  const r = await runJob(soomgo.id, { instance, ledger, runCodex: noCodex, notify: quiet });
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /needs a deposit payment on soomgo/);
  assert.equal(existsSync(join(instance.paths.jobs, soomgo.id, 'brief.md')), false);

  // A payment row with no channel is not evidence of where the money sits.
  ledger.addPayment({ jobId: soomgo.id, kind: 'deposit', amountKRW: 150000, evidence: 'operator said so' });
  assert.equal((await runJob(soomgo.id, { instance, ledger, runCodex: noCodex, notify: quiet })).status, 'refused');

  // 크몽 holds the whole order in escrow, so a partial order does not start the job, nor does a bank transfer.
  const kmong = seedJob(ledger, { platform: 'kmong' });
  ledger.addPayment({ jobId: kmong.id, kind: 'deposit', amountKRW: 150000, channel: 'kmong', evidence: 'order page' });
  const k = await runJob(kmong.id, { instance, ledger, runCodex: noCodex, notify: quiet });
  assert.equal(k.status, 'refused');
  assert.match(k.reason, /needs the full 300000 KRW held in escrow on kmong, has 150000/);
  ledger.addPayment({ jobId: kmong.id, kind: 'full', amountKRW: 150000, channel: 'bank', evidence: 'bank deposit' });
  assert.equal((await runJob(kmong.id, { instance, ledger, runCodex: noCodex, notify: quiet })).status, 'refused');
  assert.equal(ledger.getJob(kmong.id).status, 'ordered');
});

test('runJob writes brief.md, records minutes and retries once with the failed checks', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const job = seedJob(ledger, { platform: 'soomgo' });
  ledger.addPayment({ jobId: job.id, kind: 'deposit', amountKRW: 150000, channel: 'soomgo', evidence: '숨고페이 결제 완료' });
  const codex = fakeCodex([
    { 'copy/variant-a.md': '# 빵집\n\n매일 아침 \u2014 갓 구운 빵.\n', 'copy/variant-b.md': '# 빵집\n\n동네에서 굽는 빵.\n' },
    { 'copy/variant-a.md': '# 빵집\n\n매일 아침, 갓 구운 빵.\n' },
  ]);
  const r = await runJob(job.id, { instance, ledger, runCodex: codex, notify: quiet });
  assert.equal(r.status, 'accepted', JSON.stringify(r.acceptance));
  assert.equal(codex.calls.length, 2);
  const [first, retry] = codex.calls;
  assert.equal(first.sandbox, 'workspace-write');
  assert.equal(first.model, 'test-model');
  assert.equal(first.cwd, join(instance.paths.jobs, job.id, 'work'));
  assert.deepEqual(first.schema.required, ['summary', 'files', 'openQuestions']);
  assert.doesNotMatch(first.prompt, /checks failed/);
  assert.match(first.prompt, /Follow the skill at .*SKILL\.md/);
  assert.match(retry.prompt, /these checks failed:\n- sloplint: copy\/variant-a\.md em_dash/);

  const brief = readFileSync(join(instance.paths.jobs, job.id, 'brief.md'), 'utf8');
  assert.match(brief, /동네 빵집 소개 문구 두 가지가 필요합니다/);
  assert.match(brief, /- 소개 문구 2종/);
  assert.match(brief, /- work\/copy\/variant-a\.md as md/);
  assert.match(brief, /Language of every customer-facing text: ko/);

  const after = ledger.getJob(job.id);
  assert.equal(after.status, 'in_progress');
  assert.ok(after.agentMinutes > 0);
  assert.equal(after.meta.lastRun.turns, 2);
  assert.equal(after.meta.lastRun.ok, true);
});

test('deliveryAllowed needs the full price through an allowed channel', () => {
  const ledger = openLedger(':memory:');
  const job = seedJob(ledger, { platform: 'soomgo' });
  const recipe = loadRecipe('copywriting');
  const soomgo = loadDescriptor('soomgo');
  ledger.addPayment({ jobId: job.id, kind: 'deposit', amountKRW: 150000, channel: 'soomgo', evidence: 'pay 1' });
  assert.equal(deliveryAllowed(job, ledger, soomgo, recipe).ok, false);
  ledger.addPayment({ jobId: job.id, kind: 'balance', amountKRW: 150000, channel: 'bank', evidence: 'transfer' });
  assert.equal(deliveryAllowed(job, ledger, soomgo, recipe).ok, true);
  const kmongJob = seedJob(ledger, { platform: 'kmong' });
  ledger.addPayment({ jobId: kmongJob.id, kind: 'full', amountKRW: 300000, channel: 'bank', evidence: 'transfer' });
  assert.equal(deliveryAllowed(kmongJob, ledger, loadDescriptor('kmong'), recipe).ok, false);
});

test('fsw job check reports acceptance and the delivery gate without calling a model', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const job = seedJob(ledger, { platform: 'soomgo' });
  const work = join(instance.paths.jobs, job.id, 'work');
  mkdirSync(join(work, 'copy'), { recursive: true });
  writeFileSync(join(work, 'copy', 'variant-a.md'), '# 빵집\n\n매일 아침 굽습니다.\n');
  const lines = [];
  const code = await runCli(['check', job.id], { instance, ledger, log: (l) => lines.push(l) });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /FAIL files .*copy\/variant-b\.md: no file/);
  assert.match(lines.join('\n'), /delivery not allowed: needs the full 300000 KRW held in escrow on soomgo, has 0/);
});

