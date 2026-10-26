// Headless Chrome renderer for HTML and URLs (docs/DESIGN.md, src/render/html2png.mjs): OG images,
// listing thumbnails and visual QA captures. Each renderer owns a fresh profile directory under the OS
// temp folder and deletes it on close, so the operator's Chrome profile is never opened. A profile that
// cannot be removed never fails the render: it is reported with its folder named, and the next renderer
// start removes it once no process holds it.
//
// Speaks the Chrome DevTools Protocol directly over Node's built-in WebSocket instead of depending on
// puppeteer-core, which this repository does not install; the calls used (Target.createTarget with a
// flattened session, Emulation.setDeviceMetricsOverride, Page.captureScreenshot with
// captureBeyondViewport) are the ones puppeteer's own page.screenshot path issues.
// https://chromedevtools.github.io/devtools-protocol/
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pageExpression } from '../browser/driver.mjs';

export const DEFAULT_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const PROFILE_PREFIX = 'fsw-render-';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exited = (proc) => proc.exitCode !== null || proc.signalCode !== null;
const describe = (err) => (err?.code ? err.code + ' ' : '') + (err?.message ?? String(err));
const removeDir = (dir) => rmSync(dir, { recursive: true, force: true });

export class RenderError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    Object.assign(this, detail);
  }
}

// Chrome writes the chosen port and the browser target path to DevToolsActivePort once it listens.
async function readActivePort(profile, proc, timeoutMs) {
  const file = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new RenderError('FSW_RENDER_CHROME_EXIT', 'Chrome exited before DevTools came up (exit ' + proc.exitCode + ')');
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, 'utf8').split(/\r?\n/);
      if (port && path) return { port: Number(port), path };
    }
    await sleep(50);
  }
  throw new RenderError('FSW_RENDER_TIMEOUT', 'Chrome did not open DevTools within ' + timeoutMs + ' ms');
}

// Every process that names a Chrome profile folder on its command line, as {pid, commandLine}. Each
// process of a Chrome tree carries the browser's --user-data-dir (read 2026-10-27: the browser,
// crashpad-handler, gpu-process, utility and renderer children), so a folder still names its tree after
// the browser itself exited. Windows has no process list with command lines short of CIM, which costs
// one to three seconds a call, so it runs only when a removal has already failed or leftovers exist.
export function profileProcesses() {
  return new Promise((ok, reject) => {
    const done = (parse) => (err, stdout) => {
      if (err) return reject(new RenderError('FSW_RENDER_PROCESSES', 'cannot list processes: ' + err.message));
      try {
        ok(parse(String(stdout)));
      } catch (e) {
        reject(new RenderError('FSW_RENDER_PROCESSES', 'cannot read the process list: ' + e.message));
      }
    };
    const opts = { windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024 };
    if (process.platform === 'win32') {
      const query = "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%--user-data-dir=%'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], opts, done((out) => {
        const text = out.trim();
        return (text ? [].concat(JSON.parse(text)) : []).map((r) => ({ pid: r.ProcessId, commandLine: r.CommandLine ?? '' }));
      }));
    } else {
      execFile('ps', ['-eo', 'pid=,args='], opts, done((out) => out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: Number(m[1]), commandLine: m[2] }))));
    }
  });
}

// Ends a process and every process it started. taskkill /T finds the children through the parent pid, so
// it reaches the tree only while the browser is alive.
export function killTree(pid) {
  return new Promise((ok) => {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => ok());
    else {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
      ok();
    }
  });
}

// Removes a renderer's profile once nothing holds it, and returns {removed, profile, error, ended}; it never
// throws, since a leftover temp folder must not fail a render that finished. A browser that has not exited
// is ended with its whole tree. When the removal still fails, a process of the tree outlived the browser
// (crashpad-handler, gpu-process, a utility with an open database journal; 2026-10-26 left GrShaderCache,
// GPUPersistentCache, DIPS-wal and first_party_sets.db-journal), so the processes naming the folder are
// ended and awaited before the folder is removed again.
export async function releaseProfile(profile, { proc = null, processes = profileProcesses, kill = killTree, remove = removeDir, wait = sleep, exitWaitMs = 5000, treeWaitMs = 20000, pollMs = 250 } = {}) {
  if (proc && !exited(proc)) {
    await kill(proc.pid);
    for (let waited = 0; !exited(proc) && waited < exitWaitMs; waited += 50) await wait(50);
  }
  let error = null;
  const attempt = () => {
    try {
      remove(profile);
      return true;
    } catch (err) {
      error = err;
      return false;
    }
  };
  if (attempt()) return { removed: true, profile, ended: [] };
  const name = basename(profile);
  const ended = new Set();
  let held = [];
  let listing = null;
  for (let waited = 0; ; waited += pollMs) {
    try {
      held = (await processes()).filter((p) => p.commandLine.includes(name));
    } catch (err) {
      listing = err;
      break;
    }
    if (!held.length || waited >= treeWaitMs) break;
    for (const p of held) {
      if (ended.has(p.pid)) continue;
      ended.add(p.pid);
      await kill(p.pid);
    }
    await wait(pollMs);
  }
  if (!held.length) {
    // A handle can close a moment after its process is gone (an indexer or a scanner reading the folder).
    for (let i = 0; i < 3; i++) {
      if (attempt()) return { removed: true, profile, ended: [...ended] };
      await wait(500);
    }
  }
  const why = [describe(error)];
  if (held.length) why.push('still held by pid ' + held.map((p) => p.pid).join(', '));
  if (listing) why.push(describe(listing));
  return { removed: false, profile, error: why.join('; '), ended: [...ended] };
}

// Profiles earlier renderers left behind (a removal that failed, a process killed mid-render): every
// fsw-render folder in dir older than minAgeMs that no running process names is removed. The age guard
// leaves alone a folder another process has just made and not yet handed to its Chrome. Returns
// {removed, kept, failed: [{profile, error}]}; the process list is read only when there is a candidate.
export async function sweepLeftovers({ dir = tmpdir(), processes = profileProcesses, remove = removeDir, minAgeMs = 10 * 60_000, now = Date.now() } = {}) {
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(PROFILE_PREFIX))
    .map((d) => d.name)
    .filter((name) => {
      try {
        return now - statSync(join(dir, name)).mtimeMs >= minAgeMs;
      } catch {
        return false;
      }
    });
  const out = { removed: [], kept: [], failed: [] };
  if (!candidates.length) return out;
  const lines = (await processes()).map((p) => p.commandLine);
  for (const name of candidates) {
    const profile = join(dir, name);
    if (lines.some((l) => l.includes(name))) out.kept.push(profile);
    else {
      try {
        remove(profile);
        out.removed.push(profile);
      } catch (err) {
        out.failed.push({ profile, removed: false, error: describe(err) });
      }
    }
  }
  return out;
}

export const reportLeftover = ({ profile, error }) =>
  process.emitWarning('render profile ' + profile + ' could not be removed (' + error + '); the next renderer start removes it once no process holds it', { code: 'FSW_RENDER_LEFTOVER' });

function connect(url) {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolveWs(ws), { once: true });
    ws.addEventListener('error', () => reject(new RenderError('FSW_RENDER_CDP', 'cannot connect to ' + url)), { once: true });
  });
}

function cdpClient(ws) {
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new RenderError('FSW_RENDER_CDP', method + ': ' + msg.error.message));
      else ok(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });
  ws.addEventListener('close', () => {
    for (const { reject, method } of pending.values()) reject(new RenderError('FSW_RENDER_CDP', method + ': connection closed'));
    pending.clear();
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return new Promise((ok, reject) => pending.set(id, { resolve: ok, reject, method }));
    },
    waitFor(method, sessionId, timeoutMs) {
      return new Promise((ok, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(fn);
          reject(new RenderError('FSW_RENDER_TIMEOUT', method + ' not received within ' + timeoutMs + ' ms'));
        }, timeoutMs);
        const fn = (msg) => {
          if (msg.method === method && msg.sessionId === sessionId) {
            clearTimeout(timer);
            listeners.delete(fn);
            ok(msg.params);
          }
        };
        listeners.add(fn);
      });
    },
  };
}

// Resolves once every web font has loaded and every <img> has settled, so a capture never shows a
// fallback face or a half-decoded image. Lazy images are switched to eager first, since one below the
// fold never starts loading in a viewport capture; each image wait is bounded so a stalled host cannot
// hang the render.
const SETTLE = '(async () => {' +
  'await document.fonts.ready;' +
  'for (const i of document.images) if (i.loading === "lazy") i.loading = "eager";' +
  'await Promise.all([...document.images].map((i) => i.complete ? null : Promise.race([' +
  'new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); }),' +
  'new Promise((r) => setTimeout(r, 15000))])));' +
  'await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));' +
  'return { fonts: document.fonts.status, broken: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.currentSrc || i.src) };' +
  '})()';

// tempRoot, processes, kill, remove and onLeftover are the seams the cleanup runs through (tests replace them).
export async function openRenderer({ chrome = process.env.FSW_CHROME ?? DEFAULT_CHROME, timeoutMs = 30000, tempRoot = tmpdir(), processes = profileProcesses, kill = killTree, remove = removeDir, onLeftover = reportLeftover } = {}) {
  if (!existsSync(chrome)) throw new RenderError('FSW_RENDER_NO_CHROME', 'Chrome not found at ' + chrome);
  try {
    for (const left of (await sweepLeftovers({ dir: tempRoot, processes, remove })).failed) onLeftover(left);
  } catch (err) {
    onLeftover({ profile: join(tempRoot, PROFILE_PREFIX + '*'), removed: false, error: 'the leftover sweep failed: ' + describe(err) });
  }
  const profile = mkdtempSync(join(tempRoot, PROFILE_PREFIX));
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-sync', '--force-color-profile=srgb', '--font-render-hinting=none',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  const release = async () => {
    const r = await releaseProfile(profile, { proc, processes, kill, remove });
    if (!r.removed) onLeftover(r);
    return r;
  };
  let cdp;
  let ws;
  try {
    const { port, path } = await readActivePort(profile, proc, timeoutMs);
    ws = await connect('ws://127.0.0.1:' + port + path);
    cdp = cdpClient(ws);
  } catch (err) {
    // Chrome holds its profile files until its tree has exited; a removal that still fails is attached to
    // the startup error instead of replacing it.
    const released = await release();
    if (!released.removed) err.cleanup = released.error;
    throw err;
  }

  async function render(opts) {
    const { html, url, width = 1440, height = 900, fullPage = false, out, format = 'jpeg', quality = 82,
      maxSide = null, clip = null, probe = null, scale = 1 } = opts;
    if (!out) throw new RenderError('FSW_RENDER_ARGS', 'out is required');
    if (!html === !url) throw new RenderError('FSW_RENDER_ARGS', 'pass exactly one of html or url');
    if (!['jpeg', 'png'].includes(format)) throw new RenderError('FSW_RENDER_ARGS', 'format must be jpeg or png');
    let target = url;
    if (html) {
      const file = join(profile, 'page-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.html');
      writeFileSync(file, html);
      target = pathToFileURL(file).href;
    }
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    try {
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 768 }, sessionId);
      const loaded = cdp.waitFor('Page.loadEventFired', sessionId, timeoutMs);
      const nav = await cdp.send('Page.navigate', { url: target }, sessionId);
      if (nav.errorText) throw new RenderError('FSW_RENDER_NAVIGATE', 'navigation to ' + target + ' failed: ' + nav.errorText);
      await loaded;
      const settled = await cdp.send('Runtime.evaluate', { expression: SETTLE, awaitPromise: true, returnByValue: true }, sessionId);
      const state = settled.result?.value ?? {};
      let probed = null;
      if (probe) {
        const r = await cdp.send('Runtime.evaluate', { expression: probe, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new RenderError('FSW_RENDER_PROBE', 'probe threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
        probed = r.result?.value ?? null;
      }
      const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
      const content = metrics.cssContentSize ?? metrics.contentSize;
      let region = { x: 0, y: 0, width, height };
      if (fullPage) region = { x: 0, y: 0, width, height: Math.ceil(content.height) };
      if (clip) region = { x: clip.x ?? 0, y: clip.y ?? 0, width: clip.width ?? width, height: clip.height ?? height };
      // maxSide downsamples the capture so its long side stays within the limit (for images a model reads).
      const shrink = maxSide ? Math.min(1, maxSide / Math.max(region.width * scale, region.height * scale)) : 1;
      const shot = await cdp.send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality } : {}),
        captureBeyondViewport: fullPage || Boolean(clip),
        clip: { ...region, scale: shrink },
      }, sessionId);
      const bytes = Buffer.from(shot.data, 'base64');
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(out, bytes);
      return {
        out: resolve(out),
        width: Math.round(region.width * scale * shrink),
        height: Math.round(region.height * scale * shrink),
        bytes: bytes.length,
        contentHeight: Math.ceil(content.height),
        fonts: state.fonts ?? null,
        brokenImages: state.broken ?? [],
        probe: probed,
      };
    } finally {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  async function close() {
    await cdp.send('Browser.close').catch(() => {});
    const deadline = Date.now() + 5000;
    while (!exited(proc) && Date.now() < deadline) await sleep(50);
    ws?.close();
    return release();
  }

  // Which font drew the text of every element that holds text, summed per face: CDP
  // CSS.getPlatformFontsForNode, the renderer's own record, so a fallback cannot hide behind a stack.
  async function platformFonts(sessionId) {
    await cdp.send('DOM.enable', {}, sessionId);
    await cdp.send('CSS.enable', {}, sessionId);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 }, sessionId);
    const holders = [];
    const walk = (node) => {
      if (node.nodeType === 1 && (node.children ?? []).some((c) => c.nodeType === 3 && c.nodeValue.trim())) holders.push(node.nodeId);
      for (const c of node.children ?? []) walk(c);
    };
    walk(root);
    const faces = new Map();
    for (const nodeId of holders) {
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }, sessionId);
      for (const f of fonts) {
        const key = f.familyName + '|' + f.isCustomFont;
        const prev = faces.get(key) ?? { familyName: f.familyName, isCustomFont: f.isCustomFont, glyphCount: 0 };
        prev.glyphCount += f.glyphCount;
        faces.set(key, prev);
      }
    }
    return [...faces.values()];
  }

  // An HTML page printed to PDF through Page.printToPDF, the call puppeteer's page.pdf issues. The page's
  // own @page rule sets size and margins (preferCSSPageSize) and backgrounds print. It waits for fonts and
  // images the way render does and returns the per-face font report; callers also read the embedded fonts
  // back from the file (src/render/fonts.mjs).
  async function pdf({ html, out }) {
    if (!html || !out) throw new RenderError('FSW_RENDER_ARGS', 'pdf needs html and out');
    const file = join(profile, 'page-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.html');
    writeFileSync(file, html);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    try {
      await cdp.send('Page.enable', {}, sessionId);
      const loaded = cdp.waitFor('Page.loadEventFired', sessionId, timeoutMs);
      const nav = await cdp.send('Page.navigate', { url: pathToFileURL(file).href }, sessionId);
      if (nav.errorText) throw new RenderError('FSW_RENDER_NAVIGATE', 'navigation to ' + file + ' failed: ' + nav.errorText);
      await loaded;
      const settled = await cdp.send('Runtime.evaluate', { expression: SETTLE, awaitPromise: true, returnByValue: true }, sessionId);
      const faces = await platformFonts(sessionId);
      const { data } = await cdp.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false }, sessionId);
      const bytes = Buffer.from(data, 'base64');
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(out, bytes);
      return { out: resolve(out), bytes: bytes.length, fonts: settled.result?.value?.fonts ?? null, platformFonts: faces };
    } finally {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  // A tab that stays open across navigations, for reading public pages with this owned browser
  // (market sampling) so no read rides on the operator's signed-in session. It offers the two calls the
  // samplers use on a driver session: navigate(url, {settle}) and evaluate(fn, arg).
  async function page({ width = 1280, height = 1800 } = {}) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    return {
      async navigate(url, { settle = 3000 } = {}) {
        const loaded = cdp.waitFor('Page.loadEventFired', sessionId, timeoutMs);
        const nav = await cdp.send('Page.navigate', { url }, sessionId);
        if (nav.errorText) throw new RenderError('FSW_RENDER_NAVIGATE', 'navigation to ' + url + ' failed: ' + nav.errorText);
        await loaded;
        if (settle > 0) await sleep(settle);
      },
      async evaluate(fn, arg) {
        const r = await cdp.send('Runtime.evaluate', { expression: pageExpression(fn, arg), awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new RenderError('FSW_RENDER_PROBE', 'evaluate threw: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
        return JSON.parse(r.result.value);
      },
      close: () => cdp.send('Target.closeTarget', { targetId }),
    };
  }

  return { render, page, pdf, close, profile };
}

// One-shot render: opens a renderer, captures, closes. Use openRenderer for several captures.
export async function renderHtml(opts) {
  const renderer = await openRenderer({ chrome: opts.chrome, timeoutMs: opts.timeoutMs });
  try {
    return await renderer.render(opts);
  } finally {
    await renderer.close();
  }
}
