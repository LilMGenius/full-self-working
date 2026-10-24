// Appends one JSON line per event to logs/events-<Seoul dayKey>.jsonl.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayKey } from './clock.mjs';
import { ensureDir } from './instance.mjs';

export function logEvent(instance, kind, payload = {}) {
  const at = new Date();
  const entry = { at: at.toISOString(), kind, ...payload };
  const dir = ensureDir(instance.paths.logs);
  appendFileSync(join(dir, `events-${dayKey(at)}.jsonl`), JSON.stringify(entry) + '\n');
  return entry;
}
