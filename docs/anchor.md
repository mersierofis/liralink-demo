# Anchor integration — SEP-24 (`ANCHOR_PROVIDER=sep24`)

How LiraLink turns a paid link's USDC into fiat through a Stellar anchor. Code:
`backend/src/anchor/sep24-anchor.adapter.ts` (flow), `backend/src/anchor/sep24.ts` (pure helpers),
`backend/src/settlements/settlements.service.ts` (driving it). Implemented and verified against
**testanchor.stellar.org** (SDF's reference anchor, USD out); a real TRY anchor is the same code
path with a different `ANCHOR_HOME_DOMAIN`.

`ANCHOR_PROVIDER=mock` stays the default for the demo. API shapes are the same in both modes (only
`settlementMode` and the balance bucket differ — see *Settlement mode*) —
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
   - *Real anchor* (`ANCHOR_SEP24_TEST_KYC_URL` unset): a person completes `interactiveUrl`. The
     settlement stays `processing` — never `failed`, no error logged — and `GET /settlements` /
     `GET /payments` expose `interactiveUrl` for merchant-web's "Complete verification" button. The
     adapter records the anchor's last status in `Settlement.anchorStatus` (written only when it
     changes); the API shows `interactiveUrl` only while that is `incomplete` and the settlement is
     `processing`. The minute job makes one `GET /transaction` per run while waiting and resumes
     (step 6) on the first run after the anchor moves on. If the person never finishes, the anchor
     decides: an `expired`/`error` status fails the settlement with `anchor_status`.
   - *testanchor:* its UI is a JS app that posts to its reference server, so the backend makes the
     same two calls itself: `POST {ANCHOR_SEP24_TEST_KYC_URL}/start` (Bearer = the `token` query
     param of `interactiveUrl`) → `{ sessionId }`, then `POST …/submit` (Bearer = sessionId)
     `{ amount, name, surname, email, bank, account: <IBAN> }`.
6. **Send the USDC.** When `GET {TRANSFER_SERVER_SEP0024}/transaction?id=` shows
   `pending_user_transfer_start`, the adapter checks `amount_in` equals the settlement amount
   (else the settlement fails with `failReason: 'amount_mismatch'` — nothing sent), then builds a payment platform →
   `withdraw_anchor_account` with `withdraw_memo` typed by `withdraw_memo_type` (`id` | `text` |
   `hash`, base64), 300 s time bound.
   **Double-spend guard:** the signed XDR and hash are saved (`anchorTxXdr`, `anchorTxHash`)
   *before* submitting. A retry resubmits that same transaction (same sequence number — it can land
   at most once). A new payment is built only when the saved one provably never landed: its hash is
   not on Horizon **and** a ledger has closed after its `maxTime`. Within one process, a settlement
   never has two adapter calls in flight.
7. **Wait for the anchor.** `pending_user_transfer_complete` / `pending_anchor` /
   `pending_external` … → `processing`. `completed` → settlement `completed`, with `feeUSDC` from the
   anchor's `fee_details` (else `amount_fee`) and `netTRY` = `amountTRY` × (`amountUSDC` − fee) /
   `amountUSDC`, rounded down; it counts toward `paidOutTRY` (the anchor paid the IBAN). A fee in any
   asset other than our USDC → settlement `failed` with `failReason: 'unexpected_fee_asset'`, logged at
   ERROR and not retried (the anchor already paid out — reconcile by hand). A fee below 0 or above
   `amountUSDC` → `failed` / `invalid_fee`, same handling.
   `error` / `expired` / `refunded` / `no_market` / `too_small` / `too_large` → `failed` / `anchor_status`.

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

## Settlement mode (decided 2026-09-12)

`sep24` = **auto-payout per link**: the anchor pays the merchant's IBAN during settlement.
`GET /me` and `/health` return `settlementMode: 'auto_payout'` (mock: `'balance'`). Completed sep24
settlements count toward `Balance.paidOutTRY` (by `netTRY`), never `availableTRY`, and
`POST /withdrawals` returns `409 "Payouts are automatic in this mode"`. The bucket follows the
provider a settlement was created with, so switching `ANCHOR_PROVIDER` never moves completed money.

## Spec review — SEP-1 / SEP-10 / SEP-24 (2026-09-15)

Basis: the specs `skills/standards` routes anchor integrations to (there is no `anchors` skill
upstream — see `skills/standards/SOURCE.md`), at stellar-protocol `0dc4592c`: SEP-1 v2.7.0, SEP-10
v3.4.1, SEP-24 v3.8.0. `[x]` = conforms or fixed in this review, `[ ]` = open deviation.

**SEP-1 (stellar.toml)**
- [x] `https://{domain}/.well-known/stellar.toml`, 100 KB cap, no redirects (SDK `Resolver`).
- [x] Requires `TRANSFER_SERVER_SEP0024`, `WEB_AUTH_ENDPOINT`, `SIGNING_KEY`; refuses another `NETWORK_PASSPHRASE`.
- [x] **Fixed:** the fetch had no timeout → 20 s, like every other anchor call.
- [x] **Fixed:** cached for the process lifetime → re-read hourly; a rotated `SIGNING_KEY` drops the cached JWT.

**SEP-10 (web auth)**
- [x] Challenge verified before signing: server signature, sequence 0, `<home domain> auth`, `web_auth_domain`, finite time bounds (SDK `readChallengeTx`).
- [x] **Fixed:** the challenge's optional `network_passphrase` was not compared → refuses to sign for another network.
- [x] **Fixed:** a JWT the anchor rejects (401/403) stayed cached until `exp` → cleared; the next run re-authenticates.
- [x] No `client_domain`: custodial — anchors identify custodial clients by the JWT `sub`.
- [ ] The omnibus platform account authenticates without a memo / `M…` `sub`, so every merchant is one anchor user (one KYC identity). **Before a real anchor** → [#21](https://github.com/mersierofis/liralink-demo/issues/21).

**SEP-24 (interactive withdraw)**
- [x] `/info` read unauthenticated; `enabled` / `min_amount` / `max_amount` → `blockedReason` before anything is opened.
- [x] USDC sent only at `pending_user_transfer_start`, to `withdraw_anchor_account` with `withdraw_memo` / `withdraw_memo_type`; `amount_in` must equal the settlement amount.
- [x] Status polling: `GET /transaction?id=` every 3 s for 2 min, then once a minute (the spec allows polling instead of callbacks; no `on_change_callback`, so no callback signature to verify).
- [x] Terminal: `completed`, `refunded`, `expired`, `error`, `no_market`, `too_small`, `too_large`; every other `pending_*` and `on_hold` waits.
- [x] Fee from `fee_details` (else the deprecated `amount_fee`), accepted only in our USDC.
- [ ] Withdraw request body is JSON; the spec says form-encoded ("should"). testanchor accepts JSON → [#23](https://github.com/mersierofis/liralink-demo/issues/23).
- [ ] Error handling: any non-2xx counts as transient, so a 4xx on opening the withdraw or a 404 on `/transaction` is retried forever → [#23](https://github.com/mersierofis/liralink-demo/issues/23).
- [ ] `pending_user`, `on_hold`, `more_info_url`, `user_action_required_by` are not shown to the merchant → [#22](https://github.com/mersierofis/liralink-demo/issues/22).
- [ ] `refunds` ignored: partial refunds are not netted, refunded USDC is not credited back → [#24](https://github.com/mersierofis/liralink-demo/issues/24).
- [ ] KYC re-open: the interactive URL token is short-lived and a stale withdraw is never re-opened → [#10](https://github.com/mersierofis/liralink-demo/issues/10) (`user_action_required_by`, #22, gives the deadline).
- Not used: SEP-12 (the anchor collects KYC on its own interactive page), SEP-6, SEP-38 quotes, claimable balances (deposit-only).

## Known gaps / open decisions

- **Anchor limits vs. link sizes.** Links above the anchor's per-transaction maximum (10 USDC on
  testanchor ≈ 340 TRY at 34.00) stay `pending/outside_anchor_limits`. Splitting into several
  withdraws is not built.
- **Failed settlements are terminal.** `failReason` says why; there is no alerting or dead-letter
  queue yet — watch ERROR logs (`Settlement … failed`) and reconcile `unexpected_fee_asset` /
  `invalid_fee` by hand (the anchor completed, but the fee could not be netted).
- **Balance aggregation** (`BalanceService`, `completedNetTRY`) runs two aggregates per bucket — rows
  with `netTRY`, plus legacy rows at gross `amountTRY`. Accepted at current scale; roadmap: a single
  query with `COALESCE("netTRY", "amountTRY")` once settlement volume grows.
- **`BALANCE_MODE_PROVIDERS`** (`anchor.adapter.ts`) is a hand-maintained list, today `['mock']`. A new
  balance-mode provider must be added there, or its completed settlements land in `paidOutTRY`.
- **`interactiveUrl` expires.** Its token is short-lived (testanchor: 15 min after the withdraw
  opens). A merchant who clicks later gets a dead page while the settlement keeps waiting until the
  anchor expires the transaction. Re-opening a fresh withdraw for a stale one is not built —
  tracked in [#10](https://github.com/mersierofis/liralink-demo/issues/10)
  (`POST /settlements/:id/reopen`).
- Single-process guard only — running two backend instances against one DB would need a DB lock
  around the payment step.

## Testing

- Unit: `src/anchor/sep24.spec.ts` (status mapping, limits, memo types, fee parsing, JWT expiry),
  `src/settlements/settlement-math.spec.ts` (`netSettlementTRY`).
- Live e2e (spends 1 real testnet USDC per run, needs network):
  `SEP24_E2E=1 npm run test:e2e -- sep24` — `missing_iban` and `outside_anchor_limits` blocks, then
  a full 1 USDC settlement to `completed`, checked on Horizon, with `feeUSDC` 0.1 and `netTRY` 30.60
  in `paidOutTRY`. Skipped unless `SEP24_E2E=1`.
- Live **manual** e2e, the real-anchor path (1 testnet USDC, needs a person with a browser):
  `SEP24_MANUAL_KYC=1 SEP24_URL_FILE=/tmp/url npm run test:e2e -- sep24-manual-kyc`. With
  `ANCHOR_SEP24_TEST_KYC_URL` unset it holds 2.5 min checking the settlement stays `processing` with
  `interactiveUrl` on `/settlements` and `/payments` (≤ 1 anchor poll per minute, no errors), prints
  the URL, waits up to 30 min for the form, then expects `completed` and `interactiveUrl: null`.
  Keep the amount unchanged in the form (else `amount_mismatch`).
- Non-live e2e: `test/auto-payout.e2e-spec.ts` — `settlementMode`, `409` on withdrawals, `paidOutTRY`
  bucket (no calls to the anchor).
