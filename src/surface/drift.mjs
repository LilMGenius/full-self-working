// Answer shapes per extractor, and the drift between a recording and a baseline. A shape keeps keys and
// value types and drops every value, so a committed baseline carries no page text. null and an empty list
// match any shape, since an extractor answers null for an absent field and [] for an empty page.
export function shapeOf(value) {
  if (value === null || value === undefined) return { t: 'null' };
  if (Array.isArray(value)) {
    const of = [];
    for (const v of value) {
      const s = shapeOf(v);
      if (!of.some((o) => JSON.stringify(o) === JSON.stringify(s))) of.push(s);
    }
    return { t: 'array', of };
  }
  if (typeof value === 'object') return { t: 'object', k: Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k])])) };
  return { t: typeof value };
}

// {[op name]: shape[]} over a recording's answered calls. navigate answers are URLs and are left out.
export function shapesOf(recording) {
  const out = {};
  for (const e of recording) {
    if (e.op === 'navigate' || e.op === 'act' || e.error) continue;
    const key = e.op + ' ' + e.name;
    const s = shapeOf(e.answer);
    out[key] ??= [];
    if (!out[key].some((o) => JSON.stringify(o) === JSON.stringify(s))) out[key].push(s);
  }
  return out;
}

// Differences of a current shape from a baseline shape: [{path, before, after}].
export function shapeDiff(before, after, path = '') {
  if (before.t === 'null' || after.t === 'null') return [];
  if (before.t !== after.t) return [{ path: path || '.', before: before.t, after: after.t }];
  if (before.t === 'object') {
    const out = [];
    for (const k of new Set([...Object.keys(before.k), ...Object.keys(after.k)])) {
      if (!(k in after.k)) out.push({ path: path + '.' + k, before: before.k[k].t, after: 'missing' });
      else if (!(k in before.k)) out.push({ path: path + '.' + k, before: 'missing', after: after.k[k].t });
      else out.push(...shapeDiff(before.k[k], after.k[k], path + '.' + k));
    }
    return out;
  }
  if (before.t === 'array') {
    if (!before.of.length || !after.of.length) return [];
    const out = [];
    for (const a of after.of) {
      const diffs = before.of.map((b) => shapeDiff(b, a, path + '[]'));
      if (!diffs.some((d) => d.length === 0)) out.push(...diffs.sort((x, y) => x.length - y.length)[0]);
    }
    return out;
  }
  return [];
}

// Extractors whose current answers fit no baseline shape: [{extractor, path, before, after}]. An extractor
// the baseline never saw is reported as new; one the current recording did not call is not drift.
export function driftReport(baseline, current) {
  const out = [];
  for (const [extractor, shapes] of Object.entries(current)) {
    const known = baseline[extractor];
    if (!known) {
      out.push({ extractor, path: '.', before: 'unrecorded', after: 'new' });
      continue;
    }
    for (const s of shapes) {
      const diffs = known.map((b) => shapeDiff(b, s));
      if (diffs.some((d) => d.length === 0)) continue;
      for (const d of diffs.sort((x, y) => x.length - y.length)[0]) out.push({ extractor, ...d });
    }
  }
  return out;
}
