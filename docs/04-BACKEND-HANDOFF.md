# Backend → Frontend Handoff (Phase 1 + money endpoints green)

> From Hasan (backend) to Yunus (`pay-web`) and Vuslat (`merchant-web`).
> Read `00-PROJECT.md` §5/§6 first — this file only tells you **what is live right now**, the
> exact shapes the running backend returns, and the gotchas that aren't obvious from the spec.
> Source of truth for types stays `docs/api.types.ts`. If anything here disagrees with a running
> response, the running response wins — ping me and I'll fix the doc.

**Status as of 2026-09-12:** Phase 1 endpoints, the Soroban contract rail, and the Phase 2
money endpoints (`/balance`, `/payments`, `/settlements`, `/withdrawals`) are implemented and match
the contract. The live anchor is the **mock** adapter (settlements/payouts complete after ~3 s). A SEP-24
anchor adapter also exists; it switches `settlementMode` to `'auto_payout'` (§2) — build for both modes.

---

## 1. What is LIVE now (build against the real API)

Base URL: `http://localhost:3000/api` (note the global `/api` prefix). Swagger at `/docs`.

| Method | Path | Auth | Returns | Owner who needs it |
|---|---|---|---|---|
| POST | `/auth/register` | – | `201 { token, merchant }` | Vuslat |
| POST | `/auth/login` | – | `200 { token, merchant }` | Vuslat |
| GET | `/me` | Bearer | `Merchant` | Vuslat |
| PATCH | `/me` | Bearer | `Merchant` (`{ businessName?, iban?, autoSavePercent?, currentPassword?, newPassword? }`) | Vuslat |
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

## 2. Money endpoints (LIVE — Vuslat)

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/balance` | Bearer | `Balance` |
| GET | `/payments?page=&limit=` | Bearer | `{ items: PaymentListItem[], total }` |
| GET | `/settlements?page=&limit=` | Bearer | `{ items: Settlement[], total }` |
| POST | `/withdrawals` | Bearer | `201 Withdrawal` (`{ amountTRY, iban? }`) |
| GET | `/withdrawals?page=&limit=` | Bearer | `{ items: Withdrawal[], total }` |

- When a link is paid, a `Settlement` appears as `pending`/`processing` (counted in `pendingTRY`) and
  moves to `completed` a few seconds later — only then does `availableTRY` grow. Poll `/balance`
  every ~3 s on the dashboard while `pendingTRY !== "0.00"`.
- A withdrawal reduces `availableTRY` **immediately** (`status: 'requested'`), then goes
  `processing → completed`. `422` = more than `availableTRY`; `400` = no `iban` in the body and none
  on the profile (`PATCH /me`).
- `PaymentListItem.settlement` is `null` for installment payments that didn't complete a link.
- `PaymentListItem.link` = `{ code, title, amountTRY, status, quotedUSDC, receivedUSDC }` — the link's
  **current** status and totals, not a snapshot at the time of that transfer. Label rows with it:
  `status === 'underpaid'` → "Partial — `receivedUSDC` of `quotedUSDC` USDC" (an installment still
  waiting for a top-up); `status === 'paid'` with `settlement === null` → an earlier installment of
  a link that was later completed; `status === 'paid'` with a `settlement` → the completing payment.
  Compare the decimal strings as strings or with a decimal lib — never `Number()`.
- `savedUSDC` / auto-save: a settlement keeps `autoSavePercent`% of the USDC and credits
  `amountTRY` × (100 − `autoSavePercent`)%.
- **`settlementMode`** (on `GET /me`, the auth `merchant`, and `/health`) decides the money UI:
  - `'balance'` (mock anchor — live today): TRY accrues in `availableTRY`; the merchant withdraws manually.
  - `'auto_payout'` (SEP-24 anchor): the anchor pays the merchant's IBAN during settlement. Completed
    settlements count toward **`paidOutTRY`** instead of `availableTRY`, and `POST /withdrawals` returns
    `409` with message `"Payouts are automatic in this mode"`.
- **Fees:** a completed settlement carries `feeUSDC` (what the anchor kept) and `netTRY` (TRY actually
  credited or paid out). Balances use `netTRY`, not `amountTRY` — testanchor keeps 10%, so a 34.00 TRY
  link nets 30.60. Both are `null` until the settlement completes; the mock fee is `"0.0000000"`.

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

7. **Status codes:** `400` validation · `401` bad/no token · `403` wrong `currentPassword` on a
   password change (inline error — do **not** log out) · `404` unknown link/code ·
   `409` invalid state transition (e.g. cancel a `paid` link, or `POST /withdrawals` in `auto_payout`
   mode) · `422` business rule
   (withdraw > `availableTRY`). Map these in your `client.ts` `ApiError` handler;
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
- [ ] **Live now too:** dashboard balance, `/payments`, `/settlements`, `/withdrawals` (§2) — flip
      `VITE_USE_MOCK=false` when ready; the shapes are the ones in `api.types.ts`.
- [ ] `amountTRY` formatted to exactly 2 dp before `POST /links` (gotcha #3).
- [ ] Read `settlementMode` from `GET /me`. When it is `'auto_payout'`: **hide the Withdraw button**
      (and the withdraw dialog/page action), show a **"Paid to IBAN"** column in the payments table
      (the settlement's `netTRY` once `status === 'completed'`), and make the **Balance card show
      "Paid out TRY"** (`paidOutTRY`). In `'balance'` mode keep today's UI.
- [ ] Show `netTRY` (not `amountTRY`) as the credited amount on settlements; show `feeUSDC` when `> 0`.
- [ ] Settings: "Change password" form → `PATCH /me { currentPassword, newPassword }` (≥ 8 chars).
      `400` if one field is missing, `403` wrong current password.
- [ ] Demo account `demo@liralink.app` — the password is not in the repo any more: ask Hasan.
- [ ] The projector demo moment: `/links/:id` flips `open → paid` live while Yunus pays.

---

## 6. Toolchain reminders (binding — see `00-PROJECT.md` §8)
- Node **22.23.2** via `nvm use` before installing anything.
- `@stellar/stellar-sdk@16.3.0` in `pay-web` — must match the backend major. Do **not** take 17.x.
- TypeScript strict; money never as `number` in transport; English UI strings.

Questions or a shape that doesn't match reality → ping me in the team chat. I'll update
`00-PROJECT.md` §6 + `api.types.ts` first, then this file. — Hasan
