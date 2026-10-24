import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacingGuard, resolveOmowrightScript } from '../src/browser/driver.mjs';

function fakeClock() {
  let t = 1_000_000;
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, advance: (ms) => { t += ms; }, slept };
}

test('page loads wait out minGapMs from the previous load', async () => {
  const c = fakeClock();
  const g = createPacingGuard('kmong', { minGapMs: 6000, maxActionsPerHour: 100, maxMessagesPerHour: 10 }, c);
  await g.beforeLoad();
  c.advance(2000);
  await g.beforeLoad();
  c.advance(9000);
  await g.beforeLoad();
  assert.deepEqual(c.slept, [4000]);
});

test('actions stop at the hourly cap and free up once the hour rolls over', async () => {
  const c = fakeClock();
  const g = createPacingGuard('soomgo', { minGapMs: 1, maxActionsPerHour: 3, maxMessagesPerHour: 1 }, c);
  await g.beforeLoad();
  g.beforeAction();
  g.beforeAction();
  assert.throws(() => g.beforeAction(), { code: 'FSW_PACING_LIMIT' });
  await assert.rejects(g.beforeLoad(), { code: 'FSW_PACING_LIMIT' });
  c.advance(3_600_001);
  g.beforeAction();
  g.beforeMessage();
  assert.throws(() => g.beforeMessage(), { kind: 'message' });
});

test('the newest omo version directory wins, and FSW_OMOWRIGHT overrides it', () => {
  const root = mkdtempSync(join(tmpdir(), 'fsw-omo-'));
  for (const v of ['5.1.9', '5.1.45', '5.1.100-beta']) {
    const dir = join(root, v, 'skills', 'browser', 'scripts');
    if (v !== '5.1.100-beta') {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'omowright.mjs'), '');
    } else mkdirSync(join(root, v), { recursive: true });
  }
  assert.match(resolveOmowrightScript({}, root), /5\.1\.45/);
  assert.equal(resolveOmowrightScript({ FSW_OMOWRIGHT: 'x.mjs' }, root), 'x.mjs');
  assert.throws(() => resolveOmowrightScript({}, join(root, 'none')), { code: 'FSW_NO_OMOWRIGHT' });
});
