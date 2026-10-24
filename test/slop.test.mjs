import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintText } from '../src/policy/slop.mjs';

const rules = (text, opts) => lintText(text, opts).map((f) => `${f.tier}:${f.rule}`);

test('floor flags em dash, horizontal bar and a middle dot between words', () => {
  assert.deepEqual(rules('빠르게\u2014정확하게'), ['floor:em_dash']);
  assert.deepEqual(rules('a \u2015 b'), ['floor:em_dash']);
  assert.deepEqual(rules('개발·디자인 모두 가능합니다'), ['floor:middle_dot']);
  assert.deepEqual(rules('web · app'), ['floor:middle_dot']);
});

test('numbers with a middle dot and en-dash ranges pass', () => {
  assert.deepEqual(rules('3·1운동 기념일'), []);
  assert.deepEqual(rules('1–10페이지, 2–3일 소요'), []);
});

test('placeholders and AI self-reference are floor findings', () => {
  assert.deepEqual(rules('안녕하세요 [이름]님'), ['floor:placeholder']);
  assert.deepEqual(rules('Hello {{client}}'), ['floor:placeholder']);
  assert.deepEqual(rules('TODO: price'), ['floor:placeholder']);
  assert.deepEqual(rules('As an AI, I cannot'), ['floor:ai_self_reference']);
  assert.deepEqual(rules('저는 AI 언어 모델입니다'), ['floor:ai_self_reference']);
});

test('reflex findings warn on hype, stacked exclamations, emoji bullets and vanity metrics', () => {
  const found = rules('최고의 품질!!\n✅ 빠른 응답\n만족도 100% 10,000+ 고객\nA seamless experience');
  for (const r of ['reflex:hype_ko', 'reflex:stacked_exclamation', 'reflex:emoji_bullet', 'reflex:vanity_metric', 'reflex:hype_en']) assert.ok(found.includes(r), r);
  assert.ok(!found.some((r) => r.startsWith('floor:')));
  assert.deepEqual(rules('저희 스토어에 오신 것을 환영합니다'), ['reflex:welcome_phrase']);
});

test('findings carry index and excerpt', () => {
  const [f] = lintText('abc\u2014def');
  assert.equal(f.index, 3);
  assert.match(f.excerpt, /abc.def/);
});
