// The Chrome DevTools Protocol client of src/render/html2png.mjs over Node's built-in WebSocket, and the settle
// expression a render waits on before its capture.
import { RenderError } from './profile.mjs';

export function connect(url) {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolveWs(ws), { once: true });
    ws.addEventListener('error', () => reject(new RenderError('FSW_RENDER_CDP', 'cannot connect to ' + url)), { once: true });
  });
}

export function cdpClient(ws) {
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
export const SETTLE = '(async () => {' +
  'await document.fonts.ready;' +
  'for (const i of document.images) if (i.loading === "lazy") i.loading = "eager";' +
  'await Promise.all([...document.images].map((i) => i.complete ? null : Promise.race([' +
  'new Promise((r) => { i.addEventListener("load", r, { once: true }); i.addEventListener("error", r, { once: true }); }),' +
  'new Promise((r) => setTimeout(r, 15000))])));' +
  'await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));' +
  'return { fonts: document.fonts.status, broken: [...document.images].filter((i) => !i.naturalWidth).map((i) => i.currentSrc || i.src) };' +
  '})()';
