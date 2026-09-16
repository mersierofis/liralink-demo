# Demo runbook — Saturday 2026-09-19

One page for demo day. The narrative is `00-PROJECT.md` §3; the wallet setup is `pay-web/README.md`;
swapping to a real anchor is `anchor.md` → *Saturday checklist* (do **not** run that before the demo —
live stays `ANCHOR_PROVIDER=mock` / `settlementMode: balance`).

Live: [merchant panel](https://merchant-web.tutorialplatform.com) ·
[payer page](https://pay-web.tutorialplatform.com) ·
[health](https://liralink-api.tutorialplatform.com/api/health)

## Morning, in order

1. **Free memory on the API box** (13.49.104.115 — it also hosts other projects; 3.8 GB total).
   Stop, as `ec2-user`:
   ```
   sudo systemctl stop russian-stream.service   # port 8081, unrelated project
   sudo systemctl stop mektebim-api.service     # port 8084, unrelated project
   ```
   **Never stop these:** `qrmenu-postgres.service` — despite the name it is the Postgres on 5432
   holding **LiraLink's database**; `liralink-api.service` — the API on 3000; `nginx` — TLS for
   `liralink-api.tutorialplatform.com` (and ~8 other projects' vhosts).
   Restart the two stopped units after the demo. The frontends are on CloudFront/S3, not this box,
   so nothing here can take the UIs down — only the API.
2. **`npm run demo:check`** (read-only, from `backend/`):
   ```
   npm run demo:check -- --api https://liralink-api.tutorialplatform.com/api --payer G...
   ```
   Want `READY`. Exit 1 prints `NOT READY` and one line per problem. Thresholds: payer ≥ 5 USDC,
   platform ≥ 1 USDC. Also confirm the row reads `anchor  mock (balance)`.
3. **`npm run demo:reset`** — read the dry run, then apply:
   ```
   npm run demo:reset           # dry run: prints what would change, writes nothing
   npm run demo:reset -- --yes  # applies it
   ```
   It touches only `demo@liralink.app`: deletes mock withdrawals, completes mock settlements.
   It never touches links, payments or non-mock rows. Writing needs `--yes`, so a bare run is
   always safe to try. Re-run `demo:check` after.
4. **Payer wallet (Yunus's phone):** Freighter on **Testnet**, ≥ 20 USDC and a little XLM, USDC
   trustline to `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`. Setup steps:
   `pay-web/README.md`. 20 USDC covers the demo link plus retries; `demo:check` only enforces 5.
5. **Health is green.** Open the [UptimeRobot dashboard](https://dashboard.uptimerobot.com/monitors)
   — 3 monitors: API health, merchant-web, pay-web. All three must be up. Backup, and the only
   check that shows *why*:
   ```
   curl -s https://liralink-api.tutorialplatform.com/api/health
   ```
   Want `"ok":true`, `"horizon":"up"`, `"listener":"running"`, `"anchor":"mock"`.
6. **Phone on mobile data**, not venue wifi. Turn wifi off on the paying phone.
7. **Log in early:** Vuslat opens the merchant panel as `demo@liralink.app` (password: ask Hasan)
   before going on stage. Hasan opens a terminal in `backend/` on master.

## The demo — 2 minutes

| # | Who | Does | Projector shows |
|---|-----|------|-----------------|
| 1 | Vuslat | Creates a link, e.g. "Lemon order #1042", **340 TRY** (≈ 10 USDC) | Link detail, status `open`, QR + `/p/<CODE>` |
| 2 | Yunus | Opens `/p/<CODE>` on the phone, connects Freighter, pays | Amount in TRY **and** USDC, wallet confirm |
| 3 | — | — | **Money shot:** Vuslat's link flips `open → paid` live, balance credited in TRY |
| 4 | Hasan | From `backend/`, pays a *second* link as an AI agent:<br>`AGENT_SECRET=$(stellar keys secret payer) npm run agent:pay -- --code <CODE> --api https://liralink-api.tutorialplatform.com/api` | `402 Payment Required` → receipt → `PAYMENT-RESPONSE: tx <hash>` → `Link <CODE> is paid` |
| 5 | anyone | Opens the tx | `https://stellar.expert/explorer/testnet/tx/<hash>` — real testnet payment |

Have a second link created and unpaid before you start, so step 4 needs no typing on stage.

## If it breaks

| Symptom | Do this |
|---|---|
| **API down** (health fails, panel errors) | `sudo systemctl restart liralink-api` (~10 s), watch `journalctl -u liralink-api -f`; if it doesn't come back in a minute, stop debugging and show the three recorded rail txs from the root README instead. |
| **Anchor down / settlement stuck** | Nothing to do: live runs the **mock** anchor, so TRY is credited locally and no anchor is involved. If someone switched to `sep24`, roll back — `anchor.md` → *Saturday checklist* step 8 (`ANCHOR_PROVIDER=mock`, restart, keep `ANCHOR_HOME_DOMAIN` set). |
| **Wallet fails** (Freighter won't connect, sign, or no funds) | Skip the phone: Hasan pays the same link with `agent:pay` from the laptop (step 4) — same rail proof, no wallet. Last resort: open an already-paid receipt, `/p/VHHCJ8QZ`. |
| Payment sent but link stays `open` | Check `listener` in `/health`; wrong/missing memo won't match — it lands in `GET /unallocated`. Don't re-pay on stage. |
| Box is swapping / sluggish | Confirm step 1 stopped both units; `free -m` should show ≥ 1 GB available. `liralink-api` runs with `OOMScoreAdjust=-900`, so the kernel kills other projects first. |
