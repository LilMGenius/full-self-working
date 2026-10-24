// fsw approve: list open approvals, approve one (optionally with edited text) or reject it.
// A rejection and an edited approval are recorded as learning cases, since both say what the brain got wrong.
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { getApproval, listApprovals, resolveApproval } from '../brain/approvals.mjs';
import { caseFromApproval, recordOutcome } from '../learning/outcomes.mjs';

const USAGE = 'usage: fsw approve [list] | fsw approve <id> [--text "..."] | fsw approve <id> --reject [--reason "..."] | fsw approve show <id>';

export function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reject') out.reject = true;
    else if (a === '--text' || a === '--reason') {
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
