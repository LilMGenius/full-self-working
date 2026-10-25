// Drives the operator's signed-in Chrome through the omowright attached engine (BrowserSkill).
// docs/DESIGN.md (Browser) is the contract. omowright is resolved at call time from the newest omo
// plugin version, since an installer can replace the version directory under a running process;
// FSW_OMOWRIGHT overrides it with a path to skills/browser/scripts/omowright.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInstance } from '../core/instance.mjs';

const OMO_CACHE = join(homedir(), '.codex', 'plugins', 'cache', 'sisyphuslabs', 'omo');
const SCRIPT = join('skills', 'browser', 'scripts', 'omowright.mjs');
const HOUR_MS = 3_600_000;

const versionKey = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(6, '0') : p)).join('.');

export function resolveOmowrightScript(env = process.env, cacheDir = OMO_CACHE) {
  if (env.FSW_OMOWRIGHT) return env.FSW_OMOWRIGHT;
  const versions = existsSync(cacheDir) ? readdirSync(cacheDir).filter((v) => existsSync(join(cacheDir, v, SCRIPT))) : [];
  if (!versions.length) throw Object.assign(new Error(`no omowright under ${cacheDir}; set FSW_OMOWRIGHT`), { code: 'FSW_NO_OMOWRIGHT' });
  versions.sort((a, b) => (versionKey(a) < versionKey(b) ? 1 : -1));
  return join(cacheDir, versions[0], SCRIPT);
}

export class PacingLimitError extends Error {
  constructor(platform, kind, limit) {
    super(`${platform}: ${kind} limit of ${limit} per hour reached`);
    this.code = 'FSW_PACING_LIMIT';
    this.platform = platform;
    this.kind = kind;
  }
}

// Enforces a descriptor's pacing across every session in one process: page loads keep minGapMs
// apart (waiting), and actions and messages within a rolling hour stop at their caps (throwing,
// since waiting out an hour inside a tick would stall every other platform).
export function createPacingGuard(platform, pacing, { now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const { minGapMs = 0, maxActionsPerHour = Infinity, maxMessagesPerHour = Infinity } = pacing ?? {};
  let lastLoad = -Infinity;
  const actions = [];
  const messages = [];
  const take = (list, cap, kind) => {
    const t = now();
    while (list.length && list[0] <= t - HOUR_MS) list.shift();
    if (list.length >= cap) throw new PacingLimitError(platform, kind, cap);
    list.push(t);
  };
  return {
    platform,
    pacing: { minGapMs, maxActionsPerHour, maxMessagesPerHour },
    async beforeLoad() {
      const wait = lastLoad + minGapMs - now();
      if (wait > 0) await sleep(wait);
      take(actions, maxActionsPerHour, 'action');
      lastLoad = now();
    },
    beforeAction() {
      take(actions, maxActionsPerHour, 'action');
    },
    beforeMessage() {
      take(messages, maxMessagesPerHour, 'message');
    },
    counts: () => ({ actions: actions.length, messages: messages.length }),
  };
}

const guards = new Map();
export function pacingFor(platform, pacing) {
  if (!guards.has(platform)) guards.set(platform, createPacingGuard(platform, pacing));
  return guards.get(platform);
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf', '.zip': 'application/zip', '.mp4': 'video/mp4', '.txt': 'text/plain', '.html': 'text/html' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targetParams = (target) => (/^@?e\d+$/.test(target) ? { ref: target.replace(/^@/, '') } : { selector: target });

// Wraps a function so it runs in the page and its JSON-serialisable result comes back parsed.
export function pageExpression(fn, arg) {
  const call = typeof fn === 'function' ? `(${fn})(${JSON.stringify(arg ?? null)})` : fn;
  return `Promise.resolve(${call}).then((v) => JSON.stringify(v === undefined ? null : v))`;
}

// Chooses the BrowserSkill browser a session starts in, from the daemon's online list. config.browser
// names the operator's browser by the instance id or label `bsk browsers` shows (both report Chrome as
// chrome, Aside too, so name and version cannot tell them apart). The configured one wins while it is
// online; with it absent or unset, a single online browser is taken, since an id can change when Chrome
// or the extension restarts; several online and none configured is an error naming them. On 2026-10-26
// the Aside browser connected beside the operator's Chrome and every session start that named no browser
// failed with multiple_browsers_online.
export function pickBrowser(browsers, wanted) {
  const hit = wanted ? browsers.find((b) => b.instance_id === wanted || (b.label && b.label === wanted)) : null;
  if (hit) return hit.instance_id;
  if (browsers.length <= 1) return browsers[0]?.instance_id;
  const names = browsers.map((b) => b.instance_id + (b.label ? ' (' + b.label + ')' : '') + ' ' + b.browser_name + ' ' + b.browser_version).join(', ');
  throw Object.assign(new Error((wanted ? 'config.browser ' + wanted + ' is not online' : 'config.browser is unset') + ' and ' + browsers.length + ' browsers are: ' + names), { code: 'FSW_BROWSER_AMBIGUOUS' });
}

export async function openSession(name, { platform = name, pacing, settleMs = 6000, browser = loadInstance().config?.browser ?? null } = {}) {
  process.env.BSK_AUTO_START = '0';
  const { loadOmowright } = await import(pathToFileURL(resolveOmowrightScript()).href);
  const { omowright } = await loadOmowright();
  const client = new omowright.BskIpcClient({});
  const chosen = pickBrowser(await omowright.listBrowsers(client, { waitForBrowserMs: 15_000 }), browser);
  const session = await omowright.connectBrowserSkill({ client, name: `fsw-${name}`, focused: false, browser: chosen });
  const guard = pacingFor(platform, pacing);
  const call = (method, params) => session.client.call(method, { session_id: session.sessionId, ...params }, { idPrefix: method.replace(/\W/g, '-') });
  // Chrome reads an uploaded file from the daemon's staging path when the page submits it, so a
  // transfer is released only when the session stops.
  const staged = [];

  const api = {
    session,
    guard,
    loads: 0,
    async navigate(url, { settle = settleMs, timeoutMs = 45_000 } = {}) {
      await guard.beforeLoad();
      api.loads += 1;
      await session.navigate(url, { waitUntil: 'load', timeoutMs });
      if (settle > 0) await sleep(settle);
      return api.evaluate(() => location.href);
    },
    async evaluate(fn, arg, { timeoutMs = 20_000 } = {}) {
      const r = await session.evaluate(pageExpression(fn, arg), { awaitPromise: true, returnByValue: true, timeoutMs });
      if (r?.ok === false) throw Object.assign(new Error(`evaluate failed: ${r.error?.message ?? JSON.stringify(r.error)}`), { code: 'FSW_EVALUATE' });
      const value = r?.value ?? r?.result;
      return typeof value === 'string' ? JSON.parse(value) : value;
    },
    snapshot: (opts) => session.snapshot(opts),
    async click(target, opts) {
      guard.beforeAction();
      return session.click(target, opts);
    },
    async fill(target, value, opts = {}) {
      guard.beforeAction();
      return session.fill(target, value, { clearBefore: true, ...opts });
    },
    async press(key, opts) {
      guard.beforeAction();
      return session.press(key, opts);
    },
    // For inputs that reformat on every keystroke (thousand separators), where fill() loses its
    // target: focus, empty the field with End and Backspace, then press each character (a space is the
    // key named Space, since the engine rejects an empty key name). One action; keyGapMs paces the keys
    // like a person typing.
    async typeKeys(target, text, { keyGapMs = 0 } = {}) {
      guard.beforeAction();
      await session.focus(target);
      const length = await api.evaluate((sel) => document.querySelector(sel)?.value.length ?? 0, target);
      await session.press('End', { target });
      for (let i = 0; i < length; i++) await session.press('Backspace', { target });
      for (const ch of String(text)) {
        await session.press(ch === ' ' ? 'Space' : ch, { target });
        if (keyGapMs > 0) await sleep(keyGapMs);
      }
    },
    wheel: (opts) => session.wheel(opts),
    // Stages each file through the daemon's transfer channel, then hands them to the file input.
    async setFiles(target, paths) {
      guard.beforeAction();
      const files = [];
      for (const path of [paths].flat()) {
        const bytes = readFileSync(path);
        const meta = { name: basename(path), mime_type: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' };
        const { transfer_id: id, chunk_size: size } = await call('transfer.begin', { ...meta, byte_size: bytes.length });
        staged.push(id);
        files.push({ transfer_id: id, ...meta });
        for (let offset = 0; offset < bytes.length; offset += size) {
          await call('transfer.chunk', { transfer_id: id, offset, data_base64: bytes.subarray(offset, offset + size).toString('base64') });
        }
        await call('transfer.finish', { transfer_id: id });
      }
      return session.tool('upload', { files, ...targetParams(target) });
    },
    // Viewport capture written to disk as JPEG with the long side capped, never returned as bytes.
    async screenshot(out, { maxSide = 1600 } = {}) {
      const shot = await session.screenshot();
      mkdirSync(dirname(out), { recursive: true });
      const fit = `scale='if(gte(iw,ih),min(${maxSide},iw),-2)':'if(gte(iw,ih),-2,min(${maxSide},ih))'`;
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'png_pipe', '-i', 'pipe:0', '-vf', fit, '-q:v', '4', out], { input: shot.buffer });
      return { path: out, sourceWidth: shot.width, sourceHeight: shot.height };
    },
    async stop() {
      for (const id of staged.splice(0)) await call('transfer.release', { transfer_id: id }).catch(() => {});
      return session.stop();
    },
  };
  return api;
}

export async function withSession(name, fn, opts) {
  const s = await openSession(name, opts);
  try {
    return await fn(s);
  } finally {
    await s.stop();
  }
}
