// What stands between the operator's freelancer account and a bid, read in his signed-in session before
// anything is typed. Mapped on 2026-10-27 from the details page of open fixed-price projects and the self
// API: the self API's account_balances.bids_remaining counts the free bids left (6 of 6 on the free plan),
// and while the account balance is under the minimum the page shows a banner "To unlock bidding, maintain a
// minimum balance of $20 USD or equivalent" with Add Funds, and a progress list "Please complete these 3
// steps before bidding on the project" (Update your skills, Verify your email, Update your profile). No bid
// form rendered on any page read, so its fields and text limit are unknown and nothing here types into it.
import { pageBody } from './market.mjs';
import { SELF_URL, apiResultOf } from './projects.mjs';

export const BALANCE = 'FSW_FREELANCER_BALANCE';
export const STEPS = 'FSW_FREELANCER_STEPS';
export const NO_BIDS = 'FSW_FREELANCER_NO_BIDS';
export const FORM_UNMAPPED = 'FSW_FREELANCER_FORM_UNMAPPED';

export const SELF_BIDS_URL = SELF_URL + '?balance_details=true&membership_details=true';

// Runs in the page: the unlock banner, the prerequisite steps (each fl-progress-step-item once by name, done
// when an element inside carries a class naming Done), and whether a bid form shows (a textarea outside the
// banner's profile form, whose summary field is #summary).
export function pageBidGate() {
  const root = document.querySelector('app-project-details-freelancer') ?? document.body;
  const unlock = [...root.querySelectorAll('*')].find((e) => e.childElementCount === 0 && /To unlock bidding/i.test(e.textContent ?? ''));
  const steps = new Map();
  for (const item of root.querySelectorAll('fl-progress-step-item')) {
    const name = (item.querySelector('.ProgressStepTitle')?.textContent ?? '').trim();
    if (!name || steps.has(name)) continue;
    steps.set(name, [...item.querySelectorAll('[class]')].some((e) => /\bDone\b|Done$|-done\b/.test(e.getAttribute('class'))));
  }
  const form = [...root.querySelectorAll('textarea')].some((t) => t.id !== 'summary' && (t.offsetParent || t.getClientRects().length));
  return { unlock: unlock ? unlock.textContent.trim().slice(0, 200) : null, steps: [...steps].map(([name, done]) => ({ name, done })), form };
}

export async function readBidState(session, project) {
  await session.navigate(SELF_BIDS_URL, { settle: 500 });
  const self = apiResultOf(await session.evaluate(pageBody), SELF_BIDS_URL);
  const left = self?.account_balances?.bids_remaining;
  await session.navigate(project.url + '/details', { settle: 6000 });
  const gate = await session.evaluate(pageBidGate);
  return {
    bidsLeft: Number.isInteger(left) ? left : null,
    bidLimit: Number.isInteger(self?.membership_package?.bid_limit) ? self.membership_package.bid_limit : null,
    unlock: gate?.unlock ?? null,
    steps: gate?.steps ?? [],
    form: gate?.form === true,
  };
}

// The first thing that keeps a bid from going out, in the order the operator settles them: the balance the
// banner asks for, the profile steps it lists, the free bids, then the form no recording has mapped.
export function bidRefusal(state) {
  if (state.unlock) return { code: BALANCE, reason: 'freelancer shows: ' + state.unlock + '; nothing was typed' };
  const open = state.steps.filter((s) => !s.done).map((s) => s.name);
  if (open.length) return { code: STEPS, reason: 'freelancer asks to finish before bidding: ' + open.join(', ') + '; nothing was typed' };
  if (state.bidsLeft !== null && state.bidsLeft <= 0) return { code: NO_BIDS, reason: 'no free bids are left this month' + (state.bidLimit ? ' (' + state.bidLimit + ' a month)' : '') + '; nothing was typed' };
  return { code: FORM_UNMAPPED, reason: 'the freelancer bid form is not mapped from a signed-in recording; nothing was typed' };
}

// A bid inside the month's free bids costs 0 KRW; past them, or when the count was not read, the cost is
// unknown (null), which the bid budget refuses. No priced bid has been seen on the free plan.
export const bidCostKRW = (state) => (Number.isInteger(state?.bidsLeft) && state.bidsLeft > 0 ? 0 : null);
