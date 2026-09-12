# Backend → Frontend Handoff (Phase 1 green)

> From Hasan (backend) to Yunus (`pay-web`) and Vuslat (`merchant-web`).
> Read `00-PROJECT.md` §5/§6 first — this file only tells you **what is live right now**, the
> exact shapes the running backend returns, and the gotchas that aren't obvious from the spec.
> Source of truth for types stays `docs/api.types.ts`. If anything here disagrees with a running
> response, the running response wins — ping me and I'll fix the doc.

**Status as of 2026-09-12:** Phase 1 endpoints are implemented and match the contract. Phase 2
money endpoints (`/balance`, `/payments`, `/settlements`, `/withdrawals`) are **not built yet** —
keep building those screens against your MSW mock (`VITE_USE_MOCK=true`). I'll tell the team in
chat the day each of them goes live.

---

## 1. What is LIVE now (build against the real API)

Base URL: `http://localhost:3000/api` (note the global `/api` prefix). Swagger at `/docs`.

| Method | Path | Auth | Returns | Owner who needs it |
|---|---|---|---|---|
| POST | `/auth/register` | – | `201 { token, merchant }` | Vuslat |
| POST | `/auth/login` | – | `200 { token, merchant }` | Vuslat |
| GET | `/me` | Bearer | `Merchant` | Vuslat |
| PATCH | `/me` | Bearer | `Merchant` (`{ businessName?, iban?, autoSavePercent? }`) | Vuslat |
| POST | `/links` | Bearer | `201 PaymentLink` | Vuslat |
| GET | `/links?status=&page=&limit=` | Bearer | `{ items: PaymentLink[], total }` (newest first) | Vuslat |
| GET | `/links/:id` | Bearer | `PaymentLink` | Vuslat |
| POST | `/links/:id/cancel` | Bearer | `200 PaymentLink` (only if `open`) | Vuslat |
| POST | `/links/:id/onchain` | Bearer | `200 PaymentLink` — retry only, when `onchain` is `null` | Vuslat |
| GET | `/pay/:code` | public | `PayQuote` | Yunus |
| POST | `/pay/:code/submitted` | public | `202 { accepted: true }` (`{ txHash }`) | Yunus |
| GET | `/pay/:code/status` | public | `PayStatus` | Yunus |
| GET | `/health` | public | `HealthResponse` | both |
| GET | `/fx` | public | `FxResponse` | both |

## 2. What is NOT live yet (stay on the mock)

These are Phase 2. The DB tables exist but **no endpoint returns them**, so a real call 404s:

- `GET /balance`
- `GET /payments`
- `GET /settlements`
- `POST /withdrawals`, `GET /withdrawals`

**Vuslat:** your Dashboard balance card, Payments table, and Withdrawals screen depend on these.
Build them fully against MSW now (shapes are frozen in `api.types.ts`: `Balance`, `Settlement`,
`Withdrawal`). When I flip them on, only your `VITE_USE_MOCK` toggle changes — the shapes won't.

---

## 3. Gotchas that will bite you (read these)

1. **`GET /pay/:code` nests the destination + memo under `rails.memo` — NOT at the top level.**
   The `buildPaymentXdr` example in `02-PAY-WEB.md` (lines ~42–52) reads `q.destination` and
   `q.memo`. The real response has no such top-level fields. Use:
   ```ts
   const { destination, memo } = q.rails.memo!;   // memo === the 8-char link code
   Operation.payment({ destination, asset: usdc, amount: q.amountUSDC })
   Memo.text(memo)
   ```
   `rails.contract` is present when the link is on-chain — `POST /links` creates the invoice
   automatically (best-effort), so normally from the start; guard on it anyway (absent if that
   RPC call failed and nobody retried). **Vuslat:** if a link comes back with `onchain: null`, offer a
   "Retry on-chain" action → `POST /links/:id/onchain`. `POST /links` can take ~5–10 s now (it waits
   for the Soroban tx) — show a spinner.
   To pay through it: `invoice.pay({ code: invoiceCode, payer: <wallet G...> })` with the TS bindings in
   `packages/invoice-client` (contract id `rails.contract.contractId`), sign with the wallet, send,
   then `POST /pay/:code/submitted` as usual. The contract moves exactly the on-chain amount, so no
   memo and no amount input. `Payment.rail` is then `'contract'`.
   **Never drop the memo** — the listener matches the payment by `memo === code`; no memo = no match.

2. **All money is decimal strings. Never parse to `number`.** `amountTRY` is 2 dp (`"5000.00"`),
   every USDC field is 7 dp (`"147.0588236"`). Render only; do no arithmetic in the UI.

3. **`POST /links` `amountTRY` must be a string with *exactly* two decimals** — regex
   `^\d+\.\d{2}$`. `"5000"` and `"5000.5"` are rejected with `400`. Format the ₺ input to 2 dp
   before sending. Server also enforces range 1.00–1,000,000.

4. **`amountUSDC` on the pay quote is locked at creation** (`quotedUSDC`), not recomputed from the
   live rate. It's what the payer must send. For an on-chain link (`onchain` set / `rails.contract`
   present) it is locked until `expiresAt` — `quoteExpiresAt === expiresAt`, never re-quoted; only
   off-chain links re-quote on `/pay/:code` after 10 min. `receivedUSDC` is cumulative matched (`"0"` until the
   first payment); `shortfallUSDC` is present only while `status === 'underpaid'`.

5. **Underpaid / overpaid:** exact send → `paid`. Underpay → link stays `open`/`underpaid` for a
   top-up (poll keeps running). Overpay → `paid`, excess lands in `merchant.unallocatedUSDC`. Yunus:
   handle a link that goes `underpaid` (show shortfall, allow another payment). Vuslat: surface
   `unallocatedUSDC` on the dashboard if `> 0`.
   **Every successful transfer is its own `Payment`:** links, `/pay/:code` and `/pay/:code/status`
   return `payments: Payment[]` (installments + completion, oldest→newest). `payment` is kept as an
   alias for the latest one — render `payments` when showing tx hashes, or you'll hide installments.

6. **Poll `GET /pay/:code/status` every 2 s** until `status` is terminal (`paid`/`expired`/
   `cancelled`). The `/submitted` POST is only a fire-and-forget hint to speed detection up —
   detection works without it, so don't block the UI on its response.

7. **Status codes:** `400` validation · `401` bad/no token · `404` unknown link/code ·
   `409` invalid state transition (e.g. cancel a `paid` link) · `422` business rule
   (e.g. withdraw > balance, once that's live). Map these in your `client.ts` `ApiError` handler;
   Vuslat: redirect to `/login` on `401`.

8. **`code` in the URL is case-insensitive** — backend upper-cases it. Codes are 8-char uppercase.

---

## 4. Running the backend locally

You usually don't need to — use MSW. But to hit the real API:

```bash
cd backend
nvm use                       # Node 22.23.2 (repo-root .nvmrc). You are NOT on it by default.
docker compose up -d          # from repo root: Postgres 16 on localhost:5433
cp .env.example .env          # then set PLATFORM_ACCOUNT_SECRET (ask me, or see backend/README)
npx prisma migrate dev        # also runs `prisma generate` → src/generated/prisma/client
npm run start:dev             # http://localhost:3000 , Swagger at /docs
```

- **CORS** is already open to `http://localhost:5173` (merchant-web) and `http://localhost:5174`
  (pay-web). Run your dev servers on those ports or tell me to add yours.
- `GET /health` tells you the backend is up and whether Horizon/listener are running — hit it first
  if the real API "isn't working."
- `GET /fx` returns the mock rate (`34.00 TRY/USDC` in dev). The quote you get from `/links` and
  `/pay/:code` already has the rate baked in — you don't need to call `/fx` to compute anything.

---

## 5. Per-app checklist

### Yunus — `pay-web`
- [ ] Copy `docs/api.types.ts` → `src/api/types.ts`. Use `PayQuote` and `PayStatus`.
- [ ] Read `destination`/`memo` from **`q.rails.memo`** (gotcha #1), pin `@stellar/stellar-sdk@16.3.0`.
- [ ] Build against MSW seed codes (`DEMO0001`…`DEMO0004`) first; switch to real `/pay/:code` last.
- [ ] All four states + `underpaid` + error states (rejected sig, submit fail, network mismatch).
- [ ] End-to-end proof: one real 1-USDC testnet payment, paste the tx hash in chat.

### Vuslat — `merchant-web`
- [ ] Copy `docs/api.types.ts` → `src/api/types.ts`.
- [ ] **Live now:** auth, `/me`, all `/links` endpoints, link detail (poll `/links/:id` every 3 s
      while `open`). Wire these to the real API when you want.
- [ ] **Mock only for now:** dashboard balance, `/payments`, `/withdrawals` — keep MSW until I flip
      Phase 2 on. Shapes are frozen, so the swap is just the `VITE_USE_MOCK` flag.
- [ ] `amountTRY` formatted to exactly 2 dp before `POST /links` (gotcha #3).
- [ ] The projector demo moment: `/links/:id` flips `open → paid` live while Yunus pays.

---

## 6. Toolchain reminders (binding — see `00-PROJECT.md` §8)
- Node **22.23.2** via `nvm use` before installing anything.
- `@stellar/stellar-sdk@16.3.0` in `pay-web` — must match the backend major. Do **not** take 17.x.
- TypeScript strict; money never as `number` in transport; English UI strings.

Questions or a shape that doesn't match reality → ping me in the team chat. I'll update
`00-PROJECT.md` §6 + `api.types.ts` first, then this file. — Hasan
