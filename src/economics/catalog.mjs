// Which catalog services an instance answers on each platform, and who delivers each one
// (docs/DESIGN.md, Instance and Jobs).
import catalog from './services.json' with { type: 'json' };

export const DELIVERY_MODES = ['agent', 'operator'];

const configError = (message) => Object.assign(new Error(message), { code: 'FSW_CONFIG_INVALID' });

// agent: a job runs the service's recipe. operator: the operator does the work, so the service has no
// recipe, and a paid job is handed to the operator instead of a job run.
export function deliveryOf(def) {
  const mode = def?.delivery ?? 'agent';
  if (!DELIVERY_MODES.includes(mode)) throw Object.assign(new Error('catalog delivery must be one of ' + DELIVERY_MODES.join(', ') + ', got ' + mode), { code: 'FSW_SERVICE_INVALID' });
  return mode;
}

export const operatorDelivered = (service, services = catalog) => deliveryOf(services[service]) === 'operator';

// config.platforms.<id>.services lists the catalog ids the instance answers on that platform. Absent or
// null is every service the agent delivers: an operator service spends the operator's own hours, so it
// waits until the operator lists it.
export function answeredServices(config, platform, services = catalog) {
  const all = Object.keys(services).filter((k) => !k.startsWith('_'));
  const listed = config?.platforms?.[platform]?.services;
  if (listed == null) return all.filter((id) => deliveryOf(services[id]) === 'agent');
  const path = 'config platforms.' + platform + '.services';
  if (!Array.isArray(listed)) throw configError(path + ' must be a list of catalog service ids, or null for every agent-delivered service');
  const unknown = listed.filter((id) => !all.includes(id));
  if (unknown.length) throw configError(path + ' names ' + unknown.join(', ') + ', which the catalog does not hold');
  return all.filter((id) => listed.includes(id));
}

// The catalog cut to what the instance answers on one platform; the notes stay.
export function answeredCatalog(config, platform, services = catalog) {
  const keep = new Set(answeredServices(config, platform, services));
  return Object.fromEntries(Object.entries(services).filter(([k]) => k.startsWith('_') || keep.has(k)));
}
