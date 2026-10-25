// fsw projects: 크몽 엔터프라이즈 projects by hand. list and show read and judge without writing; draft
// writes the improved proposal (draft, critic, rewrites) under instance/proposals/<id>.draft.json; propose
// sends that draft (or only fills the form with --dry-run); revise reworks an open proposal approval
// through the improve loop; run is one pass of the hourly supervisor job; status reads sent ones.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { latestAllocation } from '../economics/priority.mjs';
import { loadGateRules } from '../brain/respond.mjs';
import { gateOutbound } from '../policy/gate.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { openProjectReader, openProjectSeller } from '../platforms/kmong/projects.mjs';
import { improveProposal, proposalPolicy, proposalsLeft, usedToday } from '../projects/draft.mjs';
import { markProject, rankProjects, rememberJudgement, scoreProject } from '../projects/score.mjs';
import { projectsJob, proposalsDir, readJobState, readStatuses, reviseApproval, saveProposalRecord } from '../projects/job.mjs';

const USAGE = 'usage: fsw projects list [--category it|design|marketing|video|planning|all] [--pages N] | show <id> | draft <id> | propose <id> [--dry-run] | revise <approvalId> | run | status';

export function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--category' || a === '--pages') {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value');
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else out.positional.push(a);
  }
  return out;
}

const draftFile = (instance, id) => join(proposalsDir(instance), id + '.draft.json');

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const instance = ctx.instance ?? loadInstance();
  const args = parseArgs(argv);
  const [cmd, idArg] = args.positional;
  const descriptor = loadDescriptor('kmong');
  const judgeCtx = () => ({ profile: instance.profile, config: instance.config, descriptor, allocation: latestAllocation(instance) });
  const needId = () => {
    const id = Number(idArg);
    if (!Number.isInteger(id) || id <= 0) throw new Error(USAGE);
    return id;
  };

  if (cmd === 'list') {
    const reader = await openProjectReader();
    try {
      const { projects } = await reader.listProjects({ category: args.category ?? 'it', pages: Number(args.pages ?? 1) });
      const { kept, dropped } = rankProjects(projects, judgeCtx());
      for (const { project: p, verdict: v } of kept) log([p.id, v.score, v.service, v.fit, p.amountKRW, 'floor ' + v.floorKRW, 'D-' + p.deadlineDays, 'items ' + p.requested.length, p.title].join('  '));
      log(kept.length + ' kept, ' + dropped.length + ' dropped');
      return 0;
    } finally {
      await reader.close();
    }
  }

  if (cmd === 'show') {
    const reader = await openProjectReader();
    try {
      const p = await reader.readProject(needId());
      log(JSON.stringify({ project: { ...p, description: p.description.length + ' characters' }, verdict: scoreProject(p, judgeCtx()) }, null, 2));
      return 0;
    } finally {
      await reader.close();
    }
  }

  if (cmd === 'draft') {
    const id = needId();
    const policy = proposalPolicy(instance.config);
    const reader = await openProjectReader();
    try {
      const project = await reader.readProject(id);
      const verdict = scoreProject(project, { ...judgeCtx(), minFit: policy.minFit });
      if (!verdict.keep) {
        log('project ' + id + ' is dropped: ' + verdict.reason);
        return 1;
      }
      const best = await improveProposal(project, { instance, descriptor, service: verdict.service, floorKRW: verdict.floorKRW, policy });
      mkdirSync(proposalsDir(instance), { recursive: true });
      writeFileSync(draftFile(instance, id), JSON.stringify({ at: new Date().toISOString(), project, verdict, ...best }, null, 2) + '\n');
      log(best.proposal.text);
      log('\n' + JSON.stringify({ ok: best.ok, totalKRW: best.proposal.totalKRW, violations: best.violations, warnings: best.gate.warnings, critic: best.critic, history: best.history }, null, 2));
      return best.ok ? 0 : 1;
    } finally {
      await reader.close();
    }
  }

  if (cmd === 'revise') {
    if (!idArg) throw new Error(USAGE);
    const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
    try {
      log(JSON.stringify(await reviseApproval({ instance, ledger, now: new Date(), forceMode: process.env.FSW_FORCE_MODE ?? null }, idArg), null, 2));
      return 0;
    } finally {
      if (!ctx.ledger) ledger.close();
    }
  }

  if (cmd === 'propose') {
    const id = needId();
    const file = draftFile(instance, id);
    if (!existsSync(file)) throw new Error('no draft for ' + id + '; run fsw projects draft ' + id + ' first');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const gate = gateOutbound({ platform: 'kmong', kind: 'proposal', text: saved.proposal.text, thread: { stage: 'pre_order' } }, { descriptor, instance, lessonsRules: loadGateRules(instance) });
    if (!gate.ok) {
      log('the gate blocks the draft: ' + gate.violations.map((v) => v.rule + ' ' + v.detail).join('; '));
      return 1;
    }
    const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
    const seller = await openProjectSeller();
    try {
      if (!args.dryRun) {
        const policy = proposalPolicy(instance.config);
        const left = proposalsLeft({ policy, pageQuota: await seller.quota(), usedToday: usedToday(ledger) });
        if (left <= 0) {
          log('no proposals left today (maxPerDay ' + policy.maxPerDay + ', page quota and today\'s count)');
          return 1;
        }
        if (!saved.critic?.pass) {
          log('the critic did not pass this draft; approve it through fsw approve instead');
          return 1;
        }
      }
      const res = await seller.propose(saved.project, saved.proposal, { gate, dryRun: Boolean(args.dryRun), taxInvoice: instance.business?.taxInvoice ?? null });
      const out = join(proposalsDir(instance), id + (args.dryRun ? '.dryrun.json' : '.send.json'));
      writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), ...res, form: res.form ?? null }, null, 2) + '\n');
      log(JSON.stringify({ observed: res.observed, submitted: res.submitted, reason: res.reason ?? null, code: res.code ?? null, status: res.status ?? null, steps: res.steps.map((s) => s.step) }, null, 2));
      log('record: ' + out);
      if (args.dryRun && res.observed) {
        const state = readJobState(instance);
        if (state.enterpriseProfile) writeFileSync(join(instance.dir, 'run', 'projects.json'), JSON.stringify({ ...state, enterpriseProfile: { missing: false, at: new Date().toISOString() } }, null, 2) + '\n');
      }
      if (!args.dryRun && res.observed) {
        rememberJudgement(ledger, saved.project, saved.verdict);
        markProject(ledger, id, 'proposed', { proposal: { at: new Date().toISOString(), totalKRW: saved.proposal.totalKRW, status: res.status, label: res.label } });
        ledger.addEvent({ kind: 'project.proposed', platform: 'kmong', ref: id, payload: { totalKRW: saved.proposal.totalKRW, service: saved.verdict.service, by: 'cli' } });
        saveProposalRecord(instance, id, { project: saved.project, score: saved.verdict, proposal: saved.proposal, gate, critic: saved.critic, status: res.status, observedStatus: res.label, send: { at: new Date().toISOString(), steps: res.steps } });
      }
      return res.observed ? 0 : 1;
    } finally {
      await seller.stop();
      if (!ctx.ledger) ledger.close();
    }
  }

  if (cmd === 'run' || cmd === 'status') {
    const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
    try {
      if (cmd === 'run') {
        log(JSON.stringify(await projectsJob({ instance, ledger, now: new Date(), forceMode: process.env.FSW_FORCE_MODE ?? null, log }), null, 2));
        return 0;
      }
      const seller = await openProjectSeller();
      try {
        log(JSON.stringify(await readStatuses({ instance, ledger }, { seller }), null, 2));
        return 0;
      } finally {
        await seller.stop();
      }
    } finally {
      if (!ctx.ledger) ledger.close();
    }
  }
  throw new Error(USAGE);
}

