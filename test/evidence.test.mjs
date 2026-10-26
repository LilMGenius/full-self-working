// fsw evidence first-outbound (060 U6.4): the live criterion reads only sends the surface read back on
// the page, from the newest takeover on, and writes ids and times without customer text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exampleDir, loadInstance, repoRoot } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { plan, setStatus } from '../src/outbox/index.mjs';
import { newestTakeover, run } from '../src/cli/evidence.mjs';
import { tempDir } from './tmp.mjs';

const TEXT = '안녕하세요 고객님, 견적 드립니다';

// The ledger file stays locked on Windows while it is open, so each test closes it before the temp
// directory is removed.
function setup(t) {
  const dir = tempDir('fsw-evidence-');
  for (const f of ['profile.json', 'business.json', 'config.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const instance = loadInstance({ dir });
  const ledger = openLedger(instance.paths.ledger);
  t.after(() => ledger.db.isOpen && ledger.close());
  const thread = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  // One message row moved planned -> sending -> observed with the given receipt and times.
  const sent = ({ receipt, at, text = TEXT, platform = 'soomgo', kind = 'message' }) => {
    const row = plan(ledger, { platform, threadId: thread.id, kind, payload: { text } });
    setStatus(ledger, row.id, { from: 'planned', to: 'sending' });
    setStatus(ledger, row.id, { from: 'sending', to: 'observed', receipt });
    ledger.db.prepare('UPDATE outbox SET created_at = ?, updated_at = ? WHERE id = ?').run(at, at, row.id);
    ledger.addMessage({ threadId: thread.id, direction: 'out', body: text, externalId: 'm' + row.id, at });
    return row;
  };
  const lines = [];
  const errors = [];
  const call = (args) => run(args, { instance, log: (l) => lines.push(l), error: (l) => errors.push(l), now: new Date('2026-10-27T03:00:00Z') });
  const liveDir = join(dir, 'qa', 'live');
  return { dir, instance, ledger, sent, lines, errors, call, liveDir };
}

test('no observed outbound item since the takeover exits 3 and writes no file', async (t) => {
  const s = setup(t);
  s.ledger.addEvent({ kind: 'takeover', payload: { from: 'a', to: 'b' }, at: '2026-10-26T15:00:00.000Z' });
  s.sent({ receipt: { observed: true, snippet: TEXT }, at: '2026-10-25T00:00:00.000Z' });
  assert.equal(await s.call(['first-outbound']), 3);
  assert.match(s.lines.at(-1), /no observed outbound item since 2026-10-26T15:00:00.000Z/);
  assert.equal(existsSync(s.liveDir), false);
});

test('an item read back after the takeover exits 0 and its file holds ids and times, never the customer text', async (t) => {
  const s = setup(t);
  s.ledger.addEvent({ kind: 'takeover', payload: { from: 'a', to: 'b' }, at: '2026-10-26T15:00:00.000Z' });
  const row = s.sent({ receipt: { observed: true, snippet: TEXT, externalId: 'x9' }, at: '2026-10-26T23:01:00.000Z' });
  assert.equal(await s.call(['first-outbound']), 0);
  const [name] = readdirSync(s.liveDir);
  assert.equal(name, 'first-outbound-20261027.json');
  const raw = readFileSync(join(s.liveDir, name), 'utf8');
  assert.equal(raw.includes('고객'), false);
  const out = JSON.parse(raw);
  assert.deepEqual([out.since, out.outboxId, out.platform, out.kind, out.observedAt], ['2026-10-26T15:00:00.000Z', row.id, 'soomgo', 'message', '2026-10-26T23:01:00.000Z']);
  assert.deepEqual(out.receipt, { observed: true, externalId: 'x9', snippetLength: TEXT.length });
  assert.equal(out.message.external_id, 'm' + row.id);
});

test('a row marked observed whose receipt was not read back is passed over: tampered or confirmed by the operator', async (t) => {
  const s = setup(t);
  s.sent({ receipt: { observed: false, snippet: TEXT }, at: '2026-10-26T20:00:00.000Z', text: 'a' });
  s.sent({ receipt: { observed: true, confirmedBy: 'operator', confirmedAt: '2026-10-26T20:30:00.000Z' }, at: '2026-10-26T20:30:00.000Z', text: 'b' });
  assert.equal(await s.call(['first-outbound', '--since', '2026-10-26T00:00:00+09:00']), 3);
  const real = s.sent({ receipt: { observed: true, snippet: 'c' }, at: '2026-10-26T21:00:00.000Z', text: 'c' });
  assert.equal(await s.call(['first-outbound', '--since', '2026-10-26T00:00:00+09:00']), 0);
  assert.equal(JSON.parse(readFileSync(join(s.liveDir, readdirSync(s.liveDir)[0]), 'utf8')).outboxId, real.id);
});

test('the start defaults to the newest takeover; with none and no --since, or a bad --since, the exit is 2', async (t) => {
  const s = setup(t);
  assert.equal(await s.call(['first-outbound']), 2);
  assert.match(s.errors.at(-1), /no --since and no takeover event/);
  assert.equal(await s.call(['first-outbound', '--since', 'yesterday']), 2);
  assert.equal(await s.call(['first-outbound', '--since']), 2);
  assert.equal(await s.call(['other']), 2);
  s.ledger.addEvent({ kind: 'takeover', payload: { from: 'a', to: 'b' }, at: '2026-10-25T00:00:00.000Z' });
  s.ledger.addEvent({ kind: 'takeover', payload: { from: 'b', to: 'c' }, at: '2026-10-26T15:00:00.000Z' });
  const db = new DatabaseSync(s.instance.paths.ledger, { readOnly: true });
  assert.equal(newestTakeover(db), '2026-10-26T15:00:00.000Z');
  db.close();
});

test('fsw evidence reaches the handler from the command line and passes its exit code through', (t) => {
  const s = setup(t);
  s.ledger.addEvent({ kind: 'takeover', payload: { from: 'a', to: 'b' }, at: '2026-10-26T15:00:00.000Z' });
  s.ledger.close();
  const r = spawnSync(process.execPath, [join(repoRoot, 'bin', 'fsw.mjs'), 'evidence', 'first-outbound'], { env: { ...process.env, FSW_INSTANCE: s.dir }, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /no observed outbound item since 2026-10-26T15:00:00.000Z/);
});
