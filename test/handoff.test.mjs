// A paid job plans its delivery only after fsw job handoff records every operator step of the run that
// produces files, and the delivery carries those files; a step that produces none is left to the delivery
// approval, which waits for the operator anyway. Synthetic values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { openLedger } from '../src/core/ledger.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { advance, moneyToSignals } from '../src/deal/index.mjs';
import { recordHandoff } from '../src/loop/job.mjs';
import { handoffsOf, loadRecipe } from '../src/work/index.mjs';
import { run as jobCli } from '../src/cli/job.mjs';
import { tempDir } from './tmp.mjs';

const NOW = new Date('2026-10-20T15:00:00+09:00');
const at = (hm) => '2026-10-20T' + hm + ':00+09:00';
const HIRED = '숨고 알리미\n고용이 확정됐어요\n10월 24일 (금) 오전 10:00분까지\n고용을 취소할 수 있습니다.';
const PAID = (n) => '숨고페이\n고객이 결제한 금액을 숨고가\n안전하게 보관하고 있어요\n협의한 날짜와 금액이 맞는지 확인해 주세요.\n\n서비스명: 안드로이드 개발\n서비스 금액: ' + n + '원';
const quiet = async () => ({ written: false });

function jobAccepted(service = 'mobile_app_dev') {
  const dir = tempDir('fsw-handoff-');
  for (const f of ['profile.json', 'business.json', 'config.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const instance = loadInstance({ dir });
  const ledger = openLedger(':memory:');
  const descriptor = loadDescriptor('soomgo');
  const ctx = { instance, descriptor, now: NOW };
  const step = (signal) => advance(ledger, signal, ctx);
  const t = ledger.upsertThread({ platform: 'soomgo', externalId: 'c1', kind: 'message' });
  step({ type: 'quote_observed', platform: 'soomgo', threadId: t.id, at: at('10:05'), amountKRW: 2000000, evidence: { outboxId: 1, service, scope: ['앱'], deliveryDays: 20, split: { parts: [{ amountKRW: 1000000 }, { amountKRW: 1000000 }] }, costKRW: 990, cashSpentKRW: 990 } });
  const money = (text, hm) => moneyToSignals({ platform: 'soomgo', threadId: t.id, inbound: {}, notices: [{ text, at: at(hm) }], now: NOW });
  for (const sig of money(HIRED, '10:58')) step(sig);
  for (const sig of money(PAID('1,000,000'), '11:58')) step(sig);
  const jobId = ledger.listJobs()[0].id;
  step({ type: 'run_started', platform: 'soomgo', jobId, at: at('12:00'), evidence: {} });
  const accepted = step({ type: 'run_accepted', platform: 'soomgo', jobId, at: at('12:01'), evidence: { lastRun: { ok: true, at: at('12:01') }, files: ['C:/w/app/package.json', 'C:/w/notes/handover.md'], captures: [], handoffs: handoffsOf(loadRecipe(service)) } });
  return { instance, ledger, jobId, accepted, dir };
}

test('a mobile job that passes acceptance plans no delivery until both builds are recorded, then plans one carrying them', async () => {
  const { instance, ledger, jobId, accepted, dir } = jobAccepted();
  assert.deepEqual(accepted.effects.map((e) => e.item?.kind ?? e.type), []);
  const file = (name) => (writeFileSync(join(dir, name), name), join(dir, name));
  const ctx = { instance, ledger, notify: quiet };
  const deliveries = () => ledger.listOutbox({ jobId, kinds: ['delivery'] });

  const android = await recordHandoff(jobId, 'android-build', [file('app-release.apk'), file('app-release.aab')], ctx);
  assert.deepEqual([android.recorded, android.delivery, android.pending], [true, false, ['ios-build']]);
  assert.ok(existsSync(join(instance.paths.jobs, jobId, 'handoff', 'android-build', 'app-release.apk')));
  assert.equal(deliveries().length, 0);
  const ios = await recordHandoff(jobId, 'ios-build', [file('testflight.txt')], ctx);
  assert.deepEqual([ios.delivery, ios.pending], [true, []]);

  const [row] = deliveries();
  const names = row.payload.files.map((f) => f.split(/[\\/]/).pop());
  assert.deepEqual(names, ['package.json', 'handover.md', 'app-release.apk', 'app-release.aab', 'testflight.txt']);
  assert.match(row.payload.reason, /operator steps recorded: android-build \(2 files\), ios-build \(1 files\); confirm before approving that you did: review \(The operator checks/);
  assert.deepEqual(row.payload.handoffs.map((h) => [h.id, h.files?.length ?? h.confirm.slice(0, 12)]), [['android-build', 2], ['ios-build', 1], ['review', 'The operator']]);
  assert.equal(ledger.listOutbox({ jobId, kinds: ['pay_request'] }).at(-1).payload.rest, true);
});

test('a job whose only operator step makes no files plans its delivery at acceptance, with the step to confirm', () => {
  const { accepted } = jobAccepted('landing_page_web');
  const [delivery] = accepted.effects.filter((e) => e.item?.kind === 'delivery');
  assert.match(delivery.item.payload.reason, /confirm before approving that you did: review \(/);
  assert.doesNotMatch(delivery.item.payload.reason, /operator steps recorded/);
});

test('fsw job handoff refuses a step without files to record, too few files and a missing file, and takes a conditional step without files', async () => {
  const { instance, ledger, jobId, dir } = jobAccepted();
  const file = (name) => (writeFileSync(join(dir, name), name), join(dir, name));
  const recorded = async (args) => {
    const out = [];
    const code = await jobCli(['handoff', jobId, ...args], { instance, ledger, log: (l) => out.push(l), notify: quiet });
    return [code, JSON.parse(out[0]).recorded];
  };
  assert.deepEqual(await recorded(['deploy']), [1, false]);
  assert.deepEqual(await recorded(['review']), [1, false]);
  assert.deepEqual(await recorded(['android-build', file('only.apk')]), [1, false]);
  assert.deepEqual(await recorded(['ios-build']), [0, true]);
  const refusals = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'deal.refused'").all().map((e) => JSON.parse(e.payload).reason);
  assert.ok(refusals.some((r) => /review makes no files/.test(r)) && refusals.some((r) => /android-build makes .* but 1 files were given/.test(r)));
  await assert.rejects(jobCli(['handoff', jobId, 'android-build', join(dir, 'missing.apk')], { instance, ledger, log: () => {}, notify: quiet }), { code: 'FSW_HANDOFF_FILE' });
  assert.equal(await jobCli(['handoff', jobId], { instance, ledger, error: () => {} }), 2);
  await assert.rejects(jobCli(['handoff', jobId, 'android-build', join(instance.dir, 'missing.apk')], { instance, ledger, log: () => {}, notify: quiet }), { code: 'FSW_HANDOFF_FILE' });
  assert.equal(await jobCli(['handoff', jobId], { instance, ledger, error: () => {} }), 2);
});

