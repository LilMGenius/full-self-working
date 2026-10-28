// 크몽 엔터프라이즈 projects: the public project list and detail pages, the seller's daily proposal quota
// and sent proposals, and the 제안하기 form. Lists and details render signed out, so they are read in
// an owned headless browser (src/render/html2png.mjs) and the seller account's activity stays small;
// the quota, the proposal list and the form need the session and go through the driver with the
// descriptor's pacing. The site footer forbids copying or republishing its listings: project records
// stay in the instance for the agent's own decisions and are never published or committed.
import { createHash } from 'node:crypto';
import { openSession } from '../../browser/driver.mjs';
import { openRenderer } from '../../render/html2png.mjs';
import { loadDescriptor } from '../registry.mjs';
import { AdapterRefusal, lines, squash, toInt } from '../kit.mjs';
import { gateOutbound } from '../../policy/gate.mjs';
import { pageAfterSubmit, pageCheck, pageChoose, pageConfirm, pageDetail, pageFetchList, pageMarkSubmit, pageProposalForm, pageProposeButton, pageSetField } from './projects-page.mjs';

const BASE = 'https://kmong.com';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Category tabs on /enterprise/requests (id is the category_list value) and the sort keys behind
// 최신순, 마감임박순 and 금액높은순, read from the page on 2026-10-25.
export const CATEGORIES = { all: '', it: 6, design: 1, marketing: 2, video: 7, planning: 11 };
export const SORTS = { latest: 'CREATED_AT', deadline: 'DEADLINE_DATE', amount: 'AMOUNT' };
export const REQUESTED_HEADING = '지원하실 때 아래 내용을 제안서에 꼭 포함해 주세요.';

export function listQuery({ category = 'all', sort = 'latest', page = 1, perPage = 10, q = '' } = {}) {
  const cat = category in CATEGORIES ? CATEGORIES[category] : category;
  const s = SORTS[sort] ?? sort;
  return new URLSearchParams({ q, sort: s, category_list: String(cat ?? ''), sub_category_list: '', project_type: '', page: String(page), per_page: String(perPage) }).toString();
}
export const listUrl = (opts) => BASE + '/enterprise/requests?' + listQuery(opts);
export const detailUrl = (id) => BASE + '/enterprise/requests/' + id;

// Lines of the description after the requested-items heading, until a blank line followed by a
// heading-like line or the end. These are what every proposal has to answer.
export function requestedItems(description) {
  const text = String(description ?? '').replace(/\r/g, '');
  const at = text.indexOf(REQUESTED_HEADING);
  if (at < 0) return [];
  return text.slice(at + REQUESTED_HEADING.length).split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
}

// The page version a judgement was made on: what the client wrote, the budget and the category. The
// days-left counter moves every day and is not part of it.
export function projectHash(p) {
  return createHash('sha1').update(JSON.stringify([p.title, p.description, p.amountKRW, p.sub?.id ?? null, p.status, p.projectType])).digest('hex').slice(0, 16);
}

const answerValue = (a) => (a?.type === 'TEXT' ? a.description ?? null : (a?.contents ?? []).join(', ') || null);

// A deadline in days left becomes a Seoul calendar date, counted from the day it was read.
export function deadlineDate(daysLeft, now = new Date()) {
  if (!Number.isInteger(daysLeft)) return null;
  const seoul = new Date(now.getTime() + 9 * 3_600_000);
  seoul.setUTCDate(seoul.getUTCDate() + daysLeft);
  return seoul.toISOString().slice(0, 10);
}

// One row of GET /api/custom-project/v1/requests.
export function parseProjectRow(row, { now = new Date() } = {}) {
  if (!row || !Number.isInteger(row.id)) throw new TypeError('project row without an integer id');
  const p = {
    id: row.id,
    title: squash(row.title),
    description: String(row.content ?? ''),
    amountKRW: Number.isFinite(row.amount) ? row.amount : null,
    deadlineDays: Number.isInteger(row.deadline) ? row.deadline : null,
    deadlineAt: deadlineDate(row.deadline, now),
    status: row.status ?? null,
    projectType: row.project_type ?? null,
    businessType: row.business_type ?? null,
    isGovernment: row.is_government ?? null,
    isTax: row.is_tax ?? null,
    durationDays: Number.isInteger(row.days) ? row.days : null,
    proposalCount: Number.isInteger(row.proposal_count) ? row.proposal_count : null,
    root: { id: row.category?.cat1 ?? null, name: row.category?.cat1_name ?? null },
    sub: { id: row.category?.cat2 ?? null, name: row.category?.cat2_name ?? null },
    source: 'list',
    readAt: now.toISOString(),
  };
  return { ...p, requested: requestedItems(p.description), hash: projectHash(p) };
}

// The react-query entry ["projectDetail", id] of a detail page.
export function parseProjectDetail(data, { now = new Date() } = {}) {
  if (!data || !Number.isInteger(data.id)) throw new TypeError('project detail without an integer id');
  const answers = Object.fromEntries((data.answers ?? []).map((a) => [a.title, answerValue(a)]));
  const description = String(answers['프로젝트 설명'] ?? data.description ?? '');
  const p = {
    id: data.id,
    title: squash(data.title),
    description,
    amountKRW: Number.isFinite(data.amount) ? data.amount : null,
    deadlineDays: Number.isInteger(data.deadline) ? data.deadline : null,
    deadlineAt: deadlineDate(data.deadline, now),
    status: data.status ?? null,
    projectType: data.projectType ?? null,
    businessType: data.businessType ?? null,
    isGovernment: data.isGovernment ?? null,
    isTax: data.isTax ?? null,
    isConfidential: data.isConfidential ?? null,
    isProposal: data.isProposal ?? null,
    proposalCount: Number.isInteger(data.proposalCount) ? data.proposalCount : null,
    root: { id: data.rootCategoryId ?? null, name: data.rootCategoryName ?? null },
    sub: { id: data.subCategoryId ?? null, name: data.subCategoryName ?? null },
    mode: answers['진행 방식'] ?? null,
    clientType: answers['의뢰인 유형'] ?? null,
    startDate: answers['프로젝트 시작일'] ?? null,
    endDate: answers['프로젝트 종료 예정일'] ?? null,
    readiness: answers['준비 상황'] ?? null,
    government: answers['정부지원 여부'] ?? null,
    source: 'detail',
    readAt: now.toISOString(),
  };
  return { ...p, requested: requestedItems(description), hash: projectHash(p) };
}

// /seller/proposals: "오늘 보낼 수 있는 제안 : 5개" is what is left for the Seoul day.
export function parseQuota(text) {
  const m = String(text ?? '').replace(/\s+/g, ' ').match(/오늘 보낼 수 있는 제안\s*:\s*(\d+)\s*개/);
  return m ? Number(m[1]) : null;
}

// Status labels the proposal list can show. Only the filter names (응답 대기중, 미팅) were seen while
// the list was empty; the rest are the platform's words for the same outcomes, and a card whose status
// matches none reads as unknown until a real card shows its label.
export const PROPOSAL_STATUSES = [
  { re: /미선정|선정되지\s*않|마감|종료|취소|거절|반려/, status: 'closed' },
  { re: /선정|계약/, status: 'selected' },
  { re: /미팅/, status: 'meeting' },
  { re: /응답\s*대기|대기중|열람|확인\s*전/, status: 'waiting' },
];
export const statusOf = (label) => PROPOSAL_STATUSES.find((s) => s.re.test(label))?.status ?? 'unknown';

// Each known project title on the list page, with the first status label in the lines after it.
export function parseProposals(text, titles = []) {
  const l = lines(text);
  const empty = /프로젝트에 제안한 내역이 없습니다/.test(String(text ?? ''));
  const found = [];
  for (const title of titles) {
    const at = l.findIndex((x) => squash(x) === squash(title));
    if (at < 0) continue;
    const label = l.slice(at + 1, at + 8).find((x) => statusOf(x) !== 'unknown' && x.length <= 20) ?? null;
    found.push({ title, label, status: label ? statusOf(label) : 'unknown' });
  }
  return { quota: parseQuota(text), empty, found };
}

// ---- form planning (node side, pure) ----

export const SUBMIT_LABELS = ['제안서 보내기', '제안 보내기', '제안하기', '제출하기', '보내기'];
export const CONFIRM_LABELS = ['확인', '제안하기', '보내기', '제출하기'];
const AMOUNT_LABEL = /금액|견적|예산|가격|비용/;
const TAX_CHOICES = { true: '가능', false: '불가능' };

// The proposal's length in days, first start to last end inclusive, which the form asks for.
export function proposalDays(phases) {
  const starts = (phases ?? []).map((p) => Date.parse(p.startDate + 'T00:00:00Z')).filter(Number.isFinite);
  const ends = (phases ?? []).map((p) => Date.parse(p.endDate + 'T00:00:00Z')).filter(Number.isFinite);
  if (!starts.length || !ends.length) return null;
  return Math.round((Math.max(...ends) - Math.min(...starts)) / 86_400_000) + 1;
}

// The character limit of a field without a maxLength attribute, read from its counter (0/3000).
export const counterLimit = (counters) => Math.max(0, ...(counters ?? []).map((c) => toInt(String(c).split('/')[1]) ?? 0)) || null;

// Which field takes what. Mapped on 2026-10-25 (an enterprise project): 제안할 예산 (name=amount, in 만원, with the
// floor the page prints as "최소 1540만원" for a 2200만원 budget), 제안할 진행 기간 (name=days), the 세금계산서
// 발행 여부 buttons, 제안 내용 (name=content, no maxLength attribute and a 0/3000 counter; the page cuts a
// longer text), up to six optional files and two [필수] acknowledgements. Each acknowledgement is ticked only
// when it matches one of the descriptor's enterprise.proposalAcknowledgements, so a changed term, a new fee
// rate included, stops the send. Any other required field stops it too instead of being guessed.
export function planForm(form, proposal, { taxInvoice = null, acknowledgements = [] } = {}) {
  const problems = [];
  const fills = [];
  const text = (form.dialogs ?? []).join('\n');
  const texts = form.fields.filter((f) => f.tag === 'TEXTAREA' || f.type === 'textarea' || f.tag === 'DIV');
  const main = texts.find((f) => f.name === 'content') ?? [...texts].sort((a, b) => (b.maxLength ?? 1e9) - (a.maxLength ?? 1e9))[0];
  if (!main) problems.push('no free-text field for the proposal');
  else {
    const limit = main.maxLength ?? counterLimit(form.counters);
    if (limit && [...proposal.text].length > limit) problems.push('the proposal has ' + [...proposal.text].length + ' characters and the field takes ' + limit);
    fills.push({ ref: main.ref, value: proposal.text, as: 'text' });
  }
  const amount = form.fields.find((f) => f.name === 'amount') ?? form.fields.find((f) => f.tag === 'INPUT' && ['text', 'number', 'tel'].includes(f.type) && AMOUNT_LABEL.test(f.label + ' ' + (f.placeholder ?? '')));
  if (amount) {
    const unit = /예산\s*\n?\s*만원/.test(text) ? 10_000 : 1;
    const minimum = toInt(text.match(/최소\s*([\d,]+)\s*만원/)?.[1]);
    if (proposal.totalKRW % unit) problems.push('the total ' + proposal.totalKRW + ' KRW is not a whole number of ' + unit + ' KRW');
    else if (minimum !== null && proposal.totalKRW < minimum * 10_000) problems.push('the total ' + proposal.totalKRW + ' KRW is under the form floor of ' + minimum + '만원');
    else fills.push({ ref: amount.ref, value: String(proposal.totalKRW / unit), as: 'amount' });
  }
  const daysField = form.fields.find((f) => f.name === 'days');
  if (daysField) {
    const days = proposalDays(proposal.phases);
    if (!days || days < 1) problems.push('the plan has no dates to give the form a length in days');
    else fills.push({ ref: daysField.ref, value: String(days), as: 'days' });
  }
  if ((form.buttons ?? []).some((b) => b.text === TAX_CHOICES.true) && (form.buttons ?? []).some((b) => b.text === TAX_CHOICES.false)) {
    if (typeof taxInvoice !== 'boolean') problems.push('the form asks whether a tax invoice can be issued and business.taxInvoice does not say');
    else fills.push({ choice: TAX_CHOICES[taxInvoice], other: TAX_CHOICES[!taxInvoice], as: 'choice' });
  }
  for (const f of form.fields.filter((x) => x.type === 'checkbox' && /^\[필수\]/.test(x.label ?? ''))) {
    if (acknowledgements.some((a) => (f.label ?? '').includes(a))) fills.push({ ref: f.ref, as: 'check' });
    else problems.push('unknown required acknowledgement: ' + f.label);
  }
  for (const f of form.fields) {
    if (fills.some((x) => x.ref === f.ref)) continue;
    if (f.type === 'file' && f.required) problems.push('required attachment ' + (f.label || f.ref) + ' (' + (f.accept || 'any') + ')');
    else if (f.required && f.type !== 'file' && f.type !== 'checkbox') problems.push('required field ' + (f.label || f.placeholder || f.ref) + ' has no mapping');
  }
  return { fills, problems };
}

export function readbackProblems(form, fills) {
  const out = [];
  for (const fill of fills) {
    if (fill.as === 'choice') {
      const [chosen, other] = [fill.choice, fill.other].map((t) => (form.buttons ?? []).find((b) => b.text === t));
      // The pair marks its choice with aria-pressed (seen 2026-10-25); without it, only a difference in
      // class between the two buttons can show which one is on.
      const shown = chosen && other && (chosen.pressed !== null || other.pressed !== null ? String(chosen.pressed) === 'true' && String(other.pressed) !== 'true' : chosen.className !== other.className);
      if (!chosen || !other) out.push('choice ' + fill.choice + ' disappeared');
      else if (!shown) out.push('choice ' + fill.choice + ' does not show as selected');
      continue;
    }
    const f = form.fields.find((x) => x.ref === fill.ref);
    if (!f) out.push(fill.as + ' field disappeared');
    else if (fill.as === 'check') {
      if (f.checked !== true) out.push('acknowledgement ' + (f.label ?? f.ref) + ' is not ticked');
    } else if (fill.as === 'amount' || fill.as === 'days' ? String(toInt(f.value)) !== fill.value : squash(f.value) !== squash(fill.value)) out.push(fill.as + ' field holds something else than what was written');
  }
  return out;
}

// The last check before anything is typed into the form, dry runs included: the caller's gate must have
// passed, and the text is scanned again for contact and payment details, which no proposal may carry.
export function assertSendable(proposal, gate) {
  if (gate?.ok !== true) throw new AdapterRefusal('FSW_GATE_BLOCKED', 'a proposal reaches the form only after the gate passed');
  if (typeof proposal?.text !== 'string' || !proposal.text.trim()) throw new AdapterRefusal('FSW_PROPOSAL_EMPTY', 'the proposal has no text');
  if (!Number.isInteger(proposal.totalKRW) || proposal.totalKRW <= 0) throw new AdapterRefusal('FSW_PROPOSAL_AMOUNT', 'the proposal has no total');
  const again = gateOutbound({ platform: 'kmong', kind: 'proposal', text: proposal.text }, { descriptor: loadDescriptor('kmong') });
  const leaks = again.violations.filter((v) => v.rule.startsWith('contact.') || v.rule.startsWith('payment.'));
  if (leaks.length) throw new AdapterRefusal('FSW_PROPOSAL_CONTACT', 'the proposal carries ' + leaks.map((v) => v.rule).join(', '));
}

// ---- readers ----

// Public list and detail reads in an owned headless browser. listProjects pages through the list API
// the page itself calls, from the page's own origin.
export async function openProjectReader({ renderer } = {}) {
  const own = !renderer;
  const r = renderer ?? (await openRenderer());
  const page = await r.page();
  let onList = false;
  return {
    async listProjects({ category = 'all', sort = 'latest', pages = 1, perPage = 10, now = new Date() } = {}) {
      if (!onList) {
        await page.navigate(listUrl({ category, sort }), { settle: 2500 });
        onList = true;
      }
      const out = [];
      let lastPage = null;
      for (let p = 1; p <= pages; p++) {
        const res = await page.evaluate(pageFetchList, listQuery({ category, sort, page: p, perPage }));
        if (!res.ok) throw Object.assign(new Error('kmong project list answered ' + res.status + ' on page ' + p), { code: 'FSW_KMONG_PROJECTS_LIST' });
        lastPage = res.data.last_page ?? null;
        out.push(...(res.data.requests ?? []).map((row) => parseProjectRow(row, { now })));
        if (lastPage !== null && p >= lastPage) break;
        await wait(1500);
      }
      return { projects: out, lastPage };
    },
    async readProject(id, { now = new Date() } = {}) {
      onList = false;
      await page.navigate(detailUrl(id), { settle: 3000 });
      const res = await page.evaluate(pageDetail, id);
      if (!res.ok || !res.data) throw Object.assign(new Error('kmong project ' + id + ' detail did not carry its data (' + (res.title ?? res.url) + ')'), { code: 'FSW_KMONG_PROJECT_DETAIL' });
      return parseProjectDetail(res.data, { now });
    },
    async close() {
      await page.close().catch(() => {});
      if (own) await r.close();
    },
  };
}

// Session reads and the proposal write on the operator's signed-in Chrome.
export async function openProjectSeller({ session } = {}) {
  const s = session ?? (await openSession('kmong-projects', { platform: 'kmong', pacing: loadDescriptor('kmong').pacing }));
  const proposalsPage = async () => {
    await s.navigate(BASE + '/seller/proposals?filter=ALL&meetingStatus=ALL', { settle: 6000 });
    return s.evaluate(() => document.body.innerText);
  };
  const seller = {
    session: s,
    async quota() {
      const quota = parseQuota(await proposalsPage());
      if (quota === null) throw Object.assign(new Error('the daily proposal quota is not on /seller/proposals'), { code: 'FSW_KMONG_QUOTA' });
      return quota;
    },
    async proposals(titles = []) {
      return parseProposals(await proposalsPage(), titles);
    },
    // Opens the form, fills it, reads every field back and submits only when gate.ok and not dryRun;
    // then the proposal must show on /seller/proposals. A dry run verifies the submit control and leaves.
    // taxInvoice answers the form's 세금계산서 발행 여부 (business.taxInvoice).
    async propose(project, proposal, { gate, dryRun = false, taxInvoice = null } = {}) {
      const steps = [];
      const fail = (reason, extra = {}) => ({ observed: false, submitted: false, reason, steps, ...extra });
      assertSendable(proposal, gate);
      const quotaBefore = dryRun ? null : parseQuota(await proposalsPage());
      if (quotaBefore === 0) return fail('no proposals left today on /seller/proposals', { code: 'FSW_KMONG_QUOTA_SPENT' });
      await s.navigate(detailUrl(project.id), { settle: 7000 });
      const button = await s.evaluate(pageProposeButton);
      steps.push({ step: 'button', ...button });
      if (!button.found || button.disabled) return fail('no enabled 제안하기 button on project ' + project.id);
      if (button.text !== '제안하기') return fail('the page is signed out (' + button.text + ')', { code: 'FSW_KMONG_SIGNED_OUT' });
      await s.click('[data-fsw=propose]');
      await wait(5000);
      let form = await s.evaluate(pageProposalForm);
      steps.push({ step: 'form', url: form.url, dialogs: form.dialogs, fields: form.fields.map(({ value, ...f }) => f), buttons: form.buttons, counters: form.counters });
      if (form.registrationNeeded) return fail('the enterprise profile is not registered; 제안하기 opens the registration dialog', { code: 'FSW_KMONG_ENTERPRISE_PROFILE', form });
      const plan = planForm(form, proposal, { taxInvoice, acknowledgements: loadDescriptor('kmong').enterprise?.proposalAcknowledgements ?? [] });
      steps.push({ step: 'plan', fills: plan.fills.map((f) => ({ ref: f.ref, as: f.as })), problems: plan.problems });
      if (plan.problems.length) return fail('form: ' + plan.problems.join('; '), { code: 'FSW_KMONG_FORM_UNMAPPED', form });
      for (const fill of plan.fills) {
        const r = fill.as === 'check' ? await s.evaluate(pageCheck, fill.ref) : fill.as === 'choice' ? await s.evaluate(pageChoose, fill.choice) : await s.evaluate(pageSetField, { ref: fill.ref, value: fill.value }, { timeoutMs: 60_000 });
        if (!r.ok) return fail(r.reason, { form });
        await wait(300);
      }
      await wait(1000);
      form = await s.evaluate(pageProposalForm);
      const readback = readbackProblems(form, plan.fills);
      steps.push({ step: 'readback', problems: readback, counters: form.counters });
      if (readback.length) return fail('read back: ' + readback.join('; '), { form });
      const submit = await s.evaluate(pageMarkSubmit, SUBMIT_LABELS);
      steps.push({ step: 'submit-control', ...submit });
      if (!submit.found || submit.disabled) return fail('no enabled submit control in the form', { form });
      if (dryRun) {
        await s.navigate(BASE + '/seller/proposals?filter=ALL&meetingStatus=ALL', { settle: 3000 });
        return { observed: true, submitted: false, dryRun: true, steps, form };
      }
      await s.click('[data-fsw=submit]');
      await wait(5000);
      for (let i = 0; i < 2; i++) {
        const confirm = await s.evaluate(pageConfirm, CONFIRM_LABELS);
        if (!confirm.pressed) break;
        steps.push({ step: 'confirm', ...confirm });
        await wait(4000);
      }
      const after = await s.evaluate(pageAfterSubmit);
      steps.push({ step: 'submitted', ...after });
      if (after.errors.length) return fail('the form refused the submit: ' + after.errors.join('; '), { form });
      const list = parseProposals(await proposalsPage(), [project.title]);
      const shown = list.found[0] ?? null;
      const spent = quotaBefore !== null && list.quota === quotaBefore - 1;
      steps.push({ step: 'proposals', quotaBefore, quota: list.quota, shown });
      if (!shown && !spent) return fail('the proposal does not show on /seller/proposals and the quota did not move', { submitted: true, quota: list.quota });
      return { observed: true, submitted: true, status: shown?.status ?? 'unknown', label: shown?.label ?? null, quota: list.quota, steps };
    },
    stop: () => s.stop(),
  };
  return seller;
}

