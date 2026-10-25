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
| `config.json` | required | timezone, activeHours, platforms, payment, market, yield, notify, brain, jobs |
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

Which catalog services the instance answers is a setting per platform: `platforms.<id>.services` lists catalog ids, and absent or `null` means every service the agent delivers. An operator-delivered service (`delivery: "operator"` in `src/economics/services.json`, such as `lesson_tutoring`) spends the operator's own hours, so it is answered only on a platform that lists it; `src/economics/catalog.mjs` owns the rule, and an id the catalog does not hold is a config error. The brain's catalog and price rows, the allocation's arms and a hire's job follow the same list.

Before anything is opened, an item is parked from its list row alone when the platform closed it, when its newest message is older than `pipeline.replyWindowHours` for its kind, or when the platform labels it with a service the catalog does not hold or the instance does not answer there (숨고 lessons by default stay unread for the operator, and the digest counts them). A parked item waits until a newer message arrives. In auto mode a decision below `pipeline.minAutoConfidence`, or one naming a different service than the platform's label, goes to the operator.

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
| `src/platforms/soomgo/services.mjs` | `setServiceItems(session, service, wanted, {dryRun})`, `parseServiceRows`, `parseItemModal`, `planItems` | 숨고 sends a pro only the requests whose answers match the items set on each offered service; `fsw services soomgo [--apply]` ticks the items in the instance's `platforms/soomgo-service-items.json` and reads them back |
| `src/platforms/soomgo/edits.mjs` | `setIntro`, `appendServiceDetail`, `addQuoteTemplate` | approved profile text on the established 숨고 account; `fsw edits soomgo [--apply]` types every part as a dry run, and saves a part only when `platforms/soomgo-edits.json` marks it approved, after the outbound gate; template costs come from the newest price table |
| `src/browser/driver.mjs` | `openSession(name)` | wraps the omowright attached engine on the operator's signed-in Chrome |
| `src/brain/codex.mjs` | `runCodex({prompt, schema, model, effort, cwd, sandbox, timeoutMs})` | `codex exec --ephemeral --output-schema` |
| `src/brain/respond.mjs` | `decide(thread, ctx)` | classify, reply, quote, operator flag |
| `src/platforms/<id>/market.mjs` | `sample(session, targets, {fx})` returns {rows, errors, skipped} | 크몽 reads the first 30 gig cards per category page (`kmongCategoryId`) or keyword search; 숨고 reads its public price guide; Freelancer reads the newest 30 active fixed-price projects per job (`freelancerJob`) through its public API; 위시켓 reads two pages of 외주 projects per field (`wishketField`) from its public list; Fiverr reads the first 30 gigs of a keyword search (`fiverrQuery`) from the page's embedded JSON |
| `src/economics/market.mjs` | `summarize(samples)`, `summarizeDay(rows)`, `latestSummary(instance)` | quantiles and review-weighted median for listings; guide figures and their unit pass through |
| `src/economics/fx.mjs` | `loadFx(instance)`, `toKRW(amount, currency, fx)`, `fxNote(currency, fx)` | ECB reference rates from Frankfurter (no key), read once per Seoul day into `market/fx-<day>.json`; fails with `FSW_FX_UNAVAILABLE` and caches nothing when the source cannot answer |
| `src/cli/market.mjs` | `run(argv, ctx)`, `marketEngine(platform, config)` | samples every platform the config lists, enabled or not, through that platform's market engine, retries a failed category once (a bot challenge, named by vendor, ends that platform's reads for the run and is never retried), writes the day's files only when the summary changed; a run replaces only the (platform, category) pairs it read, so naming one platform keeps the rest of the day |
| `src/browser/archive.mjs` | `archiveSession(page, {now, maxAgeDays})`, `archiveUrl(url)`, `captureOf(href)` | loads the newest Wayback capture of a page in an owned page and reports its capture time and address |
| `src/economics/pricing.mjs` | `buildPriceTable({summaries, profile, reviews, config})`, `quoteFor(row, complexity)`, `splitPayment(amount, config, descriptor)` | |
| `src/economics/yield.mjs` | `armStats(ledger)` | net KRW per weighted hour per (platform, service) |
| `src/economics/allocate.mjs` | `allocate(arms, {rng})` | Thompson sampling with an exploration floor |
| `src/portfolio/rank.mjs` | `rankPortfolio(items)` | the only ordering of portfolio items |
| `src/render/html2png.mjs` | `renderHtml({html, width, height, fullPage, out, format})`, `openRenderer().pdf({html, out})` | owned headless browser, fonts inlined; `pdf` prints through `Page.printToPDF` and returns which face drew each text node (CDP `CSS.getPlatformFontsForNode`) |
| `src/render/fonts.mjs` | `pretendardFontFace()`, `pdfFonts(bytes)`, `fontProblems`, `platformFontProblems` | Chrome prints a variable face as unnamed Type3 glyphs, so the renderer's per-node report proves the face and the PDF scan catches a named fallback |
| `src/listings/*.mjs` | per-platform listing builders | content from profile, price table, playbook |
| `src/jobs/run.mjs` | `runJob(jobId, ctx)` | executes a recipe in jobs/<id>/work |
| `src/learning/*.mjs` | `recordOutcome`, `writeLessons`, `refreshPlaybook` | re0-memo then re0 over the playbook |
| `src/supervisor/run.mjs` | `runSupervisor(ctx)` | the daemon |
| `src/platforms/kmong/projects.mjs`, `src/projects/*.mjs` | `openProjectReader()`, `openProjectSeller()`, `scoreProject`, `improveProposal`, `nextStep`, `sendDecision`, `projectsJob(ctx)`, `reviseApproval(ctx, id)` | 크몽 엔터프라이즈 projects: public reads in the owned browser, quota and 제안하기 on the session; each page version judged once as a ledger thread of kind project; a phased Korean proposal gated, critic-checked on a second model and redrafted with the critic's problems at most twice; sent only within `platforms.kmong.proposals` (maxPerDay under the page quota, minFit, autoMaxKRW), dropped as a learning case when the critic alone still rejects it, otherwise an approval holding the best draft; `fsw projects revise <approvalId>` reworks one that waits |
| `src/platforms/wishket/projects.mjs` | `openProjectReader()`, `parseProjectDetail(raw)`, `requestedItems(text)`, `applyToProject()` | 위시켓 projects read signed out in the owned browser at descriptor pacing: the open 외주 list (`pt=task_based`, `ecd=True`, newest first), then each detail page, whose JobPosting JSON-LD holds the client's text and whose page holds budget, period, applicants, deadline, skills and type; a negotiable budget falls back to a 예산 line of the description at its lower end; requested items are the marked lines under the proposal and quote headings; `applyToProject` refuses with `FSW_WISHKET_APPLY_UNMAPPED` until the signed-in form is mapped. `src/projects/score.mjs` judges them on its wishket board (`BOARDS`, `scoreProject(p, {platform})`, `boardDrop`, `projectMemory(platform)`): private matching, closed, 기간제 and monthly projects drop, fields map to catalog services through `WISHKET_FIELD_SERVICES` (an unknown field falls back to keywords), and the floor nets the tiered partner fee. `src/projects/draft.mjs` drafts for either board (`proposalPolicy(config, platform)`, `usedToday(ledger, now, platform)`, `BOARD_COPY`); where the descriptor forbids identity, the writer and the critic read the profile with names, companies and employers swapped for neutral words and no project names, and the gate blocks any name that slips through |
| `scripts/kmong-enterprise-profile.mjs` | sections on the command line | fills the kmong enterprise profile that 제안하기 requires from the decisions in `platforms/kmong-enterprise-profile.json` (shape in `examples/`), skipping entries already in their section, and registers only when `register` is named |
| `src/cli/init.mjs` | `initInstance(dir)`, `run(argv)` | copies `examples/instance` into a new directory, never overwrites, fails with `FSW_INSTANCE_EXISTS` |
| `src/profile/*.mjs` | `loadSources(inputs)`, `draftProfile(sources)`, `verifyDraft(raw, sources)`, `buildReview(...)`, `validateProfile(p)` | `fsw profile build` drafts `profile.draft.json` through `runCodex`; a claim survives only when its quote is found at its cited source line and its words and numbers are inside the quote; `fsw profile accept` promotes the draft |
| `src/profile/resume.mjs` | `buildResume({instance, lang, platform, out})` | `fsw profile resume` prints `documents/resume-<lang>.pdf` from profile.json: Korean renderings (`*_ko` beside each English field) where an entry has them, no link, handle or contact, the platform gate as a profile item before printing, and the font and two-page checks before the file replaces the last one |
| `src/cli/doctor.mjs` | `runChecks(ctx)`, `run(argv)` | one line per requirement, exit 1 when a required check fails; every probe is injectable |
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
- identity: where `descriptor.contactPolicy.identity` is `forbidden` (위시켓's terms bar names, marks and contact details on the platform), the operator's names are blocked in the text and attachment names: the person's names and handle, the payout holder, the business name and every organisation a profile role shows the person founding or heading.
- payment: off-platform payment wording and the payout account are blocked where `descriptor.offPlatformPayment` is false; a payout account is released only on a platform that allows direct transfer and only after a quote was accepted.
- price: a quote outside the price table's [floor, ceiling] for its service is blocked.
- claims: a number attached to a unit of experience (years, projects, clients, percent) must appear in `profile.approvedClaims`; a client or employer name must appear in the profile; anything in `claimsNotToMake` is blocked.
- slop: floor findings from `lintText` block (em dash, horizontal bar, middle dot between words, placeholder text, self-reference as an AI model); reflex findings warn.
- shape: length within `descriptor.limits`, same language as the customer's last message, no empty or duplicate message within the thread.
- learned: rules in `lessons/gate-rules.json` (phrases, patterns) apply like built-in ones.

## Economics

Prices are market based. For a (platform, service) row the market base is read from the newest summary: a seller with fewer than 5 reviews on that platform starts at p25 + 0.35 (median - p25), 5 to 29 reviews at the median, 30 or more between the median and p75. serviceFit strength multiplies it (strong 1.15, some 1.0, none 0.9). The cost floor is the smallest gross whose net after fees covers the standard package's agent hours at `yield.agentHourCostKRW` plus its operator minutes at `yield.humanHourValueKRW`; agent hours run in parallel at compute cost, so they are never priced like labour. The base is the market base or the cost floor, whichever is higher, and a row is viable while its cost floor stays at or under the market ceiling (p75 x 1.5 for listing quantiles, the guide maximum for price guides). A guide that publishes only its average (숨고's lesson guides print an hourly average and no 최저 or 최고) stands its average in for the minimum and maximum, so a request quote lands on it. Packages are base, base x 2.2 and base x 4, rounded to 1,000 KRW. A request quote is the platform guide average times a complexity factor from the brain (0.6 to 1.6), clamped to the guide's [min, max], moved toward the budget the buyer stated (up to its minimum, down to its maximum) without leaving the guide, and never below the cost floor plus the quote cost.

Market samples come from public pages, so every platform the config lists is sampled before any account exists there. A sample priced in another currency is converted at sampling time with that day's ECB reference rates from Frankfurter (`src/economics/fx.mjs`), cached per Seoul day, and keeps its original amount and currency, the rate, its publication date and its source; when the rates cannot be read, that day's non-KRW platforms are skipped by name. On a bidding platform the signal is the client's budget: each fixed-price project is one sample whose priceKRW is the midpoint of its budget range, a single stated amount (위시켓 예상 금액) being its own midpoint, and hourly or monthly projects, budgets left to negotiation or missing and amounts in a currency the rates lack are skipped and counted by name. Upwork has no sampler: its public job search needs a login and the owned browser met a Cloudflare block, so its market waits for a signed-in adapter. Each platform reads its public pages through a market engine, `config.market.engines.<platform>`, which defaults to the descriptor's `market.engine` and else to `owned`, so an operator can change it at any time; a null value means the default. `owned` is a headless Chrome with a fresh profile, so no read rides on any account. `attached` is the operator's Chrome through BrowserSkill, reading only public pages at the descriptor's page gap, for a host whose bot wall stops the owned browser; it shares the extension with the platform pipelines, and the supervisor runs market sampling in its own job, never inside a poll. `archive` loads the newest Wayback Machine capture in the owned browser; a sample read from it is dated by its capture time and keeps the snapshot address, a capture older than the seven days a sample may be carried fails by name, and only a sampler that keeps the capture time (it lists `archive` in its `engines` export) may be configured for it. Fiverr defaults to `attached`: on 2026-10-25 the owned browser met a PerimeterX challenge while the operator's Chrome read the same search page, and Wayback held search captures from 2016 and 2017 only. `config.market.categoriesPerRun.<platform>` (else the descriptor's `market.categoriesPerRun`, else every category) bounds how many categories one run reads, choosing never-read and then the stalest ones, while the rest keep their carried samples; `config.market.cadence.<platform>` (else the descriptor's `market.cadence`, else `day`) puts a platform in the daily market slot or in the hourly slice. Fiverr reads one of its 13 searches an hour, stalest first: a fresh session of the operator's Chrome read 30 to 48 gigs from one search page, and a second search seconds later met the challenge, so every search is refreshed within the day at one page load an hour. A challenge on any engine ends that platform's reads for the day by name, and no page is read around it. `fsw price` prices every platform with summary entries, enabled or not: a platform with no account state is priced as a new seller (0 reviews), every row carries `adapter` (whether this build can work that platform), and the allocation gives no weight to a row without one. A platform that is not enabled and cannot be priced, such as Fiverr while its VAT on fees is unknown, is listed by name under `skipped` in the table file and never blocks the enabled platforms' rows.

Payment split: below `payment.milestoneThresholdKRW` the deposit is `payment.depositRatio` of the amount and the balance is the rest; above it the milestones in `payment.milestones` apply. On a platform that escrows the whole order the split is offered only through the mechanism its descriptor names.

Yield per arm (platform, service) is the sum of net KRW (price minus platform fee, quote costs and tool costs) divided by weighted hours (agent hours plus human hours x `yield.humanHourWeight`). Allocation samples a win rate from Beta(1 + wins, 1 + losses) and a value from the price table, scores win rate x value / expected hours, and normalizes; each enabled arm under `yield.exploreUntilLeads` leads keeps a floor of `yield.explorationFloor`, cut so all floors together stay within `yield.explorationShare`, so value leads from the first day while every arm is still tried. `prioritize` (`src/economics/priority.mjs`) turns the newest weights into each tick's work order: conversations already under way first, then new requests by the weight of the services their platform label maps to, so a capped day of paid quotes and proposals goes to the best arms first.

## Portfolio

`rankPortfolio(items)` filters and orders; the site and every listing generator import it. `syncPortfolio` turns only closed jobs (every payment received and confirmed) into items. An item is eligible when it is a background project or a paid job (`paidAt` set) whose client allowed portfolio use; a job the client rated below 4 of 5 or marked as disliked is never shown. Tier A holds items the client liked (liked true or rating 4.5 or higher), ordered by liked, then client fame, then quality, then volume. Tier B holds the rest, ordered by quality, then volume. Ties fall to the newest `paidAt`, then id. Missing values sort after present ones. Item shape: {id, source (job, background), jobId, title_ko, title_en, service, client {name, public, fame 0..1, fameSource}, satisfaction {rating, liked, quote}, quality 0..1, volume {priceKRW, hours}, paidAt, permission (granted, pending, denied), media [{src, alt, kind}], summary_ko, summary_en, url}.

## Scheduling

All marks are Seoul time and aligned to minute 0. Every 5 minutes: inbox, orders and buyer requests on platforms in draft or auto mode, because marketplaces rank sellers by response time and a buyer request closes after its first few quotes. Hourly at :00: login checks on idle platforms and supervisor self-check, then 크몽 엔터프라이즈 projects, since a project stays open for days and its proposal quota is per day, then the market slice of hour-cadence platforms (one Fiverr search). Daily at 00:00: market sampling of day-cadence platforms, price table, allocation, portfolio rank and site deploy when changed, lesson consolidation. Daily at 09:00: operator digest, so the numbers are ready at the start of the workday; its market section lists each service's median on every sampled platform beside the 크몽 and 숨고 figures, saying whether a figure is a starting price, a client budget or a guide average, so the operator sees which overseas login would pay first. Mondays at 00:00: listing experiments.

The supervisor is one process started by a per-user scheduled task at logon and re-checked hourly at :00; a pid lock prevents doubles. It keeps the BrowserSkill daemon alive as a child, holds a Windows execution-state request so the machine does not idle into sleep, runs platform pipelines concurrently with one tab per platform, and runs jobs as separate processes up to `jobs.maxParallel`. Outbound actions respect `activeHours` and each descriptor's pacing (minimum gap between page loads, maximum actions and messages per hour).

A process keeps the modules it loaded, and agents edit the main checkout all day, so the scheduled task runs the supervisor from a detached worktree of `main` (`%LOCALAPPDATA%\fsw\code`, or `FSW_CODE_DIR`) that only ever holds committed code. After each tick the supervisor compares that worktree with `main`; when `main` moved and the new commit's module graph imports in a temporary worktree, it checks the commit out and exits with code 75, and the launcher starts it again at once. A commit that does not import is reported once and the running code stays. The launcher restarts a supervisor that crashed after five minutes, and the config is read again every tick, so a config edit needs no restart.

## Browser

Adapters drive the operator's own signed-in Chrome through the omowright attached engine (BrowserSkill), resolved at call time from the newest omo plugin version or `FSW_OMOWRIGHT`. They run in plain node, since the node_repl kernel lacks `process`. An adapter implements what its platform supports: `login()`, `inbox()`, `readThread(id)`, `send(id, {text, files})`, `requests()`, `readRequest(id)`, `quote(id, quote)`, `listings()`, `upsertListing(listing)`, `orders()`, `profile()`, `marketSample(query)`. Every write reads the page back and returns what it observed; an action whose result cannot be observed reports failure. Adapters never open an unread thread unless the same tick replies to it, never clear site data, and never read credentials.

Every agent and the supervisor share one BrowserSkill extension, and one stalled page stalls it for all of them: on 2026-10-25 a full snapshot of 숨고's add-service modal and repeated kmong portfolio uploads each froze it for minutes, and the supervisor's polls failed meanwhile. So a page that lists thousands of controls is read and clicked through DOM queries, never a whole-page snapshot, and a step that stalls the browser is parked as a gap instead of retried in a loop. The supervisor tells the operator when a platform fails `STUCK_POLLS` polls in a row.

## Brain

`runCodex` calls `codex exec --ephemeral --skip-git-repo-check --output-schema <schema> --output-last-message <file> -s read-only -m <model>` and parses the file. `decide` assembles the profile summary, business terms, descriptor rules, the price rows for the service, the platform playbook, the newest lessons and the thread history, and asks for {intent, service, language, reply, quote, needsOperator, operatorReason, confidence, claimsUsed}. A reply that fails the gate goes back once with the violations; a second failure becomes an approval request.

## Jobs

The supervisor's `orders` job (`src/orders/run.mjs`, every 5 minutes after the poll) starts an ordered job in a detached `fsw job run` process once its payments meet the recipe's `beforeStart` level and it has an agreed scope, at most `jobs.maxParallel` at once. When acceptance passes it queues a delivery approval with the deliverables and QA captures; on approval the files go out through the adapter's observed send once `deliveryAllowed` passes, after the balance request on a split platform, and the message asks the client for portfolio permission. A delivered job whose payments are all confirmed is closed, synced into the portfolio, published when the content hash changed and recorded as a learning case. `fsw order permission|review` records what the client answered on the platform.

A service whose catalog entry says `delivery: "operator"` (a lesson) has no recipe and never starts a job run. Once its `OPERATOR_START_LEVEL` payment (the deposit) is recorded, `handOver` moves the job to `in_progress` and tells the operator to schedule the sessions; on a split platform that notice is the balance request item, which the operator approves with `fsw approve` when the sessions are done, and the job closes like any other once the balance is paid and the platform confirms it. A deposit request the client overtook by paying on their own is closed as stale at the handover. A request quote for such a service prices one session, the same per-item gap the guide quote names for photos.

A recipe in `recipes/<service>.json` is a typed skill graph in the shape paperthin:re0-workflow recommends: ordered steps {id, skill, type (invoke-model-skill, user-handoff), output}, deliverable specs, acceptance checks and an hour estimate. `runJob` writes brief.md, runs `codex exec -s workspace-write -C jobs/<id>/work` with the graph, then runs the deterministic acceptance checks (files and formats, image dimensions, sloplint on HTML, rendered screenshots at 390, 768 and 1440 px for web work) and records agent minutes. Delivery waits for the payment state the descriptor and split require.

A revision request on a delivered job (`src/orders/revision.mjs`) reopens it: the request is kept on the job and recorded as a learning case, and the orders job runs the job again with the request in its brief, so its acceptance queues the usual delivery approval. Each package includes `INCLUDED_REVISIONS` rounds (one), which the catalog hours assume; a further round goes to the operator to quote or approve.

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

