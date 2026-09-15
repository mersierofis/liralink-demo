# pay-web status — 2026-09-13

Auditor: Yunus (local branch `pay-web/scaffold` @ `1eb37dd`). Live: https://pay-web.tutorialplatform.com · API https://liralink-api.tutorialplatform.com/api  
Note: `origin/master` still has older pay-web sources (`allowAllModules` + "Contract rail available…" label). Live bundle **does** contain `TestnetRequiredCard` ("Bu bir beta…") — deploy/git tip may be ahead of master. Unmerged branch commits: `b1d3160`, `1eb37dd`.

## 1. Summary

End-to-end memo-rail works: open quote → Freighter/xBull → USDC + `rails.memo` → `/submitted` → poll `/status` → receipt; underpaid + Mainnet beta card handled on current branch/live.
Demo blockers: **`rails.contract` is not a real pay path** (memo only); **master/source drift** (wallet fixes may not be on master); phone E2E 1 USDC proof in team chat = unverified.
Cosmetic: `formatUSDCDisplay` truncates (not rounds); QuoteCountdown can show huge `HH:MM:SS` when `quoteExpiresAt === expiresAt` (on-chain lock); Sheet UI unused.

## 2. Build-order (`docs/02-PAY-WEB.md`)

| Step | Status | Evidence |
|---|---|---|
| 1 Scaffold (Vite/React/Tailwind/shadcn/Query/PWA/MSW) | DONE | `pay-web/package.json`, `vite.config.ts` (PWA), `src/main.tsx` MSW boot |
| 2 Quote + statuses (open/paid/expired/cancelled + underpaid) | DONE | `PayPage.tsx` StatusBadge; `AmountDisplay.tsx`; live `/p/VHHCJ8QZ` paid |
| 3 Wallet connect + USDC balance | DONE | `walletKit.ts` Freighter+xBull; `useWallet.ts`; `WalletButton.tsx` Horizon balance |
| 4 Pay build/sign/submit/poll | DONE | `buildPayment.ts` (`rails.memo`); `PayPage.runPay`; `usePayStatus` 2s |
| 5 Errors + polish | DONE | Mainnet → `TestnetRequiredCard`; reject/Horizon errors; skeletons; copy/share |
| 6 Real backend | DONE | `.env` → tutorialplatform API; MSW optional |

## 3. Handoff checklist (`docs/04` §5 Yunus)

| Item | Status | Evidence |
|---|---|---|
| Copy `api.types.ts` → `src/api/types.ts` | DONE | byte-match vs local `docs/api.types.ts` (`diff -q` clean) |
| `destination`/`memo` from `q.rails.memo`; sdk `16.3.0` | DONE | `buildPayment.ts`; `package.json` pin |
| MSW DEMO0001–4 (+5 underpaid) | DONE | `mocks/data.ts`, `?mockpay=1` |
| States + underpaid + network mismatch | DONE | `PayPage` + `TestnetRequiredCard` |
| E2E 1 USDC tx hash in chat | unverified | Hasan’s earlier VHHCJ8QZ was script-paid; Freighter phone proof not confirmed here |
| `rails.contract` primary + memo fallback | MISSING | Types/slot only; no `invoice.pay` / Pay-via-contract button |
| Rail label `x402` | MISSING | `PayRail` is `'contract' \| 'memo'` only; no UI for agent rail |

## 4. Contract deviations

- none vs `docs/api.types.ts` field names used in pay calls.
- Spec example in `02-PAY-WEB.md` still shows top-level `q.destination`/`q.memo` (stale doc); **code is correct**.

## 5. Money / state / polling

- Money: `Number(balance) < Number(amount)` in `buildPayment.ts` (compare only); `formatTRY` uses `Number` for Intl. No UI arithmetic on quotes.
- USDC display: 2 dp truncate (`formatUSDCDisplay`); full string in `title` / tx amount via `payAmountUSDC`.
- Screens: `/` NotFound; `/p/:code` loading/error/expired/cancelled/paid/underpaid — covered.
- Polling: `usePayStatus` every **2s**, stops on `paid`/`expired`/`cancelled`; continues while `underpaid` or paying.

## 6. Demo readiness

- Title `LiraLink Pay`, favicon/PWA present.
- Live: beta Mainnet card present in bundle; Contract-rail label **gone** on live (still on `origin/master` source).
- Mobile 390×844: card `max-w-[420px]` — unverified visually this pass.
- Console on Mainnet connect: should be clean on branch (errors caught); unverified on old master build.

CI: pay-web workflow green on recent master pushes. Local `typecheck`/`test` last run on branch: pass. `npm run build` this pass: unverified.

## 7. Work queue (next 3 days)

1. **BLOCKER** — Merge/rebase `pay-web/scaffold` (`b1d3160`+`1eb37dd`) into master so source == live. Touch: PR only.
2. **BLOCKER** — One Freighter phone payment on an `open` link; paste tx hash in chat. Touch: none (ops).
3. **REQUIRED** — Implement memo-primary with optional **Pay via contract** when `rails.contract` set (`packages/invoice-client`). Touch: `PayPage.tsx`, `buildPayment.ts` or new `buildContractPay.ts`.
4. **REQUIRED** — Cap QuoteCountdown at mm:ss or hide when TTL == link expiry. Touch: `QuoteCountdown.tsx`, `AmountDisplay.tsx`.
5. **NICE** — Round USDC display to 2 dp (not truncate). Touch: `stellar/format.ts`.
6. **NICE** — Drop unused Sheet; shrink wallet modules already done on branch.
