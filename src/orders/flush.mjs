// Acts on approved order items for one platform, called from flushApprovals inside the outbound hours.
import { listApprovals } from '../brain/approvals.mjs';
import { sendPayRequest } from './requests.mjs';
import { sendDelivery } from './delivery.mjs';

export async function flushOrderItems({ platform, adapter, ledger, instance, descriptor }) {
  const out = [];
  for (const a of listApprovals(instance, { status: 'approved' })) {
    if (!a.orderItem || a.platform !== platform || a.closedAt) continue;
    if (a.kind === 'pay_request') out.push(await sendPayRequest({ instance, ledger, descriptor, adapter, approval: a }));
    else if (a.kind === 'delivery') out.push(await sendDelivery({ instance, ledger, descriptor, adapter, approval: a }));
  }
  return out;
}

