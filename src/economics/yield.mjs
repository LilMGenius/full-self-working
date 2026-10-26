// Yield per arm (platform, service) from the ledger (docs/DESIGN.md, Economics). Revenue counts only
// payment rows, which exist only from evidence; fees apply per payment because each 크몽 phase is its
// own order with its own tier. Quote costs count whether or not the quote won.
import { sellerNet } from './fees.mjs';
import { EconomicsError, requireNumber } from './errors.mjs';

const WON = new Set(['ordered', 'in_progress', 'delivered', 'revision', 'closed']);
const LOST_QUOTE = new Set(['declined', 'expired']);

const keyOf = (platform, service) => `${platform}\u0000${service ?? ''}`;

function emptyArm(platform, service) {
  return { platform, service, leads: 0, quotes: 0, wins: 0, losses: 0, revenueKRW: 0, feesKRW: 0, quoteCostKRW: 0, toolCostKRW: 0, netKRW: 0, agentHours: 0, humanHours: 0, closedWeightedHours: 0, closedWins: 0, leadKeys: new Set() };
}

// Weighted hours one win is expected to take: observed hours per closed job once there is one,
// otherwise the catalog estimate for the standard package.
function expectedHours(arm, services, weight) {
  if (arm.closedWins > 0) return arm.closedWeightedHours / arm.closedWins;
  const def = services?.[arm.service];
  if (!def) return null;
  const agent = requireNumber(def.agentHours?.standard, `services.${arm.service}.agentHours.standard`, 'FSW_SERVICE_INVALID');
  const human = requireNumber(def.humanMinutes?.standard, `services.${arm.service}.humanMinutes.standard`, 'FSW_SERVICE_INVALID') / 60;
  return agent + human * weight;
}

export function armStats(ledger, { descriptors, services, config }) {
  const weight = requireNumber(config?.yield?.humanHourWeight, 'config.yield.humanHourWeight');
  const arms = new Map();
  const arm = (platform, service) => {
    const k = keyOf(platform, service);
    if (!arms.has(k)) arms.set(k, emptyArm(platform, service));
    return arms.get(k);
  };
  for (const platform of Object.keys(descriptors)) {
    for (const service of Object.keys(services)) if (!service.startsWith('_')) arm(platform, service);
  }
  const descriptorFor = (platform) => {
    const d = descriptors[platform];
    if (!d) throw new EconomicsError('FSW_DESCRIPTOR_MISSING', `ledger has payments on ${platform} but no descriptor was given`, { platform });
    return d;
  };

  for (const t of ledger.listThreads()) arm(t.platform, t.service).leadKeys.add(`thread:${t.id}`);

  const threadsWithJobs = new Set();
  for (const job of ledger.listJobs()) {
    const a = arm(job.platform, job.service);
    a.leadKeys.add(job.threadId != null ? `thread:${job.threadId}` : `job:${job.id}`);
    if (job.threadId != null) threadsWithJobs.add(job.threadId);
    const won = WON.has(job.status);
    if (won) a.wins += 1;
    if (job.status === 'lost') a.losses += 1;
    const agentHours = (job.agentMinutes ?? 0) / 60;
    const humanHours = (job.humanMinutes ?? 0) / 60;
    a.agentHours += agentHours;
    a.humanHours += humanHours;
    a.toolCostKRW += job.costKRW ?? 0;
    for (const p of ledger.jobPayments(job.id)) {
      const net = sellerNet(p.amountKRW, descriptorFor(job.platform));
      a.revenueKRW += p.amountKRW;
      a.feesKRW += net.fees;
    }
    if (job.status === 'closed') {
      a.closedWins += 1;
      a.closedWeightedHours += agentHours + humanHours * weight;
    }
  }

  for (const q of ledger.listQuotes()) {
    const a = arm(q.platform, q.service);
    a.quotes += 1;
    a.quoteCostKRW += q.costKRW ?? 0;
    if (q.threadId != null) a.leadKeys.add(`thread:${q.threadId}`);
    // A lost quote whose thread has a job is already counted through the job's status.
    if (LOST_QUOTE.has(q.status) && !(q.threadId != null && threadsWithJobs.has(q.threadId))) a.losses += 1;
  }

  return [...arms.values()]
    .map(({ leadKeys, closedWeightedHours, closedWins, ...a }) => {
      const netKRW = a.revenueKRW - a.feesKRW - a.quoteCostKRW - a.toolCostKRW;
      const weightedHours = a.agentHours + a.humanHours * weight;
      return {
        ...a,
        leads: leadKeys.size,
        netKRW,
        weightedHours,
        netPerWeightedHour: weightedHours > 0 ? netKRW / weightedHours : null,
        expectedHours: expectedHours({ ...a, closedWeightedHours, closedWins }, services, weight),
      };
    })
    .sort((x, y) => x.platform.localeCompare(y.platform) || String(x.service).localeCompare(String(y.service)));
}
