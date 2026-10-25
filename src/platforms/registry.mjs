// Platform descriptors are JSON data in ./descriptors, validated on load. Rules that a script can
// decide live here as data and are enforced by src/policy/gate.mjs.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const descriptorDir = join(dirname(fileURLToPath(import.meta.url)), 'descriptors');
export const CONTACT_CLASSES = ['phone', 'email', 'url', 'messenger'];
const MODELS = ['storefront', 'request_quote', 'bidding', 'contest'];
const MILESTONES = ['native', 'reorder', 'multi_pay', 'none', 'unknown'];
const LIMIT_KINDS = ['message', 'quote', 'listing', 'profile'];
// Browsers a market sampler can read public pages through (src/cli/market.mjs).
export const MARKET_ENGINES = ['owned', 'attached', 'archive'];

function invalid(id, path, detail) {
  const err = new Error(`descriptor ${id} invalid at ${path}: ${detail}`);
  err.code = 'FSW_DESCRIPTOR_INVALID';
  err.path = path;
  return err;
}

const at = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const isText = (v) => typeof v === 'string' && v.length > 0;
const isRate = (v) => typeof v === 'number' && v >= 0 && v < 1;
const isRateOrText = (v) => isRate(v) || isText(v);

const REQUIRED = [
  ['id', isText], ['name', isText], ['region', (v) => ['kr', 'global'].includes(v)], ['currency', (v) => /^[A-Z]{3}$/.test(v)],
  ['model', (v) => [v].flat().length > 0 && [v].flat().every((m) => MODELS.includes(m))],
  ['fees', (v) => typeof v === 'object' && v !== null],
  ['fees.seller', (v) => isRateOrText(v) || (Array.isArray(v) && v.length > 0 && v.every((t) => isRate(t.rate) && (t.uptoKRW === null || t.uptoKRW > 0)))],
  ['fees.paymentNetworkRate', isRateOrText], ['fees.vatOnFees', isRateOrText],
  ['fees.buyer', (v) => isText(v) || (typeof v === 'object' && v !== null && isRateOrText(v.rate))],
  ['bidCost.unit', isText], ['bidCost.notes', isText],
  ['escrow', (v) => typeof v === 'boolean'], ['milestones', (v) => MILESTONES.includes(v)], ['splitMechanism', isText],
  ...['preOrder', 'postOrder'].map((k) => [`contactPolicy.${k}`, (v) => Array.isArray(v) && v.every((c) => CONTACT_CLASSES.includes(c))]),
  ['contactPolicy.allowedHosts', (v) => Array.isArray(v) && v.every((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h))],
  ['offPlatformPayment', (v) => typeof v === 'boolean'],
  ['automation.officialAutoReply', isText], ['automation.forbidden', Array.isArray], ['automation.notes', isText],
  ['aiPolicy', isText], ['taxInvoice', isText],
  ...['minGapMs', 'maxActionsPerHour', 'maxMessagesPerHour'].map((k) => [`pacing.${k}`, (v) => Number.isInteger(v) && v > 0]),
  ...LIMIT_KINDS.map((k) => [`limits.${k}.maxChars`, (v) => (Number.isInteger(v) && v > 0) || v === 'unknown']),
  ['rankingSignals', (v) => Array.isArray(v) && v.length > 0],
  ['sources', (v) => Array.isArray(v) && v.length > 0 && v.every((u) => /^https:\/\//.test(u))],
];

export function validateDescriptor(d, id = d?.id) {
  for (const [path, ok] of REQUIRED) {
    const v = at(d, path);
    if (v === undefined) throw invalid(id, path, 'missing');
    if (!ok(v)) throw invalid(id, path, `unexpected value ${JSON.stringify(v)}`);
  }
  const basis = d.fees.sellerTierBasis;
  if (basis !== undefined && !['marginal', 'whole'].includes(basis)) throw invalid(id, 'fees.sellerTierBasis', `unexpected value ${JSON.stringify(basis)}`);
  const engine = d.market?.engine;
  if (engine !== undefined && !MARKET_ENGINES.includes(engine)) throw invalid(id, 'market.engine', 'unexpected value ' + JSON.stringify(engine));
  // identity "forbidden" makes the gate block the operator's names (src/policy/gate.mjs identityNames).
  const identity = d.contactPolicy.identity;
  if (identity !== undefined && !['allowed', 'forbidden'].includes(identity)) throw invalid(id, 'contactPolicy.identity', 'unexpected value ' + JSON.stringify(identity));
  // A whole-amount tier that raised the rate would net less on a larger gross, and the cost floor's
  // search needs net to grow with gross.
  if (basis === 'whole' && !(Array.isArray(d.fees.seller) && d.fees.seller.every((t, i, all) => i === 0 || t.rate <= all[i - 1].rate))) {
    throw invalid(id, 'fees.seller', 'whole-amount tiers must list rates that never rise');
  }
  if (id !== undefined && d.id !== id) throw invalid(id, 'id', `file is ${id} but id is ${d.id}`);
  return d;
}

export function listDescriptors() {
  return readdirSync(descriptorDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

const cache = new Map();
export function loadDescriptor(id) {
  if (cache.has(id)) return cache.get(id);
  const file = join(descriptorDir, `${id}.json`);
  if (!/^[a-z0-9_]+$/.test(id) || !existsSync(file)) throw invalid(id, 'id', 'no descriptor file');
  const d = Object.freeze(validateDescriptor(JSON.parse(readFileSync(file, 'utf8')), id));
  cache.set(id, d);
  return d;
}
