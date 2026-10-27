// Yield per arm (platform, service) from the ledger (docs/DESIGN.md, Economics). Revenue counts only
// payment rows, which exist only from evidence; fees apply per payment because each 크몽 phase is its
// own order with its own tier. Quote costs count whether or not the quote won.
import { sellerNet } from './fees.mjs';
import { EconomicsError, requireNumber } from './errors.mjs';
import { quoteResults } from './quote-results.mjs';

const WON = new Set(['ordered', 'in_progress', 'delivered', 'revision', 'closed']);

const keyOf = (platform, service) => `${platform}\u0000${service ?? ''}`;

function emptyArm(platform, service) {
  return { platform, service, leads: 0, quotes: 0, wins: 0, losses: 0, refused: 0, revenueKRW: 0, feesKRW: 0, quoteCostKRW: 0, toolCostKRW: 0, netKRW: 0, agentHours: 0, humanHours: 0, closedWeightedHours: 0, closedWins: 0, leadKeys: new Set() };
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

// results: quoteResults (src/economics/quote-results.mjs), the list the price table learns from; the default
// reads statuses only, with no age rule.
export function armStats(ledger, { descriptors, services, config, results = quoteResults(ledger, { asOf: new Date(), expireAfterDays: Infinity }) }) {
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

  // Threads whose job already decided its quote: a job past quoted counts its own win or loss. A soomgo job
  // moves to its chat thread and names the request thread its quote sits on (findJob in src/deal/advance.mjs).
  const decidedThreads = new Set();
  for (const job of ledger.listJobs()) {
    const a = arm(job.platform, job.service);
    a.leadKeys.add(job.threadId != null ? `thread:${job.threadId}` : `job:${job.id}`);
    if (job.status !== 'quoted') for (const t of [job.threadId, job.meta?.requestThreadId]) if (t != null) decidedThreads.add(t);
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
  }
  // Losses from the replayed results, the list the price table learns from: a lost or expired quote counts
  // here unless its job already counted it, so an aged quote whose job still waits at quoted counts here. A
  // refused send never reached the client: neither a win nor a loss.
  for (const r of results) {
    const a = arm(r.platform, r.service);
    if (r.result === 'refused') a.refused += 1;
    else if ((r.result === 'lost' || r.result === 'expired') && !(r.threadId != null && decidedThreads.has(r.threadId))) a.losses += 1;
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
        quoteCostPerQuoteKRW: a.quotes > 0 ? a.quoteCostKRW / a.quotes : 0,
        expectedHours: expectedHours({ ...a, closedWeightedHours, closedWins }, services, weight),
      };
    })
    .sort((x, y) => x.platform.localeCompare(y.platform) || String(x.service).localeCompare(String(y.service)));
}
