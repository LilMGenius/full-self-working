// The operator settings (003 Settings): config.schema.json beside this file owns every config key's type,
// allowed values, default, meaning and x-choice mark. Pure helpers read and write a config document;
// validateConfig loads ajv (MIT, a dependency) only on its first call, so nothing the supervisor imports
// needs node_modules: the deploy worktree has none (003 FSW_CODE_DIR).
import { readFileSync } from 'node:fs';

const SCHEMA_URL = new URL('./config.schema.json', import.meta.url);
export const loadSchema = () => JSON.parse(readFileSync(SCHEMA_URL, 'utf8'));

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A local $ref (#/$defs/<name>) resolved against the schema root.
function deref(schema, node) {
  if (!node?.$ref) return node;
  return node.$ref.slice(2).split('/').reduce((n, k) => n[k], schema);
}

// The default document: a key with a default takes it, an object without one is built from its properties.
export function defaultsOf(schema, node = schema) {
  const out = {};
  for (const [k, raw] of Object.entries(node.properties ?? {})) {
    const p = deref(schema, raw);
    if ('default' in p) out[k] = clone(p.default);
    else if (p.properties) out[k] = defaultsOf(schema, p);
  }
  return out;
}

// The schema node of a dotted key; a segment no property names is matched through additionalProperties
// (a map keyed by platform). null for a key the schema does not describe.
export function keyInfo(schema, key) {
  let node = schema;
  for (const seg of String(key).split('.')) {
    const next = node.properties?.[seg] ?? (isObject(node.additionalProperties) ? node.additionalProperties : null);
    if (!next) return null;
    node = deref(schema, next);
  }
  return { type: node.type ?? null, enum: node.enum ?? null, default: clone(node.default), description: node.description ?? null, choice: node['x-choice'] === true };
}

export function getKey(config, key) {
  let cur = config;
  for (const seg of String(key).split('.')) {
    if (!isObject(cur) || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// A new document with key set to value; intermediate objects are created, the input is not changed.
export function setKey(config, key, value) {
  const out = clone(config) ?? {};
  const segs = String(key).split('.');
  let cur = out;
  for (const seg of segs.slice(0, -1)) {
    if (!isObject(cur[seg])) cur[seg] = {};
    cur = cur[seg];
  }
  cur[segs.at(-1)] = clone(value);
  return out;
}

let validator = null;

// Throws FSW_CONFIG_INVALID with ajv's path and message for the first error.
export async function validateConfig(config, schema = loadSchema()) {
  if (!validator) {
    const { default: Ajv2020 } = await import('ajv/dist/2020.js');
    validator = new Ajv2020({ strict: false, allErrors: false }).compile(schema);
  }
  if (validator(config)) return true;
  const e = validator.errors[0];
  // A map key the schema refuses (propertyNames) is named, since the path alone stops at the map.
  throw Object.assign(new Error('config' + (e.instancePath || '') + (e.propertyName ? ' key ' + JSON.stringify(e.propertyName) : '') + ' ' + e.message + (e.params?.allowedValues ? ': ' + e.params.allowedValues.map((v) => JSON.stringify(v)).join(', ') : '')), { code: 'FSW_CONFIG_INVALID' });
}

// Every x-choice key the operator's config.json does not hold, map keys expanded per enabled platform; a
// value equal to the default but written by the operator counts as made.
export function unmadeChoices(config, schema = loadSchema()) {
  const out = [];
  const walk = (node, prefix) => {
    for (const [k, raw] of Object.entries(node.properties ?? {})) {
      const p = deref(schema, raw);
      const key = prefix ? prefix + '.' + k : k;
      if (p['x-choice'] === true && getKey(config, key) === undefined) out.push({ key, description: p.description });
      if (p.properties && !p['x-choice']) walk(p, key);
      if (isObject(p.additionalProperties)) {
        const entry = deref(schema, p.additionalProperties);
        for (const [id, v] of Object.entries(getKey(config, key) ?? {})) if (v?.enabled) walk(entry, key + '.' + id);
      }
    }
  };
  walk(schema, '');
  return out;
}

// Every leaf key with its value, default and meaning, map keys expanded per configured entry.
export function listKeys(config, schema = loadSchema()) {
  const out = [];
  const walk = (node, prefix) => {
    for (const [k, raw] of Object.entries(node.properties ?? {})) {
      const p = deref(schema, raw);
      const key = prefix ? prefix + '.' + k : k;
      if (isObject(p.additionalProperties)) {
        const entry = deref(schema, p.additionalProperties);
        const ids = Object.keys({ ...(isObject(p.default) ? p.default : {}), ...(getKey(config, key) ?? {}) });
        for (const id of ids) {
          if (entry.properties) walk(entry, key + '.' + id);
          else out.push({ key: key + '.' + id, value: getKey(config, key + '.' + id), default: null, description: entry.description ?? p.description });
        }
      } else if (p.properties && !p['x-choice']) walk(p, key);
      else out.push({ key, value: getKey(config, key), default: p.default ?? null, description: p.description });
    }
  };
  walk(schema, '');
  return out;
}

// Schema keys missing their meaning or default, which check-example fails.
export function undocumentedKeys(schema = loadSchema()) {
  const out = [];
  const walk = (node, prefix) => {
    for (const [k, raw] of Object.entries(node.properties ?? {})) {
      const p = deref(schema, raw);
      const key = prefix ? prefix + '.' + k : k;
      if (!p.description) out.push(key + ' has no description');
      if (!('default' in p) && !p.properties) out.push(key + ' has no default');
      if (p.properties) walk(p, key);
    }
  };
  walk(schema, '');
  for (const [name, def] of Object.entries(schema.$defs ?? {})) walk(def, '$defs.' + name);
  return out;
}
