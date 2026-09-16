# Vendored: TR Mock Anchor skill

Unmodified copy of `SKILL.md` from
https://github.com/yigitcangokmen/stellar-hackathon-turkiye/blob/183fe262a2029eb9eae68209e052cbb77a6e8cdb/SKILL.md
(repo head `f06e1ae6` when fetched 2026-09-16; `SKILL.md` itself last changed in `183fe262`,
2026-09-10). It is the official integration skill for the hackathon's TRY anchor, published
alongside the docs at https://stellar-hackathon-turkiye.vercel.app/docs/entegrasyon/skill.
No licence file is declared upstream.

How LiraLink uses it: it is the source for `ANCHOR_PROVIDER=sep6` — the anchor's home domain,
endpoint layout (`/auth`, `/sep6`, `/sep12`, `/sep38`), USDC issuer, treasury address, the
`Memo.id` requirement on the withdraw payment, and the SEP-38 asset identifiers
(`iso4217:TRY`, `stellar:USDC:…`). See `docs/anchor.md` → *SEP-6*.

**Where the anchor disagrees with its own skill/docs** (measured 2026-09-16, both recorded in
`docs/anchor.md` → *Observed on tr-mock-anchor*):

- The skill and the SEP-6 docs page say withdraw minimum **1 USDC**. `GET /sep6/info` advertises
  `min_amount: 0.5` — but the anchor rejects 0.7 USDC with
  `400 {"error":"Minimum off-ramp is 1.0000000 USDC"}`. The adapter therefore treats an
  amount-related 4xx on opening a withdraw as `blockedReason: 'outside_anchor_limits'`, not as a
  transient error.
- `/sep6/info` advertises `max_amount: 300`, but a 301 USDC withdraw was accepted. We enforce the
  advertised maximum anyway.
- The skill's code samples use the SDK 12-era `Server` / `StellarTomlResolver` names; on our
  pinned `@stellar/stellar-sdk` 16.3.0 those are `Horizon.Server` and `StellarToml.Resolver`.

Deposit (TRY → USDC), `simulate-bank-transfer`, SEP-12 KYC and claimable balances are documented
in the skill but unused: LiraLink only ever off-ramps (USDC → TRY).
