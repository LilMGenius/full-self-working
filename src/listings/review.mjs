// Gig review watch for kmong (docs/DESIGN.md, Listings). The hourly listings job reads /my-gigs for every
// published gig and decides here what each observed status asks for: a gig on sale is announced to the
// operator once; a rejected gig (비승인) is recorded as a learning case with kmong's own notice, rebuilt
// with that notice fed to the brain as a violation and submitted again, at most MAX_RESUBMITS times per
// gig before it goes to the operator. kmong shows the reason in the yellow notice under the gig row
// (the 승인 안내 toggle on /my-gigs), the same box that holds its approval notices.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { squash } from '../platforms/kit.mjs';

export const MAX_RESUBMITS = 2;

// The status chips /my-gigs shows, by the code the watch uses (its 서비스 상태 안내 box, read
// 2026-10-25: 승인 전, 판매중 after manager approval, 비승인 after a failed review, 판매 중지).
const STATUS = { '승인 전': 'waiting', '판매중': 'selling', '비승인': 'rejected', '판매 중지': 'suspended', '임시 저장': 'draft', '작성 중': 'draft' };
export const gigStatus = (label) => STATUS[squash(label ?? '')] ?? 'unknown';

// The text a toggle added to a row: what lies between the longest common prefix and suffix of the
// row before and after it opened.
export function addedText(before, after) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  return b.slice(p, b.length - s);
}

// The notice text without kmong's greeting, sign-off and help-center links: what is left is the review
// result itself, which is what the next draft has to answer.
export function parseReviewNotice(text) {
  const kept = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^안녕하세요,?\s*전문가님/.test(l) && !/^크몽입니다\.?$/.test(l) && !/^감사합니다\.?$/.test(l) && !/^\(?참고\s*:/.test(l) && !/^https?:\/\//.test(l));
  const out = kept.join('\n').replace(/\s*\(?참고\s*:\s*https?:\/\/\S+\)?/g, '').trim();
  return out || null;
}

// A rejection is identified by the date kmong stamped on its notice and the gig's last edit; together
// with the status seen last hour (a resubmit sets it to waiting) the same 비승인 is handled once and
// a new one after a resubmit is handled again, even on the same day.
export const rejectionKey = (gig) => 'rejected:' + (gig?.approvedAt ?? 'none') + ':' + (gig?.modifiedAt ?? 'none');

// A rejection that asks for another category cannot be answered by rewriting the copy: kmong forbids
// moving a gig's category, so a new gig is the operator's call.
const CATEGORY_RE = /카테고리/;

// state: what earlier ticks recorded for this gig ({lastStatus, sellingNotifiedAt, handledRejection, resubmits}).
// observed: {status (code), key, notice}. Returns {action, detail}; action is none, notify_selling,
// read_notice (the notice is needed before deciding), resubmit or escalate.
export function nextReviewAction(state, observed, { maxResubmits = MAX_RESUBMITS } = {}) {
  const s = state ?? {};
  if (observed.status === 'selling') return s.sellingNotifiedAt ? { action: 'none' } : { action: 'notify_selling' };
  if (observed.status !== 'rejected') return { action: 'none' };
  if (s.handledRejection === observed.key && s.lastStatus === 'rejected') return { action: 'none' };
  if (observed.notice === undefined) return { action: 'read_notice' };
  const used = (s.resubmits ?? []).length;
  if (!observed.notice) return { action: 'escalate', detail: 'kmong rejected the gig and no reason was found in its notice box' };
  if (CATEGORY_RE.test(observed.notice)) return { action: 'escalate', detail: 'kmong asks for another category, which a rebuilt listing cannot change: ' + observed.notice };
  if (used >= maxResubmits) return { action: 'escalate', detail: 'kmong rejected the gig again after ' + used + ' automatic resubmits: ' + observed.notice };
  return { action: 'resubmit', detail: observed.notice };
}

// The violation the brain receives for a rejection: kmong's words, unchanged.
export const reviewViolation = (notice) => ({ field: 'kmong.review', rule: 'kmong.rejected', detail: 'kmong rejected the submitted listing with this notice: ' + notice });

export const reviewFile = (dir, service) => join(dir, service, 'review.json');

export function readReview(dir, service) {
  const file = reviewFile(dir, service);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { resubmits: [] };
}

export function writeReview(dir, service, state) {
  const file = reviewFile(dir, service);
  mkdirSync(join(dir, service), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(state, null, 2) + '\n');
  renameSync(file + '.tmp', file);
}

