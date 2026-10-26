# full-self-working

An autonomous freelance-outsourcing agent that runs on one local machine around the clock. It answers inquiries, sends quotes and proposals, keeps a price table current from live market samples, delivers the work, and moves its effort toward the service and platform pairs with the best hourly yield.

This tree is v0, rebuilt from the 2c77326 tree on the orphan branch `v0`. Until the takeover replaces `main`, the running agent is the old `main`; a fix the live service needs lands there and is mirrored here in the same session.

- Branch policy after takeover: each unit commits and pushes on `v0`, and `main` fast-forwards to `v0` once per phase at D after C passes, so the live supervisor hands over once per phase.

## Privacy boundary

The repository is generic and publishable. Everything about one operator lives in `instance.local/` (profile, background, business registration, payout account, ledger, job workspaces, lessons, logs, surface recordings) and is ignored by `*.local*`. Code reads the instance through `src/core/instance.mjs`; examples with placeholders live in `examples/instance/`. A personal value never appears in tracked files, tests, fixtures or commit messages. `npm run check:privacy` fails on any tracked file that matches a value from the instance, and skips when there is no instance, so in a worktree without one it runs with `FSW_INSTANCE` pointing at the operator's instance.

## Layout

docs/DESIGN.md holds the module map and the contracts between modules.

- `src/core` holds the instance loader, the SQLite ledger (`node:sqlite`, migrations by user_version, v4 adds the outbox), the one-time approval import, log, notify and Seoul clock helpers.
- `src/platforms` holds one descriptor per marketplace (fees, payment model, contact and payment policy, pacing), validated on load, plus the shared kit.
- `src/surface` is the one interface over the platforms (`openSurface`): it maps the page-level code in `src/platforms/<id>` (extractors, parsers, the kmong conversation and listing halves) to Inbound, Thread and Receipt, refuses a write without the authorize verdict send, and records or replays every driver call; `src/browser/driver.mjs` drives the operator's signed-in Chrome.
- `src/policy` is the deterministic outbound gate and slop lint; every message, quote, proposal and listing passes it before it leaves the machine.
- `src/economics` holds the service catalog, fees, exchange rates, market summaries, sampling, pricing and the price table file.
- `docs/NEGATIVE-CORPUS.md` lists what the 2c77326 tree learned, each lesson tied to the gate, test or note that holds it.

## Rules

- Platform rules are data in each descriptor and are enforced by `src/policy/gate.mjs`; a rule a script can decide is a gate, never prose in a prompt.
- Every operator choice is a setting: a mode, cap, answered service, budget, market engine or cadence, or a figure a listing prints is a key in the instance's `config.json` or `profile.json` with its default in `examples/instance`, never a constant one operator picked; `npm run check` (`scripts/check-example.mjs`) fails a key the code reads that the example lacks, and a figure a profile can answer, such as a career length, is derived from its dated roles.
- A blocked mechanism gets another mechanism before anyone proposes dropping what it served: a platform read that meets a bot wall moves to another engine, cadence or page in its descriptor and settings, and an operator-mandated source leaves only on the operator's word.
- Money moves only through the channel the platform allows. Contact details and payout accounts are released only where the descriptor permits.
- A channel that brings no leads is first checked at the platform's own matching settings, since an unset one reads as missing demand.
- A platform timestamp without a zone is read in the zone the page's own relative time confirms, checked live before its parser ships; soomgo request times are Seoul time although nothing in them says so.
- A portfolio item is public only after its payment is recorded and the client allowed portfolio use.
- Customer-facing copy passes the slop gate: no em dashes, no middle-dot enumerations, no invented metrics, no claims the instance profile cannot back.
- Module boundaries live in `scripts/check-imports.mjs`, part of `npm run check`: it fails a forbidden import between modules, a module with no row and a file-level import cycle, and a change that adds a module adds its row there and in docs/DESIGN.md.
- A lesson from a platform page, the market or a failure lands in `docs/NEGATIVE-CORPUS.md` with its holder; `scripts/check-negative-corpus.mjs` keeps every held row tied to a file that contains its anchor.
- A live page is read from this tree only through `scripts/probe.mjs`, whose window keeps it off the live supervisor's polls; recordings with customer text stay under `instance.local/qa/surfaces`, and fixtures under `test/fixtures/surfaces` are synthetic.
- Schedules start on round Seoul marks; each cron carries its Seoul time and reason.
- Commands: `npm test`, `npm run check` (tests, privacy scan, slop lint on examples, descriptor validation, example keys, module boundaries, negative corpus).
- Commits are English: `type(scope): problem` in at most 72 characters and a body of single-line `-` bullets. `hooks/commit-msg` checks every commit and `.github/workflows/commits.yml` every push, both copies of the vibeghost floor.
