import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { imageSize, runAcceptance } from '../src/work/accept.mjs';
import { buildBrief, checkJob, runJob } from '../src/work/run.mjs';
import { startBlocker, startDue } from '../src/work/start.mjs';
import { loadRecipe, serviceCatalog, validateRecipe } from '../src/work/recipe.mjs';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { codexArgs } from '../src/brain/codex.mjs';
import { parseJobAnswer, parseJwcStream } from '../src/brain/jwc.mjs';
import { deliveryAllowed, startAllowed } from '../src/deal/index.mjs';
import { tempDir } from './tmp.mjs';
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
  const job = tempDir('fsw-accept-');
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


test('viewports fails a short label that breaks mid-word in a narrow column', { timeout: 120000 }, async () => {
  const narrow = page('<dl class="row"><dt>영업시간</dt><dd>화요일부터 일요일</dd></dl>', '.row{display:grid;grid-template-columns:40px 1fr;font-size:18px}');
  const { work } = workDir({ 'site/index.html': narrow });
  const r = await runAcceptance(work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'viewports', widths: [390] }]));
  assert.equal(r.ok, false);
  assert.match(r.results[0].detail, /site\/index\.html@390: words split across lines 영업시간/);
  const wide = workDir({ 'site/index.html': narrow.replace('40px', '120px') });
  const ok = await runAcceptance(wide.work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'viewports', widths: [390] }]));
  assert.equal(ok.ok, true, ok.results[0].detail);
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
  const dir = tempDir('fsw-jobs-');
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


// The seam a job child gets from src/loop/job.mjs, built here from the deal levels with a report door that
// records every signal, and a ledger whose job status writes inside work throw.
function seam(ledger, over = {}) {
  const signals = [];
  const descriptorOf = (job) => loadDescriptor(job.platform);
  return {
    signals,
    ctx: {
      ledger, notify: quiet, runCodex: noCodex, runJwc: noCodex, jwcModel: 'test-jwc',
      startAllowed: (job, recipe) => startAllowed(job, ledger, descriptorOf(job), recipe),
      deliveryAllowed: (job, recipe) => deliveryAllowed(job, ledger, descriptorOf(job), recipe),
      report: async (s) => signals.push(s),
      ...over,
    },
  };
}
function noStatusWrites(ledger) {
  const upsert = ledger.upsertJob;
  ledger.upsertJob = (job) => {
    if ('status' in job) throw new Error('work wrote jobs.status ' + job.status);
    return upsert(job);
  };
  return () => (ledger.upsertJob = upsert);
}

test('runJob without its seam throws FSW_JOB_SEAM before reading anything', async () => {
  await assert.rejects(runJob('j1', {}), { code: 'FSW_JOB_SEAM' });
  await assert.rejects(runJob('j1', { runCodex: noCodex, runJwc: noCodex, startAllowed: () => ({ ok: true }) }), { code: 'FSW_JOB_SEAM', message: /ctx\.report/ });
});

test('runJob refuses to start without the payment the recipe and platform require', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const soomgo = seedJob(ledger, { platform: 'soomgo' });
  const { ctx, signals } = seam(ledger, { instance });
  const r = await runJob(soomgo.id, ctx);
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /needs a deposit payment on soomgo/);
  assert.equal(existsSync(join(instance.paths.jobs, soomgo.id, 'brief.md')), false);
  // A payment row with no channel is not evidence of where the money sits.
  ledger.addPayment({ jobId: soomgo.id, kind: 'deposit', amountKRW: 150000, evidence: 'operator said so' });
  assert.equal((await runJob(soomgo.id, ctx)).status, 'refused');
  // 크몽 holds the whole order in escrow, so a partial order does not start the job, nor does a bank transfer.
  const kmong = seedJob(ledger, { platform: 'kmong' });
  ledger.addPayment({ jobId: kmong.id, kind: 'deposit', amountKRW: 150000, channel: 'kmong', evidence: 'order page' });
  const k = await runJob(kmong.id, ctx);
  assert.equal(k.status, 'refused');
  assert.match(k.reason, /needs the full 300000 KRW held in escrow on kmong, has 150000/);
  ledger.addPayment({ jobId: kmong.id, kind: 'full', amountKRW: 150000, channel: 'bank', evidence: 'bank deposit' });
  assert.equal((await runJob(kmong.id, ctx)).status, 'refused');
  assert.deepEqual(signals, []);
});

test('runJob writes brief.md, retries once with the failed checks and reports run_started then run_accepted without writing a status', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const job = seedJob(ledger, { platform: 'soomgo' });
  ledger.addPayment({ jobId: job.id, kind: 'deposit', amountKRW: 150000, channel: 'soomgo', evidence: '숨고페이 결제 완료' });
  const codex = fakeCodex([
    { 'copy/variant-a.md': '# 빵집\n\n매일 아침 \u2014 갓 구운 빵.\n', 'copy/variant-b.md': '# 빵집\n\n동네에서 굽는 빵.\n' },
    { 'copy/variant-a.md': '# 빵집\n\n매일 아침, 갓 구운 빵.\n' },
  ]);
  const restore = noStatusWrites(ledger);
  const { ctx, signals } = seam(ledger, { instance, runCodex: codex });
  const r = await runJob(job.id, ctx);
  restore();
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
  assert.deepEqual(signals.map((s) => s.type), ['run_started', 'run_accepted']);
  const done = signals[1].evidence;
  assert.deepEqual([done.lastRun.ok, done.lastRun.turns, done.minutes > 0], [true, 2, true]);
  assert.deepEqual(done.files.map((f) => f.split(/[\\/]/).pop()).sort(), ['variant-a.md', 'variant-b.md']);
  assert.equal(ledger.getJob(job.id).status, 'ordered');
});

test('the brief of a hired soomgo chat reads the request text and the quote kept on the request thread', () => {
  const ledger = openLedger(':memory:');
  const req = ledger.upsertThread({ platform: 'soomgo', externalId: 'r1', kind: 'request' });
  ledger.addMessage({ threadId: req.id, direction: 'in', body: '빵집 소개 문구가 필요합니다.', externalId: 'request' });
  const q = ledger.addQuote({ threadId: req.id, platform: 'soomgo', service: 'copywriting', amountKRW: 100000, scope: ['소개 문구 2종'], status: 'accepted' });
  const chat = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  const job = ledger.upsertJob({ id: 'soomgo-r1', threadId: chat.id, platform: 'soomgo', service: 'copywriting', priceKRW: 100000, status: 'ordered', meta: { requestThreadId: req.id, quoteId: q.id } });
  const messages = [...ledger.threadMessages(req.id), ...ledger.threadMessages(chat.id)];
  const brief = buildBrief({ job, thread: chat, messages, quote: ledger.getQuote(q.id), recipe: loadRecipe('copywriting'), service: serviceCatalog().copywriting });
  assert.match(brief, /빵집 소개 문구가 필요합니다/);
  assert.match(brief, /- 소개 문구 2종/);
});

test('checkJob reports acceptance and the delivery gate it is handed, without a model', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const job = seedJob(ledger, { platform: 'soomgo' });
  const work = join(instance.paths.jobs, job.id, 'work');
  mkdirSync(join(work, 'copy'), { recursive: true });
  writeFileSync(join(work, 'copy', 'variant-a.md'), '# 빵집\n\n매일 아침 굽습니다.\n');
  const { ctx } = seam(ledger, { instance });
  const r = await checkJob(job.id, ctx);
  assert.equal(r.acceptance.ok, false);
  assert.match(r.acceptance.results.find((x) => !x.ok).detail, /copy\/variant-b\.md/);
  assert.match(r.delivery.reason, /needs the full 300000 KRW held in escrow on soomgo, has 0/);
  assert.equal((await checkJob(job.id, { instance, ledger })).delivery, null);
});

test('a recipe with executor jwc runs its turns through runJwc and the seam model, never codex', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const job = seedJob(ledger, { platform: 'soomgo' });
  ledger.addPayment({ jobId: job.id, kind: 'deposit', amountKRW: 150000, channel: 'soomgo', evidence: '숨고페이 결제 완료' });
  const dir = tempDir('fsw-recipes-');
  writeFileSync(join(dir, 'copywriting.json'), JSON.stringify({ ...loadRecipe('copywriting'), executor: 'jwc' }));
  const jwc = fakeCodex([{ 'copy/variant-a.md': '# 빵집\n\n매일 아침 굽습니다.\n', 'copy/variant-b.md': '# 빵집\n\n동네 빵입니다.\n' }]);
  const { ctx } = seam(ledger, { instance, recipeDir: dir, runJwc: jwc });
  const r = await runJob(job.id, ctx);
  assert.equal(r.status, 'accepted', JSON.stringify(r.acceptance));
  assert.equal(jwc.calls.length, 1);
  assert.equal(jwc.calls[0].cwd, join(instance.paths.jobs, job.id, 'work'));
  assert.equal(jwc.calls[0].model, 'test-jwc');
  assert.match(jwc.calls[0].prompt, /json code block/);
  assert.equal(r.turns[0].executor, 'jwc');
  assert.deepEqual(validateRecipe({ ...loadRecipe('copywriting'), executor: 'claude' }, { file: 'x.json' }).filter((e) => e.includes('executor')), ['x.json: executor: must be one of codex, jwc']);
});

test('startDue starts a paid job once within jobs.maxParallel, blocks an unpaid one and never respawns', async () => {
  const instance = makeInstance();
  instance.config.jobs.maxParallel = 1;
  const ledger = openLedger(':memory:');
  const allow = (job, recipe) => startAllowed(job, ledger, loadDescriptor(job.platform), recipe);
  const ordered = (id) => ledger.upsertJob({ ...seedJob(ledger, { platform: 'soomgo' }), id, meta: { scope: ['소개 문구 2종'] } });
  const unpaid = ordered('u1');
  const a = ordered('p1');
  const b = ordered('p2');
  for (const j of [a, b]) ledger.addPayment({ jobId: j.id, kind: 'deposit', amountKRW: 150000, channel: 'soomgo', evidence: 'pay' });
  ledger.upsertJob({ id: 'job-soomgo', status: 'lost' });
  const spawned = [];
  const live = new Set();
  const spawnJob = (_i, id) => { spawned.push(id); live.add(1000 + spawned.length); return { pid: 1000 + spawned.length, log: 'runner.log' }; };
  const alive = (pid) => live.has(pid);
  const first = await startDue({ instance, ledger, startAllowed: allow, spawnJob, alive, notify: quiet });
  assert.deepEqual(first.started, [a.id]);
  assert.deepEqual(first.blocked.map((x) => x.id), [unpaid.id]);
  assert.match(first.blocked[0].reason, /deposit/);
  assert.deepEqual(first.waiting.map((x) => x.id), [b.id]);
  const second = await startDue({ instance, ledger, startAllowed: allow, spawnJob, alive, notify: quiet });
  assert.deepEqual([second.started, spawned], [[], [a.id]]);
  await assert.rejects(startDue({ instance, ledger, spawnJob, alive, notify: quiet }), { code: 'FSW_JOB_SEAM' });
});

test('an operator-delivered job never starts a run', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'l1', kind: 'message' });
  const job = ledger.upsertJob({ id: 'l1', threadId: thread.id, platform: 'soomgo', service: 'lesson_tutoring', priceKRW: 100000, status: 'ordered', meta: { scope: ['60분 수업'] } });
  ledger.addPayment({ jobId: job.id, kind: 'deposit', amountKRW: 50000, channel: 'soomgo', evidence: 'pay' });
  const allow = () => ({ ok: true });
  assert.equal(startBlocker(job, ledger, { startAllowed: allow }), 'delivered by the operator, so no job run starts');
  const spawned = [];
  const r = await startDue({ instance, ledger, startAllowed: allow, spawnJob: (_i, id) => (spawned.push(id), { pid: 1, log: 'x' }), alive: () => true, notify: quiet });
  assert.deepEqual([spawned, r.blocked.map((x) => x.id)], [[], ['l1']]);
});

test('a revision job starts once per round', async () => {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  ledger.upsertJob({ id: 'j1', threadId: thread.id, platform: 'soomgo', service: 'landing_page_web', status: 'revision', meta: { scope: ['one page'], revisions: [{ at: '2026-10-25T02:00:00Z', text: '제목을 바꿔 주세요.', round: 1, extra: false }] } });
  const spawned = [];
  const spawnJob = (_i, id) => (spawned.push(id), { pid: 4242, log: 'runner.log' });
  const args = { instance, ledger, startAllowed: () => ({ ok: true }), spawnJob, alive: () => true, notify: quiet };
  await startDue(args);
  await startDue(args);
  assert.deepEqual(spawned, ['j1']);
  assert.equal(ledger.getJob('j1').meta.revisionRunner.round, 1);
});

test('the revision run reads the requests in its brief', () => {
  const recipe = loadRecipe('landing_page_web');
  const service = serviceCatalog().landing_page_web;
  const job = { id: 'j1', platform: 'soomgo', service: 'landing_page_web', meta: { scope: ['one page'], revisions: [{ at: '2026-10-25T02:00:00Z', text: '메뉴 사진을 더 크게', round: 1, extra: false }, { at: '2026-10-26T02:00:00Z', text: '무료 추가 수정', round: 2, extra: true }] } };
  const brief = buildBrief({ job, thread: null, messages: [], quote: null, recipe, service });
  assert.match(brief, /## Revision requests[\s\S]*Round 1 \(2026-10-25\): 메뉴 사진을 더 크게/);
  assert.doesNotMatch(brief, /무료 추가 수정/);
});

test('a writing codex turn on Windows names the sandbox the ignored user config would have set', () => {
  const base = { schemaFile: 's.json', outFile: 'o.txt', cwd: 'C:/w', proxyUrl: 'http://127.0.0.1:10100/v1', platform: 'win32' };
  const write = codexArgs({ ...base, sandbox: 'workspace-write' });
  assert.deepEqual(write.slice(write.indexOf('-s'), write.indexOf('-s') + 2), ['-s', 'workspace-write']);
  assert.ok(write.includes('windows.sandbox="elevated"'));
  assert.ok(!codexArgs({ ...base, sandbox: 'read-only' }).some((a) => a.startsWith('windows.')));
  assert.ok(!codexArgs({ ...base, sandbox: 'workspace-write', platform: 'linux' }).some((a) => a.startsWith('windows.')));
});


test('a jwc turn that exits 0 after a model error is a failure, and a stop turn yields its JSON answer', () => {
  const end = (msg) => ['{"type":"session"}', JSON.stringify({ type: 'agent_end', messages: [{ role: 'user', content: [] }, { role: 'assistant', ...msg }] })].join('\n');
  assert.throws(() => parseJwcStream(end({ content: [], stopReason: 'error', errorMessage: '404 The model codex-mini-latest does not exist' })), { code: 'FSW_JWC_MODEL', message: /404 The model codex-mini-latest/ });
  assert.throws(() => parseJwcStream('{"type":"turn_start"}'), { code: 'FSW_JWC_NO_END' });
  const text = parseJwcStream(end({ stopReason: 'stop', content: [{ type: 'text', text: 'Done.\n```json\n{"summary":"scraper","files":["scraper/index.js"],"openQuestions":[]}\n```' }] }));
  assert.deepEqual(parseJobAnswer(text), { summary: 'scraper', files: ['scraper/index.js'], openQuestions: [] });
  assert.throws(() => parseJobAnswer('I wrote the scraper.'), { code: 'FSW_JWC_BAD_JSON' });
});

