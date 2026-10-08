# Local setup (Stellar testnet only)

Everything runs on your machine. The old EC2 host is gone; `backend/scripts/deploy.sh` and `docs/demo-runbook.md` no longer apply.

## Prerequisites
- Node 22.23.2 (`nvm use`), Docker Desktop running, Stellar CLI 28, Rust with the `wasm32v1-none` target.

## First-time setup
```bash
nvm use
make install     # npm ci in backend, merchant-web, pay-web + prisma generate
make keys        # .env files, funded testnet keypairs (liralink-local-platform / -payer), USDC trustlines
make contract    # builds + deploys the invoice contract with the local platform account as admin
make db          # starts Postgres (localhost:5434), migrates, seeds
```
Then fund the payer with testnet USDC at https://faucet.circle.com (Stellar, Testnet). The script prints the address.
The demo login is `demo@liralink.app` with `SEED_DEMO_PASSWORD` from `backend/.env`.

## Every day
```bash
cd ~/Desktop/liralink && nvm use && make dev
```
| Service | URL |
|---|---|
| backend (Swagger at `/docs`) | http://localhost:3000/api |
| merchant-web | http://localhost:5173 |
| pay-web | http://localhost:5174 |
| Postgres | localhost:5434 (volume `liralink_pgdata`) |

The mock anchor is in-process (`ANCHOR_PROVIDER=mock`); it has no port of its own.

## Reset
`make reset` drops the local database, re-applies migrations and re-seeds.

## Verify the flow
1. Log in as the demo merchant and create a link (`POST /api/links`); `onchain` should contain a contract id and tx hash.
2. Memo rail: `cd backend && npm run pay:memo -- --secret <payer secret> --to <rails.memo.destination> --amount <amountUSDC> --memo <code>`.
3. Contract rail: `stellar contract invoke --id <contract> --source-account liralink-local-payer --network testnet -- pay --code <code> --payer <payer address>`.
4. `GET /api/pay/<code>` shows `paid`; `/api/settlements` and `/api/balance` show the mock settlement completed.

## Troubleshooting
- `port is already allocated`: another container holds the port; change the host port in `docker-compose.yml` and `DATABASE_URL`.
- Testnet resets periodically: rerun `make keys contract db` and refund the payer.
- Secrets live only in gitignored `.env` files and the Stellar CLI keystore.
