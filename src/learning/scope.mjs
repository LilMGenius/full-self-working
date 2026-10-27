// The platforms a lesson applies to, as the gate and the prompts compare them: platform ids from the
// descriptors plus 'all'. A model writes appliesTo as free text, so a value is trimmed and lowercased and a
// descriptor's own name (크몽, 숨고, 위시켓, Upwork) maps to its id; anything else is dropped, and a scope that
// dropped any value applies to all, so a typo never switches a lesson off where it was meant: a rule that
// applies too widely is the safe side. The readers (the outbound gate, the prompts) normalize too, so a scope
// written before this or edited by hand still reaches its platform.
import { listDescriptors, loadDescriptor } from '../platforms/registry.mjs';

export const SCOPE_IDS = [...listDescriptors(), 'all'];
const BY_NAME = new Map([['all', 'all'], ...listDescriptors().flatMap((id) => [[id, id], [loadDescriptor(id).name.trim().toLowerCase(), id]])]);

// values -> {appliesTo, dropped}: appliesTo holds known ids once each, or ['all'] when nothing is left, a value
// was dropped or 'all' is named; dropped the values no id matched.
export function normalizeAppliesTo(values) {
  const kept = [];
  const dropped = [];
  for (const v of Array.isArray(values) ? values : []) {
    const id = BY_NAME.get(String(v ?? '').trim().toLowerCase());
    if (!id) dropped.push(v);
    else if (!kept.includes(id)) kept.push(id);
  }
  return { appliesTo: !kept.length || dropped.length || kept.includes('all') ? ['all'] : kept, dropped };
}

// Whether a lesson or rule scoped by values applies on platform.
export function scopeReaches(values, platform) {
  const { appliesTo } = normalizeAppliesTo(values);
  return appliesTo.includes('all') || appliesTo.includes(platform);
}
