# Hackathon docs — notes

Notes on the five "pro" and partner pages of the Rise In × Stellar hackathon docs
(<https://stellar-hackathon-turkiye.vercel.app>), read 2026-09-16 to check whether anything in
them changes the LiraLink plan.

Each page was fetched as raw markdown (`curl -sL <url>.md` — the plain URL serves only the
Next.js shell). Every bullet comes from the fetched text; the pages are short (39–156 lines), so
specifics that are simply absent — contract addresses, fee figures, deadlines, prize rules — are
marked as absent rather than guessed. The integration pages we actually build against (SEP-6,
tam-akış, skill) are covered in [`anchor.md`](anchor.md) and
[`../skills/anchor-tr/SOURCE.md`](../skills/anchor-tr/SOURCE.md), not here.

## Smart Contract + Anchor Kompozisyonu

Source: <https://stellar-hackathon-turkiye.vercel.app/docs/pro/smart-contract-kompozisyon>

- Framed as "the most effective way to satisfy the **core feature** requirement": combine anchor integration with Soroban contracts. A strong recommendation, not a written prize rule.
- Jury rubric wording: the integration must be *part of the product's business logic*, not a bolt-on deposit/withdraw.
- Scoring table: "TRY deposit → USDC" = anchor only; "transact with USDC" = contract only; "TRY deposit, auto-placed into DeFi" = **kompozisyon** (the one that counts).
- Reference architecture: user → SEP-6 deposit TRY → anchor → USDC to the user's account → Soroban call deposits USDC into a vault contract → yield → withdraw → SEP-6 TRY payout.
- Full Rust vault contract given: `#![no_std]`, `use soroban_sdk::{contract, contractimpl, token, Address, Env};`, `pub struct Vault`.
- Signatures: `deposit(env: Env, user: Address, amount: i128)`, `balance(env: Env, user: Address) -> i128`, `withdraw(env: Env, user: Address, amount: i128)`.
- Pattern inside: `user.require_auth();`, then `token::Client::new(...)` and `transfer(&user, &env.current_contract_address(), &amount)`.
- Balances in `env.storage().persistent()` keyed by `Address`; withdraw asserts `current >= amount` ("Yetersiz bakiye").
- Frontend: `contract.call('deposit', publicKey, '100000000')` inside a normal `TransactionBuilder`.
- Amount encoding: the page comments `'100000000'` as "100 USDC (7 decimals)" — **wrong by 10×**; 1e8 stroops at 7 dp is 10 USDC. Don't copy the literal.
- Storage TTL warning: `instance` shares the contract's lifetime, `persistent` has its own TTL and **must be extended**, `temporary` is auto-deleted.
- Points at the `smart-contracts` skill's TTL section as required reading.
- No contract addresses, fee schedule or deadline on this page.

**Impact on LiraLink:** we already have the shape the jury rewards — Soroban invoice contract on one side, anchor settlement on the other. The gap is presentational: show the contract call on the *same* path as the anchor settlement, not as a parallel demo.

## Wallet SDK ile Entegrasyon

Source: <https://stellar-hackathon-turkiye.vercel.app/docs/pro/wallet-sdk>

- Core package: `npm install @stellar/typescript-wallet-sdk` — wraps every SEP flow instead of hand-rolled HTTP.
- `const wallet = Wallet.TestNet();`, `const anchor = wallet.anchor({ homeDomain: 'tr-mock-anchor.fly.dev' });`.
- Auth: `SigningKeypair.fromSecret('S...')`, then `await anchor.sep10().authenticate({ accountKp })` → `authToken`.
- Deposit: `await anchor.sep6().deposit({ authToken, params: { asset_code, account, amount } })`.
- Mapping (manual → SDK): toml fetch/parse → `wallet.anchor({ homeDomain })`; challenge+sign+token → `anchor.sep10().authenticate()`; KYC → `anchor.sep12()`; quote → `anchor.sep38()`; transfer → `anchor.sep6()`.
- Freighter: `isConnected` / `getPublicKey` / `signTransaction` from `@stellar/freighter-api`; signing needs the passphrase verbatim.
- Multi-wallet: `@creit.tech/stellar-wallets-kit`, `new StellarWalletsKit({ network: WalletNetwork.TESTNET, ... })`, `kit.openModal(...)`.
- Passkey / smart-wallet path: `passkey-kit`.
- No versions pinned, no fees, no deadlines on this page.

**Impact on LiraLink:** the SDK would replace most of `backend/src/anchor`, including the SEP-24 form-encoding workaround from PR #27. Not worth doing now — our SEP-6 and SEP-24 adapters are built, tested and passing live, and the docs only demonstrate SEP-6. Worth noting as the migration path if the hand-rolled HTTP becomes a maintenance problem.

## SEP Standartları ve Gerçek Dünyaya Geçiş

Source: <https://stellar-hackathon-turkiye.vercel.app/docs/pro/mainnet-gecis>

- Explicit: the mock anchor is a **testnet tool**, does not work on mainnet, never touches real money.
- The SEPs taught (1, 6, 10, 12, 38) are universal, so the knowledge transfers to any real anchor.
- Mock vs real comparison — network, money, bank integration, KYC, licensing, domain all differ.
- Near-verbatim warning: there is no such thing as "migrating to mainnet by changing the domain"; a real anchor is a different service with different infrastructure and requirements.
- Judging focus, in order: (1) a working testnet integration with correct SEP flows, (2) clean code — correct SEP step ordering and **error handling**, (3) UX where the user can follow the deposit/withdraw flow, (4) core feature — the anchor wired meaningfully into the product.
- Closing line: **"Mainnet deploy hackathon için gerekli değil"** — mainnet deploy is not required.
- **No mainnet deadline, date, checklist or requirement appears anywhere on this page.**

**Impact on LiraLink:** confirms the testnet-only decision costs nothing in judging. Judging item 2 (SEP error handling) is worth more than any mainnet work — relevant to the open error-handling gap tracked in [#23](https://github.com/mersierofis/liralink-demo/issues/23).

## DeFindex

Source: <https://stellar-hackathon-turkiye.vercel.app/docs/partnerler/defindex>

- A **vault aggregator / yield layer** on Stellar: deposit assets into managed vaults, earn yield.
- Features: vaults combining multiple strategies, automatic rebalancing, simple deposit/withdraw.
- Install: `npm install @defindex/sdk`.
- The "Temel Kullanım" code block is a **placeholder only** — two comment lines. No function names, no vault contract IDs, no APY or fee data.
- Composition recipe (6 steps): SEP-6 TRY deposit → USDC → deposit into a DeFindex vault → automatic yield → withdraw on demand → SEP-6 TRY withdraw.
- Resources: docs.defindex.io, /quickstart, /api, Discord.
- Points at a local `skills/defindex-sdk/SKILL.md` (not vendored in this repo).

**Impact on LiraLink:** the vault pattern maps onto holding merchant USDC between settlement and payout — close to our existing `autoSavePercent` / `savedUSDC` ledger, which is exactly the "auto-placed into DeFi" row of the scoring table. But this page carries no usable API, so "integrate DeFindex" is unestimatable without a spike.

## Soroswap

Source: <https://stellar-hackathon-turkiye.vercel.app/docs/partnerler/soroswap>

- A **liquidity aggregator** across Soroban pools and the classic Stellar DEX.
- Routing API: `https://api.soroswap.finance/optimal-route`, params `amount`, `tokenIn`, `tokenOut`, `network`.
- Example: `amount: '1000000000'` (= 100 USDC at 7 dp, correct here), `tokenIn`/`tokenOut` as contract IDs, `network: 'testnet'`.
- Response fields used: `route.amountOut` (best price) and `route.path` (hop path).
- On-chain swap through `new Contract('SOROSWAP_ROUTER_CONTRACT_ID')` — the real router ID is a **placeholder**, not given.
- Call: `swap_exact_tokens_for_tokens(amountIn, amountOutMin, path, userAddress, deadline)` — Uniswap-V2-style args.
- Composition recipe: SEP-6 TRY deposit → USDC → swap on Soroswap or provide liquidity → convert back to TRY via the anchor on withdraw.
- Resources: docs.soroswap.finance, api.soroswap.finance/docs, Discord; local `skills/soroswap-sdk/SKILL.md` (not vendored here).
- No contract addresses, no swap fee/bps figures, no deadlines.

**Impact on LiraLink:** Soroswap is token→token only. **It cannot do USDC→TRY** — lira only ever comes from the anchor — so it could only ever be an optional leg *before* the anchor withdrawal, not a replacement for it.

## Flagged — what this changes

**1. Contract + anchor composition is rewarded, but is not a stated hard requirement.**
The composition page calls it "the most effective way" to satisfy the core-feature requirement, and mainnet-geçiş lists "wire the anchor meaningfully into your product" as judging item 4. Neither says composition *gates* a prize or track, and no prize-rules page was in scope. Treat it as a scoring lever, not a gate. The jury's named failure mode is an anchor bolted *beside* the product as mere deposit/withdraw — so the demo should show the invoice contract and the anchor settlement on one path, which is what LiraLink already does (link → `invoice.pay` → settlement → SEP-6 withdrawal).

**2. Soroswap cannot do the TRY leg.** Corrects any assumption otherwise. Reusable if we ever want a pre-payout swap:

```js
const route = await (await fetch(
  'https://api.soroswap.finance/optimal-route?' + new URLSearchParams({
    amount: '1000000000',      // 100 USDC (7 decimals)
    tokenIn: 'USDC_CONTRACT_ID',
    tokenOut: 'XLM_CONTRACT_ID',
    network: 'testnet',
  })
)).json();
// route.amountOut, route.path

routerContract.call(
  'swap_exact_tokens_for_tokens',
  amountIn, amountOutMin, path, userAddress, deadline,
);
```

Router and token contract IDs are placeholders upstream; real testnet IDs would have to come from docs.soroswap.finance. If a swap leg ever sat between USDC receipt and TRY payout, `amountOutMin` (slippage floor) and `deadline` would both have to surface in the `feeUSDC` / `netTRY` math in [`anchor.md`](anchor.md).

**3. Mainnet: no deadline, no requirement, explicitly not needed.** Nothing in this source sets a date. Time reserved for a mainnet gate is better spent on SEP error handling and deposit/withdraw UX, both named judging criteria.

**4. DeFindex: pattern yes, API no.** The 6-step recipe is the shape of a merchant float between settlement and payout, but the page's code block is an empty placeholder — no SDK surface, no vault IDs, no fees. Needs a spike against docs.defindex.io before it can be planned. The composition page's own ~60-line Rust vault (`deposit`/`balance`/`withdraw`, `require_auth`, `token::Client`, per-`Address` persistent storage) is a cheaper self-hosted alternative with no partner dependency.

**5. Soroban `persistent` storage TTL — flagged upstream, already handled here.** The page warns that `persistent` storage has its own TTL and expires if it is not extended. Checked against our contract: `contracts/invoice` already bumps TTLs (each invoice is extended to `deadline` + 30 days, instance TTL to 30 days on every write) — see [`deployments.md`](deployments.md) → *Storage TTL*. No action needed; recorded so the warning is not re-raised.

**6. Wallet SDK is a possible future simplification, not a task.** See the Wallet SDK section above.
