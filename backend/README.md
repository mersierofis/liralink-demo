# LiraLink Backend

NestJS API that turns a TRY payment link into a USDC-on-Stellar payment, detects it on-chain, and credits the merchant a TRY balance. See `../docs/00-PROJECT.md` for the product/architecture overview and `../docs/01-BACKEND.md` for the full implementation brief. This README covers Phase 1 only (auth, links, quote, payment detection) — Phase 2 (settlement, withdrawals, deploy) is not yet built.

## Run locally

```
nvm use                        # pins Node 22.23.2, see repo-root .nvmrc
docker compose up -d            # Postgres 16 on localhost:5433 (5432 may already be taken locally)
cp .env.example .env            # then fill in PLATFORM_ACCOUNT_SECRET — see below
npx prisma migrate dev
npm run seed                    # idempotent: demo@liralink.app, password = SEED_DEMO_PASSWORD in .env (ask Hasan; never fabricates payments)
npm run demo:reset -- --dry-run # before a demo: drop mock withdrawals, finish mock settlements (drop --dry-run to apply)
npm run start:dev               # /docs (Swagger) at http://localhost:3000/docs
```

### Getting a platform account

The backend needs a funded Stellar testnet keypair with a USDC trustline. If you don't have one yet:

```
stellar keys generate platform --network testnet --fund
stellar keys secret platform     # paste into .env as PLATFORM_ACCOUNT_SECRET
```

The USDC trustline is established automatically on startup if missing (`StellarService.onModuleInit`) — no manual step needed.

## Deploying

**A merge to master is a deploy** (team agreement). The live API
(`https://liralink-api.tutorialplatform.com`, systemd `liralink-api`) runs from the master checkout
on the EC2 host; right after a merge, run `scripts/deploy.sh` there. It refuses to run off master,
then does:

```
git pull --ff-only
npm ci
npx prisma migrate deploy       # + npx prisma generate (Prisma 7 migrate doesn't regenerate the client)
npm run build                   # entrypoint is dist/src/main.js — `npm run start:prod` is stale
sudo systemctl restart liralink-api
```

and waits for `/api/health`. Migrations must stay additive/nullable — they run against live data.

## Architecture

```
merchant-web / pay-web ──REST──▶ NestJS API ──▶ Postgres (Prisma)
                                      │
                                      ├──▶ Horizon (testnet): PaymentListener streams
                                      │    /payments for the platform account, matches
                                      │    memo → link code, credits on match
                                      │
                                      └──▶ FxService (mock rate for Phase 1)
```

The payment rail is a classic Stellar payment (or path payment) to the platform's collection
account, with a **text memo equal to the 8-char link code**. No smart contract is required for
the core flow. See `docs/01-BACKEND.md` §1.6 and the "Toolchain gotchas" section for the
listener's actual matching rules (asset+issuer check, `memo_bytes` comparison, path-payment
handling, idempotency, backoff, reconciliation poll).

## Custody model (hackathon simplification — read before assuming production-readiness)

**One platform account holds all merchant USDC.** Merchant balances are ledger rows in Postgres,
not separate on-chain accounts — there is no on-chain segregation between merchants today. This
is an explicit, documented simplification for the hackathon timeline, not an oversight.

**Regulatory framing:** the payer is always outside Turkey; the merchant only ever sells in TRY
and receives TRY. Turkish rules restricting crypto as a domestic payment instrument are designed
around domestic settlement, which this flow does not touch — the merchant never holds or
transacts in crypto.

## Roadmap (beyond Phase 1)

- **Phase 2**: settlement (USDC→TRY via an anchor adapter — mock now, SEP-24 later), balance,
  withdrawals, Docker deploy + CI.
- **Per-merchant smart accounts** — replace the single-custody-account model above with
  segregated on-chain balances per merchant.
- **Real TRY anchor** — wire `Sep24AnchorAdapter` to a licensed Stellar anchor once one is
  selected (the mock adapter is a drop-in placeholder with the same interface).
- **x402 agentic payments** — `GET /pay/:code/agent` responding `402` with Stellar payment
  requirements, so an AI agent can pay the same link programmatically.
- **DeFindex auto-save** — deposit the `autoSavePercent` portion of each settlement into a
  DeFindex USDC vault instead of just ledgering it.

## Testing

```
npm run lint
npx tsc --noEmit -p tsconfig.build.json
npm test        # unit: code generator, quote rounding, matcher (14 fixtures)
npm run test:e2e  # e2e: auth, links, pay — 25 tests against a real Postgres + live Horizon testnet
```

The e2e suite boots the real `PaymentListenerService`, which opens a live connection to Horizon
testnet — see `docs/01-BACKEND.md`'s toolchain-gotchas section if you hit a "worker failed to
exit gracefully" warning; it's expected and harmless (`--forceExit` is already wired in).

Manual end-to-end verification (what actually proves the core flow works): register → create a
link → pay it with real testnet USDC using the link's code as a text memo → link flips to `paid`
within seconds. See `docs/01-BACKEND.md` §1.7 for the full script; this has been run against real
testnet transactions, not just mocked.
