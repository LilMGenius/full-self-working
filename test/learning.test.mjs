import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleDir, loadInstance } from '../src/core/instance.mjs';
import { recordOutcome } from '../src/learning/outcomes.mjs';
import { writeLessons } from '../src/learning/lessons.mjs';
import { refreshPlaybook, validatePattern } from '../src/learning/playbook.mjs';
import { tempDir } from './tmp.mjs';

// The learn job's cases, moved verbatim from test/brain.test.mjs at main (lines 156, 178 and 187).
function makeInstance() {
  const dir = tempDir('fsw-learn-');
  for (const f of ['profile.json', 'business.json']) copyFileSync(join(exampleDir, f), join(dir, f));
  const config = JSON.parse(readFileSync(join(exampleDir, 'config.json'), 'utf8'));
  config.notify = { toast: false, webhookUrl: null };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return loadInstance({ dir });
}

// A fake runCodex that answers from a queue and records every prompt it saw.
function fakeCodex(answers) {
  const calls = [];
  const fn = async ({ prompt, schema }) => {
    calls.push({ prompt, schema });
    if (!answers.length) throw new Error('fake codex: no answer left');
    return { data: answers.shift(), durationMs: 1 };
  };
  fn.calls = calls;
  return fn;
}
const noCodex = async () => {
  throw new Error('the model must not be called');
};

test('a generated regex that does not match its own case is not written to gate-rules.json', async () => {
  const instance = makeInstance();
  const c1 = recordOutcome(instance, null, { kind: 'approval_rejected', platform: 'kmong', text: '오픈채팅으로 오시면 더 빨리 답드려요' });
  const c2 = recordOutcome(instance, null, { kind: 'operator_correction', platform: 'kmong', text: '최저가 보장해 드립니다', before: '최저가 보장해 드립니다', after: '범위 안에서 맞춰 드리겠습니다' });
  const codex = fakeCodex([
    { lessons: [
      { class: 'chat_link_lure', rule: 'Never invite the customer to an outside chat.', evidence: [c1.id], gate: 'regex', pattern: '텔레그램\\s*방', appliesTo: ['all'] },
      { class: 'price_guarantee', rule: 'Never promise the lowest price.', evidence: [c2.id], gate: 'regex', pattern: '최저가\\s*보장', appliesTo: ['all'] },
    ] },
    { playbook: '## 대화\n\n- 외부 채팅으로 안내하지 않습니다.\n' },
  ]);
  const w = await writeLessons(instance, { runCodex: codex });
  assert.equal(w.lessons.length, 2);
  const r = await refreshPlaybook(instance, { runCodex: codex });
  assert.deepEqual(r.rules.map((x) => x.id), ['price_guarantee']);
  assert.deepEqual(r.rejected.map((x) => [x.class, x.reason]), [['chat_link_lure', 'does not match the case text it came from']]);
  const onDisk = JSON.parse(readFileSync(join(instance.paths.lessons, 'gate-rules.json'), 'utf8'));
  assert.deepEqual(onDisk.map((x) => x.id), ['price_guarantee']);
  assert.match(codex.calls[1].prompt, /Never invite the customer to an outside chat/);
  assert.equal(readFileSync(join(instance.paths.lessons, 'playbook.md'), 'utf8'), '## 대화\n\n- 외부 채팅으로 안내하지 않습니다.\n');
});

test('catastrophic or over-broad patterns are refused before they reach the gate', () => {
  const ev = [{ kind: 'approval_rejected', text: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!' }];
  assert.equal(validatePattern({ pattern: '(a+)+!' }, ev).reason, 'nested quantifier');
  assert.equal(validatePattern({ pattern: 'a{1,}'.repeat(60) }, ev).ok, false);
  assert.equal(validatePattern({ pattern: '(' }, ev).ok, false);
  assert.equal(validatePattern({ pattern: '.' }, ev).reason, 'matches an ordinary polite reply');
  assert.equal(validatePattern({ pattern: 'a{20}!' }, ev).ok, true);
});

test('writeLessons learns each case once', async () => {
  const instance = makeInstance();
  recordOutcome(instance, null, { kind: 'lead_lost', platform: 'soomgo', text: '다른 분과 진행하기로 했어요', note: 'no reply for 3 hours' });
  const codex = fakeCodex([{ lessons: [{ class: 'slow_first_reply', rule: 'Answer a new request within the hour.', evidence: [], gate: 'judgment', pattern: null, appliesTo: ['soomgo'] }] }]);
  assert.equal((await writeLessons(instance, { runCodex: codex })).newCases, 1);
  const again = await writeLessons(instance, { runCodex: noCodex });
  assert.equal(again.changed, false);
  assert.equal(codex.calls.length, 1);
});

