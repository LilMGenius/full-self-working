# Design

full-self-working (fsw) is one local process that sells, quotes, delivers and learns on freelance marketplaces for one operator. This file is the contract between modules; AGENTS.md holds the rules every change keeps.

## The loop

Every tick the supervisor runs one pipeline per enabled platform: confirm the login, read new inbound items (messages, buyer requests, orders), decide with the brain, pass every outbound item through the policy gate, act through the platform adapter, read the result back from the page, and write each step to the ledger. Once a day it refreshes market samples, recomputes the price table and the allocation, re-ranks the portfolio, redeploys the site when the ranked data changed, and turns finished outcomes into lessons that the next decisions read.

## Instance

`FSW_INSTANCE` (default `./instance.local`) is the operator's directory and the only place personal data lives. `examples/instance/` holds the same shapes with placeholder values. `src/core/instance.mjs` loads the instance, takes example defaults for optional files, and throws a named error for a missing required file.

| Path | Kind | Content |
|---|---|---|
| `profile.json` | required | person, headline_ko/en, summary_ko/en, roles, education, awards, projects, skills, serviceFit, claimsNotToMake, approvedClaims |
| `business.json` | required | company, bizRegNo, email, taxInvoice, payout {bank, account, holder} |
| `config.json` | required | timezone, activeHours, platforms, payment, yield, notify, brain, jobs |
| `background.md` | optional | long bios that listing generators adapt |
| `ledger.sqlite` | created | see Ledger |
| `market/` | created | samples-YYYYMMDD.jsonl and summary-YYYYMMDD.json |
| `platforms/` | created | per-platform UI notes and state snapshots |
| `jobs/<jobId>/` | created | brief.md, inputs/, work/, deliverables/, qa/ |
| `portfolio/` | created | items.json and media/ |
| `lessons/` | created | lessons.jsonl, playbook.md, gate-rules.json |
| `operator/` | created | requests.md (logins, approvals, questions) and approvals/<id>.json |
| `logs/` | created | events-YYYYMMDD.jsonl |

Each platform runs in one mode: `observe` reads only, `draft` writes every outbound item to `operator/approvals/` and sends it once approved, `auto` sends when the gate passes. A kind can override the mode, for example `soomgo.profileEdits: "approval"`.

Before anything is opened, an item is parked from its list row alone when the platform closed it, when its newest message is older than `pipeline.replyWindowHours` for its kind, or when the platform labels it with a service the catalog does not hold (숨고 lessons stay unread for the operator, and the digest counts them). A parked item waits until a newer message arrives. In auto mode a decision below `pipeline.minAutoConfidence`, or one naming a different service than the platform's label, goes to the operator.

## Modules

| Module | Exports | Notes |
|---|---|---|
| `src/core/instance.mjs` | `loadInstance({dir})` returns {dir, profile, business, config, paths} | paths are absolute; directories are created on first use |
| `src/core/clock.mjs` | `nowSeoul()`, `seoulParts(date)`, `nextMark(date, everyMinutes)`, `isActive(date, activeHours)`, `dayKey(date)`, `hourKey(date)` | marks are aligned to minute 0 of the Seoul hour |
| `src/core/ledger.mjs` | `openLedger(path)` returning typed helpers per table | `node:sqlite` DatabaseSync, WAL, migrations by user_version |
| `src/core/log.mjs` | `logEvent(instance, kind, payload)` | JSONL per Seoul day |
| `src/core/notify.mjs` | `notifyOperator(instance, {kind, title, body, url})` | appends operator/requests.md, Windows toast, optional webhook |
| `src/policy/slop.mjs` | `lintText(text, {lang})` returns findings [{rule, tier, index, excerpt}] | floor tier blocks, reflex tier warns |
| `src/policy/gate.mjs` | `gateOutbound(item, ctx)` returns {ok, violations, warnings} | deterministic; see Policy gate |
| `src/platforms/registry.mjs` | `loadDescriptor(id)`, `listDescriptors()` | descriptors are JSON data validated on load |
| `src/platforms/<id>/adapter.mjs` | see Browser | one adapter per marketplace |
| `src/browser/driver.mjs` | `openSession(name)` | wraps the omowright attached engine on the operator's signed-in Chrome |
| `src/brain/codex.mjs` | `runCodex({prompt, schema, model, effort, cwd, sandbox, timeoutMs})` | `codex exec --ephemeral --output-schema` |
| `src/brain/respond.mjs` | `decide(thread, ctx)` | classify, reply, quote, operator flag |
| `src/platforms/<id>/market.mjs` | `sample(session, targets)` returns {rows, errors} | 크몽 reads the first 30 gig cards per category page (`kmongCategoryId`) or keyword search; 숨고 reads its public price guide |
| `src/economics/market.mjs` | `summarize(samples)`, `summarizeDay(rows)`, `latestSummary(instance)` | quantiles and review-weighted median for listings; guide figures and their unit pass through |
| `src/cli/market.mjs` | `run(argv, ctx)` | samples every enabled platform, retries a failed category once, writes the day's files only when the summary changed |
| `src/economics/pricing.mjs` | `buildPriceTable({summaries, profile, reviews, config})`, `quoteFor(row, complexity)`, `splitPayment(amount, config, descriptor)` | |
| `src/economics/yield.mjs` | `armStats(ledger)` | net KRW per weighted hour per (platform, service) |
| `src/economics/allocate.mjs` | `allocate(arms, {rng})` | Thompson sampling with an exploration floor |
| `src/portfolio/rank.mjs` | `rankPortfolio(items)` | the only ordering of portfolio items |
| `src/render/html2png.mjs` | `renderHtml({html, width, height, fullPage, out, format})` | owned headless browser, fonts inlined |
| `src/listings/*.mjs` | per-platform listing builders | content from profile, price table, playbook |
| `src/jobs/run.mjs` | `runJob(jobId, ctx)` | executes a recipe in jobs/<id>/work |
| `src/learning/*.mjs` | `recordOutcome`, `writeLessons`, `refreshPlaybook` | re0-memo then re0 over the playbook |
| `src/supervisor/run.mjs` | `runSupervisor(ctx)` | the daemon |
| `bin/fsw.mjs` | CLI | tick, run, status, probe, market, price, publish, learn, approve, schedule |

## Ledger

| Table | Columns |
|---|---|
| `threads` | id, platform, external_id, kind (message, request, order), customer, service, status, language, last_inbound_at, last_outbound_at, created_at, meta json; unique (platform, external_id) |
| `messages` | id, thread_id, direction (in, out), body, attachments json, external_id, at, gate json; unique (thread_id, direction, external_id) |
| `quotes` | id, thread_id, platform, service, amount_krw, deposit_krw, balance_krw, scope json, delivery_days, cost_krw, status (sent, accepted, declined, expired), at |
| `jobs` | id, thread_id, platform, service, title, price_krw, status (lead, quoted, ordered, in_progress, delivered, revision, closed, lost), agent_minutes, human_minutes, cost_krw, started_at, delivered_at, closed_at, meta json |
| `payments` | id, job_id, kind (deposit, balance, full, milestone), amount_krw, channel, received_at, evidence |
| `reviews` | id, job_id, platform, rating, text, liked, at |
| `events` | id, at, kind, platform, ref, payload json |
| `money_events` | id, key unique, platform, thread_id, job_id, event, amount_krw, at, applied, note, payment_id, evidence, recorded_at |

A payment row is written only from evidence (a platform order state or a bank deposit the operator confirmed); nothing infers it. `src/orders/notices.mjs` is the one classifier of platform notices (money or noise); `src/orders/money.mjs` records each money signal once in `money_events` under a key of platform, thread, event and the Seoul minute the platform stamped, so a list row and an opened thread showing the same line act once. A hire accepts the newest sent quote and opens the job as `ordered`; a paid notice writes one payment row with the notice text as evidence; a confirmation or remittance settles the payment it follows. A signal older than seven days is recorded as history without effect. Until `config.orders.watched` is true, every reply in an accepted or paid thread goes to the operator.

## Policy gate

`gateOutbound({platform, kind, text, attachments, amountKRW, thread}, {descriptor, instance, priceTable, lessonsRules})` applies these rules and returns every violation with its rule id:

- contact: phone numbers, e-mail addresses, URLs, messenger IDs and the payout account are blocked unless `descriptor.contactPolicy` allows that class at the thread's stage.
- payment: off-platform payment wording and the payout account are blocked where `descriptor.offPlatformPayment` is false; a payout account is released only on a platform that allows direct transfer and only after a quote was accepted.
- price: a quote outside the price table's [floor, ceiling] for its service is blocked.
- claims: a number attached to a unit of experience (years, projects, clients, percent) must appear in `profile.approvedClaims`; a client or employer name must appear in the profile; anything in `claimsNotToMake` is blocked.
- slop: floor findings from `lintText` block (em dash, horizontal bar, middle dot between words, placeholder text, self-reference as an AI model); reflex findings warn.
- shape: length within `descriptor.limits`, same language as the customer's last message, no empty or duplicate message within the thread.
- learned: rules in `lessons/gate-rules.json` (phrases, patterns) apply like built-in ones.

## Economics

Prices are market based. For a (platform, service) row the market base is read from the newest summary: a seller with fewer than 5 reviews on that platform starts at p25 + 0.35 (median - p25), 5 to 29 reviews at the median, 30 or more between the median and p75. serviceFit strength multiplies it (strong 1.15, some 1.0, none 0.9). The cost floor is the smallest gross whose net after fees covers the standard package's agent hours at `yield.agentHourCostKRW` plus its operator minutes at `yield.humanHourValueKRW`; agent hours run in parallel at compute cost, so they are never priced like labour. The base is the market base or the cost floor, whichever is higher, and a row is viable while its cost floor stays at or under the market ceiling (p75 x 1.5 for listing quantiles, the guide maximum for price guides). Packages are base, base x 2.2 and base x 4, rounded to 1,000 KRW. A request quote is the platform guide average times a complexity factor from the brain (0.6 to 1.6), clamped to the guide's [min, max] and never below the cost floor plus the quote cost.

Payment split: below `payment.milestoneThresholdKRW` the deposit is `payment.depositRatio` of the amount and the balance is the rest; above it the milestones in `payment.milestones` apply. On a platform that escrows the whole order the split is offered only through the mechanism its descriptor names.

Yield per arm (platform, service) is the sum of net KRW (price minus platform fee, quote costs and tool costs) divided by weighted hours (agent hours plus human hours x `yield.humanHourWeight`). Allocation samples a win rate from Beta(1 + wins, 1 + losses) and a value from the price table, scores win rate x value / expected hours, and normalizes; each enabled arm under `yield.exploreUntilLeads` leads keeps a floor of `yield.explorationFloor`, cut so all floors together stay within `yield.explorationShare`, so value leads from the first day while every arm is still tried. The weights order request bidding, listing work and budget use.

## Portfolio

`rankPortfolio(items)` filters and orders; the site and every listing generator import it. An item is eligible when it is a background project or a paid job (`paidAt` set) whose client allowed portfolio use; a job the client rated below 4 of 5 or marked as disliked is never shown. Tier A holds items the client liked (liked true or rating 4.5 or higher), ordered by liked, then client fame, then quality, then volume. Tier B holds the rest, ordered by quality, then volume. Ties fall to the newest `paidAt`, then id. Missing values sort after present ones. Item shape: {id, source (job, background), jobId, title_ko, title_en, service, client {name, public, fame 0..1, fameSource}, satisfaction {rating, liked, quote}, quality 0..1, volume {priceKRW, hours}, paidAt, permission (granted, pending, denied), media [{src, alt, kind}], summary_ko, summary_en, url}.

## Scheduling

All marks are Seoul time and aligned to minute 0. Every 5 minutes: inbox, orders and buyer requests on platforms in draft or auto mode, because marketplaces rank sellers by response time and a buyer request closes after its first few quotes. Hourly at :00: login checks on idle platforms and supervisor self-check. Daily at 00:00: market sampling, price table, allocation, portfolio rank and site deploy when changed, lesson consolidation. Daily at 09:00: operator digest, so the numbers are ready at the start of the workday. Mondays at 00:00: listing experiments.

The supervisor is one process started by a per-user scheduled task at logon and re-checked hourly at :00; a pid lock prevents doubles. It keeps the BrowserSkill daemon alive as a child, holds a Windows execution-state request so the machine does not idle into sleep, runs platform pipelines concurrently with one tab per platform, and runs jobs as separate processes up to `jobs.maxParallel`. Outbound actions respect `activeHours` and each descriptor's pacing (minimum gap between page loads, maximum actions and messages per hour).

A process keeps the modules it loaded, so after each tick the supervisor compares the repository's HEAD with the commit it started from. When HEAD moved and the new code's module graph imports in a fresh process, it exits with code 75 and the task's launcher starts it again; a commit that does not import is reported once and the running code stays. The config is read again every tick, so a config edit needs no restart.

## Browser

Adapters drive the operator's own signed-in Chrome through the omowright attached engine (BrowserSkill), resolved at call time from the newest omo plugin version or `FSW_OMOWRIGHT`. They run in plain node, since the node_repl kernel lacks `process`. An adapter implements what its platform supports: `login()`, `inbox()`, `readThread(id)`, `send(id, {text, files})`, `requests()`, `readRequest(id)`, `quote(id, quote)`, `listings()`, `upsertListing(listing)`, `orders()`, `profile()`, `marketSample(query)`. Every write reads the page back and returns what it observed; an action whose result cannot be observed reports failure. Adapters never open an unread thread unless the same tick replies to it, never clear site data, and never read credentials.

## Brain

`runCodex` calls `codex exec --ephemeral --skip-git-repo-check --output-schema <schema> --output-last-message <file> -s read-only -m <model>` and parses the file. `decide` assembles the profile summary, business terms, descriptor rules, the price rows for the service, the platform playbook, the newest lessons and the thread history, and asks for {intent, service, language, reply, quote, needsOperator, operatorReason, confidence, claimsUsed}. A reply that fails the gate goes back once with the violations; a second failure becomes an approval request.

## Jobs

A recipe in `recipes/<service>.json` is a typed skill graph in the shape paperthin:re0-workflow recommends: ordered steps {id, skill, type (invoke-model-skill, user-handoff), output}, deliverable specs, acceptance checks and an hour estimate. `runJob` writes brief.md, runs `codex exec -s workspace-write -C jobs/<id>/work` with the graph, then runs the deterministic acceptance checks (files and formats, image dimensions, sloplint on HTML, rendered screenshots at 390, 768 and 1440 px for web work) and records agent minutes. Delivery waits for the payment state the descriptor and split require.

## Learning

Outcomes (job closed, lead lost, review, revision request, operator correction) are recorded as cases. `writeLessons` runs paperthin:re0-memo through the brain: generalize the case into its class, keep the case as evidence, name the gate that would catch it. Lessons of the same class merge. `refreshPlaybook` rewrites `lessons/playbook.md` as a clean current rule set (paperthin:re0) and moves every deterministic rule into `lessons/gate-rules.json`. The brain reads the playbook on every decision.

## Site

`site/build.mjs` reads the instance, ranks the portfolio and writes `site/dist/` (ignored). `fsw publish` builds, compares a content hash with the last deployment and deploys only on change. The Vercel project is connected to the repository with automatic deployments off, since the inputs are generated from the instance.

## Harnesses

| Harness | Used for |
|---|---|
| paperthin | re0-memo and re0 in learning, re0-order as the portfolio ordering principle, debloat, dedash and dedot in copy generation, elon when pruning arms and services, re0-workflow as the recipe shape |
| omo | browser for adapters, visual-qa and frontend in recipes, remove-ai-slops on code deliverables |
| noslopdesign | noslop-uiux and noslop-frontend in recipes for pages, detail pages and the site; sloplint.mjs on every HTML artifact |
| codexclaw | cxc-dev routers for code deliverables, cxc-dev-visualizer for detail pages and diagrams, cxc-kwrite for Korean copy, messenger bridge for operator notifications |
| jawcode | `jwc` as a second executor for code jobs when a recipe asks for it |

## Checks

`npm test` runs node:test over src. `npm run check` adds the privacy scan (no tracked file contains a value from the instance), the slop lint over templates, playbooks and recipes, and descriptor and recipe schema validation.

