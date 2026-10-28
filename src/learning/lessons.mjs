// writeLessons: the paperthin:re0-memo method over new cases, run through the brain. Each new case is
// generalized into its class with the case kept as evidence and the gate that would catch it named;
// lessons of the same class merge into one. Output: lessons/lessons.jsonl, one lesson per class.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from '../core/atomic.mjs';
import { ensureDir } from '../core/instance.mjs';
import { logEvent } from '../core/log.mjs';
import { runCodex as defaultRunCodex } from '../brain/codex.mjs';
import { readCases } from './outcomes.mjs';
import { SCOPE_IDS, normalizeAppliesTo } from './scope.mjs';

export const lessonsFile = (instance) => join(instance.paths.lessons, 'lessons.jsonl');
const stateFile = (instance) => join(instance.paths.lessons, 'state.json');

export function readLessons(instance) {
  const file = lessonsFile(instance);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const readState = (instance) => (existsSync(stateFile(instance)) ? JSON.parse(readFileSync(stateFile(instance), 'utf8')) : { learnedCaseIds: [] });

export const LESSONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lessons'],
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['class', 'rule', 'evidence', 'gate', 'pattern', 'appliesTo'],
        properties: {
          class: { type: 'string', description: 'short snake_case name of the failure or success class' },
          rule: { type: 'string', description: 'one imperative sentence the next decision follows' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'case ids this lesson is drawn from' },
          gate: { type: 'string', enum: ['regex', 'existing_gate', 'judgment'], description: 'regex when a pattern over outbound text decides it, existing_gate when a built-in gate rule already covers it, judgment otherwise' },
          pattern: { type: ['string', 'null'], description: 'JavaScript regex source when gate is regex; it must match the offending text of its evidence' },
          appliesTo: { type: 'array', items: { type: 'string', enum: SCOPE_IDS }, description: 'platform ids, or ["all"]' },
        },
      },
    },
  },
};

export function buildLessonsPrompt(existing, cases) {
  return [
    'You maintain the lessons of a freelance seller agent with the paperthin:re0-memo method. Do not run commands; answer only with the JSON the schema describes.',
    'For each new case: generalize it into the class it belongs to (the class, not this incident), keep the case id as evidence, and name the gate that would catch it next time.',
    'Merge lessons of the same class into one: keep one rule, union the evidence. Keep every existing lesson that the new cases do not change. Return the full lesson set.',
    'gate is "regex" only when a regular expression over outgoing text decides the rule without judgment; then pattern must match the offending text of its cases (the rejected draft, or the "before" text of a correction) and must not match ordinary polite replies. Otherwise pattern is null.',
    'Rules are written in English; a pattern may contain Korean. No incident narration in rules.',
    '',
    '# Existing lessons',
    JSON.stringify(existing, null, 1),
    '',
    '# New cases',
    JSON.stringify(cases, null, 1),
  ].join('\n');
}

export async function writeLessons(instance, { runCodex = defaultRunCodex, model, effort, timeoutMs } = {}) {
  const state = readState(instance);
  const learned = new Set(state.learnedCaseIds);
  const fresh = readCases(instance).filter((c) => !learned.has(c.id));
  if (!fresh.length) return { changed: false, lessons: readLessons(instance), newCases: 0 };
  const existing = readLessons(instance);
  const brain = instance.config?.brain ?? {};
  const { data } = await runCodex({
    prompt: buildLessonsPrompt(existing, fresh),
    schema: LESSONS_SCHEMA,
    model: model ?? brain.model,
    effort: effort ?? brain.effort,
    timeoutMs: timeoutMs ?? brain.timeoutMs,
  });
  if (!Array.isArray(data?.lessons)) throw new TypeError('lessons answer has no lessons array');
  const known = new Set([...readCases(instance).map((c) => c.id)]);
  const now = new Date().toISOString();
  const byClass = new Map();
  const scopeDropped = [];
  for (const l of data.lessons) {
    if (typeof l.class !== 'string' || !l.class.trim() || typeof l.rule !== 'string' || !l.rule.trim()) throw new TypeError('a lesson needs class and rule');
    const evidence = (l.evidence ?? []).filter((id) => known.has(id));
    const prev = byClass.get(l.class);
    const before = existing.find((e) => e.class === l.class);
    const scope = normalizeAppliesTo(l.appliesTo);
    if (scope.dropped.length) scopeDropped.push({ class: l.class, values: scope.dropped });
    byClass.set(l.class, {
      class: l.class,
      rule: l.rule.trim(),
      evidence: [...new Set([...(prev?.evidence ?? []), ...evidence])],
      gate: l.gate,
      pattern: l.gate === 'regex' ? l.pattern : null,
      appliesTo: scope.appliesTo,
      createdAt: before?.createdAt ?? now,
      updatedAt: before && before.rule === l.rule.trim() && before.pattern === l.pattern ? before.updatedAt : now,
    });
  }
  const lessons = [...byClass.values()];
  if (scopeDropped.length) logEvent(instance, 'learning.scope_dropped', { dropped: scopeDropped });
  ensureDir(instance.paths.lessons);
  writeAtomic(lessonsFile(instance), lessons.map((l) => JSON.stringify(l)).join('\n') + (lessons.length ? '\n' : ''));
  writeAtomic(stateFile(instance), JSON.stringify({ ...state, learnedCaseIds: [...learned, ...fresh.map((c) => c.id)] }, null, 2) + '\n');
  logEvent(instance, 'learning.lessons', { newCases: fresh.length, lessons: lessons.length });
  return { changed: true, lessons, newCases: fresh.length };
}
