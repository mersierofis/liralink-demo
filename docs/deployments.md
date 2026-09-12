# Deployments

Every on-chain deployment LiraLink depends on. Update this file in the same commit as any redeploy.

## Invoice contract — testnet

| Field | Value |
|---|---|
| Contract ID | `CBN6Q5MPD3BUXAZNG3VPYWQ42EUAOBGDFW3WWDJVGTMRRJFZO7EBJVWE` |
| CLI alias | `invoice` (`stellar contract alias show invoice --network testnet`) |
| Network | testnet — `Test SDF Network ; September 2015`, RPC `https://soroban-testnet.stellar.org` |
| Deployed | 2026-09-12 |
| Deployer / fee payer | platform account `GDWV6USF4R2ULWR5XW3TEUZSIRGRCU7PQWGSBDYJVIRFNAJ3LVNQ34N2` |
| Constructor `token` | USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` (`USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`) |
| Wasm hash | `07249d5012a760345c13daf9ed1e6014bcf7f67afa23903d278f76590c4bdeeb` |
| Upload tx | [`345109f8…`](https://stellar.expert/explorer/testnet/tx/345109f8280fd673efb77bd6228a7f33afc3887ae8721110b40a7e70919c331a) |
| Deploy tx | [`4c5b75d4…`](https://stellar.expert/explorer/testnet/tx/4c5b75d47bf4b7cd2b05702d07b7cf82c7a7bd55a84750c8f340b586b4a16b0e) |
| Explorer | [stellar.expert](https://stellar.expert/explorer/testnet/contract/CBN6Q5MPD3BUXAZNG3VPYWQ42EUAOBGDFW3WWDJVGTMRRJFZO7EBJVWE) · [Stellar Lab](https://lab.stellar.org/r/testnet/contract/CBN6Q5MPD3BUXAZNG3VPYWQ42EUAOBGDFW3WWDJVGTMRRJFZO7EBJVWE) |
| Toolchain | soroban-sdk 27.0.6, stellar CLI 28.0.0, rustc 1.98.1, target `wasm32v1-none` |
| Source | `contracts/invoice` |
| TS bindings | `packages/invoice-client` (generated from this contract id) |

Backend config: `INVOICE_CONTRACT_ID` in `backend/.env`.

### Interface

- `create(merchant: Address, code: Symbol, amount: i128, deadline: u32)` — merchant auth; `amount` in USDC stroops (7 dp); `deadline` is a ledger sequence.
- `pay(code: Symbol, payer: Address)` — payer auth; USDC SAC `transfer(payer → merchant, amount)`.
- `get(code: Symbol) -> Invoice`
- `cancel(code: Symbol)` — merchant auth; pending invoices only.

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
  -- --token CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA
```

A redeploy creates a new contract id: update this table, `INVOICE_CONTRACT_ID`, and regenerate `packages/invoice-client`. Existing invoices do not carry over.
