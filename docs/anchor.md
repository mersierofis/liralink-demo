# Anchor integration — SEP-6 and SEP-24

How LiraLink turns a paid link's USDC into fiat through a Stellar anchor. There are two real
adapters behind one interface (`backend/src/anchor/anchor.adapter.ts`), plus `mock`:

| `ANCHOR_PROVIDER` | Anchor | Fiat | Shape |
|---|---|---|---|
| **`sep6`** | **tr-mock-anchor.fly.dev** — the hackathon's official TRY anchor | **TRY** | programmatic; no human step |
| `sep24` | testanchor.stellar.org — SDF's reference anchor | USD | interactive; a person completes KYC in a browser |
| `mock` | none | TRY | instant, in-process; the demo default |

Code: `sep6-anchor.adapter.ts` / `sep24-anchor.adapter.ts` (flows), `sep6.ts` / `sep24.ts` (pure
helpers), `transfer.ts` (what the two specs share — the transaction object, `/info` limits, status
vocabulary, memo rules), `anchor-session.ts` (SEP-1 discovery + SEP-10 auth + anchor HTTP, shared
by both adapters and by the SEP-38 rate source), `withdraw-payment.ts` (the USDC payment and its
double-spend guard), and `settlements/settlements.service.ts` (driving it).

`ANCHOR_PROVIDER=mock` stays the default for the demo. API shapes are the same in every mode (only
`settlementMode` and the balance bucket differ — see *Settlement mode*) — a settlement is
`pending → processing → completed`, `provider` names the adapter, and `anchorRef` is the anchor's
transaction id. A settlement always continues on the provider it was created with.

## Config

```
ANCHOR_PROVIDER=sep24
ANCHOR_HOME_DOMAIN=testanchor.stellar.org
ANCHOR_SEP24_TEST_KYC_URL=https://anchor-reference-server-testanchor.stellar.org   # testanchor only
ANCHOR_SEP24_ENCODING=multipart   # or urlencoded: withdraw body format for this anchor (default multipart)
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
   `{ asset_code: USDC, asset_issuer, account: <platform>, amount, lang: en }` as a form,
   never JSON: `ANCHOR_SEP24_ENCODING` = `multipart` (`multipart/form-data`, default) or
   `urlencoded` (`application/x-www-form-urlencoded`). If the anchor rejects that format — 400/415/422,
   or a 5xx whose body mentions `Content-Type` (testanchor answers urlencoded with 500 "Content-Type
   … is not supported") — the same fields are retried once in the other format (a rejected request
   opened nothing), and the process keeps the format that worked. →
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

## SEP-6 — the TRY rail (`ANCHOR_PROVIDER=sep6`)

The hackathon's anchor speaks **SEP-6**, not SEP-24: the whole withdrawal is programmatic, so
there is no interactive page, no browser step and no KYC form to fill in. `interactiveUrl` is
always `null` for a `sep6` settlement.

### Config

```
ANCHOR_PROVIDER=sep6
ANCHOR_HOME_DOMAIN=tr-mock-anchor.fly.dev
FX_PROVIDER=anchor          # strongly recommended — see "Why FX_PROVIDER=anchor matters" below
```

No KYC or encoding settings: `ANCHOR_SEP24_TEST_KYC_URL` and `ANCHOR_SEP24_ENCODING` are SEP-24
only. `sep6` refuses to start unless `STELLAR_NETWORK=testnet` — the anchor is a sandbox that
moves no real money and does not exist on pubnet.

### Flow, step by step

One settlement = one SEP-6 **withdrawal** of `settlement.amountUSDC`.

1. **SEP-1 discovery.** `https://tr-mock-anchor.fly.dev/.well-known/stellar.toml` → `TRANSFER_SERVER`
   (note: *not* `TRANSFER_SERVER_SEP0024`), `WEB_AUTH_ENDPOINT`, `SIGNING_KEY`, `KYC_SERVER`,
   `ANCHOR_QUOTE_SERVER`. Refuses an anchor whose `NETWORK_PASSPHRASE` differs from ours. Read
   hourly, shared with the SEP-24 adapter and the FX rate source.
2. **Pre-checks (nothing is opened at the anchor if these fail).** The merchant must have an IBAN,
   and `GET {TRANSFER_SERVER}/info` must show `withdraw.USDC.enabled` with the amount inside
   `min_amount`/`max_amount`. Otherwise the settlement stays `pending` with `blockedReason`, and
   the minute job retries.
3. **SEP-10 auth — as the merchant's own anchor user** ([#21](https://github.com/mersierofis/liralink-demo/issues/21)).
   Every merchant's USDC sits in one platform account, so the adapter logs in with SEP-10 *Memos*:
   `GET {WEB_AUTH_ENDPOINT}?account=<platform>&memo=<merchant memo>&home_domain=…`. The anchor
   then sees one user per merchant (JWT `sub` = `G…:<memo>`), with its own KYC record, IBAN and
   transaction history. The memo is a 63-bit number derived from the merchant's UUID
   (`anchorMemoFor`) — merchants have no numeric id, and adding one would backfill live rows. The
   challenge must carry the memo asked for, and the issued JWT's `sub` must be exactly
   `G…:<memo>`; otherwise nothing is signed or cached (an anchor that ignored the memo would
   otherwise merge every merchant into one user without an error). One JWT is cached per merchant.
4. **SEP-12: register the payout IBAN.** Without it this anchor pays a default sandbox account,
   not the merchant. On the merchant's first withdraw — and whenever `merchant.iban` or the anchor
   home domain differs from what was registered — `PUT {KYC_SERVER}/customer
   { "bank_account_number": <IBAN> }` with the merchant's JWT → `{ id }`, stored as
   `Merchant.sep12CustomerId` with `sep12Iban` and `sep12HomeDomain`. When all three already match,
   one `GET {KYC_SERVER}/customer` confirms the anchor still has that customer `ACCEPTED`. If the
   sandbox was reset (status back to `NEEDS_INFO`, or another id), it registers again instead of
   letting the payout fall back to the default account. A `400` (the anchor validates a Turkish
   mod-97 IBAN) blocks the settlement with `missing_iban` — nothing is opened.
5. **Open the withdrawal.** `GET {TRANSFER_SERVER}/withdraw?asset_code=USDC&funding_method=bank_account&amount=…&account=<platform>&dest=<IBAN>`
   with the merchant's JWT → `{ id, account_id, memo, memo_type }`. Saved as `Settlement.anchorRef`
   **together with `Settlement.anchorMemo`**: the anchor scopes transactions to the JWT `sub`, so
   it is only visible to that merchant's identity. (`funding_method` replaces the deprecated `type`.)
   It is a **GET with query params** — there is no form body, so the SEP-24 multipart/urlencoded
   problem doesn't come up.
   *If the anchor rejects the amount* (4xx naming a minimum/maximum — see *Observed*), the
   settlement is `blocked` with `outside_anchor_limits` rather than treated as a transient error:
   nothing was opened and nothing was sent.
6. **Send the USDC.** The status is `pending_user_transfer_start` immediately. The adapter checks
   `amount_in` equals the settlement amount (else `failReason: 'amount_mismatch'`, nothing sent),
   then pays `withdraw_anchor_account` with **`Memo.id`** (`withdraw_memo_type: "id"` — an `id`
   memo, *not* text; without the right memo the anchor cannot match the payment). Same
   double-spend guard as SEP-24: the signed XDR and hash are persisted *before* submitting, a
   retry resubmits that same transaction, and a new one is built only when the saved one provably
   never landed.
7. **Wait for the anchor.** `GET {TRANSFER_SERVER}/transaction?id=` as the identity in
   `anchorMemo` (a withdrawal opened before per-merchant identity has `anchorMemo` null and is
   polled as the bare platform account). `pending_anchor` / `pending_external` → `processing`;
   `completed` → settlement `completed`. The completed transaction names where the lira went
   (`to`) and its bank reference (`external_transaction_id`); if `to` is not the merchant's IBAN
   the settlement still completes — the money already moved — but an ERROR is logged for manual
   reconciliation. Terminal failures (`error`, `expired`, `refunded`, `no_market`, `too_small`,
   `too_large`) → `failed` / `anchor_status`. `incomplete` — which in SEP-24 means "the customer
   has not filled the form in yet" — has no meaning here and is treated as just another pending
   anchor state.

### How the money is booked

This anchor charges its spread **in lira, not in USDC**, and reports the lira it actually paid:

```
amount_in  1.0328445 stellar:USDC:GBBD47IF…   amount_out 50.00 iso4217:TRY
amount_fee 0.25      iso4217:TRY              fee_details.asset iso4217:TRY
```

So `netTRY` is taken straight from **`amount_out`** — the money that reached the bank — and
`feeUSDC` is recorded as `0`, because the 0.25 TRY is *already deducted* from `amount_out` and
counting it again would net it twice. `feeUSDC` is only ever populated when an anchor denominates
its fee in our USDC. (Running this through the SEP-24 path would have been wrong: `sep24FeeUSDC`
returns null for a fee in `iso4217:TRY`, which would have failed the settlement with
`unexpected_fee_asset` even though the anchor had paid out correctly.)

If a future anchor reports neither a USDC fee nor a TRY `amount_out`, the settlement fails with
`unexpected_fee_asset` rather than guessing.

### Why `FX_PROVIDER=anchor` matters

With `FX_PROVIDER=mock` a link is priced at 34.00 TRY/USDC while the anchor settles at ~48.4, so
a 50 TRY link would quote 1.47 USDC and the anchor would hand back ~71 TRY — the merchant's
lira figure and the anchor's would never agree, and small links would fall under the anchor's
1 USDC minimum for no reason.

`FX_PROVIDER=anchor` locks the anchor's own rate at link creation:
`GET {ANCHOR_QUOTE_SERVER}/price?sell_asset=stellar:USDC:…&buy_asset=iso4217:TRY&sell_amount=1&context=sep6`.
The rate is `1 / total_price` — `total_price` **includes** the anchor's spread, while `price` does
not, and the spread is what the settlement is really charged. Rounded **down** to 6 dp, so the
USDC quoted for a link is never short. Cached 5 minutes; the source is logged, and `GET /fx`
returns `source: 'anchor'`. Any failure (no quote server, non-2xx, unparseable body) logs an
ERROR and **falls back to the mock rate** — link creation never fails because the anchor is down.
SEP-38 prices are public here; an anchor that demands the JWT gets it on a 401/403 retry.

This is an *indicative* price, not a firm SEP-38 quote: we do not pass a `quote_id` to the
withdrawal, so the anchor re-prices at settlement time. Over a link's lifetime the rate can drift
— see *Known gaps*.

### Observed on tr-mock-anchor (2026-09-16)

- **`/info` cannot be trusted in either direction.** It advertises `min_amount: 0.5` and
  `max_amount: 300`, but the anchor rejects 0.7 USDC with
  `400 {"error":"Minimum off-ramp is 1.0000000 USDC"}` and *accepts* 301 USDC. The skill and the
  docs page both say the minimum is 1 USDC. We enforce the advertised limits **and** map an
  amount-related 4xx to `outside_anchor_limits`, which is what actually catches the 0.5–1.0 band.
- Withdraw response: `account_id` `GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6`
  (the treasury), `memo_type: "id"`, a 12-digit `memo`, `fee_percent: 0.5`, `eta: 10`.
  Transaction ids look like `sep_msv6urjp1lprb4ilgsnj`.
- Statuses seen: `pending_user_transfer_start → pending_anchor → completed` (no `incomplete`).
- **The payout IBAN comes from SEP-12, not from `dest`.** Without a registered customer the lira
  goes to a deterministic sandbox IBAN (`TR1200099042…` for the bare platform account). `dest` is
  accepted and ignored. After `PUT /sep12/customer { bank_account_number }` it goes to the
  merchant's IBAN. The payout itself is simulated (no bank is credited), but the routing is real.
- **Transactions are scoped to the SEP-10 `sub`.** A withdrawal opened as `G…:<memo A>` is a `404`
  for `G…:<memo B>` *and* for the bare `G…`. Memo logins work on an account that has already
  logged in without one.
- Rate ≈ 48.41 TRY/USDC: Reflector's USD/TRY oracle on Stellar mainnet (cached 60 s) minus a
  50 bps spread. SEP-38 `total_price` `0.0206568891` ⇒ 48.409999. `GET /health` reports the source
  (`reflector`, or `static_fallback` if the oracle is unreachable), mid/buy/sell rates and the
  treasury balance.
- **Live settlement, 2026-09-16 (omnibus identity):** withdrawal `sep_msv6urjp1lprb4ilgsnj`,
  1.0328445 USDC in → 50.00 TRY out (0.25 TRY fee) to the sandbox default IBAN, payment
  [`731af946…`](https://stellar.expert/explorer/testnet/tx/731af946ddcbd054befb9a1d214bcf381db7c83be040629dc1ab361897a1b142).
- **Live settlement, 2026-09-16 (per-merchant identity):** withdrawal `sep_ojw0zf7k31vq3v0vr283`
  as anchor user `2502363679949800526`, 50.00 TRY paid to **the merchant's IBAN**
  `TR330006100519786457841326`, bank reference `FAST-VNFC6IMHRA`, payment
  [`440149f4…`](https://stellar.expert/explorer/testnet/tx/440149f4ac9cf07de9de10cb25f32c3fd5e4b766ed149f6a789715aac6e6269d).
  The bare platform login got `404` for it.

### Observed vs documented

What tr-mock-anchor actually does, against what its own docs say
([`skills/anchor-tr`](../skills/anchor-tr/SOURCE.md), the hackathon SEP-6 page, `/guide`, and the
SEP specs). The adapter follows the observed behaviour.

| Topic | Documented | Observed (2026-09-16) | What LiraLink does |
|---|---|---|---|
| **Fee asset** | SEP-38: fee "in the sell asset" (USDC); `/info` `fee_percent: 0.5`; the guide says `amount_fee` is "the spread, in TRY" | Withdrawal books `amount_fee 0.25 iso4217:TRY`; `amount_out` is already net | `netTRY` = `amount_out`; `feeUSDC` = 0. The SEP-24 fee path would have failed the settlement |
| **Withdraw minimum** | Skill, SEP-6 page, guide: 1 USDC | `/info` advertises `min_amount: 0.5`; the anchor rejects 0.7 with `400 Minimum off-ramp is 1.0000000 USDC` | Enforce `/info`, **and** map an amount 4xx to `outside_anchor_limits` |
| **Withdraw maximum** | `/info`: `max_amount: 300` | 301 USDC accepted | Enforce the advertised 300 anyway |
| **Payout IBAN** | SEP-6: `dest` is where the fiat goes | `dest` ignored; the IBAN registered over SEP-12 is used, else a sandbox default | Register the IBAN over SEP-12 per merchant; check `to` on completion |
| **User identity** | Skill examples: bare `GET /auth?account=G…` | Memos supported (`sub` `G…:memo`); transactions scoped per `sub` | One anchor user per merchant; `anchorMemo` stored per settlement |
| **`type` param** | Skill / SEP-6 page: `type=bank_account` | Deprecated; `funding_method=bank_account` accepted (and `type` still is) | `funding_method` |
| **Rate source** | Skill: "Reflector oracle + 50 bps spread" | Confirmed in `/health`: `source: reflector`, `spread_bps: 50` | SEP-38 `/price` → `1 / total_price`; `demo:check` prints the source |
| **Persistence** | Guide FAQ: "assume it can be reset before events" | — | SEP-12 registration is re-checked with a GET before every withdraw; `demo:check` fails if `/health` is unreachable |

## Settlement mode (decided 2026-09-12)

`sep24` and `sep6` are both **auto-payout per link**: the anchor pays out during settlement.
`GET /me` and `/health` return `settlementMode: 'auto_payout'` (mock: `'balance'`). Completed
settlements on either count toward `Balance.paidOutTRY` (by `netTRY`), never `availableTRY`, and
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
- [ ] The omnibus platform account authenticates without a memo / `M…` `sub`, so every merchant is one anchor user (one KYC identity). **Before a real anchor** → [#21](https://github.com/mersierofis/liralink-demo/issues/21). **Closed for SEP-6** (2026-09-16): `sep6` logs in per merchant with a memo, `sub` = `G…:<memo>` verified; see *SEP-6 → Flow* step 3. Still open for `sep24`, which keeps the bare account — switching it needs the per-anchor check that testanchor accepts memo logins on an account already used without one.

**SEP-24 (interactive withdraw)**
- [x] `/info` read unauthenticated; `enabled` / `min_amount` / `max_amount` → `blockedReason` before anything is opened.
- [x] USDC sent only at `pending_user_transfer_start`, to `withdraw_anchor_account` with `withdraw_memo` / `withdraw_memo_type`; `amount_in` must equal the settlement amount.
- [x] Status polling: `GET /transaction?id=` every 3 s for 2 min, then once a minute (the spec allows polling instead of callbacks; no `on_change_callback`, so no callback signature to verify).
- [x] Terminal: `completed`, `refunded`, `expired`, `error`, `no_market`, `too_small`, `too_large`; every other `pending_*` and `on_hold` waits.
- [x] Fee from `fee_details` (else the deprecated `amount_fee`), accepted only in our USDC.
- [x] Withdraw request body is a form, never JSON (was JSON; [#23](https://github.com/mersierofis/liralink-demo/issues/23)): `ANCHOR_SEP24_ENCODING` = `multipart` (default) | `urlencoded`, with one try in the other format on 400/415/422 or a 5xx whose body mentions `Content-Type`.
- [ ] Error handling: any non-2xx counts as transient, so a 4xx on opening the withdraw or a 404 on `/transaction` is retried forever → [#23](https://github.com/mersierofis/liralink-demo/issues/23).
- [ ] `pending_user`, `on_hold`, `more_info_url`, `user_action_required_by` are not shown to the merchant → [#22](https://github.com/mersierofis/liralink-demo/issues/22).
- [ ] `refunds` ignored: partial refunds are not netted, refunded USDC is not credited back → [#24](https://github.com/mersierofis/liralink-demo/issues/24).
- [ ] KYC re-open: the interactive URL token is short-lived and a stale withdraw is never re-opened → [#10](https://github.com/mersierofis/liralink-demo/issues/10) (`user_action_required_by`, #22, gives the deadline).
- Not used *by this adapter*: SEP-12 (the anchor collects KYC on its own interactive page) and claimable balances (deposit-only). SEP-6 and SEP-38 are now used — by the `sep6` adapter and by `FX_PROVIDER=anchor` respectively; they have not had a line-by-line spec review of their own, and the SEP-6 flow is documented from the spec plus what the anchor actually does (*Observed*).

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
- **SEP-6 rates are indicative, not locked.** `FX_PROVIDER=anchor` reads
  `GET /sep38/price`, not a firm `POST /sep38/quote`, and no `quote_id` is passed to the
  withdrawal — so the anchor re-prices at settlement time. A link paid hours later settles at the
  rate of that moment, and `netTRY` can differ from the link's `amountTRY`. Holding a firm quote
  would mean `withdraw-exchange` plus expiry handling (quotes live ~15 min, links up to 24 h),
  which is not built.
- **The SEP-6 payout is simulated.** tr-mock-anchor routes the lira to the merchant's registered
  IBAN, but no bank is credited — `paidOutTRY` means "the anchor says it paid". A wrong `to` on a
  completed withdrawal is logged at ERROR, not failed (the money already moved).
- **Derived merchant memo.** `anchorMemoFor` uses the UUID's first 63 bits: two merchants share an
  anchor identity with probability ~n²/2⁶⁴, and the derivation must never change — a new formula
  would make every merchant a stranger to the anchor (their open withdrawals stay reachable
  through `Settlement.anchorMemo`, but SEP-12 would re-register).
- **An anchor without `KYC_SERVER`** can't be told the payout IBAN; the `sep6` settlement throws
  and is retried every minute rather than paying an unknown account.
- **`netTRY` can exceed `amountTRY`.** When the anchor's rate moves in the merchant's favour
  between link creation and settlement, `amount_out` is larger than the link's face value and is
  booked as-is (it is the money that moved). Nothing caps it.
- Single-process guard only — running two backend instances against one DB would need a DB lock
  around the payment step.

## Saturday checklist — switching the live service to a real anchor

**Steps 1–5 are already done** (2026-09-16). The official TRY anchor went live at
`tr-mock-anchor.fly.dev`, the SEP-6 adapter is built against it, and the whole flow is verified
end to end with real testnet USDC — see *Observed on tr-mock-anchor*. Nothing is left to discover:

1. ~~**Home domain.**~~ `tr-mock-anchor.fly.dev`. It serves **our** USDC issuer
   (`GBBD47IF…`), so no asset change is needed.
2. ~~**stellar.toml.**~~ Verified: `TRANSFER_SERVER` `…/sep6`, `WEB_AUTH_ENDPOINT` `…/auth`,
   `ANCHOR_QUOTE_SERVER` `…/sep38`, `SIGNING_KEY` `GDXYO6FJ…`, `NETWORK_PASSPHRASE` = ours.
   It has **no** `TRANSFER_SERVER_SEP0024` — this anchor does not do SEP-24, which is why the
   SEP-6 adapter exists.
3. ~~**`/info` limits.**~~ `withdraw.USDC.enabled: true`, advertised 0.5–300, really 1–unbounded.
   Both are handled; see *Observed*.
4. ~~**Encoding probe.**~~ Not applicable — SEP-6 opens a withdrawal with a GET, so there is no
   request body and no multipart/urlencoded question.
5. ~~**KYC automation off.**~~ Not applicable — SEP-6 has no interactive step at all, and this
   anchor auto-approves SEP-12 KYC. Leave `ANCHOR_SEP24_TEST_KYC_URL` empty.

What remains is the decision to flip, which is deliberately **not** automatic:

6. **`ANCHOR_PROVIDER=sep6`.** Before switching, `npm run demo:check` must say READY — it now
   also fails if the anchor's `/health` is unreachable and prints its rate source and treasury
   balance — and the platform account must hold enough USDC for the links you plan to demo. The
   sandbox may have been reset by the organisers: nothing to redo on our side (SEP-12
   registrations are re-checked before every withdraw), but confirm the treasury is funded. Edit the live
   `backend/.env` (comments on their own lines only — systemd doesn't strip inline `#`):
   `ANCHOR_PROVIDER=sep6`, `ANCHOR_HOME_DOMAIN=tr-mock-anchor.fly.dev`, and
   **`FX_PROVIDER=anchor`** — without it, links stay priced at 34.00 while the anchor settles at
   ~48.4 (see *Why `FX_PROVIDER=anchor` matters*). Restart `liralink-api` and check `/health`
   reports `settlementMode: auto_payout` and `GET /fx` reports `source: "anchor"`. Settlements that
   already exist keep their provider — the completed mock ones are never re-settled.
7. **One small end-to-end link.** A merchant with an IBAN and one link worth **at least 1 USDC**
   (≈ 50 TRY at the anchor rate — under that the settlement blocks with `outside_anchor_limits`).
   Pay it and follow `GET /settlements` to `completed`; there is no browser step to complete.
   Record `anchorRef`, the payment tx hash (on Horizon: `memo_type: id`, destination
   `GCLCZEQZ…`), and `netTRY`. Expect `feeUSDC` `0` and `netTRY` ≈ the link's TRY. The API log line
   `anchor paid TR… (bank ref FAST-…)` must name **the merchant's IBAN** — an ERROR saying
   `not merchant …'s IBAN` means the SEP-12 registration didn't take.
8. **Rollback to mock.** Set `ANCHOR_PROVIDER=mock` (and `FX_PROVIDER=mock`) and restart;
   `/health` should report `settlementMode: balance`. **Keep `ANCHOR_HOME_DOMAIN` set** until every
   `sep6` settlement is `completed` or `failed` — they resume on the provider they were created
   with, and the adapter can't reach the anchor without it. Nothing is re-settled on mock. Leave
   any USDC already sent for manual reconciliation using `anchorRef` and the tx hash.

The demo currently runs `mock`. Flipping it live is the operator's call.

## Testing

- Unit: `src/anchor/sep24.spec.ts` (status mapping, limits, memo types, fee parsing, JWT expiry),
  `src/anchor/sep6.spec.ts` (SEP-6 status mapping, the `amount_out`/fee booking rules, `Memo.id`,
  `anchorMemoFor`), `src/anchor/sep6-anchor.adapter.spec.ts` (against a fake anchor: SEP-12
  register / re-register on IBAN or domain change / re-register after a sandbox reset / IBAN
  rejected, `funding_method` and no `type`, the merchant JWT on every call, `anchorMemo` persisted
  and used for polling, all block reasons including the anchor's own 4xx, the wrong-payout-IBAN
  ERROR, and that no `interactiveUrl` is ever persisted), `src/anchor/anchor-session.spec.ts`
  (SEP-1 / SEP-10 conformance shared by both adapters, and per-memo identity against real signed
  challenges: memo in the challenge URL, one cached JWT per memo, refusal of a `sub` or challenge
  that drops the memo), `src/fx/fx.service.spec.ts` (`anchorRateTRYperUSDC`),
  `src/settlements/settlement-math.spec.ts` (`netSettlementTRY`).
- Live e2e, **SEP-6** (spends ~1 real testnet USDC per run, needs network):
  `SEP6_E2E=1 npm run test:e2e -- sep6` — `GET /fx` reporting `source: anchor`, `settlementMode`,
  `missing_iban`, a block in the 0.5–1.0 USDC band where `/info` and the anchor disagree, then a
  full settlement to `completed` checked on Horizon (`memo_type: id`) with `netTRY` in
  `paidOutTRY`; then, at the anchor, that the withdrawal belongs to the merchant's memo identity
  (`404` for the bare platform login), the SEP-12 customer is stored, and the payout `to` is the
  merchant's IBAN with a bank reference. Skipped unless `SEP6_E2E=1`. Passed 2026-09-16 (5/5).
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
