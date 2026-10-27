import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { run } from '../src/cli/deal.mjs';
import { tempDir } from './tmp.mjs';

function setup() {
  const dir = tempDir('fsw-deal-cli-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const instance = loadInstance({ dir });
  const ledger = openLedger(':memory:');
  const job = (id, status) => {
    const t = ledger.upsertThread({ platform: 'kmong', externalId: 'k-' + id, kind: 'message' });
    return ledger.upsertJob({ id, threadId: t.id, platform: 'kmong', service: 'logo_brand', status, priceKRW: 100000, deliveredAt: status === 'ordered' ? null : '2026-10-20T03:00:00Z' });
  };
  const lines = [];
  const call = (argv) => run(argv, { instance, ledger, log: (l) => lines.push(l), notify: async () => ({ written: false }), now: new Date('2026-10-25T03:00:00Z') });
  return { instance, ledger, job, lines, call };
}

test('permission on a closed job ranks it in the portfolio and exits 0', async () => {
  const s = setup();
  s.job('j1', 'closed');
  assert.equal(await s.call(['j1', 'permission', 'granted']), 0);
  assert.equal(s.ledger.getJob('j1').meta.portfolio.permission, 'granted');
  assert.match(s.lines.at(-1), /^job j1 permission recorded/);
});

test('granting over a client refusal says it lifts that refusal and quotes it; a first grant says nothing of the kind', async () => {
  const s = setup();
  const j = s.job('j4', 'closed');
  s.ledger.upsertJob({ id: 'j4', meta: { portfolio: { permission: 'denied', answeredAt: '2026-10-21T02:00:00Z', source: 'brain', quote: '포트폴리오에는 올리지 말아 주세요.' } } });
  assert.equal(await s.call(['j4', 'permission', 'granted']), 0);
  assert.deepEqual(s.lines.slice(-2), ['job j4 permission granted lifts the refusal recorded 2026-10-21T02:00:00Z from brain: "포트폴리오에는 올리지 말아 주세요."', 'job j4 permission recorded; the portfolio is synced and the next listings refresh shows it in the gig images it ranks into']);
  assert.equal(s.ledger.getJob(j.id).meta.portfolio.permission, 'granted');
  s.job('j5', 'closed');
  await s.call(['j5', 'permission', 'granted']);
  assert.ok(!s.lines.some((l) => l.startsWith('job j5') && l.includes('lifts')));
});

test('permission on an ordered job exits 1 with the refusal', async () => {
  const s = setup();
  s.job('j2', 'ordered');
  assert.equal(await s.call(['j2', 'permission', 'granted']), 1);
  assert.match(s.lines.at(-1), /refused: portfolio permission needs a delivered or closed job/);
  assert.equal(s.ledger.getJob('j2').meta?.portfolio?.permission, undefined);
});

test('two jobs on one thread: each review lands on the job it names, and correcting the older one says so', async () => {
  const s = setup();
  const t = s.ledger.upsertThread({ platform: 'kmong', externalId: 'k-shared', kind: 'message' });
  s.ledger.upsertJob({ id: 'ja', threadId: t.id, platform: 'kmong', service: 'logo_brand', status: 'closed', priceKRW: 100000, deliveredAt: '2026-10-10T03:00:00Z' });
  s.ledger.upsertJob({ id: 'jb', threadId: t.id, platform: 'kmong', service: 'logo_brand', status: 'delivered', priceKRW: 100000, deliveredAt: '2026-10-20T03:00:00Z' });
  const at = (argv, minute) => run(argv, { instance: s.instance, ledger: s.ledger, log: (l) => s.lines.push(l), notify: async () => ({ written: false }), now: new Date('2026-10-25T03:0' + minute + ':00Z') });
  const rows = () => s.ledger.db.prepare('SELECT job_id, rating FROM reviews ORDER BY job_id').all().map((r) => [r.job_id, r.rating]);
  assert.equal(await at(['ja', 'review', '--rating', '5'], 0), 0);
  assert.equal(await at(['jb', 'review', '--rating', '3'], 1), 0);
  assert.deepEqual(rows(), [['ja', 5], ['jb', 3]]);
  assert.equal(await at(['ja', 'review', '--rating', '4'], 2), 0);
  assert.equal(s.lines.at(-1), 'job ja review corrected; the job keeps one review, now rating 4');
  assert.deepEqual(rows(), [['ja', 4], ['jb', 3]]);
});

test('a review on a delivered job writes one reviews row; a bad rating is a usage error', async () => {
  const s = setup();
  s.job('j3', 'delivered');
  assert.equal(await s.call(['j3', 'review', '--rating', '5', '--text', '좋아요', '--liked', 'true']), 0);
  const rows = s.ledger.db.prepare('SELECT job_id, rating, liked FROM reviews').all();
  assert.deepEqual(rows.map((r) => [r.job_id, r.rating]), [['j3', 5]]);
  await assert.rejects(s.call(['j3', 'review', '--rating', '9']), /usage: fsw deal/);
  // Entered again a minute later: one row stays; a changed rating corrects it.
  const later = (argv, minute) => run(argv, { instance: s.instance, ledger: s.ledger, log: (l) => s.lines.push(l), notify: async () => ({ written: false }), now: new Date('2026-10-25T03:0' + minute + ':00Z') });
  assert.equal(await later(['j3', 'review', '--rating', '5', '--text', '좋아요', '--liked', 'true'], 1), 0);
  assert.equal(s.lines.at(-1), 'job j3 review already recorded with this rating and text; nothing changed');
  assert.equal(await later(['j3', 'review', '--rating', '4', '--text', '좋아요', '--liked', 'true'], 2), 0);
  assert.equal(s.lines.at(-1), 'job j3 review corrected; the job keeps one review, now rating 4');
  assert.deepEqual(s.ledger.db.prepare('SELECT rating FROM reviews').all().map((r) => r.rating), [4]);
  assert.equal(await s.call(['list']), 0);
  assert.match(s.lines.at(-1), /^j3 {2}kmong {2}logo_brand {2}delivered/);
});

test('granting over a client condition says it lifts that condition and quotes it; denying it works', async () => {
  const s = setup();
  s.job('j6', 'closed');
  s.ledger.upsertJob({ id: 'j6', meta: { portfolio: { permission: 'conditional', answeredAt: '2026-10-21T02:00:00Z', source: 'brain', quote: '대표님 확인이 먼저 필요해요.' } } });
  assert.equal(await s.call(['j6', 'permission', 'granted']), 0);
  assert.equal(s.lines.at(-2), 'job j6 permission granted lifts the condition recorded 2026-10-21T02:00:00Z from brain: "대표님 확인이 먼저 필요해요."');
  s.job('j7', 'closed');
  s.ledger.upsertJob({ id: 'j7', meta: { portfolio: { permission: 'conditional', answeredAt: '2026-10-21T02:00:00Z', source: 'brain', quote: 'x' } } });
  assert.equal(await s.call(['j7', 'permission', 'denied']), 0);
  assert.equal(s.ledger.getJob('j7').meta.portfolio.permission, 'denied');
});
