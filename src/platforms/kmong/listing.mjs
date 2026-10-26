// 크몽 gigs on the operator's signed-in Chrome: the gig list, the edit form read without saving, the review
// notice of a row, and the create-or-update writer that reads every field back before it submits. The
// gig half of src/platforms/kmong/adapter.mjs at 2c77326 (:476-507, :588-591, :607-746).
import { openSession } from '../../browser/driver.mjs';
import { loadDescriptor } from '../registry.mjs';
import { AdapterRefusal, squash, toInt } from '../kit.mjs';
import { parseGigList, parseListingForm } from './parse.mjs';
import { pageOpenGigEdit, pageListingForm, pageFillForm, pageFillCore, pageFormState, pageRevealFile, pageRestoreFile, pageNewGig, pageClearSlot, pageGigNotice, pageMarkSubmit, pageAfterSubmit, pageDialogButton, pageTickDialog, pageRenameGig } from './listing-page.mjs';

const BASE = 'https://kmong.com';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Differences between the read-back form and the listing that was written into it.
export function formProblems(state, listing) {
  const out = [];
  const counters = state.counters ?? {};
  if (!('DESCRIPTION' in counters)) out.push('description field is missing');
  for (const [id, f] of [['DESCRIPTION', 'description'], ['DESCRIPTION_PROGRESS', 'process'], ['DESCRIPTION_PREPARATION', 'preparation']]) {
    if (id in counters && !toInt(counters[id]?.split('/')[0])) out.push(f + ' is empty');
  }
  if (state.packageMode !== true) out.push('package mode is off');
  listing.packages.forEach((p, i) => {
    if (state.packages?.[i]?.title !== p.title) out.push('package ' + i + ' title differs');
    if (state.packages?.[i]?.description !== p.description) out.push('package ' + i + ' description differs');
    if (toInt(state.prices?.[i]) !== p.priceKRW) out.push('package ' + i + ' price reads ' + state.prices?.[i]);
  });
  if (!(state.mainImages?.[0] >= 1)) out.push('no main image');
  if (!(state.detailImages?.[0] >= Math.min(1, listing.images.detail.length))) out.push('no detail image');
  if (listing.images.video?.length && !(state.videos?.[0] >= 1)) out.push('no video');
  if (state.keywords?.[0] !== listing.keywords.length) out.push('keywords read ' + (state.keywords?.[0] ?? 'none') + ' of ' + listing.keywords.length);
  if ((state.faqs ?? []).length !== listing.faqs.length || state.faqs.some((n) => !n)) out.push('faqs read ' + (state.faqs ?? []).length + ' of ' + listing.faqs.length);
  if (state.revisionField !== false && state.revision !== listing.revision) out.push('revision text differs');
  return out;
}

// The gig id and category ids an edit form URL carries (/my-gigs/edit/<id>?rootCategoryId=..&
// subCategoryId=..&thirdCategoryId=..); the bare /my-gigs/edit/<id> URL redirects away without them.
export function editIds(url) {
  const m = String(url ?? '').match(/\/my-gigs\/edit\/(\d+)(?:\?(.*))?$/);
  if (!m) return null;
  const q = new URLSearchParams(m[2] ?? '');
  const id = (k) => (/^\d+$/.test(q.get(k) ?? '') ? Number(q.get(k)) : null);
  return { gigId: Number(m[1]), categoryIds: { root: id('rootCategoryId'), sub: id('subCategoryId'), third: id('thirdCategoryId') } };
}

export async function openKmongListing({ session } = {}) {
  const s = session ?? (await openSession('kmong-listing', { platform: 'kmong', pacing: loadDescriptor('kmong').pacing }));
  const adapter = {
    platform: 'kmong',
    session: s,

    async listings() {
      await s.navigate(`${BASE}/my-gigs`);
      return parseGigList(await s.evaluate(() => document.body.innerText));
    },

    // Reads the gig edit form without saving: the edit page is reached through 편집하기 on /my-gigs,
    // since the bare /my-gigs/edit/<id> URL redirects back without category ids.
    async listingForm(gigId) {
      await s.navigate(`${BASE}/my-gigs`);
      if (!(await s.evaluate(pageOpenGigEdit, String(gigId)))) throw new AdapterRefusal('FSW_GIG_NOT_FOUND', `gig ${gigId} has no 편집하기 button on /my-gigs`);
      await wait(8000);
      const form = await s.evaluate(pageListingForm);
      if (!form.url.includes(`/my-gigs/edit/${gigId}`)) throw new AdapterRefusal('FSW_GIG_FORM', `edit form for ${gigId} did not open (at ${form.url})`);
      return parseListingForm(form);
    },

    // The 승인 안내 notice box of a gig row on /my-gigs, read without changing anything.
    async gigNotice(gigId) {
      await s.navigate(`${BASE}/my-gigs`, { settle: 7000 });
      return s.evaluate(pageGigNotice, String(gigId), { timeoutMs: 20_000 });
    },

    // Creates or updates a gig and submits it for review. listing is a built spec (src/listings/kmong.mjs)
    // with absolute image paths; listing.gigId reuses a draft or a rejected gig, opened by its category
    // ids when known and otherwise through 편집하기 on /my-gigs. replaceImages lists the slots (main,
    // detail) whose current files are deleted first, so a rebuilt listing shows its new images. Each step
    // reads the form back, and nothing is submitted unless every field holds what was written. Returns
    // what /my-gigs showed, with the category ids the edit URL carried.
    async upsertListing(listing, { submit = true, replaceImages = [] } = {}) {
      const steps = [];
      const fail = (reason, extra = {}) => ({ observed: false, submitted: false, gigId, categoryIds, reason, steps, ...extra });
      let gigId = listing.gigId ?? null;
      let categoryIds = listing.categoryIds ?? null;
      const { root, sub, third } = listing.category ?? {};
      if (!gigId) {
        await s.navigate(BASE + '/my-gigs/new', { settle: 7000 });
        await s.fill('input[placeholder="제목을 입력해 주세요"]', listing.title);
        const cat = await s.evaluate(pageNewGig, { root, sub, third });
        steps.push({ step: 'category', ...cat });
        if (!cat.ok) return fail(cat.reason ?? 'the categories did not take');
        await s.click('[data-fsw=next]');
        await wait(9000);
        const ids = editIds(await s.evaluate(() => location.href));
        gigId = ids?.gigId ?? null;
        categoryIds = ids?.categoryIds ?? null;
        steps.push({ step: 'draft', gigId });
        if (!gigId) return fail('다음 did not open a draft edit form');
      } else if (categoryIds?.root && categoryIds?.sub) {
        await s.navigate(BASE + '/my-gigs/edit/' + gigId + '?rootCategoryId=' + categoryIds.root + '&subCategoryId=' + categoryIds.sub + (categoryIds.third ? '&thirdCategoryId=' + categoryIds.third : ''), { settle: 8000 });
      } else {
        await s.navigate(BASE + '/my-gigs', { settle: 7000 });
        if (!(await s.evaluate(pageOpenGigEdit, String(gigId)))) return fail('gig ' + gigId + ' has no 편집하기 button on /my-gigs');
        await wait(9000);
        categoryIds = editIds(await s.evaluate(() => location.href))?.categoryIds ?? null;
      }
      let state = await s.evaluate(pageFormState);
      if (!state.url.includes('/my-gigs/edit/' + gigId)) return fail('the edit form for ' + gigId + ' did not open (at ' + state.url + ')');
      if (squash(state.title) !== squash(listing.title)) {
        const r = await s.evaluate(pageRenameGig, listing.title);
        steps.push({ step: 'title', ...r });
        if (!r.ok) return fail(r.reason);
      }
      // Images go first: the slot inputs stop taking files once the fields below hold focus and state.
      // A slot that already holds files is left as it is (a re-run keeps the uploaded set) unless
      // replaceImages names it, in which case its files are deleted first.
      // Video categories (AI 영상) require one file in 동영상; listing.images.video carries it.
      const slots = [['main', [listing.images.main], 'MAIN_GALLERY', 'mainImages'], ['detail', listing.images.detail, 'IMAGE_GALLERY', 'detailImages']];
      if (listing.images.video?.length) slots.push(['video', listing.images.video, 'VIDEO_GALLERY', 'videos']);
      for (const [slot, files, fieldId, stateKey] of slots) {
        let count = (await s.evaluate(pageFormState))[stateKey]?.[0] ?? 0;
        if (count > 0 && replaceImages.includes(slot)) {
          const cleared = await s.evaluate(pageClearSlot, fieldId, { timeoutMs: 30_000 });
          steps.push({ step: 'images.' + slot + '.clear', ...cleared });
          if (!cleared.ok) return fail('the ' + slot + ' images could not be removed: ' + (cleared.reason ?? cleared.left + ' left'));
          count = 0;
        }
        if (count > 0) {
          steps.push({ step: 'images.' + slot, kept: count });
          continue;
        }
        if (!(await s.evaluate(pageRevealFile, fieldId))) return fail('no file input for the ' + slot + ' slot');
        try {
          await s.setFiles('[data-fsw=file-up]', files);
        } finally {
          await s.evaluate(pageRestoreFile);
        }
        await wait(slot === 'video' ? 20_000 : 4000 + 1500 * files.length);
        steps.push({ step: 'images.' + slot, uploaded: files.length });
      }

      const form = listing.form ?? { meta: {}, packageSelects: {}, packageChecks: {} };
      const filled = await s.evaluate(pageFillForm, {
        description: listing.description,
        process: listing.process,
        preparation: listing.preparation,
        revision: listing.revision,
        meta: form.meta,
        packages: listing.packages.map((p) => ({ title: p.title, description: p.description })),
        packageSelects: { ...form.packageSelects, '작업 기간': listing.packages.map((p) => p.days + '일'), '수정 횟수': listing.packages.map((p) => p.revisions + '회') },
        packageChecks: form.packageChecks,
      }, { timeoutMs: 90_000 });
      steps.push({ step: 'fields', errors: filled.errors, counters: filled.counters, absent: filled.absent });
      if (filled.errors.length) return fail('form fields: ' + filled.errors.join('; '));
      for (const [i, p] of listing.packages.entries()) await s.typeKeys('[data-fsw=price-' + i + ']', String(p.priceKRW));

      const core = await s.evaluate(pageFillCore, listing.faqs, { timeoutMs: 30_000 });
      steps.push({ step: 'core', ...core });
      if (core.errors?.length) return fail('core fields: ' + core.errors.join('; '));
      state = await s.evaluate(pageFormState);
      for (const k of listing.keywords) {
        if (state.keywordText?.split('\n').some((l) => l.trim() === k)) continue;
        await s.fill('[data-fsw=keyword]', k);
        await s.press('Enter', { target: '[data-fsw=keyword]' });
        await wait(400);
      }

      state = await s.evaluate(pageFormState);
      const problems = formProblems(state, listing);
      steps.push({ step: 'readback', problems });
      if (problems.length) return fail('read back: ' + problems.join('; '), { state });
      if (!submit) return { observed: true, submitted: false, gigId, categoryIds, steps, state };

      if (!(await s.evaluate(pageMarkSubmit))) return fail('no 제출하기 button');
      await s.click('[data-fsw=submit]');
      await wait(5000);
      let after = await s.evaluate(pageAfterSubmit);
      for (let i = 0; i < 2 && after.dialogs.length; i++) {
        const confirm = after.dialogs.at(-1).buttons.find((b) => ['제출하기', '확인', '제출'].includes(b));
        const tick = await s.evaluate(pageTickDialog);
        steps.push({ step: 'dialog', text: after.dialogs.at(-1).text.slice(0, 200), ticked: tick.ticked, pressed: confirm ?? null });
        if (!confirm || !tick.checked) break;
        await s.evaluate(pageDialogButton, confirm);
        await wait(5000);
        after = await s.evaluate(pageAfterSubmit);
      }
      steps.push({ step: 'submit', url: after.url, errors: after.errors });
      if (after.errors.length) return fail('the form refused the submit: ' + after.errors.join('; '), { submitted: false });
      await s.navigate(BASE + '/my-gigs', { settle: 7000 });
      const list = parseGigList(await s.evaluate(() => document.body.innerText));
      const gig = list.gigs.find((g) => g.gigId === gigId);
      steps.push({ step: 'my-gigs', found: !!gig, status: gig?.status ?? null });
      if (!gig) return fail('gig ' + gigId + ' is not listed on /my-gigs after submit', { submitted: true });
      const submitted = gig.status !== '임시 저장' && gig.status !== '작성 중';
      return { observed: true, submitted, gigId, categoryIds, status: gig.status, title: gig.title, priceKRW: gig.priceKRW, url: gig.url, counts: list.counts, steps };
    },

    stop: () => s.stop(),
  };
  return adapter;
}
