// fsw evidence first-outbound: the live criterion of wp6. Reads the ledger read-only and prints the
// first outbox row v0 sent on a real kmong or soomgo thread and read back on the page, with the
// matching outbound message. Exit 0 when found (and the evidence file written), 3 when none yet, 2 on a
// usage error or no start point.
//   fsw evidence first-outbound [--since <iso>]   (--since defaults to the newest ledger event takeover)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dayKey } from '../core/clock.mjs';
import { ensureDir, loadInstance } from '../core/instance.mjs';

const USAGE = 'usage: fsw evidence first-outbound [--since <iso>]';

// The switch to v0 writes one ledger event takeover {from, to} (003 Takeover); the newest one is the start.
export const newestTakeover = (db) => db.prepare("SELECT at FROM events WHERE kind = 'takeover' ORDER BY id DESC LIMIT 1").get()?.at ?? null;

// A row counts only when its receipt says the surface read the item back on the page: a receipt the
// operator confirmed with fsw approve --sent (confirmedBy operator) proves a send, not a read-back.
const readBack = (receipt) => receipt?.observed === true && receipt.confirmedBy == null;
// A send read back after an interrupted drain keeps the page text as receipt.text, not snippet
// (src/outbox/drain.mjs reconcile), so the length falls back to it.
const readBackText = (receipt) => String(receipt.snippet ?? receipt.text ?? '');
// The outbound message may carry a page time rounded down to the minute, earlier than the row's own
// created_at, so the lookup starts at that minute. That minute can also hold an earlier send's message,
// so a message whose text is this row's own (the read-back text, the operator's final text or the planned
// text, the bodies the drain and fsw approve write) is preferred over the earliest one.
const minuteFloor = (iso) => new Date(Math.floor(Date.parse(iso) / 60_000) * 60_000).toISOString();
function outboundMessage(db, row, receipt) {
  if (!row.thread_id) return null;
  const candidates = db.prepare("SELECT id, external_id, at, body FROM messages WHERE thread_id = ? AND direction = 'out' AND at >= ? ORDER BY at, id").all(row.thread_id, minuteFloor(row.created_at));
  const texts = [receipt.text, JSON.parse(row.operator ?? 'null')?.finalText, JSON.parse(row.payload ?? 'null')?.text].filter((t) => typeof t === 'string' && t);
  const m = candidates.find((c) => texts.includes(c.body)) ?? candidates[0];
  return m ? { id: m.id, external_id: m.external_id, at: m.at } : null;
}

export function firstOutbound(db, since) {
  const rows = db.prepare("SELECT * FROM outbox WHERE status = 'observed' AND platform IN ('kmong','soomgo') AND kind IN ('message','quote') AND updated_at >= ? ORDER BY updated_at, id").all(since);
  for (const row of rows) {
    const receipt = JSON.parse(row.receipt ?? 'null');
    if (!readBack(receipt)) continue;
    return { outboxId: row.id, key: row.key, platform: row.platform, kind: row.kind, status: row.status, observedAt: row.updated_at, receipt: { observed: true, externalId: receipt.externalId ?? null, snippetLength: readBackText(receipt).length }, message: outboundMessage(db, row, receipt) };
  }
  return null;
}

export async function run(args, { log = console.log, error = console.error, instance = loadInstance(), now = new Date() } = {}) {
  if (args[0] !== 'first-outbound') {
    error(USAGE);
    return 2;
  }
  const at = args.indexOf('--since');
  if (at >= 0 && !args[at + 1]) {
    error(USAGE);
    return 2;
  }
  const db = new DatabaseSync(instance.paths.ledger, { readOnly: true });
  try {
    const given = at >= 0 ? args[at + 1] : newestTakeover(db);
    if (!given || !Number.isFinite(Date.parse(given))) {
      error('evidence: ' + (at >= 0 ? '--since ' + given + ' is not a time' : 'no --since and no takeover event in the ledger'));
      return 2;
    }
    // The ledger stores ISO times in UTC (toISOString), so a --since with an offset is compared in that form.
    const since = new Date(given).toISOString();
    const found = firstOutbound(db, since);
    if (!found) {
      log('evidence: no observed outbound item since ' + since);
      return 3;
    }
    const dir = ensureDir(join(instance.dir, 'qa', 'live'));
    const file = join(dir, 'first-outbound-' + dayKey(now) + '.json');
    writeFileSync(file, JSON.stringify({ since, ...found }, null, 2) + '\n');
    log('evidence: outbox ' + found.outboxId + ' (' + found.platform + ' ' + found.kind + ') observed at ' + found.observedAt + '; wrote ' + file);
    return 0;
  } finally {
    db.close();
  }
}
