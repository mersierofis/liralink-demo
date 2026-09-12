# LiraLink — Shared Project Context

> **Every AI agent (Claude Code, Cursor, Codex) working on this repo must read this file first.**
> It is the single source of truth for the product, architecture, data model and API contract.
> Each team member then follows their own file: `01-BACKEND.md` (Hasan), `02-PAY-WEB.md` (Yunus), `03-MERCHANT-WEB.md` (Vuslat).
> If anything in your own file conflicts with this one, this one wins. If the API needs to change, change it **here first**, then tell the team.

Working name: **LiraLink** (can be renamed later; keep the slug `liralink` in code).
Team: **MersiErOfis** — Hasan (backend + integrations), Vuslat (merchant web), Yunus (payer web).
Event: Rise In x Stellar Pro Hackathon, Istanbul, 19–20 Sept 2026. Genesis Track. Submission deadline: Day 2, 12:00.

---

## 1. Product in one paragraph

A Turkish merchant or exporter creates a **payment link** for an amount in Turkish lira. A customer **abroad** opens the link on their phone and pays with **USDC on Stellar** from their own wallet. LiraLink detects the on-chain payment within seconds, converts it to lira through a **licensed Stellar anchor**, and the merchant sees a **TRY balance** they can withdraw to their IBAN. The merchant never touches crypto: they sell in lira and receive lira. The payer is outside Turkey, so Turkish rules restricting crypto as a domestic payment instrument do not apply to this flow.

**Why Stellar:** cross-border settlement in ~5 seconds for ~$0.00001, native USDC, and anchors that turn on-chain balances into local fiat. Bank wires take 3–5 days and cost 2–4%.

**Target users (be specific in demos):** citrus/agri exporters in Mersin selling to buyers in the Gulf, Iraq, Russia and the EU; boutique hotels and Airbnb hosts with foreign guests; Turkish freelancers invoicing foreign clients.

## 2. Hackathon requirements this product satisfies

| Requirement | How |
|---|---|
| Integration with an eligible Stellar protocol | **Stellar Wallets Kit** (payer wallet connect), **Soroswap** (stretch: pay with any asset → USDC) |
| Anchor / local payments (real TRY rail) | USDC → TRY via anchor (SEP-24 withdraw). Adapter pattern: `mock` for dev/demo, real TRY anchor wired after Workshop #3 on Day 1 |
| Core feature is load-bearing | The whole product *is* the payment + settlement flow |
| Soroban SDK + contract on testnet | **Phase 2** in backend: `invoice` Soroban contract (see §7) — **required deliverable**. The memo rail remains the fallback demo path |
| Stretch: agentic payments | Same link payable by an AI agent via **x402** (Workshop #1) |

Judges track: shipped core integration, shipped anchor integration, real traction, real users onboarded. **Bring at least one real merchant from Mersin as a named pilot user.**

## 3. Roles and demo script

- **Merchant** (desktop, Vuslat's app): signs in → creates link "Lemon order #1042, 5,000 TRY" → shares URL → sees "Paid · 5,000 TRY credited" → withdraws to IBAN.
- **Payer** (phone, Yunus's app): opens link → sees 5,000 TRY ≈ 147.06 USDC → connects wallet → pays → sees receipt with explorer link.
- **AI agent** (stretch, terminal): `curl` the same link → `402 Payment Required` → agent pays → `200`.

Demo = two devices, one flow, real testnet transaction, ~30 seconds.

## 4. Architecture

```
merchant-web (React, Vuslat)  ──┐
                                ├──REST──▶  backend (NestJS, Hasan) ──▶ Stellar Horizon + RPC (testnet)
pay-web (React PWA, Yunus)    ──┘                 │                  ──▶ Anchor (SEP-24) [mock | real]
                                                  │                  ──▶ FX rate provider
                                                  └──▶ PostgreSQL
```

- **Payment rail (core):** classic Stellar **USDC payment with a text memo = link code** to the platform's collection account. Simple, wallet-friendly, detectable via Horizon payment stream. No contract needed for the core flow.
- **Settlement:** backend credits merchant TRY balance when payment is detected; `AnchorService` executes USDC→TRY. In `mock` mode settlement completes instantly (for demo reliability). In `sep24` mode it drives a real anchor.
- **Custody model (hackathon):** one platform collection account holds USDC; merchant balances are ledger rows in Postgres. Document this as a hackathon simplification; roadmap = non-custodial per-link SEP-24 withdrawal (funds go straight to the anchor) + per-merchant smart accounts.
- **Exact-amount policy** (implemented): `amountTRY` and `quotedUSDC` are locked at link creation. Settlement always credits `link.amountTRY`, never `receivedUSDC × fxRate`. `received == quotedUSDC` → `paid`; `received < quotedUSDC` → `underpaid` (link stays open for a top-up payment; `receivedUSDC`/`shortfallUSDC` track progress); `received > quotedUSDC` → `paid`, with the excess credited to `merchant.unallocatedUSDC` (visible in the panel, never auto-converted to TRY).

**Monorepo layout (single GitHub repo under `mdg-yazilim/liralink`):**
```
liralink/
  docs/            ← these four files + architecture diagram + pitch notes
  backend/         ← NestJS (Hasan)
  merchant-web/    ← React + Vite (Vuslat)
  pay-web/         ← React + Vite PWA (Yunus)
  contracts/       ← Soroban invoice contract (Hasan, phase 2 — required)
  docker-compose.yml
```
Each app has its own `package.json`. No shared workspace tooling needed; a copy of `docs/api.types.ts` (generated from backend DTOs) is committed for the two frontends.

**Networks/constants (testnet):**
- Horizon: `https://horizon-testnet.stellar.org`
- RPC: `https://soroban-testnet.stellar.org`
- Network passphrase: `Test SDF Network ; September 2015`
- USDC (Circle testnet): code `USDC`, issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` — confirmed on Horizon testnet (`home_domain: centre.io`, 65,117 authorized trustlines, checked 2026-09-12). Get testnet USDC for a payer account via faucet.circle.com.
- Explorer URL patterns: `https://stellar.expert/explorer/testnet/tx/{hash}`, `https://stellar.expert/explorer/testnet/account/{address}`

## 5. Domain model

```ts
type LinkStatus   = 'open' | 'underpaid' | 'paid' | 'expired' | 'cancelled';
type PayRail      = 'contract' | 'memo';       // 'contract' reserved for the Soroban invoice rail (phase 2, not yet built)
type SettleStatus = 'pending' | 'processing' | 'completed' | 'failed';
type WdStatus     = 'requested' | 'processing' | 'completed' | 'failed';

interface Merchant {
  id: string; email: string; businessName: string;
  iban?: string;                 // for withdrawals
  autoSavePercent: number;       // 0–50, default 0 (DeFindex stretch)
  unallocatedUSDC: string;       // decimal string, 7 dp — excess from overpaid links, awaiting manual handling
  createdAt: string;
}

interface PaymentLink {
  id: string;                    // uuid
  code: string;                  // 8-char, URL-safe, unique, uppercase e.g. "K7Q2M9XA" — also used as tx memo
  merchantId: string;
  merchantName: string;          // denormalized for the payer page
  title: string;                 // "Lemon order #1042"
  description?: string;
  amountTRY: string;             // decimal string, 2 dp, e.g. "5000.00" — locked at creation
  quotedUSDC: string;            // decimal string, 7 dp, quote at creation — locked, never recomputed from what's received
  fxRate: string;                // TRY per 1 USDC at quote time
  quoteExpiresAt: string;        // quotes valid 10 min; payer page re-quotes
  status: LinkStatus;
  expiresAt: string;             // default +24h
  payUrl: string;                // "https://pay.liralink.app/p/K7Q2M9XA" (env-based)
  receivedUSDC: string;          // decimal string, 7 dp — cumulative USDC matched so far ("0" until first payment)
  shortfallUSDC?: string;        // decimal string, 7 dp — set only while status is 'underpaid'
  payment?: Payment;             // present when paid — the completing transaction
  createdAt: string;
}

interface Payment {
  id: string; linkId: string;
  rail: PayRail;                 // 'memo' today — the only rail implemented
  txHash: string; payerAddress: string;
  amountUSDC: string; ledger: number;
  explorerUrl: string;
  detectedAt: string;
}

interface Settlement {
  id: string; merchantId: string; paymentId: string;
  amountUSDC: string; amountTRY: string; fxRate: string;
  savedUSDC: string;             // autoSave portion kept in USDC (stretch), "0"
  provider: 'mock' | 'sep24';
  status: SettleStatus; anchorRef?: string;
  createdAt: string; completedAt?: string;
}

interface Withdrawal {
  id: string; merchantId: string; amountTRY: string; iban: string;
  status: WdStatus; anchorRef?: string; createdAt: string; completedAt?: string;
}

interface Balance {
  availableTRY: string; pendingTRY: string; savedUSDC: string; unallocatedUSDC: string;
}

interface PayQuote {                 // what the payer page renders
  code: string; merchantName: string; title: string; description?: string;
  amountTRY: string; amountUSDC: string; fxRate: string; quoteExpiresAt: string;
  status: LinkStatus; expiresAt: string;
  receivedUSDC: string; shortfallUSDC?: string;
  rails: {
    contract?: { contractId: string; invoiceCode: string };  // absent until the Soroban invoice contract exists
    memo?:     { destination: string; memo: string };        // the only rail today
  };
  asset: { code: 'USDC'; issuer: string };
  network: 'testnet';
  payment?: Payment;                 // when paid
}

interface ApiError { statusCode: number; message: string; error?: string }
```

## 6. API contract (v1) — base path `/api`

All bodies JSON. Timestamps ISO-8601 UTC. Money as decimal strings. Auth = `Authorization: Bearer <jwt>` (merchant endpoints only). Payer endpoints are public.

### Auth (merchant)
| Method | Path | Body → Response |
|---|---|---|
| POST | `/auth/register` | `{ email, password, businessName }` → `201 { token, merchant }` |
| POST | `/auth/login` | `{ email, password }` → `200 { token, merchant }` |
| GET | `/me` | → `Merchant` |
| PATCH | `/me` | `{ businessName?, iban?, autoSavePercent? }` → `Merchant` |

### Payment links (merchant)
| Method | Path | Body → Response |
|---|---|---|
| POST | `/links` | `{ title, description?, amountTRY, expiresInHours? }` → `201 PaymentLink` |
| GET | `/links?status=&page=&limit=` | → `{ items: PaymentLink[], total }` (newest first) |
| GET | `/links/:id` | → `PaymentLink` |
| POST | `/links/:id/cancel` | → `PaymentLink` (only if `open`) |

### Money (merchant)
| Method | Path | Response |
|---|---|---|
| GET | `/balance` | `Balance` (includes `unallocatedUSDC`) |
| GET | `/payments?page=&limit=` | `{ items: (Payment & { link: Pick<PaymentLink,'code'|'title'|'amountTRY'>, settlement: Settlement })[], total }` |
| GET | `/settlements?page=&limit=` | `{ items: Settlement[], total }` |
| POST | `/withdrawals` | `{ amountTRY, iban? }` → `201 Withdrawal` (400 if > availableTRY) |
| GET | `/withdrawals` | `{ items: Withdrawal[], total }` |

### Payer (public, no auth)
| Method | Path | Response |
|---|---|---|
| GET | `/pay/:code` | `PayQuote` (re-quotes if quote expired and status is `open`) |
| POST | `/pay/:code/submitted` | `{ txHash }` → `202 { accepted: true }` — hint so backend checks this tx immediately; detection also works without it |
| GET | `/pay/:code/status` | `{ status: LinkStatus, receivedUSDC, shortfallUSDC?, payment?: Payment }` — poll every 2 s |

### System
| Method | Path | Response |
|---|---|---|
| GET | `/health` | `{ ok: true, horizon: 'up'|'down', anchor: 'mock'|'sep24', listener: 'running'|'stopped', platformAccount: 'G...' }` |
| GET | `/fx` | `{ pair: 'USDC/TRY', rate: '34.00', source: 'mock'|'live', fetchedAt }` |

### Status codes
`200/201/202` success · `400` validation · `401` no/invalid token · `404` unknown link/code · `409` invalid state transition (e.g. cancel a paid link) · `422` business rule (insufficient balance).

## 7. Soroban invoice contract (phase 2, Hasan — required; frontends get an optional second pay button)

`contracts/invoice` — records invoices on-chain so a payer can pay *through* the contract using the USDC Stellar Asset Contract. Functions: `create(merchant: Address, code: Symbol, amount: i128, deadline: u32)`, `pay(code: Symbol, payer: Address)` (calls `token.transfer(payer → merchant)` with `payer.require_auth()`), `get(code) -> Invoice`, `cancel(code)` (merchant auth). This is a **required phase-2 deliverable**. The payer page gets a second "Pay via contract" button; the classic memo rail stays as the fallback so the live demo never depends on the contract.

## 8. Conventions (all apps)

### Pinned toolchain (binding on all three apps — corrected 2026-09-12)

| | Pinned | Was (stale/wrong in original spec) |
|---|---|---|
| Node | **22.23.2** (`.nvmrc` at repo root) | 20 |
| `@stellar/stellar-sdk` | **`16.3.0`** (the `lts-16` tag, actively maintained) — backend and pay-web MUST use the same major (backend's listener parses what pay-web builds). Deliberately not 17.x: that major rewrites Buffer→Uint8Array and the XDR namespace across every public API — real porting cost, no benefit for a Horizon-only listener. | 13.x (that tag is actually a `protocol-22-beta` prerelease) |

Backend-only pins (`merchant-web` and `pay-web` unaffected): NestJS **11.2.3** (was 10 — NOT the just-released 12, which swaps Jest→Vitest/ESLint→oxlint/Webpack→Rspack by default, contradicting this doc's own "Jest + Supertest" requirement below), Prisma **pinned to `7.10.0`** exactly — never install `prisma`/`@prisma/client` unpinned, `npm i prisma` currently resolves to an `8.0.0-rc` release candidate — `bcryptjs` instead of `bcrypt` (pure JS, no native build step, avoids `node-gyp` failures on newer Node majors).

- TypeScript strict. English for UI strings, code, comments, commit messages.
- Money never as `number` in transport; parse with `decimal.js`/`big.js` when doing arithmetic (backend uses the `Decimal` re-exported from `@prisma/client` instead — see `01-BACKEND.md`).
- Env files: `.env.example` committed, `.env` git-ignored.
- Small PRs into `main`; another teammate reviews. CI: `npm run lint && npm run typecheck && npm test` per app (GitHub Actions, one workflow per app, path-filtered).
- Every screen has loading, empty and error states.
- Log every Stellar tx hash you create or detect at INFO level.

## 9. Timeline

| When | Backend (Hasan) | Merchant web (Vuslat) | Pay web (Yunus) |
|---|---|---|---|
| Sat 13 – Sun 14 | Phase 1: auth, links, quote, Horizon listener, mock anchor | Scaffold + mock + Auth/Links screens | Scaffold + Wallets Kit connect working with Freighter on testnet |
| Mon 15 – Wed 17 | Phase 2: settlement, balance, withdrawals, SEP-24 adapter skeleton, **Soroban invoice contract on testnet**, deploy to EC2 | Balance/Payments/Withdrawals screens; connect to real API | Full pay flow against real API; real USDC payment on testnet |
| Thu 18 | Freeze features. Dry-run demo twice. Pitch deck (Vuslat) | | |
| Day 1 (Fri 19) | Workshops → wire real TRY anchor; x402 stretch | Polish; pilot merchant data | Polish; phone demo rehearsal |
| Day 2 (Sat 20) | Submit by 12:00; contract already landed in phase 2 — final QA only | | |
