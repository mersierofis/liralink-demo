# merchant-web status — 2026-09-13

Auditor: Yunus (read-only audit of workspace `merchant-web/` + `origin/master`). Live: https://merchant-web.tutorialplatform.com · API https://liralink-api.tutorialplatform.com/api  
Companion image note (Hasan→Vuslat): upcoming `POST/GET /usdc-withdrawals` + “Send to my wallet” on Held/Unallocated cards — **not in FE yet**; keep placeholder copy until that backend PR merges.

## 1. Summary

Merchant loop works: auth → create/list/detail links → dashboard balance/payments → TRY withdrawals; `settlementMode` / `paidOutTRY` / `netTRY`+`feeUSDC` / underpaid labels / password change are in code.
Demo blockers: **no `interactiveUrl` “Complete verification” UX**; **no `GET /unallocated` detail list** (dashboard shows figure only); **no Retry on-chain** when `onchain: null`; types file **behind** `docs/api.types.ts`.
Cosmetic / pending: “Held in USD…” copy stays until USDC-withdrawal PR; pitch deck unverified.

## 2. Build-order (`docs/03-MERCHANT-WEB.md`)

| Step | Status | Evidence |
|---|---|---|
| 1 Scaffold + AppShell + login/mock | DONE | `App.tsx`, `layout/AppShell.tsx`, `pages/Login.tsx`, MSW |
| 2 Links + create + QR/WhatsApp | DONE | `Links.tsx`, `CreateLinkDialog.tsx`, `LinkCreatedDialog.tsx` |
| 3 Link detail poll + timeline + Simulate | DONE | `LinkDetail.tsx` 3s while open/underpaid; toast on paid; mock simulate |
| 4 Dashboard + Payments | DONE | `Dashboard.tsx`, `BalanceCard.tsx`, `Payments.tsx`, `PaymentsTable.tsx` |
| 5 Withdrawals + Settings | DONE | `Withdrawals.tsx`, `WithdrawDialog.tsx`, `Settings.tsx`, `PasswordChangeCard.tsx` |
| 6 Polish loading/empty/error | DONE | Lists use Skeleton/EmptyState/ErrorState |
| 7 Real API | DONE | Live site 200; `.env.example` `VITE_API_URL` |
| 8 Pitch deck | unverified | Not in repo |

## 3. Handoff checklist (`docs/04` §5 Vuslat)

| Item | Status | Evidence |
|---|---|---|
| Copy `api.types.ts` | PARTIAL | Present but **missing** `Settlement.interactiveUrl`, `UnallocatedCredit`, `/unallocated` paginated comment vs `docs/api.types.ts` |
| Auth + `/me` + `/links` + detail poll 3s | DONE | hooks + `LinkDetail` `refetchInterval` 3000 on open/underpaid |
| Balance / payments / settlements / withdrawals | DONE | hooks; Withdrawals page; Dashboard polls 5s |
| `amountTRY` exactly 2 dp on create | DONE | `lib/tryAmount.ts` (avoids `Number().toFixed`) |
| `settlementMode` → hide withdraw / Paid out TRY / Paid to IBAN | DONE | `Sidebar.tsx`, `BalanceCard.tsx`, `Withdrawals.tsx`, `PaymentsTable.tsx` |
| Show `netTRY`; `feeUSDC` when > 0 | DONE | `PaymentsTable` + `RecentPayments` + Decimal |
| Complete verification (`interactiveUrl`) | MISSING | no references in `merchant-web/src` |
| Unallocated detail `GET /unallocated` | MISSING | `BalanceCard` shows amount only; no route/hook/list |
| Settings password `PATCH /me` | DONE | `PasswordChangeCard.tsx`; 403 inline |
| Demo credentials | unverified | password not in repo (ask Hasan) |
| Projector open→paid | DONE | `LinkDetail` toast; polling while open/underpaid |
| Retry on-chain `POST /links/:id/onchain` | MISSING | `onchain` in types/mocks only |
| USDC “Send to my wallet” (`/usdc-withdrawals`) | MISSING | backend not in FE contract yet; placeholder copy on Saved USDC |

## 4. Contract deviations

- `merchant-web/src/api/types.ts` **lags** `docs/api.types.ts`: no `interactiveUrl`, no `UnallocatedCredit`.
- Invented FE fields: none spotted beyond docs for implemented screens.
- Mock math uses `Number(...)` in `mocks/data.ts` / handlers (mock-only).

## 5. Money / state / polling

- Display: `lib/money.ts` TRY via `Intl tr-TR`; USDC 2 dp + full tooltip; Decimal for comparisons.
- Create link: `expiresInHours: Number(values.expiresInHours)` (hours, not money) — OK.
- Screens: Login/Register/Dashboard/Links/LinkDetail/Payments/Withdrawals/Settings — loading/empty/error generally present.
- Polling: `useBalance`/`usePayments`/`useMe`-related **5s**; `useLink` **3s** while open/underpaid then stops; Withdrawals list no aggressive poll (OK).

## 6. Demo readiness

- Live merchant-web HTTP 200; title/favicon unverified this pass.
- Projector path: Link detail badge + toast ready.
- Leftover: Saved USDC helper text (“Held by LiraLink…”) intentional until Send button.
- CI: merchant-web workflow green on recent master pushes (often skipped when path filter false). Local typecheck this pass: unverified.

## 7. Work queue (next 3 days)

1. **BLOCKER** — Sync `src/api/types.ts` from `docs/api.types.ts`. Touch: `merchant-web/src/api/types.ts`.
2. **BLOCKER** — `interactiveUrl`: “Complete verification” on payments (+ dashboard banner); poll ~10s while any non-null. Touch: `PaymentsTable.tsx`, `Dashboard.tsx`, hooks.
3. **REQUIRED** — Unallocated page/drawer from `GET /unallocated` linked from BalanceCard. Touch: new page + `hooks.ts` + `BalanceCard.tsx`.
4. **REQUIRED** — Link detail/list: Retry on-chain when `onchain === null`. Touch: `LinkDetail.tsx`, `hooks.ts`.
5. **REQUIRED** (after Hasan PR) — Wire `POST/GET /usdc-withdrawals` → “Send to my wallet” on Held + Unallocated. Touch: `BalanceCard.tsx`, new dialog.
6. **NICE** — Pitch deck dry-run; confirm demo password with Hasan.
