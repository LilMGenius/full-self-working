import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { imageSize, runAcceptance } from '../src/work/accept.mjs';
import { buildBrief, checkJob, runJob } from '../src/work/run.mjs';
import { startBlocker, startDue } from '../src/work/start.mjs';
import { listRecipes, loadRecipe, SKILL_SOURCES, serviceCatalog, validateRecipe } from '../src/work/recipe.mjs';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { codexArgs } from '../src/brain/codex.mjs';
import { deliveryAllowed, startAllowed } from '../src/deal/index.mjs';
import { openRenderer } from '../src/render/html2png.mjs';
import { tempDir } from './tmp.mjs';

// runJob resolves every skill its recipe names (resolveSkill); this home holds a stub of each, so the jobs run
// on a machine without the operator's skills, such as CI.
const skillHome = tempDir('fsw-skill-home-');
for (const name of new Set(listRecipes().flatMap((id) => loadRecipe(id).steps.filter((s) => s.skill).map((s) => s.skill)))) {
  const [ns, skill] = name.includes(':') ? name.split(':') : [null, name];
  const src = ns ? SKILL_SOURCES[ns] : { kind: 'agents' };
  const folder = (src.strip && skill.startsWith(src.strip) ? skill.slice(src.strip.length) : skill).toLowerCase();
  const dir = src.kind === 'agents' ? join(skillHome, '.agents', 'skills', folder) : join(skillHome, '.codex', 'plugins', 'cache', ...src.path, '1.0.0', 'skills', folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: ' + skill + '\n---\n');
}
process.env.FSW_SKILL_HOME = skillHome;
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

// The viewports tests share one headless Chrome, closed once after the file. A close waits for the
// browser's real exit, which under two concurrent suites took 18 to 50 s, so a close per acceptance run
// put three of those waits inside two test budgets; each acceptance run's own close is left to this one.
let renderer = null;
const sharedRenderer = async () => {
  renderer ??= openRenderer();
  return { ...(await renderer), close: async () => {} };
};
after(async () => {
  if (renderer) await (await renderer).close();
});

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
  const r = await runAcceptance(work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'viewports', widths: [390, 1440] }]), { openRenderer: sharedRenderer });
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
  const r = await runAcceptance(work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'viewports', widths: [390] }]), { openRenderer: sharedRenderer });
  assert.equal(r.ok, false);
  assert.match(r.results[0].detail, /site\/index\.html@390: words split across lines 영업시간/);
  const wide = workDir({ 'site/index.html': narrow.replace('40px', '120px') });
  const ok = await runAcceptance(wide.work, recipe([{ path: 'site/index.html', format: 'html' }], [{ check: 'viewports', widths: [390] }]), { openRenderer: sharedRenderer });
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
      ledger, notify: quiet, runCodex: noCodex,
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
  await assert.rejects(runJob('j1', { runCodex: noCodex, startAllowed: () => ({ ok: true }) }), { code: 'FSW_JOB_SEAM', message: /ctx\.report/ });
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

test('a recipe with network true hands runCodex network true, and one without hands false', async () => {
  const networkTrue = tempDir('fsw-recipes-');
  writeFileSync(join(networkTrue, 'copywriting.json'), JSON.stringify({ ...loadRecipe('copywriting'), network: true }));
  const handed = [];
  for (const recipeDir of [networkTrue, undefined]) {
    const instance = makeInstance();
    const ledger = openLedger(':memory:');
    const job = seedJob(ledger, { platform: 'soomgo' });
    ledger.addPayment({ jobId: job.id, kind: 'deposit', amountKRW: 150000, channel: 'soomgo', evidence: '숨고페이 결제 완료' });
    const codex = fakeCodex([{ 'copy/variant-a.md': '# 빵집\n\n매일 아침 굽습니다.\n', 'copy/variant-b.md': '# 빵집\n\n동네 빵입니다.\n' }]);
    const { ctx } = seam(ledger, { instance, recipeDir, runCodex: codex, reviewDeliverables: async () => ({ verdict: 'pass', findings: [] }) });
    const r = await runJob(job.id, ctx);
    assert.equal(r.status, 'accepted', JSON.stringify(r.acceptance));
    handed.push(codex.calls.map((c) => [c.sandbox, c.network]));
  }
  assert.deepEqual(handed, [[['workspace-write', true]], [['workspace-write', false]]]);
  const errors = (recipe) => validateRecipe(recipe, { file: 'x.json' }).filter((e) => /network|executor/.test(e));
  assert.deepEqual(errors({ ...loadRecipe('copywriting'), network: 'yes' }), ['x.json: network: must be true or false']);
  assert.deepEqual(errors({ ...loadRecipe('copywriting'), executor: 'codex' }), ['x.json: executor: unknown key']);
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

test('codexArgs puts the network flag only on a network workspace-write turn', () => {
  const base = { schemaFile: 's.json', outFile: 'o.txt', cwd: 'C:/w', proxyUrl: 'http://127.0.0.1:10100/v1', platform: 'win32' };
  const flag = 'sandbox_workspace_write.network_access=true';
  const net = codexArgs({ ...base, sandbox: 'workspace-write', network: true });
  assert.equal(net[net.indexOf(flag) - 1], '-c');
  assert.ok(!codexArgs({ ...base, sandbox: 'workspace-write' }).includes(flag));
  assert.ok(!codexArgs({ ...base, sandbox: 'read-only', network: true }).includes(flag));
});

// U7.7: the review of accepted work runs inside the job slot, before release(), and can neither fail an
// accepted run nor pass one it could not review.
function reviewedJob(jobs = {}) {
  const instance = makeInstance();
  instance.config.jobs = { ...instance.config.jobs, model: 'cpa/claude-opus-5-5', ...jobs };
  const ledger = openLedger(':memory:');
  const job = seedJob(ledger, { platform: 'soomgo' });
  ledger.addPayment({ jobId: job.id, kind: 'deposit', amountKRW: 150000, channel: 'soomgo', evidence: '숨고페이 결제 완료' });
  const codex = fakeCodex([{ 'copy/variant-a.md': '# 빵집\n\n매일 아침 굽습니다.\n', 'copy/variant-b.md': '# 빵집\n\n동네 빵입니다.\n' }]);
  return { instance, ledger, job, codex, lock: join(instance.paths.jobs, '.running', job.id + '.lock'), runLog: join(instance.paths.jobs, job.id, 'qa', 'run.json') };
}

test('accepted work is reviewed while the job slot is held, and the run log and run_accepted carry the review', async () => {
  const j = reviewedJob();
  const seen = [];
  const verdict = { verdict: 'pass', findings: [], model: 'gpt-6.1-sol', builderModel: 'cpa/claude-opus-5-5', files: 2, hash: 'h', durationMs: 1, at: '2026-10-27T00:00:00.000Z' };
  const reviewDeliverables = async (o) => (seen.push({ slotHeld: existsSync(j.lock), builderModel: o.builderModel, model: o.model, language: o.language, work: o.paths.work, runCodex: o.runCodex === j.codex, deliverables: o.recipe.deliverables.length }), verdict);
  const { ctx, signals } = seam(j.ledger, { instance: j.instance, runCodex: j.codex, reviewDeliverables });
  const r = await runJob(j.job.id, ctx);
  assert.equal(r.status, 'accepted', JSON.stringify(r.acceptance));
  assert.deepEqual(seen, [{ slotHeld: true, builderModel: 'cpa/claude-opus-5-5', model: 'gpt-6.1-sol', language: 'ko', work: join(j.instance.paths.jobs, j.job.id, 'work'), runCodex: true, deliverables: 2 }]);
  assert.equal(existsSync(j.lock), false);
  assert.deepEqual(JSON.parse(readFileSync(j.runLog, 'utf8')).review, verdict);
  assert.deepEqual(signals.at(-1).evidence.review, verdict);
  assert.equal(signals.at(-1).type, 'run_accepted');
});

test('a review that throws is verdict error and the run stays accepted; jobs.review.model names the reviewer', async () => {
  const j = reviewedJob({ review: { enabled: true, model: 'anthropic/claude-sonnet-5-5' } });
  const models = [];
  const reviewDeliverables = async (o) => {
    models.push(o.model);
    throw Object.assign(new Error('proxy refused'), { code: 'FSW_CODEX_EXIT' });
  };
  const { ctx, signals } = seam(j.ledger, { instance: j.instance, runCodex: j.codex, reviewDeliverables });
  const r = await runJob(j.job.id, ctx);
  assert.equal(r.status, 'accepted');
  assert.deepEqual(models, ['anthropic/claude-sonnet-5-5']);
  const review = signals.at(-1).evidence.review;
  assert.deepEqual([signals.at(-1).type, review.verdict], ['run_accepted', 'error']);
  assert.match(review.findings[0].detail, /^FSW_CODEX_EXIT proxy refused/);
});

test('jobs.review.enabled false runs no review, and a run that fails acceptance is never reviewed', async () => {
  const off = reviewedJob({ review: { enabled: false, model: null } });
  let called = 0;
  const reviewDeliverables = async () => (called++, { verdict: 'pass', findings: [] });
  const a = seam(off.ledger, { instance: off.instance, runCodex: off.codex, reviewDeliverables });
  assert.equal((await runJob(off.job.id, a.ctx)).status, 'accepted');
  assert.equal('review' in a.signals.at(-1).evidence, false);
  const bad = reviewedJob();
  const broken = fakeCodex([{ 'copy/variant-a.md': '# 빵집\n' }, { 'copy/variant-a.md': '# 빵집\n' }]);
  const b = seam(bad.ledger, { instance: bad.instance, runCodex: broken, reviewDeliverables });
  assert.equal((await runJob(bad.job.id, b.ctx)).status, 'failed');
  assert.equal(called, 0);
  assert.equal(JSON.parse(readFileSync(bad.runLog, 'utf8')).review, null);
});

test('without a stub the real review reaches the executor read-only on the other family after the writing turn', async () => {
  const j = reviewedJob();
  const calls = [];
  const runCodex = async (opts) => {
    calls.push({ sandbox: opts.sandbox, model: opts.model });
    if (opts.sandbox === 'read-only') return { data: { verdict: 'fail', findings: [{ severity: 'major', file: 'copy/variant-b.md', detail: 'too short' }] }, durationMs: 2 };
    return j.codex(opts);
  };
  const { ctx, signals } = seam(j.ledger, { instance: j.instance, runCodex });
  assert.equal((await runJob(j.job.id, ctx)).status, 'accepted');
  assert.deepEqual(calls, [{ sandbox: 'workspace-write', model: 'cpa/claude-opus-5-5' }, { sandbox: 'read-only', model: 'gpt-6.1-sol' }]);
  assert.deepEqual([signals.at(-1).evidence.review.verdict, signals.at(-1).evidence.review.findings.length], ['fail', 1]);
});
