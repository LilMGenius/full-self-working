// Portfolio items on disk (instance portfolio/items.json) and their sources: background projects
// from the profile and paid jobs from the ledger. Ordering belongs to rank.mjs alone.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from '../core/instance.mjs';
import { rankPortfolio } from './rank.mjs';

const itemsPath = (instance) => join(instance.paths.portfolio, 'items.json');

// No file yet means no item has been saved; a file that exists but does not parse throws.
export function loadItems(instance) {
  const path = itemsPath(instance);
  if (!existsSync(path)) return [];
  const items = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(items)) throw new TypeError(`${path} must hold an array of items`);
  return items;
}

// Written beside the target and renamed over it, so a failed write never leaves half a file.
export function saveItems(instance, items) {
  ensureDir(instance.paths.portfolio);
  const path = itemsPath(instance);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n');
  renameSync(tmp, path);
  return path;
}

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '');

export function itemsFromProfile(profile) {
  const fit = profile?.serviceFit ?? {};
  return (profile?.projects ?? []).map((p) => ({
    id: `bg-${slug(p.name)}`,
    source: 'background',
    jobId: null,
    title_ko: p.name_ko ?? p.name,
    title_en: p.name,
    // The first catalog service whose serviceFit evidence cites this project.
    service: Object.entries(fit).find(([, f]) => (f.evidence ?? []).includes(p.name))?.[0] ?? null,
    client: null,
    satisfaction: null,
    // A background project has no review or QA score yet, so quality stays null and sorts after
    // scored items; a recorded QA result (rendered checks, a review) on the project is what fills it.
    quality: typeof p.quality === 'number' ? p.quality : null,
    volume: null,
    paidAt: null,
    permission: 'granted',
    media: p.media ?? [],
    summary_ko: p.what_ko ?? null,
    summary_en: p.what ?? null,
    url: p.url ?? null,
  }));
}

// payments are the job's ledger rows; paidAt is the newest received payment. Permission comes from
// the caller; without a recorded grant the job is pending and rankPortfolio keeps it hidden.
export function itemFromJob({ job, payments = [], review = null, permission }) {
  const meta = job.meta ?? {};
  const received = payments.map((p) => p.receivedAt).filter(Boolean).sort();
  const paid = payments.reduce((s, p) => s + p.amountKRW, 0);
  const hours = ((job.agentMinutes ?? 0) + (job.humanMinutes ?? 0)) / 60;
  return {
    id: `job-${job.id}`,
    source: 'job',
    jobId: job.id,
    title_ko: job.title ?? null,
    title_en: meta.title_en ?? null,
    service: job.service ?? null,
    client: meta.client ?? null,
    satisfaction: review ? { rating: review.rating ?? null, liked: review.liked ?? null, quote: review.text ?? null } : null,
    quality: typeof meta.quality === 'number' ? meta.quality : null,
    volume: { priceKRW: payments.length ? paid : null, hours: hours > 0 ? hours : null },
    paidAt: received.at(-1) ?? null,
    permission: permission ?? meta.portfolio?.permission ?? 'pending',
    media: meta.media ?? [],
    summary_ko: meta.summary_ko ?? null,
    summary_en: meta.summary_en ?? null,
    url: meta.url ?? null,
  };
}

// Fields a generator leaves empty keep what an earlier save held (media added by hand, a QA score).
function merge(existing, generated) {
  if (!existing) return generated;
  const out = { ...existing };
  for (const [k, v] of Object.entries(generated)) {
    const empty = v === null || (Array.isArray(v) && v.length === 0);
    if (!empty || !(k in existing)) out[k] = v;
  }
  return out;
}

export function syncPortfolio(instance, ledger) {
  const existing = loadItems(instance);
  const byId = new Map(existing.map((i) => [i.id, i]));
  const generated = [...itemsFromProfile(instance.profile)];
  for (const job of ledger.listJobs()) {
    const payments = ledger.jobPayments(job.id);
    if (!payments.length) continue;
    const review = ledger.jobReviews(job.id).at(-1) ?? null;
    generated.push(itemFromJob({ job, payments, review }));
  }
  for (const g of generated) byId.set(g.id, merge(byId.get(g.id), g));
  const items = [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (JSON.stringify(items) !== JSON.stringify(existing)) saveItems(instance, items);
  return rankPortfolio(items);
}
