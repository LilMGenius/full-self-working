// The service catalog (services.json) and the questions every layer asks of it: which catalog services
// a platform's own label can become, which market categories a platform is sampled on, which services an
// instance answers on each platform, and who delivers each one (docs/DESIGN.md, Instance and Economics).
// catalogServicesFor and targetsFor moved here from src/pipeline/thread.mjs:22-31 and
// src/cli/market.mjs:36-44 at 2c77326, so triage, deal, priority and sampling import economics instead
// of the pipeline (the 2c77326 cycle src/pipeline/thread.mjs:13 <-> src/orders/money.mjs:9); the answered
// list and the delivery mode are src/economics/catalog.mjs of 206d360, carried verbatim; parkKey is
// src/pipeline/thread.mjs:34-44 of 22fbb4b.
import { createHash } from 'node:crypto';
import services from './services.json' with { type: 'json' };
import { CATEGORY_FIELD } from './pricing.mjs';

export const catalog = services;

export const DELIVERY_MODES = ['agent', 'operator'];

const configError = (message) => Object.assign(new Error(message), { code: 'FSW_CONFIG_INVALID' });

// agent: a job runs the service's recipe. operator: the operator does the work, so the service has no
// recipe, and a paid job is handed to the operator instead of a job run.
export function deliveryOf(def) {
  const mode = def?.delivery ?? 'agent';
  if (!DELIVERY_MODES.includes(mode)) throw Object.assign(new Error('catalog delivery must be one of ' + DELIVERY_MODES.join(', ') + ', got ' + mode), { code: 'FSW_SERVICE_INVALID' });
  return mode;
}

export const operatorDelivered = (service, list = catalog) => deliveryOf(list[service]) === 'operator';

// config.platforms.<id>.services lists the catalog ids the instance answers on that platform. Absent or
// null is every service the agent delivers: an operator service spends the operator's own hours, so it
// waits until the operator lists it.
export function answeredServices(config, platform, list = catalog) {
  const all = Object.keys(list).filter((k) => !k.startsWith('_'));
  const listed = config?.platforms?.[platform]?.services;
  if (listed == null) return all.filter((id) => deliveryOf(list[id]) === 'agent');
  const path = 'config platforms.' + platform + '.services';
  if (!Array.isArray(listed)) throw configError(path + ' must be a list of catalog service ids, or null for every agent-delivered service');
  const unknown = listed.filter((id) => !all.includes(id));
  if (unknown.length) throw configError(path + ' names ' + unknown.join(', ') + ', which the catalog does not hold');
  return all.filter((id) => listed.includes(id));
}

// The catalog cut to what the instance answers on one platform; the notes stay.
export function answeredCatalog(config, platform, list = catalog) {
  const keep = new Set(answeredServices(config, platform, list));
  return Object.fromEntries(Object.entries(list).filter(([k]) => k.startsWith('_') || keep.has(k)));
}

// The catalog services a platform's own service label can become: those whose market category is the
// label, plus the ones the descriptor's serviceLabels adds for a coarse label (숨고 files a cafe homepage
// under 웹 개발). undefined: the platform gave no label, so there is nothing to check; an empty list: the
// label is a service the catalog does not hold.
export function catalogServicesFor(descriptor, label, list = services) {
  const field = CATEGORY_FIELD[descriptor.id];
  if (!field || !label) return undefined;
  const ids = Object.entries(list).filter(([id, def]) => !id.startsWith('_') && def[field] === label).map(([id]) => id);
  return [...new Set([...ids, ...(descriptor.serviceLabels?.[label] ?? [])])];
}

// The settings a list-time park was decided under: the services the instance answers on the platform,
// the reply windows, and how the platform's labels map onto the catalog. A park holds only while they do,
// so an operator who starts answering a service or widens a window gets every item parked under the old
// settings checked again from its list row, and a park written before parks carried this key is checked
// once.
export function parkKey(config, descriptor, list = services) {
  const field = CATEGORY_FIELD[descriptor.id];
  const labels = Object.entries(list).filter(([id]) => !id.startsWith('_')).map(([id, def]) => [id, field ? def[field] ?? null : null]);
  const basis = [answeredServices(config, descriptor.id, list), config?.pipeline?.replyWindowHours ?? null, descriptor.serviceLabels ?? null, labels];
  return createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 16);
}

// One market target per distinct category label, since several services can share one.
export function targetsFor(platform, list = services) {
  const field = CATEGORY_FIELD[platform];
  const byCategory = new Map();
  for (const [id, def] of Object.entries(list)) {
    if (!id.startsWith('_') && def[field] && !byCategory.has(def[field])) byCategory.set(def[field], { category: def[field], def });
  }
  return [...byCategory.values()];
}
