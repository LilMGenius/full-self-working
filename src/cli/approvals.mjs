// fsw approve: list items waiting for the operator, approve one (optionally with edited text) or reject
// it, or settle a send the surface could not observe as sent. A rejection and an edited approval are
// recorded as learning cases, since both say what the brain got wrong. Reads and writes the outbox
// (003 Outbox) instead of approval files.
import { loadInstance } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';
import { approvalView, resolve, settleSent, signalOf } from '../outbox/index.mjs';
import { advance } from '../deal/index.mjs';
import { applyEffects } from '../loop/effects.mjs';
import { loadDescriptor } from '../platforms/registry.mjs';
import { loadRecipe } from '../work/index.mjs';
import { caseFromApproval, recordOutcome } from '../learning/outcomes.mjs';

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
  const ledger = ctx.ledger ?? openLedger(instance.paths.ledger);
  try {
    if (!first || first === 'list') {
      const open = ledger.listOutbox({ statuses: ['awaiting_operator'] });
      if (!open.length) log('no open approvals');
      for (const r of open) log(r.approvalId + '  ' + r.platform + '  ' + r.kind + '  ' + (r.reason ?? '') + (r.payload.text ? '\n    ' + r.payload.text.replace(/\s+/g, ' ').slice(0, 160) : ''));
      return 0;
    }
    if (first === 'show') {
      if (!second) throw new Error(USAGE);
      const row = ledger.outboxByApproval(second);
      if (!row) throw Object.assign(new Error('no outbox item has approval id ' + second), { code: 'FSW_OUTBOX_NO_APPROVAL' });
      log(JSON.stringify(row, null, 2));
      return 0;
    }
    if (args.sent) {
      // A send the surface could not observe and the operator saw go out (7b9524e): observed, the outbound
      // message written, and the deal's quote_observed (or delivery or pay request) signal applied, so the
      // quote row holds the cash it cost and nothing sends it again.
      if (args.cost != null && !/^\d+$/.test(String(args.cost))) throw new Error('--cost needs a whole KRW amount, got ' + args.cost);
      const now = ctx.now ?? new Date();
      const { row, receipt } = settleSent(ledger, first, { costKRW: args.cost != null ? Number(args.cost) : null, now });
      const signal = signalOf(row, receipt, now);
      if (signal) {
        const r = advance(ledger, signal, { instance, descriptor: loadDescriptor(row.platform), now, loadRecipe });
        await applyEffects(r.effects, { instance, ledger, notify: ctx.notify, loadRecipe });
      }
      log(first + ' sent, as the operator confirmed');
      return 0;
    }
    const row = resolve(ledger, first, { approve: !args.reject, editedText: args.text, reason: args.reason });
    // A rejection and an edited approval say what the brain got wrong (src/cli/approvals.mjs:2).
    const c = caseFromApproval(approvalView(row));
    if (c && c.text.trim()) recordOutcome(instance, ledger, c);
    log(row.approvalId + ' ' + row.status + (row.operator?.edited ? ' with edits' : '') + (row.status === 'approved' ? '; the next drain sends it after authorize passes again' : ''));
    return 0;
  } finally {
    if (!ctx.ledger) ledger.close();
  }
}
