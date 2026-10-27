# full-self-working

fsw runs your freelance storefront on online marketplaces while you do other work. It answers inquiries and buyer requests, sends quotes priced from what comparable sellers charge, builds the paid work with a coding agent once the payment is in, and learns from every win, loss and correction. It runs on one Windows computer you own, through the Chrome you are already signed in to, and the repository holds nothing about you: your profile, accounts, ledger and customer threads stay in one folder git never tracks.

Today the whole loop, from the first message to the delivery, runs on kmong and soomgo. For wishket, fiverr and freelancer.com fsw reads market prices and fills in the seller onboarding from your profile, and for upwork the onboarding.

## A day with fsw

- Every five minutes it reads the inbox and request list of each platform you set to draft or auto, decides each new item, and sends what your rules allow or queues it for you.
- At 00:00 Seoul time it samples competitors' prices, rebuilds the price table, re-ranks your portfolio and redraws the kmong gig images whose top items changed.
- At 09:00 it writes a digest of the day before and notifies you.
- A paid job runs through the recipe for its service (a landing page, a logo, a data crawl and so on), passes the recipe's acceptance checks and a review by a model from another family (Claude for work GPT built, GPT for work Claude built), and waits for you to approve the delivery.

What needs you is one command away. `fsw` here is `node bin/fsw.mjs`, run from the repository folder.

```
fsw approve list                  # what waits for you: drafts, deliveries, payment requests
fsw approve <id>                  # send it as written
fsw approve <id> --text "..."     # send your edit instead
fsw approve <id> --reject         # drop it
fsw deal <jobId> permission granted   # the client allowed portfolio use
fsw status                        # ledger counts, the last tick, the enabled platforms
fsw settings                      # every choice with its value, default and meaning
```

## Modes and limits

Each platform runs in one of three modes: `observe` reads only, `draft` plans every outbound item for your approval, and `auto` sends what the policy allows. Every message, quote and proposal passes a gate before it leaves: the platform's contact and payment rules, the price range fsw set for that service, claims your profile cannot back, and filler that reads as machine-written. A platform that charges per quote is capped per day. A platform's mode, cash cap and the services it answers there are choices you make before it acts, and `fsw doctor` warns until you have made them.

## Setup

You need:

- Windows, since the scheduled task and the notifications use it, and Git.
- Node.js 24 or newer.
- Google Chrome with BrowserSkill, the browser extension and local service fsw drives Chrome through. The omo plugin for Codex ([LazyCodex](https://github.com/code-yeongyu/lazycodex)) sets it up, and you enable the extension in Chrome once.
- The [Codex CLI](https://github.com/openai/codex), signed in with `codex login`. By default fsw calls it through [opencodex](https://github.com/lidge-jun/opencodex), a local proxy that also lets codex reach Claude and other providers; `fsw doctor` checks the proxy and says how to call codex directly when you run none.

```
git clone https://github.com/LilMGenius/full-self-working.git
cd full-self-working
npm ci
node bin/fsw.mjs init
```

`init` creates your instance folder, `instance.local/`, from placeholder files and prints the remaining steps:

1. Draft your profile from any mix of files, folders and links about your work (a CV as PDF or text, notes, repository folders, your GitHub page): `node bin/fsw.mjs profile build cv.pdf notes.md https://github.com/<you>`. Read the draft and its review notes, fix what is wrong, then run `node bin/fsw.mjs profile accept`. Every claim in the profile cites the source it came from.
2. Fill `instance.local/business.json` (company, registration number, e-mail, payout account). Then make your choices: `node bin/fsw.mjs settings` lists every setting with its meaning, and `node bin/fsw.mjs settings set <key> <value>` changes one, for example `settings set platforms.soomgo.mode draft`. Paid work built on the default GPT model needs `jobs.review.model` set to a model of another family your codex reaches, or each delivery comes to you unreviewed.
3. Sign in in Chrome to each platform you enabled, then run `node bin/fsw.mjs doctor`, which checks Node, Chrome, BrowserSkill, Codex and your instance and prints the fix for anything missing.
4. When doctor passes, `node bin/fsw.mjs schedule install` registers the task that starts fsw at logon and checks every hour on the hour that it runs. To watch one pass right away, run `node bin/fsw.mjs tick --once`.

## Dependencies

One npm package, ajv, which `fsw settings` uses to check a change against the settings schema. The ledger is SQLite through Node's built-in `node:sqlite`.

## Why it works this way

fsw drives your own signed-in Chrome on your own machine instead of a hosted browser, lets the model write the words while code sets the price, sends every outbound item through one queue that reads each send back on the page, and has a model from another family review paid work before you approve it. Every model turn runs through the Codex CLI, inside its sandbox. [docs/DESIGN.md](docs/DESIGN.md#decisions) gives the reason and the evidence for each choice.

## More

- [docs/DESIGN.md](docs/DESIGN.md) describes the modules, the ledger and the contracts between them.
- [docs/NEGATIVE-CORPUS.md](docs/NEGATIVE-CORPUS.md) lists what the first build learned about the marketplaces, and what keeps each lesson from being learned twice.
- `src/platforms/descriptors/` holds each marketplace's fee, payment and contact rules as data.
- [AGENTS.md](AGENTS.md) is the guide for changing the code: the layout, the commands and the rules every change keeps.
