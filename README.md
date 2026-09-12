# LiraLink

Turkish merchant creates a TRY payment link; a customer abroad pays it in USDC on Stellar testnet; the merchant sees a TRY balance to withdraw to their IBAN. Built for Rise In x Stellar Pro (Istanbul, 19–20 Sept 2026), team MersiErOfis.

Read `docs/00-PROJECT.md` first — it is the shared source of truth for product, architecture, data model and API contract. Then read your own file:

- `docs/01-BACKEND.md` — backend (Hasan)
- `docs/02-PAY-WEB.md` — pay-web (Yunus)
- `docs/03-MERCHANT-WEB.md` — merchant-web (Vuslat)

## Team — MersiErOfis

- **Hasan** — backend + integrations: NestJS API, Stellar Horizon listener, anchor (SEP-24), Soroban invoice contract.
- **Vuslat** — merchant web (React + Vite) and the pitch deck.
- **Yunus** — payer web (React + Vite PWA) with Stellar Wallets Kit.

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
contracts/       Soroban invoice contract (phase 2 — required)
docker-compose.yml   Postgres 16 for local dev
```

## Local Postgres

```
nvm use
docker compose up -d
```

Each app has its own README with its own run instructions.

## Regulatory note

LiraLink is structured as an **export-collection** flow, not a domestic crypto payment. The payer is always **abroad** and pays in USDC from their own wallet; the merchant only ever sells in and receives **Turkish lira** and never touches crypto. Conversion USDC→TRY runs through a **licensed Stellar anchor** — the regulated party in the flow. Turkish rules restricting crypto as a *domestic* payment instrument are designed around domestic settlement, which this flow does not touch.

Custody is a documented hackathon simplification (one platform account holds USDC, merchant balances are ledger rows); the roadmap is **non-custodial** per-link SEP-24 withdrawal so funds go straight to the anchor. This is our engineering framing, **not legal advice — a formal legal opinion will be obtained before any production launch.**

## Stellar skills used

Skill docs applied from the Stellar handbook, under `skills/` (expanded as we integrate more):

- `skills/standards/SKILL.md` — Stellar standards: classic USDC payment with text memo, assets/trustlines, SEP-10 auth.
- `skills/anchors/SKILL.md` — anchor integration: USDC→TRY settlement via SEP-24 withdraw (mock adapter now, real TRY anchor after Workshop #3).
