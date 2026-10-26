// Record and replay at the extractor level (architect D2). A driver session is wrapped so every call is one
// JSON line {seq, op, name, arg, answer | error, at}: navigate (name is the URL), evaluate (name is the
// page-side function's name, or inline:<sha1> for an anonymous one), snapshot, and act for every page
// action (click, fill, press, typeKeys, setFiles, wheel). A replay session answers the same calls in the
// same order and fails by name on the first call that differs, so a surface, its parsers and the loop run
// against what a real page returned. Recordings with customer text stay under the instance
// (qa/surfaces/<platform>/<day>/); committed fixtures are synthetic.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { dayKey, seoulParts } from '../core/clock.mjs';

const ACTIONS = ['click', 'fill', 'press', 'typeKeys', 'setFiles', 'wheel'];
const sha = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 8);

export const extractorName = (fn) => (typeof fn === 'function' ? fn.name || 'inline:' + sha(fn) : 'expr:' + sha(fn));

// <instanceDir>/qa/surfaces/<platform>/<Seoul day>/<HHMMSS>-<label>.jsonl
export function recordingPath(instanceDir, platform, label, now = new Date()) {
  const p = seoulParts(now);
  const hms = [p.hour, p.minute, p.second].map((n) => String(n).padStart(2, '0')).join('');
  return join(instanceDir, 'qa', 'surfaces', platform, dayKey(now), hms + '-' + label + '.jsonl');
}

export function readRecording(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function recordSession(session, file) {
  mkdirSync(dirname(file), { recursive: true });
  let seq = 0;
  const write = (entry) => appendFileSync(file, JSON.stringify({ seq: seq++, ...entry, at: new Date().toISOString() }) + '\n');
  const wrap = (op, name, arg, call) => Promise.resolve().then(call).then(
    (answer) => {
      write({ op, name, arg: arg ?? null, answer: answer ?? null });
      return answer;
    },
    (err) => {
      write({ op, name, arg: arg ?? null, error: { message: err.message, code: err.code ?? null } });
      throw err;
    },
  );
  const out = {
    ...session,
    file,
    navigate: (url, opts) => wrap('navigate', url, null, () => session.navigate(url, opts)),
    evaluate: (fn, arg, opts) => wrap('evaluate', extractorName(fn), arg, () => session.evaluate(fn, arg, opts)),
    snapshot: (opts) => wrap('snapshot', 'snapshot', null, () => session.snapshot(opts)),
    stop: () => session.stop(),
  };
  for (const a of ACTIONS) if (session[a]) out[a] = (...args) => wrap('act', a, args.map((x) => (typeof x === 'object' ? null : x)), () => session[a](...args));
  Object.defineProperty(out, 'loads', { get: () => session.loads });
  return out;
}

function diverged(entry, op, name, seq) {
  return Object.assign(new Error('replay diverged at call ' + seq + ': the recording has ' + (entry ? entry.op + ' ' + entry.name : 'no more calls') + ', the surface asked ' + op + ' ' + name), { code: 'FSW_REPLAY_DIVERGED', seq });
}

// entries: a recording file path or its parsed lines.
export function replaySession(entries) {
  const calls = typeof entries === 'string' ? readRecording(entries) : [...entries];
  let i = 0;
  const next = (op, name) => {
    const entry = calls[i];
    if (!entry || entry.op !== op || entry.name !== name) throw diverged(entry, op, name, i);
    i += 1;
    if (entry.error) throw Object.assign(new Error(entry.error.message), { code: entry.error.code });
    return entry.answer;
  };
  const s = {
    loads: 0,
    replay: true,
    guard: { beforeLoad: async () => {}, beforeAction: () => {}, beforeMessage: () => {} },
    navigate: async (url) => {
      s.loads += 1;
      return next('navigate', url);
    },
    evaluate: async (fn) => next('evaluate', extractorName(fn)),
    snapshot: async () => next('snapshot', 'snapshot'),
    remaining: () => calls.length - i,
    stop: async () => {},
  };
  for (const a of ACTIONS) s[a] = async () => next('act', a);
  return s;
}
