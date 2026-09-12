# CLAUDE.md — LiraLink

Shared context for any AI agent (Claude Code, Claude.ai, Cursor, Codex) and every teammate working
in this repo. Read this first, then the source-of-truth docs below. Keep it short and current — it
is a pointer + working agreement, **not** a second copy of the specs.

## What this is

LiraLink: a Turkish merchant creates a **TRY payment link**; a customer abroad pays it in **USDC on
Stellar testnet**; the merchant sees a **TRY balance** to withdraw to their IBAN. The merchant never
touches crypto. Built for Rise In × Stellar Pro (Istanbul, 19–20 Sept 2026), team **MersiErOfis**.

## Read-first order (source of truth)

1. **`docs/00-PROJECT.md`** — product, architecture, data model, **API contract (§6)**. This wins over
   everything else. If the API must change, change it **here first**, then tell the team.
2. Your own app brief:
   - `docs/01-BACKEND.md` — backend (Hasan)
   - `docs/02-PAY-WEB.md` — pay-web (Yunus)
   - `docs/03-MERCHANT-WEB.md` — merchant-web (Vuslat)
3. `docs/04-BACKEND-HANDOFF.md` — what's live now, exact response shapes, and gotchas for the two FE apps.
4. `docs/api.types.ts` — the generated DTO types both frontends type against. Keep in sync with §6.

## Repo layout

```
docs/            product + per-app specs + api.types.ts (source of truth)
backend/         NestJS API (Hasan)                — see backend/README.md to run
merchant-web/    React + Vite, desktop (Vuslat)    — not scaffolded yet
pay-web/         React + Vite PWA, mobile (Yunus)  — not scaffolded yet
contracts/       Soroban invoice contract (phase 2 — required)
docker-compose.yml   Postgres 16 for local dev (localhost:5433)
```

## Current status (updated 2026-09-12)

- **Backend — Phase 1 green.** Live: `/auth/register|login`, `GET/PATCH /me`, all `/links`, `/pay/:code`,
  `/pay/:code/submitted`, `/pay/:code/status`, `/health`, `/fx`. Implementation matches `00-PROJECT.md` §6.
- **Soroban contract rail live (testnet).** `POST /links` creates the on-chain invoice best-effort
  (`onchain: null` on RPC failure; retry `POST /links/:id/onchain`) → `rails.contract` on `/pay/:code`;
  payments through `invoice.pay` are detected via RPC events (`Payment.rail = 'contract'`). Ids: `docs/deployments.md`.
- **Backend — Phase 2 NOT built.** `/balance`, `/payments`, `/settlements`, `/withdrawals` have no
  endpoints yet (tables/types exist). Frontends must mock these until they go live.
- **Frontends — not scaffolded.** Both build against MSW mock (`VITE_USE_MOCK=true`) until each backend
  phase is announced green in team chat.

## Working agreement (all agents + humans)

- **Contract-first.** Any request/response change goes into `docs/00-PROJECT.md` §6 + `docs/api.types.ts`
  first, then code, then a note in team chat. Never let a running endpoint silently diverge from the docs.
- **Stay in your lane.** Don't edit another owner's app folder without asking; propose in chat instead.
- **Money is always a decimal string** in transport (TRY 2 dp, USDC 7 dp). Never a JS `number`. No UI math.
- **Every screen** has loading, empty, and error states. **Log every Stellar tx hash** you create/detect.
- **Small PRs into `main`; another teammate reviews.** CI per app: `npm run lint && typecheck && test`.
- English for UI strings, code, comments, commit messages.

## Toolchain pins (binding — see `00-PROJECT.md` §8)

- Node **22.23.2** — run `nvm use` (repo-root `.nvmrc`) before installing anything. Note the machine
  default may be Node 20; you must switch.
- `@stellar/stellar-sdk` **16.3.0** in `backend/` and `pay-web/` — same major required (the listener parses
  what pay-web builds). Do **not** take 17.x.
- Backend also pins: NestJS 11, Prisma 7.10.0 exactly, `bcryptjs` (not `bcrypt`).

## Run it locally

```bash
nvm use                 # Node 22.23.2
docker compose up -d     # Postgres 16 on localhost:5433
# backend: see backend/README.md — cp .env.example .env, set PLATFORM_ACCOUNT_SECRET,
#          npx prisma migrate dev, npm run start:dev  → http://localhost:3000 (Swagger at /docs)
```

CORS is open to `http://localhost:5173` (merchant-web) and `http://localhost:5174` (pay-web).

## Known gotcha (don't miss)

`GET /pay/:code` returns the destination + memo under **`rails.memo.{destination,memo}`**, not at the top
level. The `buildPaymentXdr` example in `02-PAY-WEB.md` reads `q.destination`/`q.memo` — that's stale.
The memo must equal the link `code`; without it the backend cannot match the payment. See `04-BACKEND-HANDOFF.md` §3.
