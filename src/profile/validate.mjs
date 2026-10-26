// The shape every consumer of profile.json relies on. `fsw profile accept` refuses a draft that fails it.
import catalog from '../economics/services.json' with { type: 'json' };

const SERVICE_IDS = Object.keys(catalog).filter((k) => !k.startsWith('_'));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateProfile(p) {
  const errors = [];
  const need = (cond, path, detail) => cond || errors.push(`${path}: ${detail}`);
  need(isObj(p), 'profile', 'must be an object');
  if (!isObj(p)) return errors;
  need(isObj(p.person) && (p.person.nameKo || p.person.nameEn || p.person.handle), 'person', 'needs at least one of nameKo, nameEn, handle');
  for (const k of ['headline_ko', 'headline_en', 'summary_ko', 'summary_en']) need(typeof p[k] === 'string', k, 'must be a string (empty is allowed)');
  for (const k of ['roles', 'education', 'awards', 'projects', 'approvedClaims', 'claimsNotToMake', 'languages']) need(Array.isArray(p[k]), k, 'must be an array');
  need(isObj(p.skills) && Object.values(p.skills).every(Array.isArray), 'skills', 'must map each category to an array');
  need(isObj(p.serviceFit), 'serviceFit', 'must be an object');
  if (isObj(p.serviceFit)) {
    for (const [id, f] of Object.entries(p.serviceFit)) {
      need(SERVICE_IDS.includes(id), `serviceFit.${id}`, 'is not a catalog service');
      need(['strong', 'some', 'none'].includes(f?.strength), `serviceFit.${id}.strength`, 'must be strong, some or none');
      need(Array.isArray(f?.evidence), `serviceFit.${id}.evidence`, 'must be an array');
    }
  }
  const named = new Set([...(p.projects ?? []).map((x) => x?.name), ...(p.roles ?? []).map((r) => r?.org), ...(p.awards ?? []).map((a) => a?.name)]);
  for (const [id, f] of Object.entries(p.serviceFit ?? {})) {
    for (const e of f?.evidence ?? []) need(named.has(e), `serviceFit.${id}.evidence`, `"${e}" is not a listed project, role or award`);
  }
  for (const [i, c] of (p.approvedClaims ?? []).entries()) need(typeof c === 'string' && c.trim(), `approvedClaims.${i}`, 'must be a non-empty string');
  return errors;
}

// Values the example ships; a profile that still carries one was never filled in.
export function placeholderFields(p, example) {
  const found = [];
  for (const k of ['nameKo', 'nameEn', 'handle', 'phone', 'email']) if (p.person?.[k] && p.person[k] === example.person?.[k]) found.push(`person.${k}`);
  for (const r of p.roles ?? []) if ((example.roles ?? []).some((e) => e.org === r.org)) found.push(`roles: ${r.org}`);
  for (const x of p.projects ?? []) if ((example.projects ?? []).some((e) => e.name === x.name)) found.push(`projects: ${x.name}`);
  return found;
}
