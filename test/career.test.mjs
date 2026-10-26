// The career figure a listing prints, derived from the profile's dated roles, and the kmong career step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openLedger } from '../src/core/ledger.mjs';
import { careerLabel, careerMonths } from '../src/core/profile.mjs';
import { careerStep, listingsRefresh } from '../src/listings/watch.mjs';
import { tempDir } from './tmp.mjs';

const NOW = new Date('2026-10-25T03:00:00Z');
const months = (...periods) => careerMonths({ roles: periods.map((period) => ({ period })) }, NOW);

test('careerMonths takes the lower value of every coarse period and counts overlapping roles once', () => {
  assert.equal(months('2023.01 - 2024.03'), 13);
  assert.equal(months('2022-2024'), 12, 'a year-only start counts from its December, a year-only end to its January');
  assert.equal(months('2018-2022', '2022-2024'), 48);
  assert.equal(months('2023.09 - 현재'), 36);
  assert.equal(months('2024.12 to present'), 21, 'the resume form of an ongoing role');
  assert.equal(months('2020.01 - 2021.06', '2021.01 - 2022.06'), 28);
});

test('a missing or unparseable period hides the figure', () => {
  assert.equal(careerMonths({ roles: [] }, NOW), null);
  assert.equal(careerMonths({}, NOW), null);
  assert.equal(months('2022-2024', 'since forever'), null);
  assert.equal(months('2023.13 - 2024.01'), null);
});

test('careerLabel prints years and months as listings print them', () => {
  assert.deepEqual([careerLabel(37), careerLabel(12), careerLabel(5), careerLabel(0), careerLabel(null)], ['3년 1개월', '1년', '5개월', '0개월', null]);
});

const ctxFor = (over = {}) => {
  const notes = [];
  const calls = [];
  const ledger = openLedger(':memory:');
  return { notes, calls, ledger, ctx: { instance: { dir: tempDir('fsw-career-'), profile: { roles: [{ period: '2023.09 - 현재' }] } }, ledger, now: NOW, notify: async (_i, n) => (notes.push(n), { written: true }), ...over } };
};
const pageShowing = (calls, shown, { lands = true } = {}) => {
  let value = shown;
  return { read: async () => (calls.push('read'), value), set: async (label) => (calls.push('set ' + label), lands && (value = label), { observed: lands }) };
};

test('a forced observe pass skips the career write before any page opens', async () => {
  const s = ctxFor();
  s.ctx.careerPage = pageShowing(s.calls, '2년');
  s.ctx.forceMode = 'observe';
  assert.deepEqual(await careerStep(s.ctx), { status: 'skipped', detail: 'FSW_FORCE_MODE=observe skips the career write' });
  assert.deepEqual([s.calls, s.notes], [[], []]);
});

test('the career is written only when the page shows another figure, read back, and recorded once', async () => {
  const s = ctxFor();
  s.ctx.careerPage = pageShowing(s.calls, '3년 1개월');
  assert.deepEqual(await careerStep(s.ctx), { changed: true, from: '3년 1개월', to: '3년' });
  assert.deepEqual(s.calls, ['read', 'set 3년', 'read']);
  const ev = s.ledger.db.prepare("SELECT ref, payload FROM events WHERE kind = 'platform.profile_edit'").all();
  assert.deepEqual(ev.map((e) => [e.ref, JSON.parse(e.payload)]), [['career', { from: '3년 1개월', to: '3년' }]]);
  s.calls.length = 0;
  assert.deepEqual(await careerStep(s.ctx), { changed: false, from: '3년', to: '3년' });
  assert.deepEqual(s.calls, ['read']);
  const lost = ctxFor();
  lost.ctx.careerPage = pageShowing(lost.calls, '2년', { lands: false });
  assert.match((await careerStep(lost.ctx)).detail, /shows 2년 after the write/);
  assert.equal(lost.ledger.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'platform.profile_edit'").get().n, 0);
});

test('with no mapped career field the step writes nothing and tells the operator the derived figure once', async () => {
  const s = ctxFor();
  const r = await careerStep(s.ctx);
  assert.deepEqual([r.changed, r.to], [false, '3년']);
  assert.deepEqual(s.notes.map((n) => [n.title, n.dedupeKey]), [['kmong career should read 3년', 'career:kmong']]);
  const hidden = ctxFor();
  hidden.ctx.instance.profile = { roles: [{ period: 'soon' }] };
  assert.deepEqual(await careerStep(hidden.ctx), { changed: false, detail: 'career hidden: a role has no parseable period' });
});

test('the daily listings refresh reports the career step beside its gigs', async () => {
  const s = ctxFor();
  const r = await listingsRefresh(s.ctx);
  assert.deepEqual([r.status, r.career.to], ['skipped', '3년']);
});
