// Runs one non-interactive `codex exec` turn with a JSON output schema and returns the parsed last message.
//
// Invocation measured 2026-10-25 on the operator machine (codex-cli 0.164.0, gpt-6.1-sol, effort low,
// trivial schema {ok: boolean}, two sequential rounds a b c a b c, every run answered {"ok":true}):
//   (a) plain user config: 30.3 s and 21.5 s, because six SessionStart, four UserPromptSubmit and two
//       Stop hooks plus plugins and MCP servers load on every turn (40.7k tokens).
//   (b) --ignore-user-config with openai_base_url on the opencodex proxy: 7.6 s and 8.0 s, and every turn
//       first logs a failed websocket upgrade (426 Upgrade Required) before falling back to HTTP.
//   (c) --ignore-user-config with an inline provider on the same proxy and supports_websockets=false:
//       5.2 s and 4.9 s, no failed upgrade; cpa/claude-opus-5-5 also answered through the proxy.
// (c) is the default. FSW_CODEX_PROXY=none falls back to (a) when the proxy is not running.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PROXY_URL = 'http://127.0.0.1:10100/v1';

export class CodexError extends Error {
  constructor(message, { code, exitCode = null, stderrTail = '', durationMs = null } = {}) {
    super(message);
    this.name = 'CodexError';
    this.code = code;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
    this.durationMs = durationMs;
  }
}

// Arguments for one turn. `proxyUrl: null` runs with the plain user config (variant a).
// --ignore-user-config also drops [windows] sandbox, and without it codex 0.164.0 on Windows runs a
// workspace-write turn read-only (its banner says "sandbox: read-only" and every write is "blocked by
// policy"; measured 2026-10-25), so a writing turn names the Windows sandbox itself.
export function codexArgs({ schemaFile, outFile, model, effort, cwd, sandbox = 'read-only', proxyUrl = DEFAULT_PROXY_URL, platform = process.platform, windowsSandbox = process.env.FSW_CODEX_WINDOWS_SANDBOX ?? 'elevated' }) {
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-s', sandbox, '--output-schema', schemaFile, '--output-last-message', outFile, '--color', 'never'];
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (cwd) args.push('-C', cwd);
  if (proxyUrl) {
    args.push('--ignore-user-config', '-c', `model_providers.fsw={name="fsw",base_url="${proxyUrl}",wire_api="responses",supports_websockets=false}`, '-c', 'model_provider="fsw"');
    if (platform === 'win32' && sandbox !== 'read-only') args.push('-c', `windows.sandbox="${windowsSandbox}"`);
  }
  args.push('-');
  return args;
}

const tail = (s, n = 1200) => (s.length > n ? s.slice(-n) : s);

export async function runCodex({ prompt, schema, model, effort, cwd, sandbox, timeoutMs = 240_000, proxyUrl = process.env.FSW_CODEX_PROXY ?? DEFAULT_PROXY_URL, bin = process.env.FSW_CODEX_BIN ?? 'codex' }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('runCodex needs a prompt');
  if (!schema || typeof schema !== 'object') throw new TypeError('runCodex needs a JSON schema object');
  const dir = mkdtempSync(join(tmpdir(), 'fsw-codex-'));
  const schemaFile = join(dir, 'schema.json');
  const outFile = join(dir, 'last.txt');
  writeFileSync(schemaFile, JSON.stringify(schema));
  const args = codexArgs({ schemaFile, outFile, model, effort, cwd, sandbox, proxyUrl: proxyUrl === '' || proxyUrl === 'none' ? null : proxyUrl });
  const started = Date.now();
  try {
    const { exitCode, stderr, timedOut } = await new Promise((resolve, reject) => {
      // No shell: libuv finds codex.exe on PATH and quotes each argument; the prompt travels on stdin.
      const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stderrBuf = '';
      let timedOutFlag = false;
      child.stdout.on('data', (d) => (stderrBuf = tail(stderrBuf + d, 8000)));
      child.stderr.on('data', (d) => (stderrBuf = tail(stderrBuf + d, 8000)));
      const timer = setTimeout(() => {
        timedOutFlag = true;
        killTree(child);
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new CodexError(`codex could not start: ${err.message}`, { code: 'FSW_CODEX_SPAWN', stderrTail: tail(stderrBuf) }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stderr: stderrBuf, timedOut: timedOutFlag });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
    const durationMs = Date.now() - started;
    const meta = { exitCode, stderrTail: tail(stderr), durationMs };
    if (timedOut) throw new CodexError(`codex exec timed out after ${timeoutMs} ms`, { code: 'FSW_CODEX_TIMEOUT', ...meta });
    if (exitCode !== 0) throw new CodexError(`codex exec exited with ${exitCode}`, { code: 'FSW_CODEX_EXIT', ...meta });
    let raw;
    try {
      raw = readFileSync(outFile, 'utf8');
    } catch {
      throw new CodexError('codex exec wrote no last message', { code: 'FSW_CODEX_NO_OUTPUT', ...meta });
    }
    try {
      return { data: JSON.parse(raw), durationMs };
    } catch {
      throw new CodexError(`codex last message is not JSON: ${tail(raw, 300)}`, { code: 'FSW_CODEX_BAD_JSON', ...meta });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// codex starts its own children (sandbox helpers, tools), so a timeout kills the whole tree.
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else child.kill('SIGKILL');
}
