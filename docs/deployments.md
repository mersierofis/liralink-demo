# Deployments

Every on-chain deployment LiraLink depends on. Update this file in the same commit as any redeploy.

## Invoice contract — testnet

| Field | Value |
|---|---|
| Contract ID | `CDKZYQI4HI347ZVAMXT2XPHLYDSDKN6ERELKASGJDII6AQU6ROFQ45EJ` |
| CLI alias | `invoice` (`stellar contract alias show invoice --network testnet`) |
| Network | testnet — `Test SDF Network ; September 2015`, RPC `https://soroban-testnet.stellar.org` |
| Deployed | 2026-09-12 (admin-auth redeploy) |
| Deployer / fee payer | platform account `GDWV6USF4R2ULWR5XW3TEUZSIRGRCU7PQWGSBDYJVIRFNAJ3LVNQ34N2` |
| Constructor `token` | USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) |
| Constructor `admin` | platform account `GDWV6USF4R2ULWR5XW3TEUZSIRGRCU7PQWGSBDYJVIRFNAJ3LVNQ34N2` — the only key that can `create`/`cancel` |
| Wasm hash | `f95d67feb7dd55ca72eaf49bc0c7dc61e1955b83fc65e273f2d3875c47370950` |
| Upload tx | [`cf37b728…`](https://stellar.expert/explorer/testnet/tx/cf37b72866b044c382c40e321317ca8a85e555b59402bfeb2f5303e29ee144e3) |
| Deploy tx | [`4a16ba6f…`](https://stellar.expert/explorer/testnet/tx/4a16ba6f13f85c9408dce88f83d9706bbbffd7e3a217a7aa1e0fca2f0b151641) |
| Explorer | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CDKZYQI4HI347ZVAMXT2XPHLYDSDKN6ERELKASGJDII6AQU6ROFQ45EJ) · [Stellar Lab](https://lab.stellar.org/r/testnet/contract/CDKZYQI4HI347ZVAMXT2XPHLYDSDKN6ERELKASGJDII6AQU6ROFQ45EJ) |
| Toolchain | soroban-sdk 27.0.6, stellar CLI 28.0.0, rustc 1.98.1, target `wasm32v1-none` |
| Source | `contracts/invoice` |
| TS bindings | `packages/invoice-client` (generated from this contract id) |

Backend config: `INVOICE_CONTRACT_ID` in `backend/.env`.

### Interface

- `__constructor(token: Address, admin: Address)` — pins the USDC SAC and the admin (platform account).
- `create(merchant: Address, code: Symbol, amount: i128, deadline: u32)` — **admin auth**; `merchant` is only the payout address (never signs); `amount` in USDC stroops (7 dp); `deadline` is a ledger sequence.
- `pay(code: Symbol, payer: Address)` — payer auth; USDC SAC `transfer(payer → merchant, amount)`.
- `get(code: Symbol) -> Invoice`
- `cancel(code: Symbol)` — **admin auth**; pending invoices only.

Superseded: `CBN6Q5MPD3BUXAZNG3VPYWQ42EUAOBGDFW3WWDJVGTMRRJFZO7EBJVWE` (wasm `07249d50…`, same day) required merchant auth on `create`/`cancel`, which a custodial merchant can never give. Do not use.

Errors: `AlreadyExists=1`, `NotFound=2`, `NotPending=3`, `Expired=4`, `InvalidAmount=5`.

### Events (for RPC `getEvents`)

Topics are `[event_name, code]`; data is a map.

| Event | Topics | Data |
|---|---|---|
| created | `["created", code]` | `{ merchant, amount, deadline }` |
| paid | `["paid", code]` | `{ payer, merchant, amount }` |
| cancelled | `["cancelled", code]` | `{ merchant }` |

Storage TTL: each invoice is extended to live until `deadline` + 30 days (capped at the network max); instance TTL is bumped to 30 days on every write.

### Redeploy

```bash
cd contracts && cargo test && stellar contract build
STELLAR_ACCOUNT=<platform secret from backend/.env> \
  stellar contract deploy --network testnet --alias invoice \
  --wasm target/wasm32v1-none/release/invoice.wasm \
  -- --token CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
     --admin GDWV6USF4R2ULWR5XW3TEUZSIRGRCU7PQWGSBDYJVIRFNAJ3LVNQ34N2
```

A redeploy creates a new contract id: update this table, `INVOICE_CONTRACT_ID`, and regenerate `packages/invoice-client`. Existing invoices do not carry over.
