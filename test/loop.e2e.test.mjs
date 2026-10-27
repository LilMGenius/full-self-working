// The D1 gate (030 section 7.11): one kmong inquiry answered and one soomgo request carried from its quote to
// a closed job, every surface replayed from the synthetic recordings under test/fixtures/loop-e2e through
// openSurface(platform, {replay}). Real: ledger, triage, decide with code pricing, authorize, outbox, deal,
// work runner and loop. The adapters keep their page waits, so the run takes about a minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCases } from '../src/learning/outcomes.mjs';
import { repoRoot } from '../src/core/instance.mjs';
import { openSurface } from '../src/surface/index.mjs';
import { readRecording } from '../src/surface/recorder.mjs';
import { KMONG_REPLY, QUOTE_REPLY, driveLoop, fixturePath } from './helpers/loop-e2e.mjs';

const events = (ledger, kind) => ledger.db.prepare('SELECT * FROM events WHERE kind = ? ORDER BY id').all(kind).map((e) => ({ ref: e.ref, ...JSON.parse(e.payload ?? 'null') }));
const threadOf = (ledger, platform, ref) => ledger.listThreads({ platform }).find((t) => t.externalId === ref);
const outbound = (ledger, platform, ref) => ledger.threadMessages(threadOf(ledger, platform, ref).id).filter((m) => m.direction === 'out');

test('a soomgo request reaches a closed job and a kmong inquiry an observed reply, replayed end to end', { timeout: 300_000 }, async () => {
  const { ledger, instance, ticks, portfolioBefore } = await driveLoop({ open: (platform, n) => openSurface(platform, { replay: fixturePath(repoRoot, platform, n) }) });
  try {
    // 9. every recorded driver call, the write forms included, was asked once and in order.
    for (const t of ticks) {
      assert.equal(t.result.status, 'ok', 'T' + t.n + ' ' + JSON.stringify(t.result.errors ?? t.result.error));
      assert.equal(t.surface.session.remaining(), 0, 'T' + t.n + ' left recorded calls unasked');
    }
    const acts = (platform, n) => readRecording(fixturePath(repoRoot, platform, n)).filter((e) => e.op === 'act');
    assert.equal(acts('kmong', 1).filter((a) => a.name === 'click' && a.arg[0] === '[data-fsw=send]').length, 1);
    assert.deepEqual(acts('soomgo', 2).find((a) => a.name === 'typeKeys').arg, ['[data-fsw=quote-price]', '300000']);
    assert.deepEqual(acts('soomgo', 4).find((a) => a.name === 'typeKeys').arg, ['[data-fsw=pay-amount]', '150000']);
    assert.deepEqual(acts('soomgo', 7).find((a) => a.name === 'typeKeys').arg, ['[data-fsw=pay-amount]', '150000']);
    assert.deepEqual(acts('soomgo', 8).map((a) => a.name), ['fill', 'setFiles', 'click']);

    // 1. the deal moved the job through the table and refused nothing.
    assert.deepEqual(events(ledger, 'deal.transition').filter((e) => e.jobId === 'soomgo-r100').map((e) => e.from + '->' + e.to), ['null->quoted', 'quoted->ordered', 'ordered->in_progress', 'in_progress->delivered', 'delivered->closed']);
    assert.equal(events(ledger, 'deal.refused').length, 0);

    // 2. the one quote.
    const quotes = ledger.listQuotes({ platform: 'soomgo' });
    assert.deepEqual(quotes.map((q) => [q.status, q.amountKRW, q.depositKRW, q.balanceKRW, q.costKRW]), [['accepted', 300000, 150000, 150000, 990]]);
    assert.equal(ledger.listQuotes({ platform: 'kmong' }).length, 0);

    // 3. payments.
    assert.deepEqual(ledger.jobPayments('soomgo-r100').map((p) => [p.kind, p.amountKRW, p.channel]), [['deposit', 150000, 'soomgo'], ['balance', 150000, 'soomgo']]);

    // 4. money events: the row-status hire and every repeat read add nothing.
    assert.deepEqual(ledger.listMoneyEvents().map((e) => [e.event, e.applied]), [['hired', true], ['paid', true], ['paid', true], ['confirmed', true], ['confirmed', true]]);

    // 5. outbox rows and their status histories.
    const history = (id) => events(ledger, 'outbox.status').filter((e) => e.id === id).map((e) => e.to);
    const rows = ledger.listOutbox();
    assert.deepEqual(rows.map((r) => [r.id, r.kind]), [[1, 'message'], [2, 'quote'], [3, 'pay_request'], [4, 'delivery'], [5, 'pay_request']]);
    assert.deepEqual(history(1), ['planned', 'sending', 'observed']);
    assert.deepEqual(history(2), ['planned', 'sending', 'observed']);
    for (const id of [3, 4, 5]) assert.deepEqual(history(id), ['planned', 'awaiting_operator', 'approved', 'sending', 'observed'], 'row ' + id);
    assert.equal(rows[1].payload.amountKRW, 300000);
    assert.deepEqual([rows[2].payload.amountKRW, rows[4].payload.amountKRW], [150000, 150000]);
    assert.match(rows[2].payload.text, /Deposit$/);
    assert.match(rows[4].payload.text, /Balance$/);
    assert.deepEqual([rows[3].payload.review.verdict, rows[3].operator.resolutionReason], ['error', 'files read by hand']);
    assert.match(rows[3].payload.review.findings[0].detail, /builder gpt-6\.1-sol \(openai\)/);
    assert.ok(rows.every((r) => r.status === 'observed'));
    // The delivery waited at T7 for the balance with no status change.
    assert.deepEqual(ticks.find((t) => t.n === 7).result.outbox, { held: 1, observed: 1 });

    // 6. one learning case.
    assert.deepEqual(readCases(instance).map((c) => [c.kind, c.jobId]), [['job_closed', 'soomgo-r100']]);

    // 7. outbound messages.
    assert.deepEqual(outbound(ledger, 'kmong', '300').map((m) => m.body), [KMONG_REPLY]);
    assert.deepEqual(outbound(ledger, 'soomgo', 'r100').map((m) => m.body), [QUOTE_REPLY]);
    const delivery = outbound(ledger, 'soomgo', '200');
    assert.equal(delivery.length, 1);
    assert.match(delivery[0].body, /포트폴리오에 소개해도 괜찮을까요/);
    assert.deepEqual(delivery[0].attachments, ['index.html', 'HOSTING.md']);

    // 8. the closed job reaches the portfolio only with the client's permission.
    assert.ok(!portfolioBefore.includes('job-soomgo-r100'));
    const { rankPortfolio } = await import('../src/portfolio/rank.mjs');
    const { loadItems } = await import('../src/portfolio/store.mjs');
    assert.ok(rankPortfolio(loadItems(instance)).some((i) => i.id === 'job-soomgo-r100'));
  } finally {
    ledger.close();
  }
});
