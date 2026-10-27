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

test('--sent dates the quote by its press, and a deal that throws leaves the row unobserved', async () => {
  const s = setup();
  const row = s.waiting('r2', '20261020-soomgo-0000cc01', 'quote', { amountKRW: 300000, costKRW: 990, thread: { kind: 'request', stage: 'pre_order' } });
  setStatus(s.ledger, row.id, { from: 'awaiting_operator', to: 'approved' });
  setStatus(s.ledger, row.id, { from: 'approved', to: 'sending' });
  const pressedAt = '2026-10-19T23:30:00.000Z';
  setStatus(s.ledger, row.id, { from: 'sending', to: 'unobserved', reason: 'not observed', receipt: { observed: false, pressed: true, costKRW: 990, pressedAt } });
  const real = s.ledger.addQuote;
  s.ledger.addQuote = () => {
    throw new Error('disk I/O error');
  };
  await assert.rejects(s.cli(['20261020-soomgo-0000cc01', '--sent']), /disk I\/O error/);
  s.ledger.addQuote = real;
  assert.equal(s.ledger.getOutbox(row.id).status, 'unobserved');
  assert.equal(s.ledger.threadMessages(row.threadId).filter((m) => m.direction === 'out').length, 0);
  assert.equal(await s.cli(['20261020-soomgo-0000cc01', '--sent']), 0);
  const [q] = s.ledger.listQuotes();
  assert.deepEqual([q.at, q.costKRW], [pressedAt, 990]);
});

// U7.7: a delivery shows its review, and approving one that did not pass needs --reason.
test('fsw approve shows a delivery review and approves a non-pass review only with --reason', async () => {
  const s = setup();
  s.waiting('c1', '20261020-soomgo-0000aa01', 'delivery', { files: ['C:/j/a.md'], runAt: '2026-10-20T10:00:00Z', review: { verdict: 'fail', findings: [{ severity: 'blocker', file: 'copy/a.md', detail: 'only one variant' }, { severity: 'minor', file: null, detail: 'title repeats' }] } });
  await s.cli(['list']);
  assert.match(s.lines.join('\n'), /20261020-soomgo-0000aa01 {2}soomgo {2}delivery[^\n]*\n {4}요청하신[^\n]*\n {4}review: fail \(2 findings\)\n {6}blocker copy\/a\.md: only one variant\n {6}minor: title repeats/);
  s.lines.length = 0;
  await s.cli(['show', '20261020-soomgo-0000aa01']);
  assert.match(s.lines.join('\n'), /review: fail \(2 findings\)\n {2}blocker copy\/a\.md: only one variant/);
  await assert.rejects(s.cli(['20261020-soomgo-0000aa01']), { code: 'FSW_REVIEW_NOT_PASSED' });
  assert.equal(s.ledger.outboxByApproval('20261020-soomgo-0000aa01').status, 'awaiting_operator');
  assert.equal(await s.cli(['20261020-soomgo-0000aa01', '--reason', 'read both files myself']), 0);
  assert.deepEqual([s.ledger.outboxByApproval('20261020-soomgo-0000aa01').status, s.ledger.outboxByApproval('20261020-soomgo-0000aa01').operator.resolutionReason], ['approved', 'read both files myself']);
});

// A delivery is approved against the bytes its review read: a changed file needs --reason, and files added after
// the review (operator steps) are listed as unreviewed.
test('fsw approve refuses a passed delivery whose files changed since the review unless --reason, and lists files added after it', async () => {
  const { hashTree } = await import('../src/work/review.mjs');
  const { mkdirSync: mk } = await import('node:fs');
  const s = setup();
  const work = join(s.instance.paths.jobs, 'j1', 'work');
  mk(join(work, 'copy'), { recursive: true });
  writeFileSync(join(work, 'copy', 'a.md'), '# 빵집\n');
  const added = join(s.instance.paths.jobs, 'j1', 'handoff', 'domain.txt');
  const review = { verdict: 'pass', findings: [], reviewed: ['copy/a.md'], work, hash: hashTree(work, ['copy/a.md']) };
  s.waiting('c1', '20261020-soomgo-0000aa01', 'delivery', { files: [join(work, 'copy', 'a.md'), added], runAt: '2026-10-20T10:00:00Z', review });
  await s.cli(['list']);
  assert.match(s.lines.join('\n'), /review: pass \(0 findings\)\n {6}unreviewed, added after the review: .*domain\.txt/);
  writeFileSync(join(work, 'copy', 'a.md'), '# 바뀐 빵집\n');
  s.lines.length = 0;
  await s.cli(['list']);
  assert.match(s.lines.join('\n'), /review: pass \(0 findings\)\n {6}the reviewed files changed since the review/);
  await assert.rejects(s.cli(['20261020-soomgo-0000aa01']), { code: 'FSW_REVIEW_CHANGED', message: /changed since its review; approving it needs --reason/ });
  assert.equal(s.ledger.outboxByApproval('20261020-soomgo-0000aa01').status, 'awaiting_operator');
  assert.equal(await s.cli(['20261020-soomgo-0000aa01', '--reason', 'I edited the title myself']), 0);
  assert.equal(s.ledger.outboxByApproval('20261020-soomgo-0000aa01').status, 'approved');
});
