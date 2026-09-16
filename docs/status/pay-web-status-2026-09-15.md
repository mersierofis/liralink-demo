# pay-web status — 2026-09-16 (PR #26 review fixes)

Previous: `docs/status/pay-web-status-2026-09-15.md`.

## Done this pass

| Item | Status | Notes |
|---|---|---|
| English TestnetRequiredCard | DONE | Heading, body, steps, button |
| Contract rail only when `status === 'open'` | DONE | Hides on underpaid (full on-chain amount would overpay) |
| Contract sim / wallet rejection errors | DONE | Check `isSimulationError` before wallet; narrow rejection mapping |
| Retry last rail | DONE | ErrorState retries `lastRail` |
| FAILED / StillPending | DONE | Throw on FAILED; `watcher.onSubmitted` → `/submitted` + return hash on StillPending |
| Unfunded ≠ Mainnet | DONE | Horizon miss → Friendbot message (`generic`) |
| Balance/trustline before contract | DONE | Same friendly copy as memo rail |
| Types rebase | DONE | `pay-web/src/api/types.ts` synced from `docs/api.types.ts` |
| invoice-client packaging | DONE | `dist/` untracked; postinstall uses `npm ci`; CI path includes package |
| Scope | DONE | Removed merchant-web status doc; dropped `console.info` tx logs |

## Verify locally

```bash
cd pay-web && npm ci && npm run typecheck && npm run lint && npm test && npm run build
npm run dev  # :5174
```

- Underpaid link: memo only (no contract button).
- Open on-chain link: contract primary + memo fallback.
- Mainnet Freighter: English beta card.
- Unfunded testnet account: Friendbot message (not Mainnet card).
- `VITE_CONTRACT_RAIL=false` requires a **rebuild and redeploy** (Vite inlines env at build time).

## Still open

- Live Freighter contract pay on device (Soroban invoke → receipt `Paid via smart contract`).
