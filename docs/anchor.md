# Anchor integration — SEP-24 (`ANCHOR_PROVIDER=sep24`)

How LiraLink turns a paid link's USDC into fiat through a Stellar anchor. Code:
`backend/src/anchor/sep24-anchor.adapter.ts` (flow), `backend/src/anchor/sep24.ts` (pure helpers),
`backend/src/settlements/settlements.service.ts` (driving it). Implemented and verified against
**testanchor.stellar.org** (SDF's reference anchor, USD out); a real TRY anchor is the same code
path with a different `ANCHOR_HOME_DOMAIN`.

`ANCHOR_PROVIDER=mock` stays the default for the demo. API shapes are identical in both modes —
a settlement is `pending → processing → completed`, `provider: 'sep24'`, `anchorRef` = the
anchor's transaction id.

## Config

```
ANCHOR_PROVIDER=sep24
ANCHOR_HOME_DOMAIN=testanchor.stellar.org
ANCHOR_SEP24_TEST_KYC_URL=https://anchor-reference-server-testanchor.stellar.org   # testanchor only
```

The platform account (`PLATFORM_ACCOUNT_SECRET`) authenticates and sends the USDC — custodial, as
everywhere else in phase 2.

## Flow, step by step

One settlement = one SEP-24 **withdraw** of `settlement.amountUSDC` (the quoted USDC minus
auto-save).

1. **SEP-1 discovery.** `GET https://{ANCHOR_HOME_DOMAIN}/.well-known/stellar.toml` →
   `TRANSFER_SERVER_SEP0024`, `WEB_AUTH_ENDPOINT`, `SIGNING_KEY`. Refuses an anchor whose
   `NETWORK_PASSPHRASE` differs from ours. Cached per process.
2. **Pre-checks (nothing is opened at the anchor if these fail).** The merchant must have an IBAN,
   and `GET {TRANSFER_SERVER_SEP0024}/info` must show `withdraw.USDC.enabled` with the amount within
   `min_amount`/`max_amount` (testanchor: 1–10 USDC per withdraw). Otherwise the settlement stays
   `pending` with `blockedReason` = `missing_iban` | `outside_anchor_limits` |
   `anchor_withdraw_disabled`, and the minute job retries it.
3. **SEP-10 auth.** `GET {WEB_AUTH_ENDPOINT}?account=<platform>&home_domain=…` → challenge.
   `WebAuth.readChallengeTx` verifies it (anchor `SIGNING_KEY` signature, sequence 0, time bounds,
   home domain, web-auth domain) **before** the platform key signs it; `POST {WEB_AUTH_ENDPOINT}`
   returns the JWT (cached until a minute before `exp`).
4. **Open the withdraw.** `POST {TRANSFER_SERVER_SEP0024}/transactions/withdraw/interactive`
   `{ asset_code: USDC, asset_issuer, account: <platform>, amount, lang: en }` →
   `{ id, url }`. Saved as `Settlement.anchorRef` / `interactiveUrl`. Status `incomplete`.
5. **Interactive step (KYC + bank details).**
   - *Real anchor:* a person completes `interactiveUrl`. The settlement stays `processing`; the
     job polls every minute until the anchor moves on. (Surfacing `interactiveUrl` to the merchant
     is not built — it is not in the API.)
   - *testanchor:* its UI is a JS app that posts to its reference server, so the backend makes the
     same two calls itself: `POST {ANCHOR_SEP24_TEST_KYC_URL}/start` (Bearer = the `token` query
     param of `interactiveUrl`) → `{ sessionId }`, then `POST …/submit` (Bearer = sessionId)
     `{ amount, name, surname, email, bank, account: <IBAN> }`.
6. **Send the USDC.** When `GET {TRANSFER_SERVER_SEP0024}/transaction?id=` shows
   `pending_user_transfer_start`, the adapter checks `amount_in` equals the settlement amount
   (else the settlement fails — nothing sent), then builds a payment platform →
   `withdraw_anchor_account` with `withdraw_memo` typed by `withdraw_memo_type` (`id` | `text` |
   `hash`, base64), 300 s time bound.
   **Double-spend guard:** the signed XDR and hash are saved (`anchorTxXdr`, `anchorTxHash`)
   *before* submitting. A retry resubmits that same transaction (same sequence number — it can land
   at most once). A new payment is built only when the saved one provably never landed: its hash is
   not on Horizon **and** a ledger has closed after its `maxTime`. Within one process, a settlement
   never has two adapter calls in flight.
7. **Wait for the anchor.** `pending_user_transfer_complete` / `pending_anchor` /
   `pending_external` … → `processing`. `completed` → settlement `completed` (TRY credited to
   `availableTRY`). `error` / `expired` / `refunded` / `no_market` / `too_small` / `too_large` →
   settlement `failed`.

One adapter call follows the anchor for up to 2 minutes (poll every 3 s), then returns
`processing`; `SettlementsService.reconcile` (every minute, and at boot) resumes every unfinished
`sep24` settlement. A thrown error (network, Horizon, anchor 5xx) leaves the settlement as it is
for the next run — it never marks money as failed on a transient error.

A settlement always continues on the provider it was created with, even if `ANCHOR_PROVIDER`
changes later (`ANCHOR_ADAPTERS` holds both).

## Observed on testanchor (2026-09-12)

- `/info`: USDC withdraw enabled, `min_amount` 1, `max_amount` 10, `fee.enabled: false` — but the
  reference server still books a 10% fee (`amount_in 1` → `amount_out 0.9`, `iso4217:USD`).
- `withdraw_anchor_account` `GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF`,
  `withdraw_memo_type: id`. It holds a trustline to our USDC issuer (`GBBD47…`).
- Statuses seen: `incomplete → pending_user_transfer_start → pending_anchor → pending_external →
  completed`.

## Known gaps / open decisions

- **Withdrawals in `sep24` mode fail.** A SEP-24 withdraw pays the fiat out to the bank at
  settlement time, so there is no separate "TRY payout" step; `payoutTRY` rejects with an explicit
  error. How `POST /withdrawals` should behave with a real anchor (settlement credits a ledger that
  is withdrawn later vs. anchor pays the IBAN directly per link) is a product decision still open.
- **Anchor limits vs. link sizes.** Links above the anchor's per-transaction maximum (10 USDC on
  testanchor ≈ 340 TRY at 34.00) stay `pending/outside_anchor_limits`. Splitting into several
  withdraws is not built.
- **Anchor fee** is not reflected in the ledger: the merchant is credited the locked `amountTRY`.
- Single-process guard only — running two backend instances against one DB would need a DB lock
  around the payment step.

## Testing

- Unit: `src/anchor/sep24.spec.ts` (status mapping, limits, memo types, JWT expiry).
- Live e2e (spends 1 real testnet USDC per run, needs network):
  `SEP24_E2E=1 npm run test:e2e -- sep24` — `missing_iban` and `outside_anchor_limits` blocks, then
  a full 1 USDC settlement to `completed`, checked on Horizon. Skipped unless `SEP24_E2E=1`.
