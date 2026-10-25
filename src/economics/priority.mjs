// Where effort goes first: the newest allocation (src/economics/allocate.mjs, written daily by the
// supervisor) turned into an order over work items. Conversations already under way come before new
// requests, since an unanswered customer costs the response-rate signals every platform ranks by; new
// requests follow by the allocation weight of the service the platform labels them with, so a capped
// day of paid quotes or proposals is spent on the arms with the best expected yield per hour first.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogServicesFor } from '../pipeline/thread.mjs';

const ALLOCATION_RE = /^allocation-(\d{8})\.json$/;

// The newest allocation file in the instance, or null when the daily job has not written one yet.
export function latestAllocation(instance) {
  const dir = instance?.paths?.pricing;
  const file = dir && existsSync(dir) ? readdirSync(dir).filter((f) => ALLOCATION_RE.test(f)).sort().at(-1) : null;
  if (!file) return null;
  const { weights } = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  if (!Array.isArray(weights)) throw Object.assign(new Error(file + ' has no weights array'), { code: 'FSW_ALLOCATION_INVALID' });
  return { file: join(dir, file), day: file.match(ALLOCATION_RE)[1], weights };
}

// The weight of one (platform, service) arm; 0 for an arm the allocation left out (not viable, not
// enabled, no price row), null when there is no allocation at all.
export function armWeight(allocation, platform, service) {
  if (!allocation) return null;
  return allocation.weights.find((w) => w.platform === platform && w.service === service)?.weight ?? 0;
}

// A request's weight is the best weight among the catalog services its platform label allows; a request
// with no label or no allocation sorts as neutral, after weighted ones and before known zeros.
export function itemWeight(item, { allocation, descriptor }) {
  if (!allocation) return null;
  const services = item.service ? catalogServicesFor(descriptor, item.service) : undefined;
  if (!services?.length) return null;
  return Math.max(...services.map((s) => armWeight(allocation, descriptor.id, s)));
}

// Stable order: messages first in list order, then requests by weight (neutral after weighted, zero
// last), list order breaking ties.
export function prioritize(items, { allocation, descriptor }) {
  const rank = (item) => {
    if (item.kind !== 'request') return [0, 0];
    const w = itemWeight(item, { allocation, descriptor });
    // Weighted requests rank in [-2, -1), neutral ones at -0.5 and known zeros at 0.
    return [1, w === null ? -0.5 : w === 0 ? 0 : -1 - w];
  };
  return items
    .map((item, i) => ({ item, i, r: rank(item) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.i - b.i)
    .map((x) => x.item);
}
