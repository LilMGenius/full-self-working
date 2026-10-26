// fsw deal: what the operator saw on the platform that fsw cannot read yet, sent to the deal as signals
// (replaces fsw order, src/cli/order.mjs at 2c77326, which wrote job meta and reviews directly).
//   fsw deal list
//   fsw deal <jobId> permission granted|denied
//   fsw deal <jobId> review --rating <1-5> [--text "..."] [--liked true|false]
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { advance } from '../deal/index.mjs';
import { applyEffects } from '../loop/index.mjs';

const USAGE = 'usage: fsw deal list | fsw deal <jobId> permission granted|denied | fsw deal <jobId> review --rating <1-5> [--text "..."] [--liked true|false]';

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
  try {
    const [first, sub, ...rest] = argv;
    if (!first || first === 'list') {
      const jobs = ledger.listJobs();
      if (!jobs.length) log('no jobs');
      for (const j of jobs) log(j.id + '  ' + j.platform + '  ' + (j.service ?? '-') + '  ' + j.status + '  paid ' + ledger.jobPayments(j.id).reduce((s, p) => s + p.amountKRW, 0) + ' of ' + (j.priceKRW ?? '?') + '  portfolio ' + (j.meta?.portfolio?.permission ?? 'pending'));
      return 0;
    }
    const job = ledger.getJob(first);
    if (!job) throw new Error('no job ' + first);
    const at = (ctx.now ?? new Date()).toISOString();
    let signal;
    if (sub === 'permission' && ['granted', 'denied'].includes(rest[0])) {
      signal = { type: rest[0] === 'granted' ? 'permission_granted' : 'permission_refused', platform: job.platform, threadId: job.threadId, jobId: job.id, at, evidence: { source: 'operator' } };
    } else if (sub === 'review') {
      const o = options(rest);
      const rating = Number(o.rating);
      if (!(rating >= 1 && rating <= 5) || (o.liked !== undefined && !['true', 'false'].includes(o.liked))) throw new Error(USAGE);
      signal = { type: 'review', platform: job.platform, threadId: job.threadId, jobId: job.id, at, evidence: { source: 'operator', text: o.text ?? 'operator recorded a ' + rating + ' star review', rating, liked: o.liked === undefined ? null : o.liked === 'true' } };
    } else throw new Error(USAGE);
    const before = ledger.db.prepare('SELECT max(id) AS id FROM events').get().id ?? 0;
    const prior = job.meta?.portfolio ?? {};
    const r = advance(ledger, signal, { instance, descriptor: loadDescriptor(job.platform), now: new Date(at) });
    await applyEffects(r.effects, { instance, ledger, ...(ctx.notify ? { notify: ctx.notify } : {}) });
    // A refused permission writes deal.refused; a review on a job not yet delivered is recorded unapplied.
    const refused = ledger.db.prepare("SELECT payload FROM events WHERE id > ? AND kind = 'deal.refused' AND ref = ?").get(before, job.id);
    // The deal keys an operator review by its job (moneyKey in src/deal/advance.mjs), so this entry's
    // events are found by that key and by the job's review row, never by an event ref that names a thread.
    const ownKey = (payload) => String(JSON.parse(payload).key ?? '').endsWith(':review:operator:' + job.id);
    const review = sub === 'review' ? ledger.db.prepare("SELECT payload FROM events WHERE id > ? AND kind = 'money.review'").all(before).find((e) => ownKey(e.payload)) ?? null : null;
    const reason = refused ? JSON.parse(refused.payload).reason : review && !JSON.parse(review.payload).applied ? JSON.parse(review.payload).note : null;
    // A job has one review: entering it again corrects that row or, unchanged, records nothing.
    if (sub === 'review' && !review && !refused) {
      const kept = ledger.listMoneyEvents({ jobId: job.id, event: 'review' }).find((e) => JSON.parse(e.evidence).source === 'operator');
      const reviewId = kept ? JSON.parse(kept.evidence).reviewId : null;
      const corrected = ledger.db.prepare("SELECT payload FROM events WHERE id > ? AND kind = 'deal.review_corrected'").all(before).find((e) => JSON.parse(e.payload).reviewId === reviewId);
      log('job ' + job.id + ' review ' + (corrected ? 'corrected; the job keeps one review, now rating ' + JSON.parse(corrected.payload).to.rating : 'already recorded with this rating and text; nothing changed'));
      return 0;
    }
    // A grant over a refusal publishes work the client asked to keep private, so the operator sees what he lifted.
    if (!reason && signal.type === 'permission_granted' && prior.permission === 'denied') log('job ' + job.id + ' permission granted lifts the refusal recorded ' + (prior.answeredAt ?? 'earlier') + ' from ' + (prior.source ?? 'unknown') + (prior.quote ? ': "' + prior.quote + '"' : ' (no client sentence kept)'));
    log('job ' + job.id + ' ' + sub + (reason ? ' refused: ' + reason : ' recorded; the portfolio is synced and the next daily publish shows it'));
    return reason ? 1 : 0;
  } finally {
    if (!ctx.ledger) ledger.close();
  }
}
