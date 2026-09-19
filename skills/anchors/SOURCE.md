# Vendored: Stellar anchors skill

Unmodified copies of `SKILL.md`, `README.md`, `LICENSE` and the whole `references/` tree from
https://github.com/CheesecakeLabs/stellar-anchor-skill/tree/be34740f1d81a43e543279eab7544994e17b7c95
(repo head when fetched 2026-09-19; that commit is `main`, dated 2026-07-01), listed on
https://skills.stellar.org/ as the **Anchors** skill and served from
https://raw.githubusercontent.com/CheesecakeLabs/stellar-anchor-skill/main/SKILL.md.
License: Apache-2.0 (`LICENSE`, vendored). Upstream's `CLAUDE.md` is a contributor guide for that
repo, not skill content, and is not vendored.

**This is not an SDF repo.** The handbook calls Anchors an "official" skill, but the directory
lists it under *Community*, authored by Cheesecake Labs. Our earlier search only covered
`stellar/stellar-dev-skill` — the org that holds the eight official skills — which is why we
concluded no `anchors` skill existed (see `skills/standards/SOURCE.md`). That conclusion was right
about `stellar/stellar-dev-skill` and wrong about the ecosystem: each community skill lives in its
own repo, and the directory page is the only index. There is no JSON manifest
(`/index.json`, `/skills.json`, `/api/skills` all 404).

How LiraLink uses it: it is the implementation-layer checklist for the SEP-6 TRY rail — its
13 "Gotchas" and `references/client/sep6-programmatic.md` are the basis of the audit in
`docs/anchor.md` → *Skill review — anchors skill (2026-09-19)*. It is the first source we have that
documents the two SEP-6-only statuses (`pending_customer_info_update`,
`pending_transaction_info_update`) and `PATCH /transactions/{id}`, none of which the adapter
handles — [#38](https://github.com/mersierofis/liralink-demo/issues/38).

Read alongside `skills/standards` (SEP spec text) and `skills/anchor-tr` (this anchor's own
integration guide). Where the three disagree, `docs/anchor.md` records what the running anchor
actually does.

The server half (`references/server/`, `references/testing/`) is vendored for completeness but
unused: LiraLink integrates *with* an anchor, it does not build one.
