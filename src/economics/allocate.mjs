// Thompson-sampling allocation over (platform, service) arms (docs/DESIGN.md, Economics).
// Each arm draws a win rate from Beta(1 + wins, 1 + losses); its score is win rate x the net of the
// price table's base / expected weighted hours. Scores are normalized into weights, and every enabled
// arm still under config.yield.exploreUntilLeads leads keeps a floor: config.yield.explorationFloor, cut
// so that all floors together stay within config.yield.explorationShare. Without that cap, twenty young
// arms at 5 percent each would take the whole mass and every arm would get the same weight.
import { EconomicsError, requireNumber } from './errors.mjs';

// mulberry32 by Tommy Ettinger (public domain), the 32-bit PRNG widely quoted from
// https://gist.github.com/tommyettinger/46a874533244883189143505d203312c ; returns floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal by Box-Muller; 1 - u keeps the logarithm's argument in (0, 1].
function normal(rng) {
  const u1 = 1 - rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Gamma(shape, 1) by Marsaglia and Tsang, "A Simple Method for Generating Gamma Variables",
// ACM TOMS 26(3), 2000. Shapes below 1 use the paper's boost: Gamma(a + 1) x U^(1 / a).
export function gamma(shape, rng) {
  if (!(shape > 0)) throw new RangeError(`gamma shape must be positive, got ${shape}`);
  if (shape < 1) return gamma(shape + 1, rng) * Math.pow(1 - rng(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(rng);
    const v0 = 1 + c * x;
    if (v0 <= 0) continue;
    const v = v0 * v0 * v0;
    const u = 1 - rng();
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

export function beta(a, b, rng) {
  const x = gamma(a, rng);
  return x / (x + gamma(b, rng));
}

// Raise every floor arm to at least `floor`, scaling the others into what remains, until stable.
function applyFloor(shares, floorArms, floor) {
  if (!floorArms.size) return shares;
  if (floorArms.size * floor >= 1) return shares.map((_, i) => (floorArms.has(i) ? 1 / floorArms.size : 0));
  const fixed = new Set();
  let out = shares.slice();
  for (;;) {
    for (const i of floorArms) if (out[i] < floor) fixed.add(i);
    const free = out.map((_, i) => i).filter((i) => !fixed.has(i));
    const freeMass = free.reduce((s, i) => s + shares[i], 0);
    const remaining = 1 - fixed.size * floor;
    const next = out.map((_, i) => (fixed.has(i) ? floor : freeMass > 0 ? (shares[i] / freeMass) * remaining : 0));
    if (next.every((v, i) => Math.abs(v - out[i]) < 1e-15)) return next;
    out = next;
  }
}

export function allocate(arms, { priceTable, config, rng = Math.random }) {
  const maxFloor = requireNumber(config?.yield?.explorationFloor, 'config.yield.explorationFloor');
  const share = requireNumber(config?.yield?.explorationShare, 'config.yield.explorationShare');
  const untilLeads = requireNumber(config?.yield?.exploreUntilLeads, 'config.yield.exploreUntilLeads');
  // Draw in a fixed order so a seeded run does not depend on the order arms arrive in.
  const ordered = [...arms].sort((x, y) => x.platform.localeCompare(y.platform) || String(x.service).localeCompare(String(y.service)));
  const results = ordered.map((a) => {
    const out = { platform: a.platform, service: a.service, leads: a.leads, wins: a.wins, losses: a.losses, weight: 0, score: 0, exploring: false };
    if (config.platforms?.[a.platform]?.enabled !== true) return { ...out, reason: 'platform not enabled' };
    const row = priceTable.find((r) => r.platform === a.platform && r.service === a.service);
    if (!row) return { ...out, reason: 'no price row' };
    // An arm on a platform this build cannot work (no adapter) gets nothing until one exists and signs in.
    if (row.adapter === false) return { ...out, reason: 'no adapter' };
    if (!row.viable) return { ...out, reason: row.reason ?? 'price row not viable' };
    const value = requireNumber(row.baseNetKRW, `price row ${a.platform}/${a.service}.baseNetKRW`, 'FSW_PRICE_ROW_MISSING');
    if (!(a.expectedHours > 0)) throw new EconomicsError('FSW_ARM_INVALID', `arm ${a.platform}/${a.service} has no expected hours`);
    const winRate = beta(1 + a.wins, 1 + a.losses, rng);
    return { ...out, winRate, valueKRW: value, expectedHours: a.expectedHours, score: (winRate * value) / a.expectedHours, exploring: a.leads < untilLeads };
  });
  const total = results.reduce((s, r) => s + r.score, 0);
  if (total > 0) {
    const shares = results.map((r) => r.score / total);
    const floorArms = new Set(results.flatMap((r, i) => (r.exploring ? [i] : [])));
    const floor = floorArms.size ? Math.min(maxFloor, share / floorArms.size) : 0;
    applyFloor(shares, floorArms, floor).forEach((w, i) => (results[i].weight = w));
  }
  return results.sort((x, y) => y.weight - x.weight || x.platform.localeCompare(y.platform) || String(x.service).localeCompare(String(y.service)));
}
