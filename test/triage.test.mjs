import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir } from '../src/core/instance.mjs';
import { pipelineSettings } from '../src/core/settings.mjs';
import { answeredServices, catalog, catalogServicesFor, parkKey } from '../src/economics/catalog.mjs';
import { loadDescriptor } from '../src/platforms/registry.mjs';
import { THREAD_ATTEMPTS, awaitingReply, needsWork, parkEvent, triage } from '../src/triage/index.mjs';

const example = () => JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
const withServices = (services) => {
  const c = example();
  c.platforms.soomgo.services = services;
  return c;
};
const soomgo = loadDescriptor('soomgo');
const kmong = loadDescriptor('kmong');
// The settings shape every case passes (003 Triage): the pipeline settings plus the answered list.
const settingsOf = (config, platform = 'soomgo') => ({ ...pipelineSettings(config), answered: answeredServices(config, platform) });
const NOW = new Date('2026-10-25T12:00:00+09:00');
const ctx = (over = {}) => {
  const config = over.config ?? example();
  return { mode: 'auto', now: NOW, settings: settingsOf(config, (over.descriptor ?? soomgo).id), descriptor: soomgo, parkKey: parkKey(config, over.descriptor ?? soomgo), ...over };
};
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const LESSON = { kind: 'request', ref: 'r1', unread: true, at: hoursAgo(1), service: '프로그래밍/코딩 레슨' };

test('a message past the reply window parks with stale: and waits until a newer message under the same key', () => {
  const c = ctx({ descriptor: kmong, config: example() });
  const ib = { kind: 'message', ref: 't1', unread: true, at: hoursAgo(73) };
  const t = triage(ib, null, c);
  assert.equal(t.action, 'park');
  assert.match(t.reason, /^stale: newest message is 73 hours old, window 72/);
  assert.equal(parkEvent(t.reason), 'thread.skipped');
  const row = { meta: { skipped: { at: ib.at, reason: t.reason, key: c.parkKey } } };
  assert.equal(needsWork(ib, row, c.parkKey), false);
  assert.equal(triage(ib, row, c).action, 'wait');
  assert.equal(needsWork({ ...ib, at: hoursAgo(1) }, row, c.parkKey), true);
  assert.equal(triage({ ...ib, at: hoursAgo(71) }, null, c).action, 'open');
});

test('an expired request parks without opening', () => {
  assert.deepEqual(triage({ kind: 'request', ref: 'r2', unread: true, at: hoursAgo(1), quotable: false }, null, ctx()), { action: 'park', reason: 'expired' });
  assert.equal(triage({ kind: 'request', ref: 'r3', unread: true, at: hoursAgo(1), expiresAt: hoursAgo(0.5) }, null, ctx()).reason, 'expired');
});


test('a request that already has the most quotes its platform takes parks as expired before anything opens', () => {
  const req = (quoteCount) => ({ kind: 'request', ref: 'r4', unread: true, at: hoursAgo(1), service: '웹 개발', quoteCount });
  const t = triage(req(10), null, ctx());
  assert.deepEqual(t, { action: 'park', reason: 'expired: the request already has 10 quotes and soomgo takes 10' });
  assert.equal(parkEvent(t.reason), 'thread.skipped');
  assert.deepEqual([triage(req(9), null, ctx()).action, triage(req(null), null, ctx()).action], ['open', 'open']);
});

test('an unread notice parks once and returns only with a newer message', () => {
  const c = ctx();
  const ib = { kind: 'message', ref: 'c1', unread: true, at: hoursAgo(1), preview: '고객님이 견적을 조회하였습니다' };
  const t = triage(ib, null, c);
  assert.equal(t.action, 'park');
  assert.match(t.reason, /^notice: /);
  assert.equal(parkEvent(t.reason), 'thread.system');
  const row = { meta: { skipped: { at: ib.at, reason: t.reason, key: c.parkKey } } };
  assert.equal(triage(ib, row, c).action, 'wait');
  assert.equal(triage({ ...ib, at: hoursAgo(0.5), preview: '수정 가능할까요?' }, row, c).action, 'open');
});

test('an out-of-catalog request parks catalog: and counts as thread.operator', () => {
  const t = triage({ kind: 'request', ref: 'r4', unread: true, at: hoursAgo(1), service: '피아노 레슨' }, null, ctx());
  assert.equal(t.action, 'park');
  assert.equal(t.reason, 'catalog: service 피아노 레슨 is not in the catalog');
  assert.equal(parkEvent(t.reason), 'thread.operator');
});

test('a lesson request stays parked for the operator by default and opens once settings.answered lists lesson_tutoring', () => {
  const off = ctx({ config: withServices(null) });
  const t = triage(LESSON, null, off);
  assert.equal(t.action, 'park');
  assert.match(t.reason, /which config platforms\.soomgo\.services does not answer$/);
  assert.equal(parkEvent(t.reason), 'thread.operator');
  const on = ctx({ config: withServices(['lesson_tutoring', 'landing_page_web']) });
  assert.equal(triage(LESSON, null, on).action, 'open');
});

test('a lesson parked while the settings did not answer lessons is checked again once they do', () => {
  const offKey = parkKey(withServices(null), soomgo);
  const onKey = parkKey(withServices(['lesson_tutoring']), soomgo);
  const row = { meta: { skipped: { at: LESSON.at, reason: 'catalog: ...', key: offKey } } };
  assert.equal(needsWork(LESSON, row, offKey), false);
  assert.equal(needsWork(LESSON, row, onKey), true);
  const old = { meta: { skipped: { at: LESSON.at, reason: 'catalog: ...' } } };
  assert.equal(needsWork(LESSON, old, onKey), true);
});

test('a read row waits while its list time and key hold, and a night read holds only for observe ticks', () => {
  const key = parkKey(example(), soomgo);
  const ib = { kind: 'message', ref: 'c2', unread: false, at: hoursAgo(2) };
  const decided = { lastInboundAt: hoursAgo(3), meta: { settled: { at: ib.at, by: 'decide', key } } };
  assert.equal(needsWork(ib, decided, key), false);
  assert.equal(needsWork({ ...ib, at: hoursAgo(1) }, decided, key), true);
  assert.equal(needsWork(ib, decided, 'another-key'), true);
  const night = { lastInboundAt: hoursAgo(3), meta: { settled: { at: ib.at, by: 'observe', key } } };
  assert.equal(needsWork(ib, night, key, 'observe'), false);
  assert.equal(needsWork(ib, night, key, 'auto'), true);
});

test('a thread whose pass threw is passed again while meta.failed.count is under THREAD_ATTEMPTS and nothing was sent after it', () => {
  const ib = { kind: 'request', ref: 'r5', unread: false, at: hoursAgo(5) };
  const failed = (count, over = {}) => ({ lastInboundAt: hoursAgo(5), meta: { failed: { count, at: hoursAgo(1), code: 'FSW_BRAIN_BAD_DECISION' } }, ...over });
  assert.equal(needsWork(ib, failed(1), null), true);
  assert.equal(needsWork(ib, failed(THREAD_ATTEMPTS - 1), null), true);
  assert.equal(needsWork(ib, failed(THREAD_ATTEMPTS), null), false);
  assert.equal(needsWork(ib, failed(1, { lastOutboundAt: hoursAgo(0.5) }), null), false);
});

test('a coarse label allows several services', () => {
  assert.deepEqual(catalogServicesFor(soomgo, '웹 개발').sort(), ['landing_page_web', 'web_app_dev']);
  assert.equal(triage({ kind: 'request', ref: 'r6', unread: true, at: hoursAgo(1), service: '웹 개발' }, null, ctx()).action, 'open');
});

test('every service a descriptor label adds is a catalog service', () => {
  for (const [label, services] of Object.entries(soomgo.serviceLabels)) {
    for (const id of services) assert.ok(id in catalog, label + ' names ' + id + ', which the catalog does not hold');
  }
});

test('observe mode returns observe for unread and read items', () => {
  const c = ctx({ mode: 'observe', settings: null });
  assert.deepEqual(triage({ kind: 'message', ref: 'o1', unread: true, at: hoursAgo(1) }, null, c), { action: 'observe', reason: 'observe mode leaves an unread item unread' });
  assert.deepEqual(triage({ kind: 'message', ref: 'o2', unread: false, at: hoursAgo(1) }, null, c), { action: 'observe', reason: 'observe mode reads without replying' });
});

test('an open message or quote row holds the thread; a pay_request or delivery row does not', () => {
  const ib = { kind: 'message', ref: 'h1', unread: true, at: hoursAgo(1) };
  for (const status of ['planned', 'awaiting_operator', 'approved', 'sending', 'unobserved']) {
    assert.deepEqual(triage(ib, null, ctx({ openOutbox: [{ id: 7, kind: 'quote', status }] })), { action: 'wait', reason: 'outbox item 7 is ' + status });
  }
  assert.equal(triage(ib, null, ctx({ openOutbox: [{ id: 8, kind: 'message', status: 'observed' }] })).action, 'open');
  assert.equal(triage(ib, null, ctx({ openOutbox: [{ id: 9, kind: 'pay_request', status: 'awaiting_operator' }, { id: 10, kind: 'delivery', status: 'approved' }] })).action, 'open');
});

test('awaitingReply is true for a newest inbound inside the window, false after an outbound or past it', () => {
  const settings = pipelineSettings(example());
  const row = { kind: 'message' };
  assert.equal(awaitingReply(row, [{ direction: 'in', at: hoursAgo(2) }], { now: NOW, settings }), true);
  assert.equal(awaitingReply(row, [{ direction: 'in', at: hoursAgo(3) }, { direction: 'out', at: hoursAgo(2) }], { now: NOW, settings }), false);
  assert.equal(awaitingReply(row, [{ direction: 'in', at: hoursAgo(80) }], { now: NOW, settings }), false);
  assert.equal(awaitingReply({ kind: 'request' }, [{ direction: 'in', at: hoursAgo(50) }], { now: NOW, settings }), false);
  assert.equal(awaitingReply(row, [], { now: NOW, settings }), false);
});
