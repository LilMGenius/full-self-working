// An interrupted send is settled from the page and never sent again (003 Outbox; docs/NEGATIVE-CORPUS.md row 42):
// a real child process drains one row and is killed between the click and the receipt, and the next drain
// reads the thread back instead of calling send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { drain, plan } from '../src/outbox/index.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { authorize } from '../src/policy/authorize.mjs';
import { scriptedSurface } from './helpers/surface.mjs';
import { tempDir } from './tmp.mjs';

const NOON = new Date('2026-10-20T12:00:00+09:00');
const TEXT = '요청하신 구성으로 진행 가능합니다. 원하시는 일정을 알려 주세요.';
const decision = { intent: 'inquiry', service: 'landing_page_web', language: 'ko', reply: TEXT, quote: null, needsOperator: false, operatorReason: null, confidence: 0.9, claimsUsed: [], statedBudgetKRW: null };
const src = (rel) => JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'src', rel)).href);
// The process the test kills: it drains one kmong row on a ledger file with a surface whose send writes a marker
// file (the click happened) and then never answers, so the process dies between the click and the receipt. It is
// written into the test's temp folder, since node --test would run any .mjs under test/ as a test file.
const CHILD_SOURCE = [
  "import { writeFileSync } from 'node:fs';",
  'import { loadInstance } from ' + src('core/instance.mjs') + ';',
  'import { openLedger } from ' + src('core/ledger.mjs') + ';',
  'import { drain } from ' + src('outbox/index.mjs') + ';',
  'import { loadDescriptor } from ' + src('platforms/registry.mjs') + ';',
  'import { authorize } from ' + src('policy/authorize.mjs') + ';',
  'const [ledgerFile, instanceDir, marker] = process.argv.slice(2);',
  'const surface = {',
  "  platform: 'kmong',",
  '  read: async () => ({ messages: [], notices: [] }),',
  "  send: async () => (writeFileSync(marker, 'clicked'), setInterval(() => {}, 60_000), new Promise(() => {})),",
  '  stop: async () => {},',
  '};',
  "await drain(openLedger(ledgerFile), { platform: 'kmong', surface, authorize, ctx: { descriptor: loadDescriptor('kmong'), instance: loadInstance({ dir: instanceDir }), mode: 'auto', now: new Date('2026-10-20T12:00:00+09:00'), notify: async () => ({}) } });",
].join('\n');

function instanceDir() {
  const dir = tempDir('fsw-crash-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

const waitFor = async (file, child, ms = 30_000) => {
  const by = Date.now() + ms;
  while (!existsSync(file)) {
    if (child.exitCode !== null) throw new Error('the child exited ' + child.exitCode + ' before the click');
    if (Date.now() > by) throw new Error('no click within ' + ms + ' ms');
    await new Promise((r) => setTimeout(r, 50));
  }
};

// Plans one kmong message on a ledger file, lets a child drain it until the click, and kills the child there.
async function crashedDrain() {
  const dir = instanceDir();
  const file = join(dir, 'ledger.sqlite');
  const marker = join(dir, 'clicked');
  const childFile = join(dir, 'crash-child.mjs');
  writeFileSync(childFile, CHILD_SOURCE);
  const ledger = openLedger(file);
  const thread = ledger.upsertThread({ platform: 'kmong', externalId: 'c1', kind: 'message' });
  const row = plan(ledger, { platform: 'kmong', threadId: thread.id, kind: 'message', payload: { text: TEXT, decision } });
  ledger.close();
  const child = spawn(process.execPath, [childFile, file, dir, marker], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  try {
    await waitFor(marker, child);
  } catch (err) {
    child.kill('SIGKILL');
    throw new Error(err.message + ': ' + stderr);
  }
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  const reopened = openLedger(file);
  return { dir, ledger: reopened, row: reopened.getOutbox(row.id), thread };
}

const drainAgain = (s, surface, notes) => drain(s.ledger, { platform: 'kmong', surface, authorize, ctx: { descriptor: loadDescriptor('kmong'), instance: loadInstance({ dir: s.dir }), mode: 'auto', now: NOON, notify: async (_i, n) => (notes.push(n), {}) } });

test('a drain killed after the click leaves the row sending; the page showing the text settles it observed without a second send', async () => {
  const s = await crashedDrain();
  assert.equal(s.row.status, 'sending');
  const surface = scriptedSurface({ platform: 'kmong', threads: { c1: { messages: [{ direction: 'out', text: TEXT, at: new Date().toISOString(), externalId: 'm9' }], notices: [] } } });
  const notes = [];
  const out = await drainAgain(s, surface, notes);
  assert.deepEqual(out.map((x) => [x.id, x.action, x.reconciled]), [[s.row.id, 'observed', true]]);
  assert.equal(s.ledger.getOutbox(s.row.id).status, 'observed');
  assert.deepEqual(s.ledger.threadMessages(s.thread.id).filter((m) => m.direction === 'out').map((m) => [m.body, m.externalId]), [[TEXT, 'm9']]);
  assert.equal(surface.count('send'), 0);
  s.ledger.close();
});

test('a drain killed after the click whose text is not on the page goes unobserved for the operator, never resent', async () => {
  const s = await crashedDrain();
  assert.equal(s.row.status, 'sending');
  const surface = scriptedSurface({ platform: 'kmong', threads: { c1: { messages: [], notices: [] } } });
  const notes = [];
  const out = await drainAgain(s, surface, notes);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[s.row.id, 'unobserved']]);
  assert.equal(s.ledger.getOutbox(s.row.id).status, 'unobserved');
  assert.equal(s.ledger.threadMessages(s.thread.id).filter((m) => m.direction === 'out').length, 0);
  assert.equal(surface.count('send'), 0);
  assert.deepEqual(notes.map((n) => n.dedupeKey), ['outbox-unobserved:' + s.row.id]);
  // A later drain leaves the unobserved row to the operator.
  assert.deepEqual(await drainAgain(s, surface, notes), []);
  assert.equal(surface.count('send'), 0);
  s.ledger.close();
});

test('a read-back that fails after the kill keeps the row sending and tells the operator once, with no send', async () => {
  const s = await crashedDrain();
  const surface = scriptedSurface({ platform: 'kmong', threads: { c1: new Error('the page did not load') } });
  const notes = [];
  const out = await drainAgain(s, surface, notes);
  assert.deepEqual(out.map((x) => [x.id, x.action]), [[s.row.id, 'reconcile_failed']]);
  assert.equal(s.ledger.getOutbox(s.row.id).status, 'sending');
  assert.equal(surface.count('send'), 0);
  assert.deepEqual(notes.map((n) => n.dedupeKey), ['outbox-reconcile:' + s.row.id]);
  s.ledger.close();
});
