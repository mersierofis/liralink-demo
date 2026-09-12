# merchant-web

Owner: Vuslat. Desktop web app a Turkish merchant uses to create LiraLink payment links, watch
payments arrive, and withdraw a TRY balance. Read `../docs/00-PROJECT.md` first, then
`../docs/03-MERCHANT-WEB.md` for the full brief and `../docs/04-BACKEND-HANDOFF.md` for what the
backend actually returns.

## Stack

Vite + React 18 + TypeScript (strict) + Tailwind CSS + shadcn/ui (hand-rolled components on
Radix primitives) + TanStack Query + React Router v6 + react-hook-form/zod + MSW.

## Run locally

```bash
nvm use                # Node 22.23.2, repo-root .nvmrc
npm install
cp .env.example .env    # then point VITE_API_URL at a backend, see below
npm run dev             # http://localhost:5173
```

### `.env`

```
VITE_API_URL=...                 # backend base URL, must end in /api
VITE_USE_MOCK=true|false         # true = MSW mock handlers, false = real API
VITE_EXPLORER_TX_URL=https://stellar.expert/explorer/testnet/tx/
VITE_EXPLORER_ACCOUNT_URL=https://stellar.expert/explorer/testnet/account/
```

This repo's own `.env` (git-ignored) currently points at the live testnet deployment:
`https://liralink-api.tutorialplatform.com/api`, `VITE_USE_MOCK=false`. Demo login:
`demo@liralink.app` / `demo1234`.

## Scripts

```bash
npm run dev         # dev server
npm run build        # tsc -b && vite build
npm run lint         # eslint
npm run typecheck    # tsc -b --noEmit
npm run test         # vitest run
```

## Status

Scaffold only — see `../docs/03-MERCHANT-WEB.md` build order for what's next (auth pages,
links, link detail, dashboard, withdrawals/settings, MSW handlers, polish).
