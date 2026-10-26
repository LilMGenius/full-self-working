# full-self-working

An agent that runs your freelance storefront while you do other things: it reads your marketplace inbox and buyer requests, replies and quotes within rules you set, keeps prices tied to what comparable sellers charge, builds the work once a deposit is in, and learns from every win, loss and correction. It runs on one computer you own, through the Chrome you are already signed in to, and your personal data never leaves the folder you keep it in.

This branch is v0, a rebuild of the agent's orchestration. At v0.1.0 it holds the foundations: the ledger, the outbound gate, the marketplace rule sheets, and the pricing math with its market sampling and price table. The running agent stays on `main` until this branch takes it over.

## Try it

You need Node.js 24 or newer. There are no packages to install.

```
git clone -b v0 https://github.com/LilMGenius/full-self-working.git
cd full-self-working
npm run check
```

`npm run check` runs the tests and the repository checks. The privacy scan needs your instance folder; without one it says so and skips.

## More

- [docs/DESIGN.md](docs/DESIGN.md) describes the modules, the ledger and the contracts between them.
- [docs/NEGATIVE-CORPUS.md](docs/NEGATIVE-CORPUS.md) lists what the first build learned about the marketplaces, and what keeps each lesson from being learned twice.
- `src/platforms/descriptors/` holds each marketplace's fee, payment and contact rules as data.
