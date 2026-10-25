# full-self-working

An autonomous freelance-outsourcing agent that runs on one local machine around the clock. It answers inquiries, sends quotes and proposals, keeps a price table current from live market samples, delivers the work, and moves its effort toward the service and platform pairs with the best hourly yield.

## Privacy boundary

The repository is generic and publishable. Everything about one operator lives in `instance.local/` (profile, background, business registration, payout account, ledger, job workspaces, lessons, logs) and is ignored by `*.local*`. Code reads the instance through `src/core/instance.mjs`; examples with placeholders live in `examples/instance/`. A personal value never appears in tracked files, tests, fixtures or commit messages. The public site is built locally from the instance into the ignored `site/dist/` and deployed as prebuilt output, and it never carries the payout account. `npm run check:privacy` fails on any tracked file that matches a value from `instance.local/`.

## Layout

- `bin/fsw.mjs` is the CLI (`fsw tick`, `fsw status`, `fsw probe <platform>`, `fsw market`, `fsw price`, `fsw publish`, `fsw schedule`).
- `src/core` holds the instance loader, the SQLite ledger (`node:sqlite`) and Seoul clock helpers.
- `src/platforms/<id>` holds one descriptor (fees, payment model, contact and payment policy, pacing) and one browser adapter per marketplace.
- `src/policy` is the deterministic outbound gate: every message, quote and listing passes it before it leaves the machine.
- `src/economics` turns market samples into a price table and job outcomes into hourly yield and a Thompson-sampling allocation.
- `src/brain` drafts replies and quotes through `codex exec` with a JSON output schema; `src/jobs` runs deliverable work from recipe graphs.
- `src/portfolio/rank.mjs` is the only ordering of portfolio items; the site and every listing generator import it.
- `src/learning` records outcomes and writes lessons; `playbooks/` holds the generic defaults the lessons refine.
- `site/` is the public portfolio gallery.

## Rules

- Platform rules are data in each descriptor and are enforced by `src/policy/gate.mjs`; a rule a script can decide is a gate, never prose in a prompt.
- Money moves only through the channel the platform allows. Contact details and payout accounts are released only where the descriptor permits.
- A channel that brings no leads is first checked at the platform's own matching settings, since an unset one reads as missing demand; `fsw doctor` warns for each offered soomgo catalog service without request items.
- A portfolio item is public only after its payment is recorded and the client allowed portfolio use.
- Customer-facing copy passes the slop gate: no em dashes, no middle-dot enumerations, no invented metrics, no claims the instance profile cannot back.
- Schedules start on round Seoul marks; each cron carries its Seoul time and reason.
- Commands: `npm test`, `npm run check` (tests, privacy scan, slop lint on templates).
- Commits are English: `type(scope): problem` in at most 72 characters and a body of single-line `-` bullets. `hooks/commit-msg` checks every commit and `.github/workflows/commits.yml` every push, both copies of the vibeghost floor.

