import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { plan, setStatus } from '../src/outbox/index.mjs';
import { readCases } from '../src/learning/outcomes.mjs';
import { run } from '../src/cli/approvals.mjs';
import { tempDir } from './tmp.mjs';

function makeInstance() {
  const dir = tempDir('fsw-approve-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}
const TEXT = '요청하신 구성으로 진행 가능합니다.';
function setup() {
  const instance = makeInstance();
  const ledger = openLedger(':memory:');
  const lines = [];
  const cli = (argv) => run(argv, { instance, ledger, log: (l) => lines.push(l), notify: async () => ({}), now: new Date('2026-10-20T12:00:00+09:00') });
  const waiting = (ref, approvalId, kind = 'message', payload = {}) => {
    const t = ledger.upsertThread({ platform: 'soomgo', externalId: ref, kind: kind === 'quote' ? 'request' : 'message' });
    const row = plan(ledger, { platform: 'soomgo', threadId: t.id, kind, payload: { text: TEXT, service: 'landing_page_web', ...payload } });
    setStatus(ledger, row.id, { from: 'planned', to: 'awaiting_operator', approvalId, reason: 'draft mode' });
    return row;
  };
  return { instance, ledger, lines, cli, waiting };
}

test('fsw approve list prints the rows waiting for the operator', async () => {
  const s = setup();
  assert.equal(await s.cli(['list']), 0);
  assert.deepEqual(s.lines, ['no open approvals']);
  s.waiting('c1', '20261020-soomgo-0000aa01');
  s.lines.length = 0;
  await s.cli([]);
  assert.match(s.lines[0], /^20261020-soomgo-0000aa01 {2}soomgo {2}message {2}draft mode\n {4}요청하신 구성으로/);
});

test('approving with --text records an operator_correction case and rejecting records approval_rejected', async () => {
  const s = setup();
  s.waiting('c1', '20261020-soomgo-0000aa01');
  s.waiting('c2', '20261020-soomgo-0000aa02');
  assert.equal(await s.cli(['20261020-soomgo-0000aa01', '--text', '말씀하신 구성으로 진행하겠습니다.']), 0);
  assert.match(s.lines.at(-1), /approved with edits; the next drain sends it after authorize passes again$/);
  assert.equal(await s.cli(['20261020-soomgo-0000aa02', '--reject', '--reason', 'scope not agreed']), 0);
  assert.deepEqual(readCases(s.instance).map((c) => [c.kind, c.threadRef]), [['operator_correction', 'c1'], ['approval_rejected', 'c2']]);
});

test('--sent --cost settles an unobserved quote once through the deal; a bad cost or a waiting row is refused', async () => {
  const s = setup();
  const row = s.waiting('r1', '20261020-soomgo-0000bb01', 'quote', { amountKRW: 300000, costKRW: 990, thread: { kind: 'request', stage: 'pre_order' } });
  setStatus(s.ledger, row.id, { from: 'awaiting_operator', to: 'approved' });
  setStatus(s.ledger, row.id, { from: 'approved', to: 'sending' });
  setStatus(s.ledger, row.id, { from: 'sending', to: 'unobserved', reason: 'not observed' });
  assert.equal(await s.cli(['20261020-soomgo-0000bb01', '--sent', '--cost', '900']), 0);
  assert.equal(s.lines.at(-1), '20261020-soomgo-0000bb01 sent, as the operator confirmed');
  const quotes = s.ledger.listQuotes();
  assert.deepEqual(quotes.map((q) => [q.costKRW, q.status, q.amountKRW]), [[900, 'sent', 300000]]);
  assert.equal(s.ledger.getJob('soomgo-r1').status, 'quoted');
  await assert.rejects(s.cli(['20261020-soomgo-0000bb01', '--sent', '--cost', '9.5']), /--cost needs a whole KRW amount/);
  s.waiting('c3', '20261020-soomgo-0000bb02');
  await assert.rejects(s.cli(['20261020-soomgo-0000bb02', '--sent']), { code: 'FSW_OUTBOX_RESOLVED' });
  assert.equal(s.ledger.outboxByApproval('20261020-soomgo-0000bb02').status, 'awaiting_operator');
  assert.equal(s.ledger.listQuotes().length, 1);
});
