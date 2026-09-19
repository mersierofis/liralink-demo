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

There is no `anchors` skill **in this repo**: `skills/anchors` does not exist at this commit or at
`main` (202be802, checked 2026-09-15) and has no history.

**Corrected 2026-09-19:** we first read that as "no anchors skill exists". It does — as a
*community* skill, in its own repo (`CheesecakeLabs/stellar-anchor-skill`), listed on
https://skills.stellar.org/ and now vendored at `skills/anchors`. Only the eight *official* skills
live in `stellar/stellar-dev-skill`; every community skill has its own repo and the directory page
is the only index. The anchors skill is the implementation layer to this one's spec pointers — see
`skills/anchors/SOURCE.md`.

Relative links to `../smart-contracts/`, `../assets/`, `../dapp/` etc. point at sibling skills that
are not vendored here.
