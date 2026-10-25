// fsw approve: list open approvals, approve one (optionally with edited text) or reject it, or settle a
// send the adapter could not observe as sent. A rejection and an edited approval are recorded as learning
// cases, since both say what the brain got wrong.
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { closeApproval, getApproval, listApprovals, resolveApproval } from '../brain/approvals.mjs';
import { caseFromApproval, recordOutcome } from '../learning/outcomes.mjs';
import { recordSent } from '../pipeline/thread.mjs';

const USAGE = 'usage: fsw approve [list] | fsw approve <id> [--text "..."] | fsw approve <id> --reject [--reason "..."] | fsw approve <id> --sent [--cost <KRW>] | fsw approve show <id>';

export function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reject') out.reject = true;
    else if (a === '--sent') out.sent = true;
    else if (a === '--text' || a === '--reason' || a === '--cost') {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value');
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new Error('unknown option ' + a);
    else out.positional.push(a);
  }
  return out;
}

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const instance = ctx.instance ?? loadInstance();
  const args = parseArgs(argv);
  const [first, second] = args.positional;
  if (!first || first === 'list') {
    const open = listApprovals(instance, { status: 'open' });
    if (!open.length) log('no open approvals');
    for (const a of open) log(a.id + '  ' + a.platform + '  ' + a.kind + '  ' + a.reason + (a.draft ? '\n    ' + a.draft.replace(/\s+/g, ' ').slice(0, 160) : ''));
    return 0;
  }
  if (first === 'show') {
    if (!second) throw new Error(USAGE);
    log(JSON.stringify(getApproval(instance, second), null, 2));
    return 0;
  }
  if (args.sent) {
    settleSent(instance, first, args, ctx);
    log(first + ' sent, as the operator confirmed');
    return 0;
  }
  const resolved = resolveApproval(instance, first, { approve: !args.reject, editedText: args.text, reason: args.reason });
  const c = caseFromApproval(resolved);
  if (c && c.text.trim()) {
    const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
    try {
      recordOutcome(instance, ledger, c);
    } finally {
      if (!ctx.ledger) ledger.close();
    }
  }
  log(resolved.id + ' ' + resolved.status + (resolved.edited ? ' with edits' : '') + (resolved.status === 'approved' ? '; the next tick sends it after the gate passes again' : ''));
  return 0;
}

// The operator saw on the platform that a send the adapter could not observe went out: the ledger gets
// what an observed send records, and the approval closes as sent, so nothing sends it a second time.
export function settleSent(instance, id, { cost } = {}, ctx = {}) {
  const record = getApproval(instance, id);
  const unobserved = record.status === 'unobserved' || (record.status === 'open' && record.unobserved === true);
  if (!unobserved) throw new Error(id + ' is ' + record.status + '; --sent settles only a send the adapter could not observe');
  if (cost != null && !/^\d+$/.test(String(cost))) throw new Error('--cost needs a whole KRW amount, got ' + cost);
  const costKRW = cost != null ? Number(cost) : record.pressed?.costKRW ?? record.costKRW ?? null;
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  try {
    recordSent({ ledger, platform: record.platform, threadId: record.threadId, text: record.finalText ?? record.draft, quote: record.quote, service: record.service, costKRW });
    ledger.addEvent({ kind: record.quote ? 'quote.sent' : 'message.sent', platform: record.platform, ref: record.threadRef, payload: { approvalId: id, confirmedBy: 'operator', amountKRW: record.quote?.amountKRW ?? null, costKRW } });
  } finally {
    if (!ctx.ledger) ledger.close();
  }
  return closeApproval(instance, id, { status: 'sent', detail: 'the operator confirmed the send' });
}
