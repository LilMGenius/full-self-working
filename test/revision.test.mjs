import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { INCLUDED_REVISIONS, noteRevision, startRevisions } from '../src/orders/revision.mjs';
import { buildBrief } from '../src/jobs/run.mjs';
import { processThread } from '../src/pipeline/thread.mjs';
import { loadRecipe, serviceCatalog } from '../src/jobs/recipe.mjs';

function makeInstance() {
  const dir = mkdtempSync(join(tmpdir(), 'fsw-rev-'));
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

function delivered() {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  ledger.upsertJob({ id: 'j1', threadId: thread.id, platform: 'soomgo', service: 'landing_page_web', status: 'delivered', deliveredAt: '2026-10-25T01:00:00Z', meta: { scope: ['one page'] } });
  return { instance, ledger, thread };
}

const notes = () => {
  const fn = async (instance, n) => fn.calls.push(n);
  fn.calls = [];
  return fn;
};

test('a revision request on delivered work reopens the job once and becomes a learning case', async () => {
  const { instance, ledger, thread } = delivered();
  const notify = notes();
  const args = { instance, ledger, platform: 'soomgo', thread, decision: { intent: 'revision' }, text: '메뉴 사진을 더 크게 바꿔 주세요.', notify };
  assert.deepEqual(await noteRevision(args), { action: 'reopened', jobId: 'j1', round: 1 });
  const job = ledger.getJob('j1');
  assert.equal(job.status, 'revision');
  assert.equal(job.meta.revisions[0].text, '메뉴 사진을 더 크게 바꿔 주세요.');
  const cases = readFileSync(join(instance.paths.lessons, 'cases.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(cases.map((c) => [c.kind, c.jobId]), [['revision_request', 'j1']]);
  assert.equal(await noteRevision({ ...args, decision: { intent: 'inquiry' } }), null);
});

test('a repeat of the same request changes nothing, and a round beyond the included one goes to the operator', async () => {
  const { instance, ledger, thread } = delivered();
  const notify = notes();
  const base = { instance, ledger, platform: 'soomgo', thread, decision: { intent: 'revision' }, notify };
  await noteRevision({ ...base, text: '로고를 왼쪽으로 옮겨 주세요.' });
  ledger.upsertJob({ id: 'j1', status: 'delivered' });
  assert.equal((await noteRevision({ ...base, text: '로고를 왼쪽으로 옮겨 주세요.' })).action, 'duplicate');
  const r = await noteRevision({ ...base, text: '이번엔 색을 전부 바꿔 주세요.' });
  assert.deepEqual([r.action, r.round, INCLUDED_REVISIONS], ['extra', 2, 1]);
  assert.equal(ledger.getJob('j1').status, 'delivered');
  assert.equal(notify.calls.length, 1);
  assert.match(notify.calls[0].body, /이번엔 색을 전부 바꿔 주세요/);
});

test('a reopened job starts once per round within jobs.maxParallel', async () => {
  const { instance, ledger, thread } = delivered();
  await noteRevision({ instance, ledger, platform: 'soomgo', thread, decision: { intent: 'revision' }, text: '제목을 바꿔 주세요.', notify: notes() });
  const spawned = [];
  const spawnJob = (inst, id) => (spawned.push(id), { pid: 4242, log: 'runner.log' });
  await startRevisions({ instance, ledger, spawnJob, alive: () => true, notify: notes() });
  await startRevisions({ instance, ledger, spawnJob, alive: () => true, notify: notes() });
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

test('the inbox pipeline reopens a delivered job when the customer asks for changes', async () => {
  const { instance, ledger, thread } = delivered();
  const adapter = { readThread: async (id) => ({ id, messages: [{ direction: 'out', text: '완성본 보내드립니다.', externalId: 'o1' }, { direction: 'in', text: '버튼 색만 파란색으로 바꿔 주세요.', externalId: 'i1' }] }) };
  const decide = async () => ({ action: 'reply', modelCalls: 1, decision: { intent: 'revision', service: 'landing_page_web', language: 'ko', reply: '반영해서 다시 보내드리겠습니다.', quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [] }, item: { kind: 'message' }, gate: { ok: true, violations: [], warnings: [] }, priceRow: null });
  await processThread({ platform: 'soomgo', threadRef: { id: 'c1', unread: false, at: new Date().toISOString() }, adapter, ledger, instance, descriptor: loadDescriptor('soomgo'), mode: 'draft', decide });
  const job = ledger.getJob('j1');
  assert.equal(job.status, 'revision');
  assert.match(job.meta.revisions[0].text, /버튼 색만 파란색으로/);
  assert.equal(existsSync(join(instance.paths.lessons, 'cases.jsonl')), true);
});
