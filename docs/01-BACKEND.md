# LiraLink Backend — Implementation Brief for Claude Code (Hasan)

> Read `docs/00-PROJECT.md` first. This file tells you how to build `backend/`.
> Work in phases. After each phase: run tests, run the manual verification listed, commit. Do not start the next phase until the current one is green.
> When something in the Stellar SDK doesn't behave as described here, read the SDK source in `node_modules/@stellar/stellar-sdk` before guessing.

## Stack

> **Versions corrected 2026-09-12** — see `00-PROJECT.md` §8 Pinned toolchain. The original brief pinned stale/wrong versions (Node 20, NestJS 10, stellar-sdk 13.x — that tag is a `protocol-22-beta` prerelease, `bcrypt`). Use the table below, not the historical numbers. Note we deliberately did **not** take the newest majors of NestJS or stellar-sdk — see the rationale inline.

- **Node 22.23.2** (`.nvmrc` at repo root), **NestJS 11.2.3** (not the just-released 12 — it swaps Jest→Vitest, ESLint→oxlint, Webpack→Rspack by default, contradicting this doc's own Jest+Supertest choice below), TypeScript strict
- **Prisma pinned to `7.10.0` exactly** + PostgreSQL 16 (Docker for local; RDS or a Postgres container on EC2 for demo) — never install `prisma`/`@prisma/client` unpinned; unpinned currently resolves to an `8.0.0-rc` release candidate
- `@stellar/stellar-sdk@16.3.0` (the `lts-16` tag, still actively maintained — not 17.x, which rewrites Buffer→Uint8Array and the XDR namespace across every public API for no benefit here) — Horizon + RPC clients, tx building. Must match the major pay-web uses.
- Money math: use **`Decimal` re-exported from `@prisma/client`**, not a standalone `decimal.js` dependency. Prisma's `Decimal` is API-identical to decimal.js but a distinct instance — `instanceof` checks and mixed operands across the two fail (a known Prisma issue). Importing one `Decimal` from one place avoids that class entirely.
- `@nestjs/config`, `@nestjs/schedule`, `@nestjs/swagger`, `@nestjs/event-emitter`, `@nestjs/throttler`, `class-validator`, `class-transformer`
- Auth: `@nestjs/jwt`, **`bcryptjs`** (pure JS — no native build step), `@nestjs/passport` + `passport-jwt`
- Tests: Jest (unit) + Supertest (e2e against a test DB)
- Lint: ESLint + Prettier (Nest defaults)

### Toolchain gotchas hit while scaffolding (2026-09-12) — read this before touching versions

- **`@nestjs/jwt` and `@nestjs/passport` must stay pinned to `11.0.0` / `11.0.5`.** Their `12.x` releases are ESM-only (no `require` export condition at all — confirmed via `npm view <pkg> exports`), so anything newer breaks Jest instantly with "Must use import to load ES Module". This is a companion-package trap independent of core `@nestjs/core` staying on 11 — check `npm view <pkg>@<version> exports --json` for a `require` key before bumping *any* Nest companion package.
- **Prisma 7's generator needs an in-`src` output path**, not the `prisma init` default (`../generated/prisma`, outside `src/`) — NestJS's compiler can't see it there. Ours is `prisma/schema.prisma`'s `generator client { output = "../src/generated/prisma" }`.
- **Prisma 7 removed `datasource.url` from `schema.prisma` entirely.** The connection string now lives in `prisma7.config.ts` (for CLI commands) and is passed to `PrismaClient` at runtime via a driver adapter — we use `@prisma/adapter-pg` + `pg`. `PrismaService` constructs `new PrismaPg({ connectionString })` and passes it as `{ adapter }` to `super()`.
- **Prisma 7's default query engine is WASM-based and uses dynamic `import()`,** which crashes under plain Jest ("A dynamic import callback was invoked without --experimental-vm-modules"). Every Jest invocation needs `NODE_OPTIONS=--experimental-vm-modules` — already wired into all `test*` npm scripts via `cross-env`, don't strip it out.
- **`@stellar/stellar-sdk@16.3.0`'s own CJS build transitively pulls in ESM-only packages** (`@noble/hashes@2.x`, `@noble/ed25519`, `uint8array-extras` — each has no `require` export condition at all, confirmed via `npm view <pkg> exports --json`). This only breaks Jest — the real app runs fine (Nest's own compiler handles it, as proven by the live `changeTrust` bootstrap tx in Step 6). Both `package.json`'s `jest` block and `test/jest-e2e.json` carry `"transformIgnorePatterns": ["node_modules/(?!(@stellar/stellar-sdk|@noble|uint8array-extras)/)"]` so ts-jest transforms those three instead of skipping them. If a future SDK bump introduces a new transitive ESM-only dep, the error message names the exact file — add its package name to this pattern.
- **The e2e suite boots the real `PaymentListenerService`, which opens a live Horizon SSE connection** (Step 7) — every e2e run genuinely reaches testnet. Its socket doesn't always release before Jest's own process-exit check fires ("A worker process has failed to exit gracefully"), a known friction point for any long-lived HTTP/SSE client under Jest. Harmless — tests still pass — but `test:e2e` carries `--forceExit` so CI doesn't hang on it. If this ever needs true isolation from the network, override `PaymentListenerService` with a no-op in a dedicated e2e test module rather than fighting the SSE client's teardown.
- **The generated Prisma client's relative imports use explicit `.js` extensions** (ESM convention) even though the files are `.ts` — ts-jest's CommonJS resolution can't follow those. Both `package.json`'s `jest` block and `test/jest-e2e.json` carry `"moduleNameMapper": { "^(\\.{1,2}/.*)\\.js$": "$1" }` to strip the extension at resolve time; don't remove it.
- **`prisma init` on this Prisma version also drops unrelated AI-agent-skill scaffolding** (`.claude/skills/`, `.windsurf/skills/`, `.agents/skills/`, `skills-lock.json`) into the project root. Deleted — not part of this project.

## Module map

```
src/
  main.ts                 (global ValidationPipe, CORS for both web origins, Swagger at /docs, prefix /api)
  app.module.ts
  config/                 env schema (zod or joi) — fail fast on missing vars
  prisma/                 PrismaService
  auth/                   register/login/JWT strategy/guard, current-merchant decorator
  merchants/              /me endpoints
  links/                  create/list/get/cancel, code generator, quote on create
  fx/                     FxService: 'mock' fixed rate | 'live' (free public API), 5-min cache
  stellar/                StellarService: Horizon + RPC clients, platform account, asset consts,
                          PaymentListener (Horizon payments stream → detects link payments)
  payments/               record detected payment, mark link paid, emit event
  settlements/            on payment.detected → create settlement → AnchorService → credit balance
  anchor/                 AnchorService interface + MockAnchorAdapter + Sep24AnchorAdapter (skeleton)
  balance/                availableTRY/pendingTRY/savedUSDC computed from settlements & withdrawals
  withdrawals/            request → (mock: complete in 5s) → debit balance
  pay/                    public payer endpoints
  health/                 /health, /fx
  common/                 ApiError filter, decimal helpers, pagination dto
```

Use Nest's `EventEmitter2` (`@nestjs/event-emitter`) for `payment.detected` → settlements. Keep listener and settlement decoupled.

## Environment (`.env.example`)

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://liralink:liralink@localhost:5432/liralink   # bump the port (e.g. 5433) if something else on your machine already holds 5432
JWT_SECRET=change-me
CORS_ORIGINS=http://localhost:5173,http://localhost:5174
PAY_WEB_BASE_URL=http://localhost:5174/p

STELLAR_NETWORK=testnet
HORIZON_URL=https://horizon-testnet.stellar.org
RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
PLATFORM_ACCOUNT_SECRET=S...          # collection account; create with `stellar keys generate platform --network testnet --fund`
USDC_CODE=USDC
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5

FX_PROVIDER=mock                      # mock | live
FX_MOCK_RATE_TRY_PER_USDC=34.00
FX_LIVE_URL=                          # optional public rate endpoint

ANCHOR_PROVIDER=mock                  # mock | sep24
ANCHOR_HOME_DOMAIN=                   # e.g. testanchor.stellar.org (sep24 mode)
ANCHOR_MOCK_DELAY_MS=3000

LINK_DEFAULT_EXPIRY_HOURS=24
QUOTE_TTL_MINUTES=10
```

## Prisma schema (essentials)

Tables: `Merchant`, `PaymentLink` (unique `code`), `Payment` (unique `txHash`), `Settlement`, `Withdrawal`, `ProcessedOperation` (unique Horizon operation id — idempotency for the listener), **`ListenerCursor`** (single row, persists the Horizon paging token so a restart resumes instead of replaying or skipping), **`PaymentAttempt`** (opId, linkCode?, txHash, from, amountUSDC, assetCode, reason, createdAt — records underpaid/unmatched inbound operations that never became a `Payment`; the original brief required "storing the attempt" without naming a table for it). Money columns as `Decimal(20,7)`. Index `PaymentLink(code)`, `PaymentLink(merchantId, createdAt)`.

---

## Phase 1 — Foundation + link creation + payment detection (Sat–Sun)

### 1.1 Scaffold
`nest new backend --strict`, add deps, Prisma init, Docker compose with Postgres, Swagger on `/docs`, global prefix `/api`, global `ValidationPipe({ whitelist: true, transform: true })`, exception filter that returns `ApiError` shape.

### 1.2 Auth + merchants
Register/login with bcryptjs (cost 10) and JWT (7 d). `@CurrentMerchant()` decorator. `GET/PATCH /me` with validation: `autoSavePercent` 0–50, `iban` matches `^TR\d{24}$`.

### 1.3 Platform account bootstrap
On startup `StellarService` loads keypair from `PLATFORM_ACCOUNT_SECRET`, checks the account exists on Horizon and has a **USDC trustline**; if the trustline is missing, submit a `changeTrust` op once and log it. Log platform public key at startup banner. Expose in `/health`.

### 1.4 FX + quote
`FxService.getRate(): { rate: Decimal, source, fetchedAt }`. Mock returns env rate. `quote(amountTRY) = amountTRY / rate`, rounded **up** to 7 dp (payer never underpays). Quote valid `QUOTE_TTL_MINUTES`.

### 1.5 Links
- Code generator: 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), retry on collision.
- `POST /links`: validate `amountTRY` decimal string ≥ 1.00, ≤ 1,000,000; create with quote; `payUrl = PAY_WEB_BASE_URL + '/' + code`.
- Cron every minute: `open` links past `expiresAt` → `expired`.
- `GET /pay/:code`: if `open` and quote expired → re-quote and persist. Return `PayQuote` including `destination` (platform pubkey), `memo = code`, asset consts.

### 1.6 PaymentListener (the heart)
- On module init, open Horizon stream: `server.payments().forAccount(platform).join('transactions').cursor(lastCursor ?? 'now').stream({ onmessage, onerror })`. **`.join('transactions')` embeds the full transaction (including memo) in every streamed record at zero extra HTTP cost** — confirmed live against Horizon testnet SSE; do not call `op.transaction()` separately, it's redundant once joined. Persist the paging token after each processed message (table `ListenerCursor`) so restarts don't skip payments; the SDK's cursor advance is in-memory only.
- Accept **`payment`, `path_payment_strict_receive`, and `path_payment_strict_send`** operation types — a payer swapping XLM→USDC in one tx produces a path payment that still credits USDC to `to`; filtering on `type === 'payment'` alone silently drops that money.
- For each op: read the joined transaction's `memo_type === 'text'` and **`memo_bytes`** (base64) — compare `memo_bytes` against the base64 of the expected code, not the lossy UTF-8 `memo` field. Match: `to === platform`, `asset_type === 'credit_alphanum4'` **and** `asset_code === USDC` **and** `asset_issuer === USDC_ISSUER` (all three — code alone isn't enough, anyone can issue an asset called `USDC`), memo equals an `open` link code.
- Validate `amount >= link.quotedUSDC` (allow overpay; log underpay as `payment.underpaid` and **do not** mark paid — leave link open, store the attempt).
- Idempotency: insert `ProcessedOperation(opId)` first, in the same DB transaction as the state change and the cursor update; skip if the unique constraint rejects it (reconnects **will** replay operations you've already seen).
- On match: create `Payment`, set link `paid`, emit `payment.detected`.
- `POST /pay/:code/submitted { txHash }`: fetch tx from Horizon immediately and run the same matcher (covers stream lag). 202 always.
- Reconnect with your own exponential backoff on stream error — **the SDK does not back off**; its only auto-reconnect is a 15s-default watchdog timer that fires on silence, not on error. `/health.listener` reflects state.
- Run a periodic (e.g. every 2 min) REST reconciliation poll over the same cursor range through the same matcher, since SSE can stall silently without erroring.
- Out of scope for Phase 1 (document, don't build): claimable-balance deposits to the platform account don't appear on `/payments` at all and need a separate watcher if ever supported.

### 1.7 Verification (manual)
1. `npm run start:dev`, open `/docs`.
2. Register, create a link for 340.00 TRY → expect ~10 USDC quote at mock rate.
3. Fund a payer account with testnet USDC (faucet.circle.com → Stellar testnet, or mint via Circle faucet to the payer's address after adding a trustline). Send `10 USDC` to the platform address with **text memo = link code** using Stellar Lab.
4. Within ~5 s the link is `paid`; `GET /pay/:code/status` shows the payment with explorer URL.
5. Send a second payment with the same memo → ignored (link not open), logged.

### 1.8 Tests
Unit: code generator, quote rounding, matcher (`match(op, tx, link)` pure function with fixtures for wrong asset, wrong memo, underpay, overpay). E2e: auth + links happy path against test DB.

---

## Phase 2 — Settlement, balance, withdrawals, deploy (Mon–Wed)

### 2.1 AnchorService
```ts
interface AnchorAdapter {
  name: 'mock' | 'sep24';
  settleToTRY(input: { settlementId, amountUSDC: Decimal, merchant: Merchant }): Promise<{ ref: string }>;
  payoutTRY(input: { withdrawalId, amountTRY: Decimal, iban: string }): Promise<{ ref: string }>;
  getStatus(ref: string): Promise<SettleStatus>;
}
```
- **MockAnchorAdapter**: resolves after `ANCHOR_MOCK_DELAY_MS`, always `completed`. Deterministic refs `mock-...`.
- **Sep24AnchorAdapter** (skeleton, real wiring on Day 1 after Workshop #3): fetch `https://{ANCHOR_HOME_DOMAIN}/.well-known/stellar.toml`, read `TRANSFER_SERVER_SEP0024`, SEP-10 auth with platform key, `POST /transactions/withdraw/interactive` for USDC, then send USDC to the anchor's returned address with the returned memo, poll `GET /transaction?id=`. Implement against `testanchor.stellar.org` so the code path is exercised even before a TRY anchor is known. Document every step in `docs/anchor.md`.

### 2.2 Settlements
Listener → `payment.detected` → `SettlementsService.createFromPayment`: `amountTRY = amountUSDC * fxRate(at detection)`; `savedUSDC = amountUSDC * autoSavePercent/100` (kept in USDC; DeFindex deposit is a stretch — for now just ledger it); settle the remainder via adapter. Status `pending → processing → completed`. Balance: `availableTRY = Σ completed settlements − Σ non-failed withdrawals`, `pendingTRY = Σ pending/processing`.

### 2.3 Withdrawals
`POST /withdrawals`: require `iban` (body or merchant profile), `amountTRY ≤ availableTRY` else 422. Mock adapter completes after delay. List endpoint.

### 2.4 Payments list for the merchant panel
`GET /payments` joined with link summary and settlement.

### 2.5 Deploy
- Dockerfile (multi-stage), `docker-compose.yml` with Postgres for EC2.
- GitHub Action: lint/typecheck/test on PR; on `main` build image (optional push).
- EC2: run under Docker, nginx reverse proxy with TLS (certbot) on `api.<domain>`; CORS for the two web apps' domains. `/health` must be green from the internet.
- Seed script: one demo merchant (`demo@liralink.app / demo1234`), 3 links (one paid with a real testnet tx), realistic Mersin-exporter data.

### 2.6 Verification
Full loop from a fresh DB: register → link → pay from Stellar Lab → `/balance.availableTRY` grows after mock delay → withdrawal reduces it. Both frontends connected with `VITE_USE_MOCK=false`.

---

## Phase 3 — Stretch (only when Phases 1–2 are green)

1. **x402** (Day 1 after Workshop #1): protect `GET /pay/:code/agent` — respond `402` with Stellar payment requirements (amount in USDC, destination, memo); accept retry with payment proof header; verify on Horizon using the same matcher. Follow `skills/agentic-payments/SKILL.md` from skills.stellar.org and the x402 quickstart. Add a `scripts/agent-pay.ts` demo client.
2. **Soroban invoice contract** (`contracts/invoice`, Rust): see `00-PROJECT.md` §7. Start from `soroban-examples/single_offer`. Deploy to testnet, generate TS bindings, add `POST /links/:id/onchain` that creates the invoice on-chain and returns the contract id; payer page gets an optional "Pay via contract" button.
3. **DeFindex auto-save**: deposit `savedUSDC` into a DeFindex USDC vault on testnet via their SDK; expose `savedUSDC` with vault position. Use the official DeFindex SDK skill file.
4. **Soroswap**: if payer's wallet has no USDC, quote a swap route; only if trivially available via their API.

Record every skill file path used (e.g. `skills/anchors/SKILL.md`) in `docs/skills-used.md` — the submission requires it.

## Definition of done (backend)

- `/health` green on EC2 from the internet, listener `running`.
- A real testnet USDC payment with memo flips a link to `paid` in < 10 s and credits TRY.
- Swagger accurate; `docs/api.types.ts` exported for the frontends.
- Seed data loads with one command.
- README: run locally in 5 commands; architecture diagram; custody/regulatory note; roadmap (per-merchant smart accounts, real TRY anchor, x402, DeFindex).
