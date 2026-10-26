// fsw settings: every operator choice in config.json with its value, default and meaning (003 Settings).
//   fsw settings                     one line per key
//   fsw settings set <key> <value>   value is read as JSON when it parses, else as a string
//   fsw settings reset <key>         the schema default
// A change is validated against src/core/config.schema.json, written beside config.json and renamed over
// it, and recorded as one settings.changed event; the supervisor reads it at its next tick.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getKey, keyInfo, listKeys, loadSchema, setKey, validateConfig } from '../core/config.mjs';
import { instanceDir } from '../core/instance.mjs';
import { openLedger } from '../core/ledger.mjs';

const USAGE = 'usage: fsw settings | fsw settings set <key> <value> | fsw settings reset <key>';
const show = (v) => (v === undefined ? 'unset' : JSON.stringify(v));

function parseValue(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function run(argv, ctx = {}) {
  const log = ctx.log ?? console.log;
  const error = ctx.error ?? console.error;
  const dir = ctx.dir ?? instanceDir();
  const file = join(dir, 'config.json');
  if (!existsSync(file)) {
    error('no config.json in ' + dir + '; run fsw init first');
    return 1;
  }
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const schema = loadSchema();
  const [cmd, key, ...rest] = argv;
  if (!cmd) {
    for (const k of listKeys(config, schema)) log(k.key + ' = ' + show(k.value) + ' (default ' + JSON.stringify(k.default) + ') ' + k.description);
    return 0;
  }
  if (!['set', 'reset'].includes(cmd) || !key || (cmd === 'set' && !rest.length)) {
    error(USAGE);
    return 2;
  }
  const info = keyInfo(schema, key);
  if (!info) {
    error('unknown setting ' + key + '; fsw settings lists every key');
    return 1;
  }
  if (cmd === 'reset' && info.default === undefined) {
    error(key + ' has no default; set it with fsw settings set ' + key + ' <value>');
    return 1;
  }
  const value = cmd === 'set' ? parseValue(rest.join(' ')) : info.default;
  const old = getKey(config, key);
  const next = setKey(config, key, value);
  try {
    await validateConfig(next, schema);
  } catch (err) {
    if (err.code !== 'FSW_CONFIG_INVALID') throw err;
    error('settings: ' + err.message + '; config.json is unchanged');
    return 1;
  }
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, file);
  const ledger = ctx.ledger ?? openLedger(join(dir, 'ledger.sqlite'));
  try {
    ledger.addEvent({ kind: 'settings.changed', ref: key, payload: { key, old: old ?? null, new: value } });
  } finally {
    if (!ctx.ledger) ledger.close();
  }
  log(key + ' = ' + show(value) + ' (was ' + show(old) + '); the supervisor reads it at its next tick');
  return 0;
}
