// fsw doctor: one line per thing a running agent needs. Exit 1 when a required check fails.
// Status words: ok, warn (works, but look), FAIL (required and broken), skip (not needed here).
// Every probe is injectable through ctx.probes, so tests drive each outcome without a model or a browser.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCodex } from '../brain/codex.mjs';
import { DEFAULT_PROXY_URL } from '../brain/codex.mjs';
import { exampleDir, instanceDir, readJson, repoRoot } from '../core/instance.mjs';
import { catalogServicesFor, pipelineSettings } from '../pipeline/thread.mjs';
import { answeredServices } from '../economics/catalog.mjs';
import { listDescriptors, loadDescriptor } from '../platforms/registry.mjs';
import { placeholderFields } from '../profile/validate.mjs';
import { bskStatus } from '../supervisor/keepalive.mjs';
import { loadAdapter } from '../supervisor/run.mjs';

const PROBE_SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };

const result = (status, name, detail, hint) => ({ status, name, detail, hint });

export function parseNodeRange(range) {
  const m = /^>=\s*(\d+)(?:\.(\d+))?/.exec(String(range ?? '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2] ?? 0) } : null;
}

export function checkNode({ version = process.versions.node, engines = readJson(join(repoRoot, 'package.json')).engines?.node } = {}) {
  const need = parseNodeRange(engines);
  if (!need) return result('FAIL', 'node', `package.json engines.node "${engines}" is not a >= range doctor can read`);
  const [major, minor] = version.split('.').map(Number);
  const ok = major > need.major || (major === need.major && minor >= need.minor);
  return ok ? result('ok', 'node', `${version} satisfies ${engines}`) : result('FAIL', 'node', `${version} is older than ${engines}`, 'install a current Node.js from nodejs.org');
}

const defaultProbes = {
  codexVersion: () => {
    const r = spawnSync(process.env.FSW_CODEX_BIN ?? 'codex', ['--version'], { encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) return { ok: false, detail: r.error?.message ?? String(r.stderr).trim() };
    return { ok: true, detail: String(r.stdout).trim() };
  },
  codexCall: async () => {
    const { data, durationMs } = await runCodex({ prompt: 'Answer with the JSON object {"ok": true}.', schema: PROBE_SCHEMA, timeoutMs: 90_000 });
    return { ok: data?.ok === true, durationMs, detail: JSON.stringify(data) };
  },
  proxy: async (url) => {
    const res = await fetch(url.replace(/\/+$/, '') + '/models', { signal: AbortSignal.timeout(5000) });
    return { status: res.status };
  },
  bsk: () => bskStatus(),
  taskStatus: () => {
    if (process.platform !== 'win32') return { supported: false };
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repoRoot, 'scripts', 'task.ps1'), '-Status'], { encoding: 'utf8', windowsHide: true });
    return { supported: true, status: r.status, out: String(r.stdout) + String(r.stderr) };
  },
  vercel: () => {
    // vercel is a .cmd shim on Windows, which only cmd.exe starts; the arguments are fixed text.
    const r = process.platform === 'win32' ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'vercel whoami'], { encoding: 'utf8', windowsHide: true }) : spawnSync('vercel', ['whoami'], { encoding: 'utf8' });
    return { ok: !r.error && r.status === 0, out: String(r.stdout || r.stderr || r.error?.message).trim().split(/\r?\n/).pop() };
  },
  openAdapter: async (id) => {
    const open = await loadAdapter(id);
    if (!open) return null;
    const adapter = await open();
    return { login: () => adapter.login(), services: adapter.services && (() => adapter.services()), stop: () => adapter.stop() };
  },
};

const CHROME_PATHS = () => [
  process.env.FSW_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);

export function checkChrome(exists = existsSync) {
  const found = CHROME_PATHS().find((p) => exists(p));
  return found ? result('ok', 'chrome', found) : result('FAIL', 'chrome', 'no Chrome found', 'install Google Chrome, or set FSW_CHROME to its executable');
}

// The instance: files present, example values replaced, config sections the pipeline refuses to run without.
export function checkInstance(dir) {
  const out = [];
  const missing = ['profile.json', 'business.json', 'config.json'].filter((f) => !existsSync(join(dir, f)));
  if (missing.length) {
    out.push(result('FAIL', 'instance', `${dir} lacks ${missing.join(', ')}`, 'run: fsw init'));
    return { out, instance: null };
  }
  const profile = readJson(join(dir, 'profile.json'));
  const business = readJson(join(dir, 'business.json'));
  const config = readJson(join(dir, 'config.json'));
  out.push(result('ok', 'instance', dir));
  const holds = placeholderFields(profile, readJson(join(exampleDir, 'profile.json')));
  out.push(holds.length ? result('FAIL', 'profile', `still holds example values: ${holds.join(', ')}`, 'run: fsw profile build <your background>, then fsw profile accept') : result('ok', 'profile', `${(profile.approvedClaims ?? []).length} approved claim(s), ${Object.values(profile.serviceFit ?? {}).filter((f) => f.strength !== 'none').length} service(s) with fit`));
  const example = readJson(join(exampleDir, 'business.json'));
  const sameAsExample = ['bizRegNo', 'email'].filter((k) => business[k] && business[k] === example[k]);
  if (business.payout?.account && business.payout.account === example.payout?.account) sameAsExample.push('payout.account');
  out.push(sameAsExample.length ? result('FAIL', 'business', `still holds example values: ${sameAsExample.join(', ')}`, 'edit business.json') : result('ok', 'business', `${business.company ?? 'no company name'}`));
  const known = new Set(listDescriptors());
  const enabled = Object.entries(config.platforms ?? {}).filter(([, p]) => p.enabled);
  const active = enabled.filter(([, p]) => p.mode !== 'observe');
  const problems = [];
  try {
    if (active.length) pipelineSettings(config);
  } catch (err) {
    problems.push(err.message);
  }
  for (const [id, p] of enabled) {
    if (!known.has(id)) problems.push(`platform ${id} has no descriptor`);
    if (!['observe', 'draft', 'auto'].includes(p.mode)) problems.push(`platform ${id} mode "${p.mode}" is not observe, draft or auto`);
  }
  if (!enabled.length) problems.push('no platform is enabled');
  out.push(problems.length ? result('FAIL', 'config', problems.join('; '), 'edit config.json') : result('ok', 'config', `${enabled.map(([id, p]) => `${id}:${p.mode}`).join(' ')}`));
  // A platform whose bids cost money (descriptor bidCost.unit) refuses a paid quote until both caps are set.
  const noCap = active.filter(([id, p]) => known.has(id) && loadDescriptor(id).bidCost.unit !== 'none' && !(Number.isInteger(p.maxQuotesPerDay) && typeof p.maxCashPerDay === 'number'));
  out.push(noCap.length ? result('warn', 'cash caps', `${noCap.map(([id]) => id).join(', ')}: no maxQuotesPerDay and maxCashPerDay, so paid quotes are refused`, 'set both in config.json platforms') : result('ok', 'cash caps', 'every platform that charges for bids has a daily cap'));
  return { out, instance: { profile, business, config, enabled } };
}

export async function runChecks(ctx = {}) {
  const probes = { ...defaultProbes, ...(ctx.probes ?? {}) };
  const dir = instanceDir(ctx.instanceDir);
  const env = ctx.env ?? process.env;
  const out = [];
  const push = (r) => (out.push(r), r);

  push(checkNode(ctx.node));

  const codex = probes.codexVersion();
  push(codex.ok ? result('ok', 'codex cli', codex.detail) : result('FAIL', 'codex cli', codex.detail || 'codex did not start', 'install the Codex CLI and sign in: npm i -g @openai/codex, then codex login'));

  const proxy = env.FSW_CODEX_PROXY ?? DEFAULT_PROXY_URL;
  const proxyOff = proxy === '' || proxy === 'none';
  if (proxyOff) push(result('skip', 'proxy', 'FSW_CODEX_PROXY=none: codex runs with your own config'));
  else {
    try {
      const p = await probes.proxy(proxy);
      push(result('ok', 'proxy', `${proxy} answered ${p.status}`));
    } catch (err) {
      push(result('FAIL', 'proxy', `${proxy} did not answer: ${err.cause?.code ?? err.message}`, 'start the opencodex proxy, or set FSW_CODEX_PROXY=none to use codex directly'));
    }
  }

  if (codex.ok) {
    try {
      const c = await probes.codexCall();
      push(c.ok ? result('ok', 'codex call', `one schema call answered in ${(c.durationMs / 1000).toFixed(1)} s`) : result('FAIL', 'codex call', `the schema call returned ${c.detail}`));
    } catch (err) {
      push(result('FAIL', 'codex call', `${err.code ?? 'error'}: ${err.message}${err.stderrTail ? ' | ' + String(err.stderrTail).trim().split(/\r?\n/).pop() : ''}`, proxyOff ? 'run: codex login' : 'check the proxy and its upstream login'));
    }
  } else push(result('skip', 'codex call', 'codex cli is not available'));

  push(checkChrome(ctx.exists));

  let daemon = false;
  try {
    const s = await probes.bsk();
    daemon = s.daemon === true;
    if (!s.daemon) push(result('FAIL', 'browserskill', `no daemon answering${s.detail ? ': ' + s.detail : ''}`, 'install the omo plugin (BrowserSkill) and start its daemon; fsw run starts it for you'));
    else if (!s.browsers) push(result('FAIL', 'browserskill', `daemon ${s.version ?? ''} answers but no browser is connected`, 'open Chrome with the BrowserSkill extension enabled'));
    else push(result('ok', 'browserskill', `daemon ${s.version ?? ''}, ${s.browsers} browser(s) connected`));
  } catch (err) {
    push(result('FAIL', 'browserskill', `${err.code ?? 'error'}: ${err.message}`, 'install the BrowserSkill CLI (bsk) with the omo plugin, or set FSW_BSK to its path'));
  }

  const { out: instanceChecks, instance } = checkInstance(dir);
  instanceChecks.forEach(push);

  for (const [id, p] of instance?.enabled ?? []) {
    const name = `login ${id}`;
    if (!daemon) {
      push(result('skip', name, 'BrowserSkill is not running, so the login cannot be read'));
      continue;
    }
    let adapter = null;
    try {
      adapter = await probes.openAdapter(id);
      if (!adapter) {
        push(result(p.mode === 'observe' ? 'warn' : 'FAIL', name, 'enabled, but this build has no adapter for it', `set platforms.${id}.enabled to false in config.json`));
        continue;
      }
      const l = await adapter.login();
      push(l.loggedIn ? result('ok', name, `signed in${l.nickname ? ' as ' + l.nickname : ''}${l.sellerMode === false ? ' (not in seller mode)' : ''}`) : result('FAIL', name, 'not signed in', `sign in to ${id} in Chrome (the profile BrowserSkill drives), then run fsw doctor again`));
      // A platform that matches requests to the items set on each offered service (soomgo) sends a
      // service without items nothing, so an offered catalog service left unset is a silent zero. A
      // service the instance does not answer there (config platforms.<id>.services) is the operator's own.
      if (l.loggedIn && adapter.services) {
        const answered = answeredServices(instance.config, id);
        const unset = (await adapter.services()).filter((s) => !s.itemsSet && catalogServicesFor(loadDescriptor(id), s.name)?.some((sv) => answered.includes(sv))).map((s) => s.name);
        push(unset.length
          ? result('warn', `items ${id}`, `${unset.join(', ')}: no request items set, so ${id} sends these services no requests`, `list the items you can serve in platforms/${id}-service-items.json, then run: fsw services ${id} --apply`)
          : result('ok', `items ${id}`, 'every offered catalog service has request items set'));
      }
    } catch (err) {
      push(result('FAIL', name, `${err.code ?? 'error'}: ${err.message}`));
    } finally {
      if (adapter) await adapter.stop().catch(() => {});
    }
  }

  const task = probes.taskStatus();
  if (!task.supported) push(result('skip', 'schedule', 'the scheduled task is built for Windows; start fsw run yourself or use your own service manager'));
  else if (/not registered/.test(task.out)) push(result('warn', 'schedule', 'the fsw-supervisor task is not registered', 'run: fsw schedule install'));
  else if (task.status !== 0) push(result('FAIL', 'schedule', `task status failed: ${task.out.trim().split(/\r?\n/).pop()}`));
  else {
    const lock = /^lock\s+(.*)$/m.exec(task.out)?.[1] ?? 'unknown';
    const state = /^state\s+(.*)$/m.exec(task.out)?.[1] ?? 'unknown';
    push(result('ok', 'schedule', `task ${state}; lock: ${lock}`));
  }

  const site = instance?.config.site;
  if (!site?.project) push(result('skip', 'vercel', 'config.site.project is empty, so no site is published'));
  else {
    const v = probes.vercel();
    push(v.ok ? result('ok', 'vercel', `signed in as ${v.out}`) : result('warn', 'vercel', `not signed in: ${v.out}`, 'run: vercel login (only needed to publish the portfolio site)'));
  }
  return out;
}

export const failed = (checks) => checks.filter((c) => c.status === 'FAIL');

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  if (argv.length) {
    (ctx.error ?? console.error)('usage: fsw doctor');
    return 1;
  }
  const checks = await runChecks(ctx);
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) log(`${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}${c.hint && c.status !== 'ok' && c.status !== 'skip' ? `  -> ${c.hint}` : ''}`);
  const bad = failed(checks);
  log(bad.length ? `\n${bad.length} required check(s) failed: ${bad.map((c) => c.name).join(', ')}` : '\nevery required check passed');
  return bad.length ? 1 : 0;
}
