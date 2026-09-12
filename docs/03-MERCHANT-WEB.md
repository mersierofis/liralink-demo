# LiraLink Merchant Web — Implementation Brief for Claude Code (Vuslat)

> Read `docs/00-PROJECT.md` first. This file tells you how to build `merchant-web/`: the **desktop web app a Turkish merchant/exporter uses** to create payment links, watch payments arrive, see their TRY balance and withdraw to their IBAN.
> Build against the mock API first (`VITE_USE_MOCK=true`); switch to the real backend when Hasan says Phase 1 is green.
> Work in small steps; after each step run `npm run dev` and verify in the browser before continuing.

## Stack (do not deviate)

- **Vite + React 18 + TypeScript (strict)**, desktop-first, responsive down to tablet
- **Tailwind CSS** + **shadcn/ui** (Table, Card, Badge, Dialog, Sheet, Form, Input, Select, Tabs, Toast/Sonner, Skeleton)
- **TanStack Query** (fetching, polling), **react-hook-form + zod** (forms)
- **React Router v6**
- **MSW** for the mock API
- No Next.js, no Redux, no CSS-in-JS. UI language: English.

## Screens

| Route | Screen | What's on it |
|---|---|---|
| `/login`, `/register` | Auth | email/password (+ business name on register). JWT stored in memory + `sessionStorage`. Redirect to `/` when logged in. |
| `/` | **Dashboard** | Balance card: **Available TRY** (big), Pending TRY, Saved USDC (only if > 0). "Create link" primary button. Recent payments (last 5) with live updates (poll every 5 s). Quick stats: links open / paid this week. |
| `/links` | **Links** | Table: code, title, amount TRY, ≈ USDC, status badge (open/paid/expired/cancelled), created, actions (copy URL, open QR, cancel). Filter by status. "Create link" opens a Dialog: title, description, amount TRY (₺ input, 2 dp), expiry (24h default). On success: show the link with **copy button**, **QR code** (`qrcode.react`) and a **"Share on WhatsApp"** button (`https://wa.me/?text=…`). |
| `/links/:id` | **Link detail** | Everything about one link + payment (tx hash, payer address, explorer link) + settlement status timeline (pending → processing → completed). Polls every 3 s while `open`. This is the screen shown on the projector during the demo. |
| `/payments` | **Payments** | Table: date, link title/code, USDC received, fx rate, TRY credited, settlement status, explorer link. |
| `/withdrawals` | **Withdrawals** | Balance summary + "Withdraw" dialog (amount ≤ available, IBAN prefilled from profile, validate `TR` + 24 digits) + history table with status badges. |
| `/settings` | **Settings** | Business name, IBAN, **Auto-save %** slider 0–50 with copy "Keep part of every payment in USDC" (stretch feature; the field exists in the API). |

Global: left sidebar nav, top bar with business name + logout, toast on every mutation, loading skeletons, empty states ("No links yet — create your first one"), error states with retry.

## Demo moment to design for
Link detail page on a projector: status flips from **Open** to **Paid** in real time when Yunus pays from his phone, then settlement steps light up and the balance card increments. Make that transition visibly satisfying (badge color change + subtle animation + toast "Payment received · 5,000.00 TRY"). Don't over-animate elsewhere.

## API usage
All merchant endpoints from `00-PROJECT.md` §6. `src/api/client.ts` adds `Authorization: Bearer`, maps `ApiError`, redirects to `/login` on 401. Hooks in `src/api/hooks.ts`: `useMe`, `useLinks(filters)`, `useLink(id)` (refetchInterval 3000 while open), `useCreateLink`, `useCancelLink`, `useBalance` (refetchInterval 5000), `usePayments`, `useWithdrawals`, `useCreateWithdrawal`, `useUpdateMe`.

Money: render with `Intl.NumberFormat('tr-TR', { style:'currency', currency:'TRY' })` for TRY and `USDC` with 2 dp (tooltip shows 7 dp). Never do math in the UI beyond display.

### Env (`.env.example`)
```
VITE_API_URL=http://localhost:3000/api
VITE_USE_MOCK=true
VITE_EXPLORER_TX_URL=https://stellar.expert/explorer/testnet/tx/
VITE_EXPLORER_ACCOUNT_URL=https://stellar.expert/explorer/testnet/account/
```

## Mock API (MSW) — `src/mocks/handlers.ts`
Implement every merchant endpoint per the contract, stateful in memory:
- Demo merchant `demo@liralink.app / demo1234`, business "Erdemli Narenciye A.Ş.", IBAN `TR330006100519786457841326`.
- 6 links: 2 open, 3 paid (with payments + completed settlements, realistic tx hashes 64-hex, payer addresses `G…`), 1 expired. Titles like "Lemon order #1042 — Al Rashid Trading (Dubai)", "Orange shipment #77 — Berlin Fruchthandel".
- Balance derived from mock settlements/withdrawals.
- Dev toggle: `POST /mock/pay/:id` (mock-only) flips an open link to paid after 2 s and creates settlement `pending → completed` over 6 s — so the demo transition can be rehearsed without the backend. Expose a small "Simulate payment" button on link detail **only when** `VITE_USE_MOCK=true`.

## Project structure
```
src/
  main.tsx, App.tsx (router, providers, MSW boot)
  api/ client.ts, types.ts (copy of docs/api.types.ts), hooks.ts
  auth/ AuthProvider.tsx, RequireAuth.tsx
  layout/ AppShell.tsx, Sidebar.tsx, TopBar.tsx
  pages/ Login, Register, Dashboard, Links, LinkDetail, Payments, Withdrawals, Settings
  components/ BalanceCard, StatusBadge, MoneyTRY, MoneyUSDC, CopyButton, ExplorerLink, CreateLinkDialog, LinkCreatedDialog (URL + QR + WhatsApp), WithdrawDialog, SettlementTimeline, PaymentsTable, LinksTable, EmptyState
  mocks/ handlers.ts, browser.ts, data.ts
```

## Steps (in order)
1. Scaffold + Tailwind + shadcn + router + Query + MSW; `AppShell` with sidebar; `/login` works against mock.
2. Links list + Create link dialog + Link created dialog (copy / QR / WhatsApp). Status badges.
3. Link detail with polling + settlement timeline + "Simulate payment" (mock only). Rehearse the demo transition.
4. Dashboard (balance card + recent payments) and Payments table.
5. Withdrawals + Settings (IBAN validation, auto-save slider).
6. Polish: empty/loading/error states, toasts, keyboard focus, `typecheck` + `lint` clean.
7. Switch to real API (`VITE_USE_MOCK=false`); verify with a real testnet payment made by Yunus.
8. **Pitch deck** (Vuslat owns it): use the official Rise In template; slides: problem (exporter's 3–5 day, 2–4% wire), solution + 30-second demo, why Stellar, anchor + integrations used, regulatory framing (payer abroad, merchant receives TRY), pilot user from Mersin, roadmap (real TRY anchor, per-merchant smart accounts, x402 agents, DeFindex auto-save), team.

## Definition of done
- Full merchant loop on mock and on real API: register → create link → see it paid → balance up → withdraw.
- Link detail transition looks great on a projector at 1080p.
- No blank screens; every list has empty/loading/error states.
- README: run locally, demo credentials, how to simulate a payment in mock mode.
