# full-self-working

An agent that runs your freelance storefront while you do other things. It watches your marketplace inbox and buyer requests, replies and quotes in your name within rules you set, keeps its prices tied to what comparable sellers charge, builds the work once a deposit is in, and learns from every win, loss and correction.

It runs on one computer you own, through the Chrome you are already signed in to. Nothing is hosted, and your personal data never leaves the folder you keep it in.

Today it works on two Korean marketplaces, 크몽 (Kmong) and 숨고 (Soomgo). Fiverr, Upwork, Freelancer and 위시켓 (Wishket) have rule sheets in the repository, but no browser adapter yet, so fsw cannot work on them.

## What it does

- Reads new messages, buyer requests and orders on each enabled platform, and drafts the reply or quote.
- Checks every outgoing message against a fixed rule set before it leaves: no contact details or off-platform payment where the platform forbids them, no experience numbers you did not approve, no price outside your price table, no AI-sounding filler.
- Samples public listings each day, rebuilds a price table, and spends more effort on the service and platform pairs that earn the most per hour.
- Starts the work for a paid order from a recipe, checks the result, and queues it for your approval before anything is delivered.
- Turns closed jobs into a portfolio site and turns your corrections into lessons it reads on the next decision.

## What it does not do

- It does not move money. Payment goes through each platform's own checkout, and a payout account is shown to a client only where the platform allows a direct transfer and only after a quote was accepted.
- It does not deliver work before the order is paid and you approved the delivery.
- It does not invent a background. Claims about you come from a profile you reviewed, and the gate blocks a number about your experience that is not on your approved list.
- It does not store passwords. It drives the Chrome profile you signed in to yourself.

## How it keeps you safe

Each platform runs in one of three modes in `config.json`.

| Mode | What fsw does |
|---|---|
| `observe` | Reads only. Nothing is written or sent. |
| `draft` | Writes every outgoing item to `operator/approvals/`. It is sent only after you run `fsw approve <id>`. |
| `auto` | Sends when the outbound gate passes. A decision the model is unsure about still goes to you. |

Start every platform in `observe`, then `draft`, and move to `auto` only after you have read a few days of drafts.

Four more limits apply on top of the mode:

- **The outbound gate** is plain code, not a prompt. A message that breaks a rule is blocked and rewritten once; a second failure becomes an approval request for you.
- **Cash caps.** Platforms that charge per quote (숨고 charges cash) refuse a quote until you set `maxQuotesPerDay` and `maxCashPerDay` for that platform.
- **Services.** A platform answers every service the agent can deliver unless its `services` setting lists the ones you want. Lessons (`lesson_tutoring`) are taught by you, so they are answered only where `services` lists them; fsw then replies, quotes and asks for payments, and tells you to schedule the sessions once the deposit arrives.
- **Approvals.** Delivery and payment requests always wait for you. Profile edits follow the `profileEdits` setting of each platform (`approval` waits for you). Until `orders.watched` is true in `config.json`, every reply in a thread with an accepted quote or a payment goes to you first.

## Install

You need Windows for the always-on parts (the scheduled task, sleep prevention and toast notifications), Google Chrome, and:

- Node.js 24 or newer.
- The Codex CLI, signed in (`npm i -g @openai/codex`, then `codex login`). fsw asks it for every drafted reply.
- BrowserSkill with its Chrome extension, from the omo plugin, so fsw can drive your signed-in Chrome.

```
git clone https://github.com/LilMGenius/full-self-working.git
cd full-self-working
```

There are no packages to install. If you do not run the opencodex proxy that the default Codex settings point at, set `FSW_CODEX_PROXY=none` and fsw uses your own Codex config.

## Set up

**1. Create your instance.** Everything about you lives in one folder that git ignores.

```
node bin/fsw.mjs init
```

This copies placeholder files into `instance.local/`, never overwriting anything, and prints the remaining steps. To keep the folder elsewhere, give it a path (`fsw init D:\fsw-me`) and set `FSW_INSTANCE` to that path.

**2. Build your profile from your own background.** Hand fsw whatever shows who you are: a CV, a LinkedIn data export, notes, a PDF, a link, or folders of your own projects.

```
node bin/fsw.mjs profile build cv.pdf notes.md D:\code\my-project --author "Your Git Name"
```

fsw reads the files, and for a project folder it reads the README and your commits. The model drafts `profile.draft.json`, and every claim must point to the file, line and exact words it came from. A claim whose words are not found at that line is dropped. Where two sources disagree, the lower value is kept. Anything the sources do not say stays out. Add `--lang ko` for the review list in Korean.

Open `profile.review.md`. It lists each claim with its source, what was left out, and what you still need to check. Fix the draft if needed, then promote it:

```
node bin/fsw.mjs profile accept
```

Your old `profile.json` is kept beside the new one. LinkedIn exports are read for your own profile only; files that hold other people's data, such as connections and messages, are skipped.

**3. Fill in `business.json`** (company name, registration number, e-mail, payout account) by hand. It is never drafted from your sources. Then read `config.json`: which platforms are enabled, their modes, the cash caps, the active hours for sending, and the `brain` model.

**4. Sign in to each enabled platform in Chrome.** Use the Chrome profile that has the BrowserSkill extension, and keep it open. For 숨고, switch to your seller (expert) account.

**5. Check the machine.**

```
node bin/fsw.mjs doctor
```

Doctor prints one line per requirement: Node version, Codex CLI and one real model call, the proxy, Chrome, BrowserSkill, your instance files, leftover placeholder values, platform logins, the scheduled task, and the Vercel login if you publish a site. It exits with 1 when something required is missing, and each failing line says what to do.

**6. Keep it running.**

```
node bin/fsw.mjs schedule install
```

This registers a per-user task that starts fsw at logon and checks it every hour. It runs from a separate copy of the code, so editing the repository never changes a running agent by accident. `fsw schedule status` shows it, and `fsw schedule uninstall` removes it.

## Daily use

| Command | What it shows or does |
|---|---|
| `fsw status` | The instance, ledger counts and the enabled platforms with their modes |
| `fsw approve` | Lists open approvals; `fsw approve <id>` sends one, `--text "..."` edits it first, `--reject --reason "..."` refuses it, and `--sent [--cost <KRW>]` records a send the adapter could not confirm but you saw go out, so it is never sent twice |
| `fsw order list` | Jobs in progress; `order permission` and `order review` record what a client answered |
| `fsw learn` | Turns finished outcomes into lessons now instead of waiting for the daily pass |
| `fsw publish` | Rebuilds the portfolio site and deploys it only if its content changed |

Every morning at 09:00 Seoul time fsw writes a digest of the previous day to `operator/digest-YYYYMMDD.md` and sends a notification. Anything that needs you, such as a login that expired or a question it cannot answer, is added to `operator/requests.md` and shown as a toast.

To try a change safely, run `FSW_FORCE_MODE=observe node bin/fsw.mjs tick`. The override can only lower a platform's mode, never raise it.

## Privacy

The repository holds no personal data. Your profile, business details, payout account, ledger, job files and logs live in the instance folder, which `.gitignore` excludes. The public portfolio site is built from the instance on your machine and never contains your payout account. `npm run check:privacy` fails if any tracked file contains a phone number, e-mail address, registration number or account number from your instance.

## More

- [docs/DESIGN.md](docs/DESIGN.md) describes the modules, the ledger, the gate rules and the pricing model.
- `src/platforms/descriptors/` holds each marketplace's fee, payment and contact rules as data.
- `recipes/` holds the step graphs for each kind of work.
