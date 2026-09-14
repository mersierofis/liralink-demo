# LiraLink Pay Web — Implementation Brief for Cursor (Yunus)

> Read `docs/00-PROJECT.md` first. This file tells you how to build `pay-web/`: the page a **foreign customer opens on their phone** to pay a LiraLink payment link with USDC on Stellar testnet.
> Build against the mock API first (`VITE_USE_MOCK=true`); switch to the real backend when Hasan says Phase 1 is green.
> Work in small steps. After each step, run `npm run dev`, open the page on a phone-sized viewport, and verify what changed before continuing.

## Stack (do not deviate)

- **Vite + React 19 + TypeScript (strict)**, mobile-first, PWA (`vite-plugin-pwa`) so it installs to the home screen and looks native on the demo phone
- **Tailwind CSS** + **shadcn/ui** (Button, Card, Badge, Skeleton, Alert, Sheet)
- **TanStack Query** for fetching + polling
- **React Router v6** — routes: `/p/:code` (payment page), `/` (redirect to a "no link" explainer)
- **@creit.tech/stellar-wallets-kit** — wallet connect (Freighter, xBull, Albedo, etc.) — this is our eligible "Stellar Wallets Kit" integration
- **@stellar/stellar-sdk@16.3.0** (pinned, must match the backend's major — see `00-PROJECT.md` §8; do not take 17.x, it rewrites Buffer→Uint8Array and the XDR namespace) — build the payment transaction; the wallet signs it
- **MSW** for the mock API
- No Next.js, no Redux, no CSS-in-JS

## What the page does (the whole product in 4 states)

1. **Quote** — link opened: merchant name, title, `5,000.00 TRY`, `≈ 147.0588236 USDC` (show 2 dp: `≈ 147.06 USDC`, full precision in the tx), fx rate, "quote refreshes in 09:41", **Connect wallet** button.
2. **Ready** — wallet connected: short address `GABC…XYZ`, USDC balance (or a warning "No USDC trustline / balance" with a link to faucet.circle.com on testnet), **Pay 147.06 USDC** button.
3. **Paying** — tx signed and submitted: spinner, "Confirming on Stellar… (~5 s)"; poll `GET /pay/:code/status` every 2 s.
4. **Paid** — big check, "Paid to <merchant>", amount, tx hash (copy), **View on Stellar.Expert**, "Share receipt" (Web Share API, fallback copy).

Terminal/error states: `expired`, `cancelled`, `already paid` (show receipt), `not found`, wallet rejected signature, submission failed (show Horizon error, allow retry), network mismatch (wallet on mainnet → block with clear message).

## Data flow

```
GET /api/pay/:code  → PayQuote { amountUSDC, rails: { memo: { destination, memo }, contract? }, asset, quoteExpiresAt, status, ... }
[Connect wallet]    → StellarWalletsKit.openModal → getAddress()
[Pay]               → build tx (see below) → kit.signTransaction(xdr) → horizon.submitTransaction
                    → POST /api/pay/:code/submitted { txHash }   (fire-and-forget hint)
                    → poll GET /api/pay/:code/status until status === 'paid'
```

### Building the payment transaction (`src/stellar/buildPayment.ts`)

```ts
import { Horizon, TransactionBuilder, Operation, Asset, Memo, BASE_FEE, Networks } from '@stellar/stellar-sdk';

export async function buildPaymentXdr(q: PayQuote, source: string) {
  const server = new Horizon.Server(import.meta.env.VITE_HORIZON_URL);
  const account = await server.loadAccount(source);            // throws if unfunded → show "account not funded"
  const usdc = new Asset(q.asset.code, q.asset.issuer);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: q.rails.memo!.destination, asset: usdc, amount: q.amountUSDC })) // rails.memo is always present
    .addMemo(Memo.text(q.rails.memo!.memo))                      // memo = link code — REQUIRED, backend matches on it
    .setTimeout(180)
    .build();
  return tx.toXDR();
}
```
Amount must be a string with ≤ 7 dp. **Never drop the memo** — without it the backend cannot match the payment.

Before building, check the source account's balances for the USDC trustline; if missing, show the trustline warning (do not try to add it for the user — keep scope small).

### Wallet kit setup (`src/stellar/walletKit.ts`)
Singleton `StellarWalletsKit` with `network: WalletNetwork.TESTNET`, `selectedWalletId: FREIGHTER_ID`, `modules: allowAllModules()`. Persist selected wallet id in memory only. Provide a `useWallet()` hook: `{ address, connect, disconnect, signXdr }`.

### Env (`.env.example`)
```
VITE_API_URL=http://localhost:3000/api
VITE_USE_MOCK=true
VITE_HORIZON_URL=https://horizon-testnet.stellar.org
VITE_EXPLORER_TX_URL=https://stellar.expert/explorer/testnet/tx/
```

## Mock API (MSW) — `src/mocks/handlers.ts`
Implement `GET /pay/:code`, `POST /pay/:code/submitted`, `GET /pay/:code/status` exactly per `00-PROJECT.md` §6. Seed codes:
- `DEMO0001` open, 5,000.00 TRY, merchant "Erdemli Narenciye A.Ş.", title "Lemon order #1042"
- `DEMO0002` paid (with fake tx hash + explorer url)
- `DEMO0003` expired · `DEMO0004` cancelled
In mock mode, after `POST /submitted`, flip `DEMO0001` to `paid` after 3 polls so the Paying → Paid path is testable without a wallet. Also add a `?mockpay=1` dev toggle that skips the wallet and calls `/submitted` with a fake hash.

## Project structure
```
src/
  main.tsx, App.tsx (router, QueryClientProvider, MSW boot when VITE_USE_MOCK)
  api/ client.ts (fetch wrapper, ApiError), types.ts (copy of docs/api.types.ts), hooks.ts (usePayQuote, usePayStatus, useSubmitted)
  stellar/ walletKit.ts, buildPayment.ts, useWallet.ts, format.ts (short address, money)
  pages/ PayPage.tsx, NotFoundPage.tsx
  components/ QuoteCard, MerchantHeader, AmountDisplay, WalletButton, PayButton, PayingState, PaidReceipt, ErrorState, QuoteCountdown
  mocks/ handlers.ts, browser.ts, data.ts
```

## Steps (do them in order)

1. **Scaffold**: Vite React-TS, Tailwind, shadcn init, PWA plugin (name "LiraLink Pay", theme color, icons), router, TanStack Query, MSW wired behind `VITE_USE_MOCK`. `npm run dev` shows a placeholder at `/p/DEMO0001`.
2. **Quote state** with mock data: layout, amount display, countdown, all four link statuses render correctly. Mobile viewport 390×844 looks right; desktop shows the card centered max-w 420px.
3. **Wallet connect**: Freighter installed in your browser and set to **Testnet**; fund the account at lab.stellar.org; add USDC trustline and get testnet USDC from faucet.circle.com. `Connect wallet` shows the address and USDC balance read from Horizon.
4. **Pay**: build → sign → submit → `/submitted` → polling → Paid. Test first against mock `/status` (flip after 3 polls), then with the real backend when available.
5. **Errors + polish**: every error state above; copy buttons; share receipt; explorer link; loading skeletons; `npm run typecheck && npm run lint` clean.
6. **Real backend**: `VITE_USE_MOCK=false`, `VITE_API_URL=https://api.<domain>/api`. Make one real 1 USDC payment end to end and paste the tx hash in the team chat.

## Definition of done
- On a phone: open link → connect Freighter → pay → receipt, under 60 s, without touching the laptop.
- All link statuses and error states are handled, no blank screens.
- Works installed as PWA on the demo phone.
- README with setup (Freighter testnet, faucet steps) so anyone can reproduce.
