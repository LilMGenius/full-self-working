// The stage a thread is in: the later of what the page says and what the ledger's money evidence says,
// so an adapter that prints pre_order on every thread cannot pull a paid order back before its quote
// (src/pipeline/thread.mjs:76-84, src/orders/money.mjs:47,54-61 at 2c77326). A job now opens at quoted,
// which is not an accepted quote, so quoted is excluded beside lost.
const STAGES = ['pre_order', 'quote_accepted', 'post_order'];

// The newest job of a thread, by insertion order (jobs carry no creation time): an answer or a stage on a
// thread that once held a closed job belongs to the job opened after it.
export function jobOfThread(ledger, platform, threadId) {
  const row = ledger.db.prepare('SELECT id FROM jobs WHERE platform = ? AND thread_id = ? ORDER BY rowid DESC LIMIT 1').get(platform, threadId);
  return row ? ledger.getJob(row.id) : null;
}

export function stageFromLedger(ledger, platform, threadId) {
  const job = jobOfThread(ledger, platform, threadId);
  if (job && ledger.jobPayments(job.id).length) return 'post_order';
  if ((job && !['lost', 'quoted'].includes(job.status)) || ledger.listQuotes({ threadId, status: 'accepted' }).length) return 'quote_accepted';
  return null;
}

export function stageOf({ page, kind }, ledger, platform, threadId) {
  const shown = page ?? (kind === 'order' ? 'post_order' : 'pre_order');
  const evidence = stageFromLedger(ledger, platform, threadId) ?? 'pre_order';
  return STAGES.indexOf(evidence) > STAGES.indexOf(shown) ? evidence : shown;
}
