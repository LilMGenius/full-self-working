// Headless Chrome renderer for HTML and URLs (docs/DESIGN.md, src/render/html2png.mjs): OG images,
// listing thumbnails and visual QA captures. Each renderer owns a fresh profile directory under the OS
// temp folder and deletes it on close, so the operator's Chrome profile is never opened.
//
// Speaks the Chrome DevTools Protocol directly over Node's built-in WebSocket instead of depending on
// puppeteer-core, which this repository does not install; the calls used (Target.createTarget with a
// flattened session, Emulation.setDeviceMetricsOverride, Page.captureScreenshot with
// captureBeyondViewport) are the ones puppeteer's own page.screenshot path issues.
// https://chromedevtools.github.io/devtools-protocol/
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pageExpression } from '../browser/driver.mjs';

export const DEFAULT_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

export async function openRenderer({ chrome = process.env.FSW_CHROME ?? DEFAULT_CHROME, timeoutMs = 30000 } = {}) {
  if (!existsSync(chrome)) throw new RenderError('FSW_RENDER_NO_CHROME', 'Chrome not found at ' + chrome);
  const profile = mkdtempSync(join(tmpdir(), 'fsw-render-'));
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-sync', '--force-color-profile=srgb', '--font-render-hinting=none',
    '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let ws;
  try {
    const { port, path } = await readActivePort(profile, proc, timeoutMs);
    ws = await connect('ws://127.0.0.1:' + port + path);
    cdp = cdpClient(ws);
  } catch (err) {
    proc.kill();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
    while (proc.exitCode === null && Date.now() < deadline) await sleep(50);
    if (proc.exitCode === null) proc.kill();
    ws?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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

  return { render, page, close, profile };
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
