// kmong shows order counters before any order row could be parsed: a rise in any counter is an order
// event the operator must see. Returns {changed, rises}. Carried verbatim from src/orders/money.mjs:63-83
// at 2c77326. The orders argument is 003's orders?() -> {counts, total, gap, orders}; the alert reads
// counts and gap.
// Gap: kmong order rows are not parsed (no order was ever observed on the account), so a rise opens no
// job and writes no payment; parsing /seller/order-list rows against a real order closes it (060).
import { notifyOperator } from '../core/notify.mjs';

export async function recordOrderCounters({ ledger, instance, platform, orders, notify = notifyOperator }) {
  const counts = orders?.counts;
  if (!counts) return { changed: false, rises: [] };
  const prev = ledger.db.prepare("SELECT payload FROM events WHERE kind = 'orders.read' AND platform = ? ORDER BY id DESC LIMIT 1").get(platform);
  const before = prev ? JSON.parse(prev.payload)?.counts ?? null : null;
  ledger.addEvent({ kind: 'orders.read', platform, payload: { counts, total: orders.total ?? null, gap: orders.gap ?? null } });
  const rises = before ? Object.entries(counts).filter(([k, n]) => Number.isInteger(n) && n > (before[k] ?? 0)).map(([k, n]) => ({ counter: k, from: before[k] ?? 0, to: n })) : [];
  if (!rises.length) return { changed: false, rises };
  ledger.addEvent({ kind: 'orders.changed', platform, payload: { rises, gap: 'order rows are not parsed; no job or payment is recorded from a counter' } });
  await notify(instance, {
    kind: 'order',
    title: platform + ' order counters rose: ' + rises.map((r) => r.counter + ' ' + r.from + ' to ' + r.to).join(', '),
    body: 'fsw does not parse ' + platform + ' order rows yet, so no job or payment was recorded. Open the order list on ' + platform + ' and handle the order by hand.',
    dedupeKey: 'orders:' + platform + ':' + JSON.stringify(counts),
  });
  return { changed: true, rises };
}
