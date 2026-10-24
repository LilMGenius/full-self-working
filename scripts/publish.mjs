#!/usr/bin/env node
// Builds the portfolio site and deploys it to Vercel only when its content changed (docs/DESIGN.md, Site):
//   node scripts/publish.mjs [--instance <dir>] [--force] [--dry-run]
// The last deployed hash and URL live in <instance>/site/last-deploy.json. The project is connected to
// the repository with git deployments off, because the inputs are generated from the instance; the
// prebuilt site/dist is uploaded as static output.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInstance } from '../src/core/instance.mjs';
import { buildSite } from '../site/build.mjs';

// On Windows vercel is a .cmd shim, which only a shell can start; the arguments are this script's own
// config values, quoted into one command line so no argument list is concatenated unescaped.
const quote = (a) => (/^[\w./:@=-]+$/.test(a) ? a : '"' + String(a).replace(/"/g, '\\"') + '"');
function runVercel(args, opts) {
  if (process.platform !== 'win32') return execFileSync('vercel', args, opts);
  return execFileSync(['vercel', ...args].map(quote).join(' '), { ...opts, shell: true });
}

export class PublishError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function readLastDeploy(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function writeLastDeploy(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  renameSync(tmp, path);
}

// --json makes vercel deploy print one JSON document whether a person or an agent runs it; a deploy that
// reports no ready production deployment is a failure.
function deploy({ dir, team, project }) {
  let stdout;
  try {
    stdout = runVercel(['deploy', dir, '--prod', '--yes', '--json', '--scope', team, '--project', project], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    throw new PublishError('FSW_PUBLISH_DEPLOY', 'vercel deploy failed: ' + String(err.stderr || err.message).trim().split('\n').slice(-5).join(' | '));
  }
  let report;
  try {
    report = JSON.parse(stdout.slice(stdout.indexOf('{')));
  } catch {
    throw new PublishError('FSW_PUBLISH_DEPLOY', 'vercel deploy printed no JSON report: ' + stdout.trim().slice(0, 400));
  }
  const d = report.deployment ?? {};
  if (report.status !== 'ok' || d.readyState !== 'READY' || d.target !== 'production' || !/^https:\/\//.test(d.url ?? '')) {
    throw new PublishError('FSW_PUBLISH_DEPLOY', 'vercel deploy did not report a ready production deployment: ' + JSON.stringify({ status: report.status, readyState: d.readyState, target: d.target, url: d.url }));
  }
  return { url: d.url, id: d.id, productionUrl: d.productionUrl ?? null };
}

// The deployment and the public domain both answer with the built index and its hash before the record
// is written, so a recorded hash always names what visitors get. The domain check also catches a git
// build promoted over the prebuilt output, which on this project serves an empty repository root.
async function served(url) {
  const res = await fetch(url + '/.content-hash', { cache: 'no-store' });
  const index = await fetch(url + '/', { cache: 'no-store' });
  return { index: index.status, hash: res.ok ? (await res.text()).trim() : null };
}

async function verify(urls, hash) {
  for (const url of urls) {
    let got;
    for (let attempt = 0; attempt < 6; attempt++) {
      got = await served(url);
      if (got.index === 200 && got.hash === hash) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (got.index !== 200 || got.hash !== hash) {
      throw new PublishError('FSW_PUBLISH_VERIFY', url + ' answered ' + got.index + ' with content hash ' + got.hash + ', expected ' + hash);
    }
  }
}

export async function publish({ instance: instanceDir, force = false, dryRun = false, log = () => {} } = {}) {
  const instance = loadInstance({ dir: instanceDir, allowExampleConfig: true });
  const site = instance.config.site ?? {};
  if (!site.vercelTeam || !site.project) throw new PublishError('FSW_PUBLISH_CONFIG', 'config.site needs vercelTeam and project');
  const built = await buildSite({ instance: instance.dir, log });
  const recordPath = join(instance.dir, 'site', 'last-deploy.json');
  const last = readLastDeploy(recordPath);
  if (!force && last?.hash === built.hash) {
    log('publish: content hash ' + built.hash.slice(0, 12) + ' already deployed at ' + last.url + ', nothing to do');
    return { deployed: false, hash: built.hash, url: last.url };
  }
  if (dryRun) {
    log('publish: content changed (' + (last?.hash?.slice(0, 12) ?? 'never deployed') + ' to ' + built.hash.slice(0, 12) + '), dry run stops here');
    return { deployed: false, hash: built.hash, url: null, changed: true };
  }
  const { url, id, productionUrl } = deploy({ dir: built.out, team: site.vercelTeam, project: site.project });
  await verify([url, ...(site.domain ? ['https://' + site.domain] : [])], built.hash);
  const record = { hash: built.hash, url, deploymentId: id, productionUrl, domain: site.domain ?? null, project: site.project, team: site.vercelTeam, deployedAt: new Date().toISOString(), priceTable: built.priceTable };
  writeLastDeploy(recordPath, record);
  log('publish: deployed ' + built.hash.slice(0, 12) + ' to ' + url + (site.domain ? ' (' + site.domain + ')' : ''));
  return { deployed: true, ...record };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const opts = { force: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--instance') opts.instance = args[++i];
    else if (args[i] === '--force') opts.force = true;
    else if (args[i] === '--dry-run') opts.dryRun = true;
    else throw new PublishError('FSW_PUBLISH_ARGS', 'unknown argument ' + args[i] + ' (use --instance, --force, --dry-run)');
  }
  await publish({ ...opts, log: (m) => console.log(m) });
}
