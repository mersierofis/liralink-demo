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
type PayRail      = 'contract' | 'memo' | 'x402'; // 'contract' = Soroban invoice rail · 'x402' = agent paid GET /pay/:code/agent (testnet, x402.org facilitator)
type SettleStatus = 'pending' | 'processing' | 'completed' | 'failed';
type WdStatus     = 'requested' | 'processing' | 'completed' | 'failed';
type UsdcWdStatus = 'submitted' | 'completed' | 'failed'; // POST /usdc-withdrawals — 'submitted' until the payment is on the ledger
type SettlementMode = 'balance' | 'auto_payout'; // balance: TRY accrues, merchant withdraws (mock anchor) · auto_payout: the anchor pays the IBAN at settlement (sep24)
type SettleFailReason = 'unexpected_fee_asset' | 'invalid_fee' | 'anchor_status' | 'amount_mismatch'; // why a settlement is 'failed' — terminal, never retried

interface Merchant {
  id: string; email: string; businessName: string;
  iban?: string;                 // for withdrawals
  autoSavePercent: number;       // 0–50, default 0 (DeFindex stretch)
  unallocatedUSDC: string;       // decimal string, 7 dp — overpaid excess + stray payments, minus non-failed USDC withdrawals from it
  settlementMode: SettlementMode; // from the backend's ANCHOR_PROVIDER — Withdraw button vs "Paid to IBAN"
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
  quoteExpiresAt: string;        // on-chain links: === expiresAt (quote locked, never re-quoted); otherwise valid 10 min and /pay re-quotes
  status: LinkStatus;
  expiresAt: string;             // default +24h
  payUrl: string;                // "https://pay.liralink.app/p/K7Q2M9XA" (env-based)
  receivedUSDC: string;          // decimal string, 7 dp — cumulative USDC matched so far ("0" until first payment)
  shortfallUSDC?: string;        // decimal string, 7 dp — set only while status is 'underpaid'
  payment?: Payment;             // most recent transfer (the completing one once paid) — alias for payments.at(-1)
  payments: Payment[];           // every successful transfer that credited this link (installments + completion), oldest→newest
  onchain: { contractId: string; invoiceCode: string; deadlineLedger: number; txHash?: string } | null; // Soroban invoice (§7); null if creation's best-effort call failed
  createdAt: string;
}

interface Payment {
  id: string; linkId: string;
  rail: PayRail;                 // 'memo' = classic text-memo payment; 'contract' = paid through the invoice contract
  txHash: string; payerAddress: string;
  amountUSDC: string; ledger: number;
  explorerUrl: string;
  detectedAt: string;
}

interface Settlement {
  id: string; merchantId: string; paymentId: string;
  amountUSDC: string; amountTRY: string; fxRate: string;
  savedUSDC: string;             // autoSave portion kept in USDC (stretch), "0"
  feeUSDC: string | null;        // anchor fee kept from amountUSDC, 7 dp — null until completed (mock: "0.0000000")
  netTRY: string | null;         // TRY credited (balance) or paid to the IBAN (auto_payout), 2 dp — null until completed
  provider: 'mock' | 'sep24';
  status: SettleStatus; anchorRef?: string;
  failReason: SettleFailReason | null; // set only when status is 'failed' (see docs/anchor.md)
  interactiveUrl: string | null; // sep24: the anchor's KYC page while it waits for the merchant ("Complete verification"); null otherwise
  createdAt: string; completedAt?: string;
}

interface Withdrawal {
  id: string; merchantId: string; amountTRY: string; iban: string;
  status: WdStatus; anchorRef?: string; createdAt: string; completedAt?: string;
}

interface UsdcWithdrawal {             // USDC sent from the platform account to the merchant's own Stellar wallet
  id: string; merchantId: string;
  amountUSDC: string;            // 7 dp
  destination: string;           // G… — existed and trusted USDC when requested
  source: 'saved' | 'unallocated'; // the balance that paid for it — debited when the request is accepted
  status: UsdcWdStatus;
  txHash: string; explorerUrl: string; // signed before it is submitted, so present from the first response
  failReason: 'failed_on_ledger' | 'expired_unsubmitted' | null; // set only when 'failed'; the amount went back to `source`
  createdAt: string; completedAt?: string;
}

interface Balance {
  availableTRY: string; pendingTRY: string; savedUSDC: string; unallocatedUSDC: string;
  paidOutTRY: string;            // 2 dp — Σ netTRY of completed auto_payout settlements, already on the merchant's IBAN
}

interface PayQuote {                 // what the payer page renders
  code: string; merchantName: string; title: string; description?: string;
  amountTRY: string; amountUSDC: string; fxRate: string; quoteExpiresAt: string;
  status: LinkStatus; expiresAt: string;
  receivedUSDC: string; shortfallUSDC?: string;
  rails: {
    contract?: { contractId: string; invoiceCode: string };  // present while the link is on-chain (PaymentLink.onchain)
    memo?:     { destination: string; memo: string };        // always present
  };
  asset: { code: 'USDC'; issuer: string };
  network: 'testnet';
  payment?: Payment;                 // most recent transfer (completing one once paid) — alias for payments.at(-1)
  payments: Payment[];               // all transfers that credited this link, oldest→newest
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
| GET | `/me` | → `Merchant` (incl. `settlementMode`) |
| PATCH | `/me` | `{ businessName?, iban?, autoSavePercent?, currentPassword?, newPassword? }` → `Merchant` — change the password by sending both (`newPassword` ≥ 8 chars); `400` if only one is sent, `403` if `currentPassword` is wrong |

### Payment links (merchant)
| Method | Path | Body → Response |
|---|---|---|
| POST | `/links` | `{ title, description?, amountTRY, expiresInHours? }` → `201 PaymentLink` — also creates the Soroban invoice (§7) best-effort, locking `quotedUSDC` until `expiresAt`; if RPC fails the link is still `201` with `onchain: null` |
| GET | `/links?status=&page=&limit=` | → `{ items: PaymentLink[], total }` (newest first) |
| GET | `/links/:id` | → `PaymentLink` |
| POST | `/links/:id/cancel` | → `PaymentLink` (only if `open`; also cancels the on-chain invoice, best-effort) |
| POST | `/links/:id/onchain` | → `PaymentLink` with `onchain` set — manual retry when creation's best-effort invoice failed (`onchain: null`). Uses the link's existing `quotedUSDC` (no re-quote) and locks it until `expiresAt`. Only if `open` with nothing received (`409` otherwise); a link already on-chain is returned unchanged; `503` if no contract is configured |

### Money (merchant)
| Method | Path | Response |
|---|---|---|
| GET | `/balance` | `Balance` (includes `unallocatedUSDC`) |
| GET | `/payments?page=&limit=` | `{ items: (Payment & { link: Pick<PaymentLink,'code'|'title'|'amountTRY'|'status'|'quotedUSDC'|'receivedUSDC'>, settlement: Settlement \| null })[], total }` (newest first; `settlement` is `null` for installments that didn't complete the link; `link.status`/`receivedUSDC` are the link's current values, so a partial payment shows as `underpaid` with `receivedUSDC` < `quotedUSDC`) |
| GET | `/settlements?page=&limit=` | `{ items: Settlement[], total }` (newest first) — one per paid link, created on detection, `pending → processing → completed` via the anchor |
| POST | `/withdrawals` | `{ amountTRY, iban? }` → `201 Withdrawal` (`status: 'requested'`, amount reserved immediately). `422` if > `availableTRY`; `400` if `amountTRY` ≤ 0 or no `iban` in body or profile; `409` `"Payouts are automatic in this mode"` when `settlementMode` is `auto_payout` |
| GET | `/withdrawals?page=&limit=` | `{ items: Withdrawal[], total }` (newest first) |
| POST | `/usdc-withdrawals` | `{ amountUSDC, destination, source: 'saved' \| 'unallocated' }` → `201 UsdcWithdrawal` — sends USDC from the platform account to the merchant's own `destination` and debits `savedUSDC` / `unallocatedUSDC` in the same DB transaction. The payment is signed and stored before it is submitted, so every retry resubmits that same transaction (it can never be sent twice). Normally returns `status: 'completed'` (~5 s); `'submitted'` if Horizon didn't confirm in time — the backend retries every minute until it lands (`completed`) or can no longer land (`failed`, amount returned to `source`). `400` if `amountUSDC` isn't 7 dp or ≤ 0, `destination` isn't a valid G… address, or `source` is unknown; `422` (plain `message`) if `amountUSDC` > the `source` balance, or `destination` doesn't exist, has no USDC trustline, has too little trustline limit left, or is the platform account |
| GET | `/usdc-withdrawals?page=&limit=` | `{ items: UsdcWithdrawal[], total }` (newest first) |
| GET | `/unallocated?page=&limit=` | `{ items: UnallocatedCredit[], total }` (newest first) — every credit to `unallocatedUSDC`: `source: 'stray'` (a payment to a link no longer payable, credited in full) or `'overpaid'` (the excess over `quotedUSDC` on the completing payment); all rows sum to the credits — `unallocatedUSDC` = that sum − non-failed `/usdc-withdrawals` with `source: 'unallocated'`. Each row: `{ id, source, txHash, explorerUrl, amountUSDC, linkCode, reason, createdAt }` |

Balance: `availableTRY = Σ netTRY of completed balance-mode (mock) settlements − Σ non-failed withdrawals`, `paidOutTRY = Σ netTRY of completed auto_payout (sep24) settlements` (never withdrawable — the anchor already paid the IBAN), `pendingTRY = Σ amountTRY of pending/processing settlements` (gross; the fee is known only on completion), `savedUSDC = Σ savedUSDC of non-failed settlements − Σ non-failed USDC withdrawals from 'saved'`, `unallocatedUSDC` = stored counter: credited by overpaid/stray payments, debited by USDC withdrawals from `'unallocated'` (a failed one gives it back). Which bucket a settlement lands in follows the provider it was created with. A settlement's gross `amountTRY` is the link's locked `amountTRY` × (100 − `autoSavePercent`)% (keeping `quotedUSDC` × `autoSavePercent`% as `savedUSDC`); on completion `netTRY = amountTRY × (amountUSDC − feeUSDC) / amountUSDC`, rounded down to kuruş, and balances use `netTRY`.

### Payer (public, no auth)
| Method | Path | Response |
|---|---|---|
| GET | `/pay/:code` | `PayQuote` (re-quotes if quote expired, status is `open`, and the link is **not** on-chain — on-chain quotes are locked) |
| POST | `/pay/:code/submitted` | `{ txHash }` → `202 { accepted: true }` — hint so backend checks this tx immediately; detection also works without it |
| GET | `/pay/:code/agent` | **x402 (testnet only, experimental).** Without a `PAYMENT-SIGNATURE` header → `402` `PaymentRequired` (x402 v2 body + base64 `PAYMENT-REQUIRED` header: `exact` scheme, `stellar:testnet`, USDC SAC, `amount` = amount due in 7-dp base units, `payTo` = platform account; no memo — the URL identifies the link). With a valid header → the x402.org (Coinbase) facilitator verifies + settles, the backend reads the transfer back from Horizon and credits it (`Payment.rail = 'x402'`) → `200 { code, linkStatus, rail, network, facilitator, credit, reason?, settlement, payment: Payment \| null }` + `PAYMENT-RESPONSE` header. If the facilitator **times out** settling (outcome unknown) → `202 { code, status: 'pending', x402SettlementId, rail, network, facilitator }`; the backend reconciles it every minute (credits it only if a transaction carrying the payer's signed auth entries shows up on Horizon — never by payer + amount — retries the settle while the auth entries are valid, else fails it) — poll `/pay/:code/status`. `409` if the link isn't `open`/`underpaid` or the settled tx hash was already processed; `503` if x402 is disabled or the facilitator is down |
| GET | `/pay/:code/status` | `{ status: LinkStatus, receivedUSDC, shortfallUSDC?, payment?: Payment, payments: Payment[] }` — poll every 2 s (`payments` = every transfer, `payment` = the latest/completing one) |

### System
| Method | Path | Response |
|---|---|---|
| GET | `/health` | `{ ok: true, horizon: 'up'|'down', anchor: 'mock'|'sep24', listener: 'running'|'stopped', platformAccount: 'G...', settlementMode: 'balance'|'auto_payout' }` |
| GET | `/fx` | `{ pair: 'USDC/TRY', rate: '34.00', source: 'mock'|'live', fetchedAt }` |

### Status codes
`200/201/202` success · `400` validation · `401` no/invalid token · `403` wrong `currentPassword` on `PATCH /me` · `404` unknown link/code · `409` invalid state transition (e.g. cancel a paid link) or not allowed in this settlement mode (`POST /withdrawals` when `auto_payout`) · `422` business rule (insufficient balance; USDC withdrawal destination can't receive USDC).

## 7. Soroban invoice contract (phase 2, Hasan — required; frontends get an optional second pay button)

`contracts/invoice` — records invoices on-chain so a payer can pay *through* the contract using the USDC Stellar Asset Contract. Functions: `create(merchant: Address, code: Symbol, amount: i128, deadline: u32)`, `pay(code: Symbol, payer: Address)` (calls `token.transfer(payer → merchant)` with `payer.require_auth()`), `get(code) -> Invoice`, `cancel(code)`. Deployed with `__constructor(token, admin)`: `create` and `cancel` require the **admin** (platform account) auth — merchants are custodial and never sign; `merchant` is only the payout address. Live ids: `docs/deployments.md`. This is a **required phase-2 deliverable**. The payer page gets a second "Pay via contract" button; the classic memo rail stays as the fallback so the live demo never depends on the contract.

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
