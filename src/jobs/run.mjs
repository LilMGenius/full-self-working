// Runs one paid job (docs/DESIGN.md, Jobs): checks the payment state the recipe and the platform require,
// writes jobs/<id>/brief.md, runs one codex exec turn in jobs/<id>/work with the recipe's skill graph, runs
// the render steps and the acceptance checks, feeds failed checks back once, and records agent minutes.
// It never marks a job delivered: delivery is a separate act that deliveryAllowed gates.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCodex as defaultRunCodex } from '../brain/codex.mjs';
import { nowSeoul } from '../core/clock.mjs';
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { notifyOperator } from '../core/notify.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { openRenderer as defaultOpenRenderer } from '../render/html2png.mjs';
import { matchFiles, runAcceptance } from './accept.mjs';
import { loadRecipe, resolveSkill, serviceCatalog } from './recipe.mjs';

export const DEFAULT_JOB_MODEL = 'gpt-6.1-sol';
const DEFAULT_TIMEOUT_MS = 90 * 60_000;

export const JOB_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'files', 'openQuestions'],
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
};

export class JobError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    Object.assign(this, detail);
  }
}

// A payment counts only when it came through a channel the platform allows: the platform itself, or a
// direct bank transfer where the descriptor permits off-platform payment. A row without a channel is not
// evidence of where the money sits.
export function countedPayments(payments, descriptor) {
  const channels = descriptor.offPlatformPayment === true ? [descriptor.id, 'bank'] : [descriptor.id];
  return payments.filter((p) => p.evidence && p.amountKRW > 0 && channels.includes(p.channel));
}

// Platforms that hold the whole order in escrow before work starts (크몽 reorders phases as separate
// orders, so a phase order is a job row of its own); an unknown split mechanism is treated the same way.
const wholeOrderEscrow = (descriptor) => descriptor.escrow === true && ['reorder', 'none', 'unknown'].includes(descriptor.milestones);

function paymentLevelMet(level, job, payments, descriptor) {
  const counted = countedPayments(payments, descriptor);
  const paidKRW = counted.reduce((s, p) => s + p.amountKRW, 0);
  const base = { level, paidKRW, priceKRW: job.priceKRW ?? null, payments: counted.map((p) => p.id) };
  if (level === 'none') return { ok: true, ...base, reason: 'recipe needs no payment' };
  if (level === 'full' || (level === 'deposit' && wholeOrderEscrow(descriptor))) {
    if (!(job.priceKRW > 0)) return { ok: false, ...base, reason: 'job has no price to compare payments with' };
    if (paidKRW >= job.priceKRW) return { ok: true, ...base, reason: level === 'full' ? 'full price received' : 'order held in ' + descriptor.id + ' escrow' };
    return { ok: false, ...base, reason: level === 'full' || descriptor.milestones !== 'unknown'
      ? 'needs the full ' + job.priceKRW + ' KRW ' + (descriptor.escrow ? 'held in escrow' : 'paid') + ' on ' + descriptor.id + ', has ' + paidKRW
      : 'split mechanism of ' + descriptor.id + ' is unknown, so the full order must be held first; has ' + paidKRW };
  }
  if (level === 'deposit') {
    if (counted.some((p) => ['deposit', 'milestone', 'full'].includes(p.kind))) return { ok: true, ...base, reason: 'deposit received' };
    return { ok: false, ...base, reason: 'needs a deposit payment on ' + descriptor.id + ' before work starts' };
  }
  return { ok: false, ...base, reason: 'unknown payment level ' + level };
}

export const startAllowed = (job, ledger, descriptor, recipe) => paymentLevelMet(recipe.payment.beforeStart, job, ledger.jobPayments(job.id), descriptor);

// Whether the finished result may be sent, from payment rows and descriptor rules only.
export const deliveryAllowed = (job, ledger, descriptor, recipe) => paymentLevelMet(recipe.payment.beforeDelivery, job, ledger.jobPayments(job.id), descriptor);

export function jobPaths(instance, jobId) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(jobId))) throw new JobError('FSW_JOB_ID', 'job id ' + jobId + ' is not a safe directory name');
  const dir = join(instance.paths.jobs, String(jobId));
  return { dir, brief: join(dir, 'brief.md'), work: join(dir, 'work'), inputs: join(dir, 'inputs'), qa: join(dir, 'qa'), runLog: join(dir, 'qa', 'run.json') };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// One lock file per running job under jobs/.running; locks whose process died are removed, and the count of
// live ones is held under jobs.maxParallel across every fsw process on the machine.
function acquireSlot(instance, jobId, maxParallel) {
  const dir = join(instance.paths.jobs, '.running');
  mkdirSync(dir, { recursive: true });
  let live = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.lock'))) {
    const pid = Number(readFileSync(join(dir, f), 'utf8'));
    if (!alive(pid)) rmSync(join(dir, f), { force: true });
    else if (f === jobId + '.lock') throw new JobError('FSW_JOB_RUNNING', 'job ' + jobId + ' is already running in process ' + pid);
    else live++;
  }
  if (live >= maxParallel) throw new JobError('FSW_JOB_BUSY', live + ' jobs running, jobs.maxParallel is ' + maxParallel);
  const file = join(dir, jobId + '.lock');
  const fd = openSync(file, 'wx');
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return () => rmSync(file, { force: true });
}

function agreedScope(job, quote) {
  if (Array.isArray(quote?.scope) && quote.scope.length) return quote.scope;
  if (Array.isArray(job.meta?.scope) && job.meta.scope.length) return job.meta.scope;
  if (typeof job.meta?.scope === 'string' && job.meta.scope.trim()) return [job.meta.scope.trim()];
  return null;
}

function deadlineOf(job, quote) {
  if (job.meta?.deadline) return String(job.meta.deadline);
  if (quote?.deliveryDays > 0 && quote.at) return nowSeoul(new Date(Date.parse(quote.at) + quote.deliveryDays * 86_400_000)).ymd;
  return null;
}

const constraintText = (c) => (c ? ' (' + Object.entries(c).map(([k, v]) => k + ' ' + v).join(', ') + ')' : '');

export function buildBrief({ job, thread, messages, quote, recipe, service }) {
  const scope = agreedScope(job, quote);
  const language = thread?.language ?? job.meta?.language ?? 'ko';
  const inbound = messages.filter((m) => m.direction === 'in' && m.body?.trim());
  const lines = [
    '# ' + (job.title ?? service.en) + ' (' + job.id + ')',
    '',
    '- Service: ' + recipe.service + ' (' + service.ko + ', ' + service.en + ')',
    '- Platform: ' + job.platform,
    '- Package: ' + (job.meta?.package ?? 'standard'),
    '- Price: ' + (job.priceKRW != null ? job.priceKRW + ' KRW' : 'not recorded'),
    '- Deadline: ' + (deadlineOf(job, quote) ?? 'not agreed'),
    '- Language of every customer-facing text: ' + language,
    '',
    '## Customer request',
    '',
    ...(inbound.length ? inbound.map((m) => '> ' + m.body.trim().replace(/\n/g, '\n> ') + '\n') : ['(no messages recorded)', '']),
    '## Agreed scope',
    '',
    ...scope.map((s) => '- ' + s),
    '',
    '## Deliverables',
    '',
    ...recipe.deliverables.map((d) => '- work/' + d.path + ' as ' + d.format + constraintText(d.constraints)),
    ...service.deliverables.map((d) => '- covers: ' + d),
    '',
  ];
  return lines.join('\n');
}

const SLOP_RULES = 'No em dash or horizontal bar, no middle dot between words, no placeholder text (lorem ipsum, TODO, bracketed names), no self-reference as an AI, no hype words, and no number, client name or result the brief does not state. ' +
  'No visible text that describes the page or its images (such as a caption saying a picture is an illustration); descriptions for screen readers go in alt or aria-label.';

export function buildPrompt({ paths, recipe, skills, language, failures }) {
  const steps = recipe.steps.filter((s) => s.type === 'invoke-model-skill');
  const lines = failures
    ? [
      'The work in this directory went through acceptance and these checks failed:',
      ...failures.map((r) => '- ' + r.check + ': ' + r.detail),
      '',
      'Fix every failure in place, keep everything that passed, and answer with the same JSON shape as before.',
      '',
    ]
    : [];
  lines.push(
    'You are delivering a paid freelance job. Your working directory is ' + paths.work + '; write only inside it.',
    'Read the brief at ' + paths.brief + ' first. Customer files, if any, are in ' + paths.inputs + ' (read them, never change them).',
    'Do the steps below in order without asking questions; record anything you had to assume in openQuestions.',
    '',
    '## Steps',
    '',
  );
  for (const s of steps) {
    lines.push('- ' + s.id + ': ' + s.does + ' Reads ' + s.input + '; writes ' + s.output + '.' + (s.skill ? ' Follow the skill at ' + skills[s.skill] + '.' : ''));
  }
  const renders = recipe.steps.filter((s) => s.type === 'script' && s.run === 'render');
  for (const s of renders) lines.push('- ' + s.id + ' (done by a script after you finish): ' + s.input + ' is rendered to ' + s.output + '.');
  lines.push(
    '',
    '## Must exist when you finish',
    '',
    ...recipe.deliverables.map((d) => '- ' + d.path + ' (' + d.format + constraintText(d.constraints) + ')'),
    '',
    '## Checks that run after you',
    '',
    ...recipe.acceptance.map((c) => '- ' + c.check + (c.widths ? ' at ' + c.widths.join(', ') + ' px: no horizontal overflow, fonts loaded, no broken image' : '') + (c.run ? ': ' + c.run + (c.cwd ? ' in ' + c.cwd : '') : '') + (c.paths ? ' over ' + c.paths.join(', ') : '')),
    '',
    'Customer-facing text is written in ' + language + '. ' + SLOP_RULES,
    'Pages load no remote fonts, scripts or images; embed or copy what they need into the working directory.',
    'Answer with JSON: summary (what you made), files (paths relative to the working directory) and openQuestions.',
  );
  return lines.join('\n');
}

function readPageSize(file) {
  const html = readFileSync(file, 'utf8');
  const m = /<meta\s+name=["']fsw-size["']\s+content=["'](\d+)x(\d+)["']/i.exec(html) ?? /<meta\s+content=["'](\d+)x(\d+)["']\s+name=["']fsw-size["']/i.exec(html);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

// Executes the recipe's render steps; returns one result per step, failing with the cause when a file
// cannot be rendered.
async function runRenderSteps(paths, recipe, renderer) {
  const results = [];
  for (const s of recipe.steps.filter((x) => x.type === 'script' && x.run === 'render')) {
    const files = matchFiles(paths.work, s.input);
    const problems = [];
    const made = [];
    if (!files.length) problems.push('no file matches ' + s.input);
    for (const f of files) {
      const src = join(paths.work, f);
      const stem = f.split('/').pop().replace(/\.[^.]+$/, '');
      const out = join(paths.work, s.output.replace('{stem}', stem));
      const size = s.args.size === 'page' ? readPageSize(src) : { width: s.args.width, height: s.args.height ?? 900 };
      if (!size) {
        problems.push(f + ': no fsw-size meta tag');
        continue;
      }
      const opts = { width: size.width, height: size.height, fullPage: Boolean(s.args.fullPage), out, format: s.args.format };
      try {
        if (/\.svg$/i.test(f)) {
          const img = '<img src="' + pathToFileURL(src).href + '" style="display:block;width:' + size.width + 'px;height:' + size.height + 'px;object-fit:contain">';
          await renderer.render({ ...opts, html: '<!doctype html><html><body style="margin:0;background:#fff">' + img + '</body></html>' });
        } else {
          await renderer.render({ ...opts, url: pathToFileURL(src).href });
        }
        made.push(s.output.replace('{stem}', stem));
      } catch (err) {
        problems.push(f + ': ' + (err.code ? err.code + ' ' : '') + err.message);
      }
    }
    results.push({ check: 'render', ok: !problems.length, detail: problems.length ? s.id + ': ' + problems.join('; ') : s.id + ': ' + made.join(', ') });
  }
  return results;
}

async function renderAndAccept(paths, recipe, { openRenderer, language }) {
  let renderResults = [];
  if (recipe.steps.some((s) => s.type === 'script' && s.run === 'render')) {
    let renderer;
    try {
      renderer = await openRenderer();
    } catch (err) {
      renderResults = [{ check: 'render', ok: false, detail: 'renderer did not start: ' + (err.code ? err.code + ' ' : '') + err.message }];
    }
    if (renderer) {
      try {
        renderResults = await runRenderSteps(paths, recipe, renderer);
      } finally {
        await renderer.close();
      }
    }
  }
  const acc = await runAcceptance(paths.work, recipe, { qaDir: paths.qa, lang: language, openRenderer });
  const results = [...renderResults, ...acc.results];
  return { ok: results.every((r) => r.ok), results };
}

// runJob(jobId, ctx) -> {ok, status, reason?, acceptance?, turns, agentMinutes}. ctx: instance, ledger,
// runCodex, openRenderer, recipeDir, notify (all optional; tests inject runCodex so no model is called).
export async function runJob(jobId, ctx = {}) {
  const instance = ctx.instance ?? loadInstance();
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  const runCodex = ctx.runCodex ?? defaultRunCodex;
  const openRenderer = ctx.openRenderer ?? defaultOpenRenderer;
  const notify = ctx.notify ?? notifyOperator;
  try {
    const job = ledger.getJob(jobId);
    if (!job) throw new JobError('FSW_JOB_MISSING', 'no job ' + jobId + ' in the ledger');
    if (['delivered', 'closed', 'lost'].includes(job.status)) throw new JobError('FSW_JOB_STATE', 'job ' + jobId + ' is ' + job.status);
    const recipe = loadRecipe(job.service, ctx.recipeDir ? { dir: ctx.recipeDir } : {});
    const service = serviceCatalog()[job.service];
    const descriptor = loadDescriptor(job.platform);
    const pay = startAllowed(job, ledger, descriptor, recipe);
    if (!pay.ok) {
      ledger.addEvent({ kind: 'job.refused', platform: job.platform, ref: jobId, payload: { reason: pay.reason } });
      return { ok: false, status: 'refused', reason: pay.reason, payment: pay };
    }
    const thread = job.threadId ? ledger.getThread(job.threadId) : null;
    const messages = thread ? ledger.threadMessages(thread.id) : [];
    const quote = thread ? ledger.listQuotes({ threadId: thread.id, status: 'accepted' }).at(-1) ?? null : null;
    if (!agreedScope(job, quote)) {
      ledger.addEvent({ kind: 'job.refused', platform: job.platform, ref: jobId, payload: { reason: 'no agreed scope' } });
      return { ok: false, status: 'refused', reason: 'no agreed scope: no accepted quote with scope and no job.meta.scope' };
    }
    const skills = Object.fromEntries(recipe.steps.filter((s) => s.skill).map((s) => [s.skill, resolveSkill(s.skill).file]));
    const jobsCfg = instance.config.jobs ?? {};
    const release = acquireSlot(instance, String(jobId), jobsCfg.maxParallel ?? 1);
    const started = Date.now();
    const turns = [];
    let acceptance = null;
    let error = null;
    try {
      const paths = jobPaths(instance, jobId);
      for (const d of [paths.work, paths.inputs, paths.qa]) mkdirSync(d, { recursive: true });
      const language = thread?.language ?? job.meta?.language ?? 'ko';
      writeFileSync(paths.brief, buildBrief({ job, thread, messages, quote, recipe, service }));
      ledger.upsertJob({ id: job.id, status: 'in_progress', startedAt: job.startedAt ?? new Date().toISOString() });
      const turn = async (failures) => {
        const prompt = buildPrompt({ paths, recipe, skills, language, failures });
        const r = await runCodex({ prompt, schema: JOB_RESULT_SCHEMA, model: jobsCfg.model ?? DEFAULT_JOB_MODEL, effort: jobsCfg.effort, cwd: paths.work, sandbox: 'workspace-write', timeoutMs: jobsCfg.timeoutMs ?? DEFAULT_TIMEOUT_MS });
        turns.push({ retry: Boolean(failures), durationMs: r.durationMs, ...r.data });
      };
      try {
        await turn(null);
        acceptance = await renderAndAccept(paths, recipe, { openRenderer, language });
        if (!acceptance.ok) {
          await turn(acceptance.results.filter((r) => !r.ok));
          acceptance = await renderAndAccept(paths, recipe, { openRenderer, language });
        }
      } catch (err) {
        error = err;
      }
      writeFileSync(paths.runLog, JSON.stringify({ jobId, at: new Date().toISOString(), turns, acceptance, error: error ? { code: error.code, message: error.message } : null }, null, 2));
    } finally {
      release();
    }
    const minutes = (Date.now() - started) / 60_000;
    const agentMinutes = (job.agentMinutes ?? 0) + minutes;
    const lastRun = { at: new Date().toISOString(), ok: Boolean(acceptance?.ok) && !error, turns: turns.length, failed: acceptance?.results.filter((r) => !r.ok).map((r) => r.check) ?? [], error: error?.message ?? null };
    ledger.upsertJob({ id: job.id, status: 'in_progress', agentMinutes, meta: { ...(job.meta ?? {}), lastRun } });
    ledger.addEvent({ kind: lastRun.ok ? 'job.accepted' : 'job.failed', platform: job.platform, ref: jobId, payload: { ...lastRun, minutes } });
    const handoffs = recipe.steps.filter((s) => s.type === 'user-handoff').map((s) => '- ' + s.id + ': ' + s.ask);
    const body = lastRun.ok
      ? 'Acceptance passed after ' + turns.length + ' turn(s). Before delivery:\n' + handoffs.join('\n')
      : (error ? 'The run stopped: ' + error.message : 'Acceptance still fails after one retry: ' + lastRun.failed.join(', ')) + '\nSee ' + jobPaths(instance, jobId).runLog;
    await notify(instance, { kind: 'job', title: 'job ' + jobId + (lastRun.ok ? ' ready for review' : ' needs a person'), body, dedupeKey: 'job-' + jobId + '-' + lastRun.at });
    if (error) throw error;
    return { ok: lastRun.ok, status: lastRun.ok ? 'accepted' : 'failed', acceptance, turns, agentMinutes };
  } finally {
    if (!ctx.ledger) ledger.close();
  }
}

// Re-runs acceptance on a job's existing work without calling a model.
export async function checkJob(jobId, ctx = {}) {
  const instance = ctx.instance ?? loadInstance();
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  try {
    const job = ledger.getJob(jobId);
    if (!job) throw new JobError('FSW_JOB_MISSING', 'no job ' + jobId + ' in the ledger');
    const recipe = loadRecipe(job.service, ctx.recipeDir ? { dir: ctx.recipeDir } : {});
    const paths = jobPaths(instance, jobId);
    const thread = job.threadId ? ledger.getThread(job.threadId) : null;
    const acceptance = await renderAndAccept(paths, recipe, { openRenderer: ctx.openRenderer ?? defaultOpenRenderer, language: thread?.language ?? job.meta?.language });
    return { acceptance, delivery: deliveryAllowed(job, ledger, loadDescriptor(job.platform), recipe), qa: resolve(paths.qa) };
  } finally {
    if (!ctx.ledger) ledger.close();
  }
}
