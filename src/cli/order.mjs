// fsw order: what the operator saw on the platform that fsw cannot read itself.
//   fsw order list                                   jobs with their status, payments and portfolio permission
//   fsw order permission <jobId> granted|denied      the client's answer to the portfolio question
//   fsw order review <jobId> --rating <1-5> [--text "..."] [--liked true|false]
// A permission or review change syncs the portfolio and runs the change-gated publish.
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { syncPortfolio } from '../portfolio/store.mjs';
import { runPublish } from '../orders/delivery.mjs';

const USAGE = 'usage: fsw order list | fsw order permission <jobId> granted|denied | fsw order review <jobId> --rating <1-5> [--text "..."] [--liked true|false]';

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || i + 1 >= argv.length) throw new Error(USAGE);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const instance = ctx.instance ?? loadInstance();
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  const publish = ctx.publish ?? runPublish;
  try {
    const [sub, id, ...rest] = argv;
    if (!sub || sub === 'list') {
      const jobs = ledger.listJobs();
      if (!jobs.length) log('no jobs');
      for (const j of jobs) {
        const paid = ledger.jobPayments(j.id).reduce((s, p) => s + p.amountKRW, 0);
        log(j.id + '  ' + j.platform + '  ' + (j.service ?? '-') + '  ' + j.status + '  paid ' + paid + ' of ' + (j.priceKRW ?? '?') + '  portfolio ' + (j.meta?.portfolio?.permission ?? 'pending'));
      }
      return 0;
    }
    const job = id ? ledger.getJob(id) : null;
    if (!job) throw new Error(id ? 'no job ' + id : USAGE);
    if (sub === 'permission') {
      if (!['granted', 'denied'].includes(rest[0])) throw new Error(USAGE);
      ledger.upsertJob({ id, meta: { ...job.meta, portfolio: { ...(job.meta?.portfolio ?? {}), permission: rest[0], answeredAt: new Date().toISOString() } } });
      ledger.addEvent({ kind: 'job.portfolio_permission', platform: job.platform, ref: id, payload: { permission: rest[0] } });
    } else if (sub === 'review') {
      const o = options(rest);
      const rating = Number(o.rating);
      if (!(rating >= 1 && rating <= 5)) throw new Error(USAGE);
      if (o.liked !== undefined && !['true', 'false'].includes(o.liked)) throw new Error(USAGE);
      ledger.addReview({ jobId: id, platform: job.platform, rating, text: o.text ?? null, liked: o.liked === undefined ? null : o.liked === 'true' });
    } else throw new Error(USAGE);
    const shown = syncPortfolio(instance, ledger).filter((i) => i.jobId === id).length;
    const p = publish(instance);
    log('job ' + id + ' ' + sub + ' recorded; ' + (shown ? 'shown' : 'not shown') + ' in the portfolio; publish ' + (p.ok ? 'ok' : 'failed') + (p.detail ? ': ' + p.detail : ''));
    return p.ok ? 0 : 1;
  } finally {
    if (!ctx.ledger) ledger.close();
  }
}

