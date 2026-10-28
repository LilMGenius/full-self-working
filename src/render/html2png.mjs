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
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pageExpression } from '../browser/driver.mjs';
import { SETTLE, cdpClient, connect } from './cdp.mjs';
import { KILL_TIMEOUT_MS, PROFILE_PREFIX, RenderError, TREE_WAIT_MS, describe, exited, killTree, profileProcesses, readActivePort, releaseProfile, removeDir, reportLeftover, reportWait, sleep, sweepLeftovers, within } from './profile.mjs';

export const DEFAULT_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// How long close gives the browser to exit after Browser.close before ending its tree.
const CLOSE_GRACE_MS = 5000;
// How long close then waits for the killed browser to finish exiting, the kill included. Exit normally
// comes within a second; at 93% memory it took 43 s (2026-10-27), during which taskkill refuses the
// terminating process and its profile cannot be removed. Grace and exit wait are close's whole deadline:
// the profile release after them skips its own kill and gets only the time left, so a close that meets a
// browser which never exits returns within about 65 s.
const EXIT_WAIT_MS = 60000;
// tempRoot, processes, kill, remove, onLeftover and warn are the seams the cleanup runs through, and
// closeGraceMs and exitWaitMs set close's deadline (tests replace them).
export async function openRenderer({ chrome = process.env.FSW_CHROME ?? DEFAULT_CHROME, timeoutMs = 30000, tempRoot = tmpdir(), processes = profileProcesses, kill = killTree, remove = removeDir, onLeftover = reportLeftover, warn = reportWait, closeGraceMs = CLOSE_GRACE_MS, exitWaitMs = EXIT_WAIT_MS } = {}) {
  if (!existsSync(chrome)) throw new RenderError('FSW_RENDER_NO_CHROME', 'Chrome not found at ' + chrome);
  try {
    for (const left of (await sweepLeftovers({ dir: tempRoot, processes, remove })).failed) onLeftover(left);
  } catch (err) {
    onLeftover({ profile: join(tempRoot, PROFILE_PREFIX + '*'), removed: false, error: 'the leftover sweep failed: ' + describe(err) });
  }
  const profile = mkdtempSync(join(tempRoot, PROFILE_PREFIX));
  // A start that fails keeps the system error as its cause: spawn throws for a file Windows cannot run
  // (EFTYPE) and emits error for one it cannot find (ENOENT), which readActivePort sees only as an exit code.
  const notStarted = (cause, cleanup) => new RenderError('FSW_RENDER_SPAWN', 'Chrome at ' + chrome + ' did not start: ' + describe(cause), { cause, ...(cleanup ? { cleanup } : {}) });
  let proc;
  try {
    proc = spawn(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
      '--disable-sync', '--force-color-profile=srgb', '--font-render-hinting=none',
      '--user-data-dir=' + profile, '--remote-debugging-port=0', 'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
  } catch (err) {
    const released = await releaseProfile(profile, { processes, kill, remove, warn });
    if (!released.removed) onLeftover(released);
    throw notStarted(err, released.removed ? null : released.error);
  }
  let spawnError = null;
  // Resolves once the browser process has exited. Under load a closed browser can stay in Windows' exit
  // for tens of seconds (43 s after Browser.close, measured 2026-10-27 at 93% memory) while taskkill
  // refuses a process that is already terminating, so a caller that releases the profile later without
  // the process handle waits on this first.
  const browserExit = new Promise((ok) => {
    proc.once('exit', () => ok());
    proc.once('error', (err) => {
      spawnError = err;
      ok();
    });
  });
  // A close has already ended the browser and waited for it, so its release skips that pass (proc null)
  // and gets only what is left of close's deadline.
  const release = async ({ waited = false, treeWaitMs = TREE_WAIT_MS } = {}) => {
    const r = await releaseProfile(profile, { proc: waited ? null : proc, processes, kill, remove, warn, treeWaitMs });
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
    if (spawnError) throw notStarted(spawnError, released.removed ? null : released.error);
    if (!released.removed) err.cleanup = released.error;
    throw err;
  }

  async function render(opts) {
    const { html, url, width = 1440, height = 900, fullPage = false, out, format = 'jpeg', quality = 82,
      maxSide = null, clip = null, probe = null, scale = 1, fontReport = false } = opts;
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
      // The renderer's own record of which face drew each text node (CDP CSS.getPlatformFontsForNode), so a
      // capture proves its font; fonts below is only the loading status the settle script read.
      const faces = fontReport ? await platformFonts(sessionId) : null;
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
        platformFonts: faces,
        brokenImages: state.broken ?? [],
        probe: probed,
      };
    } finally {
      // cleanup: a target already gone needs no close, and the capture above already holds its result
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  async function close() {
    const deadline = Date.now() + closeGraceMs + exitWaitMs;
    const left = () => Math.max(0, deadline - Date.now());
    // The reply to Browser.close is not awaited, since a hung browser never sends it and a closing one
    // usually loses it with the connection; any other answer is recorded.
    Promise.resolve().then(() => cdp.send('Browser.close')).catch((err) => {
      if (!/connection closed$/.test(err.message)) warn('Browser.close', err);
    });
    // The profile is released only after the browser's real exit (the exit event, not a poll that gives up),
    // and a browser that ignores Browser.close through the grace is ended with its tree first.
    const exitWithin = (ms) => within(browserExit, ms, 'the browser exit').catch((err) => warn('closing browser pid ' + proc.pid + ' of ' + profile, err));
    await exitWithin(closeGraceMs);
    if (!exited(proc)) {
      const killMs = Math.min(KILL_TIMEOUT_MS, left());
      await within(kill(proc.pid, { timeoutMs: killMs }), killMs, 'taskkill').catch((err) => warn('ending browser pid ' + proc.pid + ' of ' + profile, err));
      await exitWithin(left());
    }
    ws?.close();
    // A browser still alive past the deadline still holds its profile, and removing the folder now could only
    // strip files out from under it, so the folder is left to a later sweep and the leftover names the live pid.
    if (!exited(proc)) {
      const kept = { removed: false, profile, error: 'browser pid ' + proc.pid + ' did not exit within the close deadline; its profile is left for the next sweep', ended: [] };
      onLeftover(kept);
      return kept;
    }
    return release({ waited: true, treeWaitMs: Math.min(TREE_WAIT_MS, left()) });
  }

  // Which font drew the text of every element that holds text, summed per face: CDP
  // CSS.getPlatformFontsForNode, the renderer's own record, so a fallback cannot hide behind a stack. The
  // walk pierces shadow roots (open ones and the user-agent root that draws an input's placeholder and
  // value) and frames, and asks every pseudo-element too, since ::before and ::after content is text no
  // element child holds.
  async function platformFonts(sessionId) {
    await cdp.send('DOM.enable', {}, sessionId);
    await cdp.send('CSS.enable', {}, sessionId);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
    const holders = [];
    const walk = (node) => {
      if (node.nodeType === 1 && (node.pseudoType || (node.children ?? []).some((c) => c.nodeType === 3 && c.nodeValue.trim()))) holders.push(node.nodeId);
      for (const c of [...(node.pseudoElements ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : []), ...(node.children ?? [])]) walk(c);
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
      // cleanup: a target already gone needs no close, and the capture above already holds its result
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

  return { render, page, pdf, close, profile, exited: browserExit };
}
