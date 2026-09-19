# merchant-web status — 2026-09-19

Owner: Vuslat. Supersedes the 2026-09-13 audit (that file only lives on `pay-web/scaffold`). Live:
https://merchant-web.tutorialplatform.com · API https://liralink-api.tutorialplatform.com/api

## Work queue from the 09-13 audit

| # | Item | Status | PR |
|---|---|---|---|
| 1 | Sync `src/api/types.ts` to `docs/api.types.ts` (verbatim) | DONE | #30 |
| 2 | "Complete verification" for `settlement.interactiveUrl` (payments table, dashboard banner, link detail) | DONE — see caveat | #31 (never reached master, stacked on a stale base) → re-landed as #46 |
| 3 | Unallocated USDC detail drawer from the balance card (`GET /unallocated`, uses `summary`) | DONE | #47 |
| 4 | "Retry on-chain" when `onchain === null`; visible progress while creating a link | PR open | #48 |
| 5 | "Send to my wallet" (`POST/GET /usdc-withdrawals`) on Held in USD + Unallocated; replaces the "no way to withdraw yet" copy | PR open | #49 |
| 6 | Per-page `<title>`, remove dev leftovers | PR open | #50 (favicon + base title/description already in #36/#37) |

Merge order does not matter; #48/#49 were rebased onto master after #46/#47 merged (conflicts in
`hooks.ts`, `BalanceCard.tsx`, `mocks/handlers.ts` resolved by keeping both sides).

## Known limits (not verified live)

- **`interactiveUrl` button:** the live anchor is now `sep6` (`/health`), settlements are `mock`/`sep6`,
  and SEP-6 has no interactive form — `interactiveUrl` is `null` on both. The UI is correct against the
  types and mock data but has never rendered against a real waiting settlement.
- **Retry on-chain:** could not force an RPC failure on the live API; verified by types/mock only.
- **Send to my wallet:** a real `POST /usdc-withdrawals` spends testnet USDC from the demo merchant's
  balance, so it was not fired. `GET /usdc-withdrawals` verified live (empty list). Needs one manual
  send with a trustlined wallet and one without (to see the verbatim 422) at 1920×1080.
- `docs/api.types.ts` still says `anchor: 'mock' | 'sep24'` / `provider: 'mock' | 'sep24'`; live returns
  `sep6`. merchant-web reads neither field, so nothing breaks — doc drift for Hasan.

## Contract fidelity

`src/api/types.ts` is byte-identical to `docs/api.types.ts`. Money stays decimal strings end to end:
TRY inputs go through `lib/tryAmount.ts`, USDC withdrawal amounts through `lib/usdcAmount.ts` (Decimal,
exactly 7 dp, never `Number()`).

## Demo checklist

- Demo merchant is `settlementMode: auto_payout` on the live API: balance card shows "Paid out to your
  IBAN", sidebar says "Payouts".
- `demo:check` / demo runbook live in `backend/` and `docs/` (Hasan).
