# LiraLink

Turkish merchant creates a TRY payment link; a customer abroad pays it in USDC on Stellar testnet; the merchant sees a TRY balance to withdraw to their IBAN. Built for Rise In x Stellar Pro (Istanbul, 19–20 Sept 2026), team MersiErOfis.

Read `docs/00-PROJECT.md` first — it is the shared source of truth for product, architecture, data model and API contract. Then read your own file:

- `docs/01-BACKEND.md` — backend (Hasan)
- `docs/02-PAY-WEB.md` — pay-web (Yunus)
- `docs/03-MERCHANT-WEB.md` — merchant-web (Vuslat)

## Toolchain (binding on all three apps)

- Node **22.23.2** — run `nvm use` (reads the root `.nvmrc`) before installing anything.
- `@stellar/stellar-sdk@16.3.0` in both `backend/` and `pay-web/` — must match major versions; the backend's payment listener parses the transactions pay-web builds.

See `docs/00-PROJECT.md` §8 for the full pinned-toolchain table and the reasoning behind each pin.

## Layout

```
docs/            product + per-app specs, docs/api.types.ts (generated backend DTOs)
backend/         NestJS (Hasan)
merchant-web/    React + Vite (Vuslat)
pay-web/         React + Vite PWA (Yunus)
contracts/       Soroban invoice contract (phase 3)
docker-compose.yml   Postgres 16 for local dev
```

## Local Postgres

```
nvm use
docker compose up -d
```

Each app has its own README with its own run instructions.
