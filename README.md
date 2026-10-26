# full-self-working

An agent that runs your freelance storefront while you do other things: it reads your marketplace inbox and buyer requests, replies and quotes within rules you set, keeps prices tied to what comparable sellers charge, builds the work once a deposit is in, and learns from every win, loss and correction. It runs on one computer you own, through the Chrome you are already signed in to, and your personal data never leaves the folder you keep it in.

`main` is the running agent. Work lands on the `v0` branch and reaches `main` once per phase, after its checks pass.

## Try it

You need Node.js 24 or newer. There are no packages to install.

```
git clone https://github.com/LilMGenius/full-self-working.git
cd full-self-working
npm run check
```

`npm run check` runs the tests and the repository checks. The privacy scan needs your instance folder; without one it says so and skips.

## More

- [docs/DESIGN.md](docs/DESIGN.md) describes the modules, the ledger and the contracts between them.
- [docs/NEGATIVE-CORPUS.md](docs/NEGATIVE-CORPUS.md) lists what the first build learned about the marketplaces, and what keeps each lesson from being learned twice.
- `src/platforms/descriptors/` holds each marketplace's fee, payment and contact rules as data.
