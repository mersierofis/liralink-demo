# Vendored: Stellar standards skill

Unmodified copies of `SKILL.md`, `ecosystem.md` and `resources.md` from
https://github.com/stellar/stellar-dev-skill/tree/1f57ed1a2b67e9f6e0adedc8f7897ea4935902a6/skills/standards
(also served at https://skills.stellar.org/skills/standards/SKILL.md), fetched 2026-09-15 — the same
commit as `skills/agentic-payments`. License: Apache-2.0 (upstream repo).

How LiraLink uses it: the anchor section of `SKILL.md` ("I need anchor integration for fiat rails")
routed us to SEP-24 (hosted interactive withdraw), with SEP-1 (`stellar.toml`) and SEP-10 (web auth)
as its prerequisites. The adapter was reviewed against those specs directly — see
`docs/anchor.md` → *Spec review*. SEP-6, SEP-12, SEP-31 and `ecosystem.md` / `resources.md` are
vendored for completeness but not used.

There is **no `anchors` skill** upstream: `skills/anchors` does not exist at this commit or at
`main` (202be802, checked 2026-09-15) and has no history. Anchor guidance lives in this skill.

Relative links to `../smart-contracts/`, `../assets/`, `../dapp/` etc. point at sibling skills that
are not vendored here.
