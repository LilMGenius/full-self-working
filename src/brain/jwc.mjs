// Runs one non-interactive jawcode turn (jwc -p --mode json) and returns the JSON object its last message
// ends with, in the {data, durationMs} shape runCodex returns, so src/jobs/run.mjs can use either executor.
//
// Contract measured 2026-10-25 with jawcode 1.1.2: --mode json prints one JSON event per line on stdout and
// ends with {"type":"agent_end","messages":[...]}. The exit code is not evidence: with its default model
// (codex-mini-latest) the provider answered 404 and jwc still exited 0, with stopReason "error" and the
// errorMessage on the last assistant message. A turn counts only when that message has stopReason "stop".
// The default model is pinned for that reason; openai/gpt-5.6-sol wrote a file and answered in 7.4 s.
//
// jwc has no --output-schema, so the prompt asks for the JSON object and this module parses and checks it.
// jwc has no sandbox either: unlike codex -s workspace-write, a jwc turn can write anywhere the operator
// can. Closing that gap needs an OS-level boundary (a separate low-rights account or a container) around
// the process; until then a recipe chooses jwc only for work whose inputs are the brief and public pages.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_JWC_MODEL = 'openai/gpt-5.6-sol';
const THINKING = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export class JwcError extends Error {
  constructor(message, { code, exitCode = null, stderrTail = '', durationMs = null } = {}) {
    super(message);
    this.name = 'JwcError';
    this.code = code;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
    this.durationMs = durationMs;
  }
}

// The prompt travels as a file (jwc @file), since cmd.exe caps a command line at 8191 characters.
export function jwcArgs({ promptFile, model = DEFAULT_JWC_MODEL, thinking }) {
  const args = ['-p', '--mode', 'json', '--no-session', '--no-title', '--model', model];
  if (thinking) {
    if (!THINKING.includes(thinking)) throw new TypeError('jwc thinking must be one of ' + THINKING.join(', ') + ', got ' + thinking);
    args.push('--thinking', thinking);
  }
  args.push('@' + promptFile, 'Do the task in the attached file.');
  return args;
}

// Finds the JSON object a message ends with: a fenced json block, or the text from its first brace.
function trailingJson(text) {
  const fenced = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].at(-1)?.[1];
  const candidates = [fenced, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)].filter(Boolean);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate; the caller reports the text when none parses
    }
  }
  return null;
}

// Reads jwc --mode json stdout and returns the final assistant text, or throws with the reason.
export function parseJwcStream(stdout) {
  const end = stdout.split(/\r?\n/).filter((l) => l.startsWith('{"type":"agent_end"')).at(-1);
  if (!end) throw new JwcError('jwc printed no agent_end event', { code: 'FSW_JWC_NO_END' });
  const messages = JSON.parse(end).messages ?? [];
  const last = messages.filter((m) => m.role === 'assistant').at(-1);
  if (!last) throw new JwcError('jwc ended without an assistant message', { code: 'FSW_JWC_NO_END' });
  if (last.stopReason !== 'stop') {
    throw new JwcError('jwc turn ended with stopReason ' + last.stopReason + (last.errorMessage ? ': ' + last.errorMessage : ''), { code: 'FSW_JWC_MODEL' });
  }
  return (last.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

export function parseJobAnswer(text) {
  const data = trailingJson(text);
  const ok = data && typeof data.summary === 'string' && Array.isArray(data.files) && Array.isArray(data.openQuestions);
  if (!ok) throw new JwcError('jwc final message holds no {summary, files, openQuestions} object: ' + text.slice(-300), { code: 'FSW_JWC_BAD_JSON' });
  return data;
}

const tail = (s, n = 1200) => (s.length > n ? s.slice(-n) : s);
const quote = (a) => {
  if (/["%\r\n]/.test(a)) throw new TypeError('jwc argument cannot hold a quote, percent sign or newline: ' + a);
  return '"' + a + '"';
};

export async function runJwc({ prompt, model, thinking, cwd, timeoutMs = 3_600_000, bin = process.env.FSW_JWC_BIN ?? 'jwc' }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('runJwc needs a prompt');
  if (!cwd) throw new TypeError('runJwc needs a working directory');
  const dir = mkdtempSync(join(tmpdir(), 'fsw-jwc-'));
  try {
    const promptFile = join(dir, 'prompt.md');
    writeFileSync(promptFile, prompt);
    const args = jwcArgs({ promptFile, model, thinking });
    const started = Date.now();
    const { exitCode, stdout, stderr, timedOut } = await new Promise((resolve, reject) => {
      // jwc is an npm shim (jwc.cmd) on Windows, which only a shell can start; every argument is quoted.
      const win = process.platform === 'win32';
      const child = win
        ? spawn([bin, ...args].map(quote).join(' '), { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let timedOutFlag = false;
      // stdout is kept from the newest agent_end line on; earlier events are progress only.
      child.stdout.on('data', (d) => {
        out += d;
        const at = out.lastIndexOf('{"type":"agent_end"');
        if (at > 0) out = out.slice(at);
        else if (at < 0 && out.length > 1_000_000) out = out.slice(out.lastIndexOf('\n') + 1);
      });
      child.stderr.on('data', (d) => (err = tail(err + d, 8000)));
      const timer = setTimeout(() => {
        timedOutFlag = true;
        if (win && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new JwcError('jwc could not start: ' + e.message, { code: 'FSW_JWC_SPAWN', stderrTail: tail(err) }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout: out, stderr: err, timedOut: timedOutFlag });
      });
    });
    const durationMs = Date.now() - started;
    const meta = { exitCode, stderrTail: tail(stderr), durationMs };
    if (timedOut) throw new JwcError('jwc timed out after ' + timeoutMs + ' ms', { code: 'FSW_JWC_TIMEOUT', ...meta });
    if (exitCode !== 0) throw new JwcError('jwc exited with ' + exitCode, { code: 'FSW_JWC_EXIT', ...meta });
    try {
      return { data: parseJobAnswer(parseJwcStream(stdout)), durationMs };
    } catch (e) {
      throw Object.assign(e, meta);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
