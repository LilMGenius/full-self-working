// refreshPlaybook: rewrite lessons/playbook.md as one clean current rule set (paperthin:re0, no incident
// log) and move every lesson a regex can decide into lessons/gate-rules.json, which src/policy/gate.mjs
// applies as ctx.lessonsRules. A generated regex is written only after it compiles, passes a length and
// nested-quantifier check, matches the case text it came from, and stays silent on the operator's
// corrected text and on ordinary polite replies.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../core/instance.mjs';
import { logEvent } from '../core/log.mjs';
import { floorFindings } from '../policy/slop.mjs';
import { runCodex as defaultRunCodex } from '../brain/codex.mjs';
import { readCases } from './outcomes.mjs';
import { readLessons, writeAtomic } from './lessons.mjs';

export const MAX_PATTERN_LENGTH = 200;
const ALLOWED_FLAGS = /^[imsu]*$/;
// A quantified group that itself contains a quantifier, such as (a+)+ or (\w*x)*, backtracks
// exponentially on a near miss; so does a backreference. Both are refused.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/;
const BACKREFERENCE = /\\[1-9]|\\k</;
// Replies any seller sends; a learned rule that matches one of these would block ordinary work.
export const BENIGN_REPLIES = [
  '안녕하세요. 문의 주셔서 감사합니다. 원하시는 구성과 일정을 알려 주시면 견적을 드리겠습니다.',
  '네, 가능합니다. 참고하실 사이트가 있으면 알려 주세요.',
  'Hello, thanks for reaching out. Could you share the scope and the deadline?',
];

const offendingText = (c) => (c.kind === 'operator_correction' ? c.before ?? c.text : c.text);

export function validatePattern({ pattern, flags = 'iu' }, evidenceCases) {
  if (typeof pattern !== 'string' || !pattern) return { ok: false, reason: 'empty pattern' };
  if (pattern.length > MAX_PATTERN_LENGTH) return { ok: false, reason: 'pattern longer than ' + MAX_PATTERN_LENGTH };
  if (!ALLOWED_FLAGS.test(flags)) return { ok: false, reason: 'flags ' + flags + ' are not allowed' };
  if (NESTED_QUANTIFIER.test(pattern)) return { ok: false, reason: 'nested quantifier' };
  if (BACKREFERENCE.test(pattern)) return { ok: false, reason: 'backreference' };
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    return { ok: false, reason: 'does not compile: ' + err.message };
  }
  if (!evidenceCases.length) return { ok: false, reason: 'no evidence case to test against' };
  if (!evidenceCases.some((c) => re.test(offendingText(c)))) return { ok: false, reason: 'does not match the case text it came from' };
  const corrected = evidenceCases.filter((c) => typeof c.after === 'string' && c.after.trim()).map((c) => c.after);
  if (corrected.some((t) => re.test(t))) return { ok: false, reason: 'matches the corrected text the operator approved' };
  if (BENIGN_REPLIES.some((t) => re.test(t))) return { ok: false, reason: 'matches an ordinary polite reply' };
  return { ok: true };
}

export const ruleId = (cls) => String(cls).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'lesson';

export function compileGateRules(lessons, cases) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rules = [];
  const rejected = [];
  for (const l of lessons) {
    if (l.gate !== 'regex') continue;
    const evidence = (l.evidence ?? []).map((id) => byId.get(id)).filter(Boolean);
    const v = validatePattern({ pattern: l.pattern, flags: 'iu' }, evidence);
    if (!v.ok) {
      rejected.push({ class: l.class, pattern: l.pattern, reason: v.reason });
      continue;
    }
    // appliesTo keeps the rule on the platforms its lesson was learned on (src/policy/gate.mjs); evidence names
    // the cases it was checked against.
    rules.push({ id: ruleId(l.class), pattern: l.pattern, flags: 'iu', reason: l.rule, tier: 'floor', appliesTo: l.appliesTo?.length ? l.appliesTo : ['all'], evidence: l.evidence ?? [] });
  }
  return { rules, rejected };
}

export const PLAYBOOK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['playbook'],
  properties: { playbook: { type: 'string', description: 'markdown rule set' } },
};

export function buildPlaybookPrompt(proseLessons, gated, current, findings = []) {
  return [
    'Rewrite the learned playbook of a freelance seller agent with the paperthin:re0 method: one clean current rule set grouped by topic, each rule one imperative line, no incident log, no dates, no case ids, no duplicate rules. Do not run commands; answer only with the JSON the schema describes.',
    'Rules that the outbound gate already enforces are listed so you do not restate them as prose.',
    'Plain markdown: headings and "- " bullets. No em dash, no middle dot, no hype words.',
    '',
    '# Lessons to express as rules',
    JSON.stringify(proseLessons.map((l) => ({ class: l.class, rule: l.rule, appliesTo: l.appliesTo })), null, 1),
    '',
    '# Enforced by the gate (do not restate)',
    JSON.stringify(gated.map((r) => r.reason), null, 1),
    '',
    '# Current playbook',
    current || '(empty)',
    ...(findings.length ? ['', '# Your previous answer failed the slop floor; fix these', ...findings.map((f) => '- ' + f.rule + ': ' + f.excerpt)] : []),
  ].join('\n');
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

export async function refreshPlaybook(instance, { runCodex = defaultRunCodex, model, effort, timeoutMs } = {}) {
  const dir = ensureDir(instance.paths.lessons);
  const lessons = readLessons(instance);
  const { rules, rejected } = compileGateRules(lessons, readCases(instance));
  const gatedClasses = new Set(rules.map((r) => r.id));
  // A regex lesson whose pattern was refused stays a prose rule, so the lesson is not lost.
  const prose = lessons.filter((l) => !(l.gate === 'regex' && gatedClasses.has(ruleId(l.class))));
  const playbookPath = join(dir, 'playbook.md');
  const rulesPath = join(dir, 'gate-rules.json');
  const statePath = join(dir, 'playbook-state.json');
  const fingerprint = sha(JSON.stringify({ prose: prose.map((l) => [l.class, l.rule, l.appliesTo]), rules }));
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};

  const rulesText = JSON.stringify(rules, null, 2) + '\n';
  const rulesChanged = readIf(rulesPath) !== rulesText;
  if (rulesChanged) writeAtomic(rulesPath, rulesText);

  let playbookChanged = false;
  if (state.fingerprint !== fingerprint || !existsSync(playbookPath)) {
    const brain = instance.config?.brain ?? {};
    const current = readIf(playbookPath);
    const ask = async (findings) => (await runCodex({ prompt: buildPlaybookPrompt(prose, rules, current, findings), schema: PLAYBOOK_SCHEMA, model: model ?? brain.model, effort: effort ?? brain.effort, timeoutMs: timeoutMs ?? brain.timeoutMs })).data;
    let text = prose.length ? (await ask([])).playbook : '';
    let findings = floorFindings(text);
    if (findings.length) {
      text = (await ask(findings)).playbook;
      findings = floorFindings(text);
      if (findings.length) throw new Error('playbook rewrite failed the slop floor twice: ' + findings.map((f) => f.rule).join(', '));
    }
    const next = text.trim() ? text.trim() + '\n' : '';
    if (next !== current) {
      writeAtomic(playbookPath, next);
      playbookChanged = true;
    }
    writeAtomic(statePath, JSON.stringify({ fingerprint }, null, 2) + '\n');
  }
  logEvent(instance, 'learning.playbook', { rules: rules.length, rejected: rejected.length, playbookChanged, rulesChanged });
  return { rules, rejected, playbookChanged, rulesChanged };
}
