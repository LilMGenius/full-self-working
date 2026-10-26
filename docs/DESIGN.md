# Design

full-self-working (fsw) is one local process that sells, quotes, delivers and learns on freelance marketplaces for one operator. This file is the contract between modules; AGENTS.md holds the rules every change keeps. A module marked with a later phase does not exist yet; the phase that builds it adds its section here.

## The loop

Per enabled platform, one surface session per tick: confirm the login (a surface with `publicSense` keeps sensing when the login fails), sense the list rows (money fields go to the deal state machine), triage each row, read and decide and authorize and plan at most MAX_THREADS_PER_PLATFORM opened threads, apply the deal effects, then drain the outbox inside the outbound hours with read-back, so a deposit request from a hire seen in this tick is drained in the same tick; six failed polls in a row notify once. An item parked from its list row (closed, past the reply window, or labelled with a service the catalog does not hold or the instance does not answer there) waits until a newer message arrives or the settings it was parked under change (the services the instance answers, the reply windows, or how the platform's labels map onto the catalog), which checks it again from its list row. An item a pass already read (observed at night, or decided with nothing to send) keeps the list time it covered the same way, so a platform notice that moves the list time past the newest stored message does not send it through the model on every tick; a night read holds only for night ticks, so the first tick inside the outbound hours still decides. Daily and hourly jobs keep their ids in `run/state.json` lastRuns.

## Modules

Arrows point from importer to imported and name the main edges: supervisor to loop, economics, listings, projects, portfolio, learning and surface (supply); loop to surface, triage, brain, policy, outbox, deal and work; outbox to policy and core; brain to policy and economics; triage and policy to economics (the catalog); deal to economics and core; work to render; site to portfolio; cli to supervisor, outbox, deal and economics; every module to core. The Never imports column is the rule `scripts/check-imports.mjs` enforces, which also fails a file-level import cycle; a module with no rule there has an empty cell.

| Module | Files | Owns | Public interface | Never imports | Phase |
|---|---|---|---|---|---|
| core | `src/core` | instance, clock, ledger and migrations, approval import, log, notify; settings, transactions and notices in wp3, the BrowserSkill client in wp4, the authorization token in wp9 | `loadInstance`, `openLedger`, `outboxKey`, the outbox helpers, `importApprovals`, clock helpers, `logEvent`, `notifyOperator` | any other module | wp1 |
| platforms | `src/platforms`, `src/browser` | descriptors, registry, kit; the driver and each platform's page code in wp2 | `loadDescriptor`, `listDescriptors`, `validateDescriptor` | surface, triage, brain, outbox, deal, work, loop, supervisor | wp1, wp2 |
| surface | `src/surface` | one wrapper per platform over its page code, recorder and replay, shape drift | `openSurface`, `openListingSurface`, `hasSurface`, `SAMPLERS`, `recordSession`, `replaySession`, `driftReport` | policy, brain, deal, outbox, `src/core/ledger.mjs` | wp2 |
| economics | `src/economics` | catalog with the answered list and delivery modes, fees, fx, market summaries, sampling with its engines and cadence, pricing, price table; quote and priority in wp3; yield and allocation in wp4 | `catalogServicesFor`, `targetsFor`, `answeredServices`, `answeredCatalog`, `deliveryOf`, `operatorDelivered`, `marketEngine`, `categoriesPerRun`, `marketCadence`, `marketPlatforms`, `sellerNet`, `loadFx`, `summarizeDay`, `latestSummary`, `sampleMarket`, `buildPriceTable`, `quoteForRequest`, `splitPayment`, `latestTable`, `refreshPriceTable` | | wp1 |
| policy | `src/policy` | gate, slop; authorize in wp3 | `gateOutbound`, `lintText`, `authorize` (wp3) | surface, brain, deal | wp1, wp3 |
| triage | `src/triage` | park, open and awaiting-reply rules | `triage` | surface, brain | wp3 |
| brain | `src/brain` | decide, prompts, codex and jwc runners | `decide`, `runCodex`, `runJwc` | surface, deal, outbox | wp3 |
| outbox | `src/outbox` | plan, usage, drain, resolve | `plan`, `setStatus`, `drain`, `resolve`, `itemOf`, `newApprovalId` | brain, deal | wp3 |
| deal | `src/deal` | the state machine, money signals and keys, delivery text, readiness, sweep | `advance` | surface, brain, outbox, work | wp3 |
| work | `src/work` | recipes, job runner, acceptance | `runJob` | surface, deal, outbox | wp3 |
| render | `src/render` | HTML to PNG and PDF, font checks | `openRenderer`, `renderHtml`, font checks | | wp3 |
| portfolio | `src/portfolio` | the one ordering of portfolio items and their store | `rankPortfolio`, `syncPortfolio` | | wp3 |
| learning | `src/learning` | outcomes in wp3; lessons, playbook and `playbooks/` in wp4 | `recordOutcome`, `writeLessons`, `refreshPlaybook` | | wp3, wp4 |
| listings | `src/listings` | gig images, the kmong gig builder, proofs, review, the listings jobs | `listingsWatch`, `listingsRefresh` | | wp4 |
| projects | `src/projects` | enterprise project drafts, scores and the projects job, which plans `proposal` rows | `projectsJob`, `planProposal` | | wp4 |
| loop | `src/loop` | one tick step per platform, deal effects, order counters, job starts | `step`, `applyEffects` | | wp3 |
| supervisor | `src/supervisor` | daemon, lock, handover, schedule, keepalive, supply report, digest | `runSupervisor`, `runTick`, `writeSupply` | | wp4 |
| cli | `bin/fsw.mjs`, `src/cli` | the operator verbs | `fsw run`, `fsw tick`, `fsw approve`, `fsw job` (wp3), `fsw deal`, `fsw status` and the carried verbs (wp4) | | wp3, wp4 |
| site | `site/`, `scripts/publish.mjs` | the public portfolio gallery and its deploy | `site/build.mjs`, `scripts/publish.mjs` | | wp4, rebuilt in wp7 |

## Instance

`FSW_INSTANCE` (default `./instance.local`) is the operator's directory and the only place personal data lives. `examples/instance/` holds the same shapes with placeholder values. `src/core/instance.mjs` loads the instance and throws `FSW_INSTANCE_MISSING` for a missing required file.

| Path | Kind | Content |
|---|---|---|
| `profile.json` | required | person, headline_ko/en, summary_ko/en, roles, education, awards, projects, skills, serviceFit, claimsNotToMake, approvedClaims |
| `business.json` | required | company, bizRegNo, email, taxInvoice, payout {bank, account, holder} |
| `config.json` | required | timezone, activeHours, pipeline, platforms (each with `services`), payment, market (`engines`, `categoriesPerRun`, `cadence` per platform), yield, notify, brain, jobs, orders, listings, site |
| `background.md` | optional | long bios that listing generators adapt |
| `ledger.sqlite` | created | see Ledger |
| `market/` | created | samples-YYYYMMDD.jsonl, summary-YYYYMMDD.json, fx-YYYYMMDD.json |
| `pricing/` | created | price-table-YYYYMMDD.json |
| `platforms/` | created | per-platform state snapshots (<id>-state.json) |
| `operator/` | created | requests.md; approvals/<id>.json from the 2c77326 tree, imported into the outbox once and left in place |
| `logs/` | created | events-YYYYMMDD.jsonl |

## Ledger

`openLedger(path)` runs the migrations from `PRAGMA user_version` up, one transaction each; a migration that rebuilds a referenced table turns foreign keys off around its transaction and checks them before the commit. Version 4 adds the outbox and changes no older table, so the 2c77326 code opens a version 4 file.

| Table | Columns |
|---|---|
| `threads` | id, platform, external_id, kind (message, request, order, project), customer, service, status, language, last_inbound_at, last_outbound_at, created_at, meta json; unique (platform, external_id) |
| `messages` | id, thread_id, direction (in, out), body, attachments json, external_id, at, gate json; unique (thread_id, direction, external_id) |
| `quotes` | id, thread_id, platform, service, amount_krw, deposit_krw, balance_krw, scope json, delivery_days, cost_krw, status (sent, accepted, declined, expired), at |
| `jobs` | the deal row from the first observed quote: id, thread_id, platform, service, title, price_krw, status (lead, quoted, ordered, in_progress, delivered, revision, closed, lost), agent_minutes, human_minutes, cost_krw, started_at, delivered_at, closed_at, meta json |
| `payments` | id, job_id, kind (deposit, balance, full, milestone), amount_krw, channel, received_at, evidence |
| `reviews` | id, job_id, platform, rating, text, liked, at |
| `events` | id, at, kind, platform, ref, payload json |
| `money_events` | id, key unique, platform, thread_id, job_id, event, amount_krw, at, applied, note, payment_id, evidence, recorded_at |
| `outbox` | id, key unique, platform, thread_id, job_id, kind (message, quote, pay_request, delivery, proposal), payload json {text, amountKRW, split, scope, deliveryDays, files, costKRW, threadRef, serviceLabel, thread, decision, priceRow; importedFrom on imported rows; the proposal, currency and review keys of later phases}, verdict json, status (planned, awaiting_operator, approved, sending, observed, unobserved, blocked, rejected, stale), reason, approval_id unique, operator json {resolvedAt, finalText, edited, resolutionReason}, receipt json, created_at, updated_at |

Every SQL statement on the outbox lives in `src/core/ledger.mjs`: `addOutbox`, `updateOutbox(id, patch, {from})` (with `from`, a compare-and-set on status that returns null when the row has moved), `getOutbox`, `outboxByKey`, `outboxByApproval` and `listOutbox({platform, statuses, kinds, threadId, jobId})`; only `src/outbox` and `importApprovals` call the two writers. The outbox key is `platform:threadRef:kind:sha1(text|amount|files)` of the planned item (`outboxKey`), so an item planned twice is one row. An operator edit stays on its row as `operator.finalText` with `operator.edited: true`, and the drain sends and reads back `operator.finalText ?? payload.text`; the key keeps hashing the planned text, so the brain planning the same draft again lands on the same row, and a revised draft is a new row. A payment row is written only from evidence. `importApprovals(ledger, dir)` turns each 2c77326 approval file into an outbox row keyed by approval_id (open to awaiting_operator, approved, rejected and dropped to rejected, sent to observed, expired to stale, blocked, unobserved; project_proposal to proposal) and reports a file it cannot map by name; a row still planned, awaiting_operator or approved whose file holds a final status follows the file with a compare-and-set and an `outbox.status` event (`reconciled`); a second run imports and reconciles nothing.

## Surface

`openSurface(platform, {session, record, replay})` returns, per platform this build can work (`hasSurface`: kmong, soomgo), `login`, `sense` (list rows as Inbound, nothing opened), `read(ref, {willReply, kind})` (a Thread; `kind` is 'message' or 'request', a soomgo request is one inbound message built from its answers, and a kind the platform lacks is refused before any page loads), `send` and `quote` (a Receipt, refused without `authorized.verdict === 'send'`; the token is not yet bound to its outbox row, a gap wp9 closes with `src/core/authz.mjs`), `payRequest` (soomgo, needs `approved`), `orders` (`{counts, total, gap, orders}`), `supply` (a `Supply`) and `stop`; kmong gains `propose` in wp4. Page knowledge stays in `src/platforms/<id>`; the surface maps shapes. `openListingSurface('kmong')` serves the gig writer. A session may be the signed-in Chrome, a recording (`record`: one JSON line per call, `{seq, op, name, arg, answer | error, at}`, under `<instance>/qa/surfaces/<platform>/<day>/`) or a replay of one, which fails with `FSW_REPLAY_DIVERGED` on the first call that differs. `scripts/surface-drift.mjs` compares a recording's answer shapes with `test/fixtures/surfaces/<platform>/shapes.json`; `scripts/probe.mjs` runs one read operation inside the window after the live tick of a 5-minute mark. `SAMPLERS` (kmong, soomgo, freelancer, wishket, fiverr) is the sampler map `sampleMarket` is handed.

## Policy gate

`gateOutbound({platform, kind, text, attachments, amountKRW, thread}, {descriptor, instance, priceRow, lessonsRules})` returns every violation with its rule id: contact (phone, e-mail, URL, messenger ID and payout account unless the descriptor allows that class at the thread's stage), identity (where `contactPolicy.identity` is forbidden), payment (off-platform wording and the payout account), price (outside the row's floor and ceiling), claims (an experience number not in `profile.approvedClaims`, anything in `claimsNotToMake`), slop (floor findings of `lintText` block, reflex findings warn), shape (length within `descriptor.limits`, the customer's language, no empty or duplicate message) and learned rules from `lessons/gate-rules.json`. `authorize` (wp3) composes it with mode, hours, confidence, label, stage, budget and pacing.

## Economics

Prices are market based. A (platform, service) row's market base comes from the newest summary: under 5 reviews p25 + 0.35 (median - p25), 5 to 29 the median, 30 or more halfway to p75; serviceFit multiplies it (strong 1.15, some 1.0, none 0.9). The cost floor is the smallest gross whose net after fees covers the standard package's agent hours at `yield.agentHourCostKRW` plus its operator minutes at `yield.humanHourValueKRW`; the base is the higher of the two, and a row is viable while its cost floor stays at or under the market ceiling. Packages are base, base x 2.2 and base x 4, rounded to 1,000 KRW. A request quote is the guide average times a complexity factor (0.6 to 1.6), clamped to the guide, moved toward the buyer's stated budget and never below the cost floor plus the quote cost. `splitPayment` gives deposit and balance below `payment.milestoneThresholdKRW` and milestones above it, through the mechanism the descriptor names.

`sampleMarket(instance, {platforms, samplers, withPage, loadFx, now, day, log})` samples every platform the config lists with the samplers and page opener it is given, retries a failed category once, stops a platform at its first bot challenge, converts foreign prices at the day's ECB rates or fails that platform by name, replaces only the pairs it read, carries pairs it could not read for up to `CARRY_DAYS` (7), and writes the day's files only when the summary changed. Each platform is read through its market engine (`config.market.engines.<platform>`, else the descriptor's `market.engine`, else `owned`; `attached` is the operator's Chrome for public pages, `archive` the newest Wayback capture dated by its capture time), at most `config.market.categoriesPerRun.<platform>` categories a run, stalest first, and an error marked final is not retried; `config.market.cadence.<platform>` puts a platform in the daily market job or the hourly slice. `answeredServices(config, platform)` is the list of catalog services an instance answers on a platform (`platforms.<id>.services`, null for every agent-delivered one), and `operatorDelivered(service)` marks a service the operator delivers, such as `lesson_tutoring`. A price guide that prints only its average prices at that average. `refreshPriceTable(instance, {adapterFor, day, log})` prices every platform with summary entries and writes a new table only when a row changed; `latestTable(dir)` reads the newest. `catalogServicesFor(descriptor, label)` is the one mapping from a platform's label to catalog services.

## Checks

`npm test` runs node:test over `test/`. `npm run check` adds the privacy scan (no tracked file holds a value from the instance; skipped without one), the slop lint over examples, playbooks, recipes and site, descriptor validation, the example-keys check (every config, profile and business key the code reads is in `examples/instance`), `scripts/check-imports.mjs` (every import against the Never imports column of Modules, a module without a row, and file-level import cycles, printed as file:line and the edge) and the negative corpus check. `scripts/rehearse-migration.mjs` proves the v4 migration on a copy of a live ledger.
