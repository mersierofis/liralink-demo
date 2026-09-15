# pay-web status — 2026-09-15 (update)

Previous: `docs/status/pay-web-status-2026-09-13.md`. This update reflects Hasan’s Cursor queue (15 Sep).

## Done this pass (branch `pay-web/scaffold` → PR #26)

| Queue item | Status | Commit / notes |
|---|---|---|
| 1 BLOCKER — PR wallet fixes | DONE | https://github.com/mersierofis/liralink-demo/pull/26 — Freighter+xBull, Mainnet beta card, no Connecting hang |
| 2 REQUIRED — QuoteCountdown lock | DONE | `11992a5` — on-chain (`quoteExpiresAt === expiresAt`) → “Rate locked until link expires”; else mm:ss |
| 3 REQUIRED — x402 rail labels | DONE | `8d4557c` — `PayRail` includes `x402`; receipt shows memo/contract/x402 labels |
| 4 REQUIRED — Pay via contract | DONE (code) | `ff627c0` (+ dist follow-up) — primary button when `rails.contract` + `VITE_CONTRACT_RAIL≠false`; memo fallback; errors shown verbatim. **Live Freighter contract pay still unverified on device.** |
| 5 NICE — USDC round 2 dp | DONE | `e01f151` — half-up rounding in `formatUSDCDisplay` |

## Verify locally

```bash
cd pay-web && npm ci && npm run typecheck && npm run lint && npm test && npm run build
npm run dev  # :5174 — 390×844
```

- On-chain open link: no multi-hour countdown; “Rate locked…”.
- `rails.contract` present: primary “Pay … via contract”, secondary memo fallback.
- Mainnet Freighter: beta Testnet card.
- Paid receipt with `rail: memo|contract|x402` shows the matching label.

## Still open / for Hasan

- Phone Freighter **contract** payment end-to-end (needs open on-chain link + USDC trustline).
- If contract rail misbehaves in demo: set `VITE_CONTRACT_RAIL=false`.
- Memo Freighter 1 USDC proof in team chat: still ops/unverified here.
