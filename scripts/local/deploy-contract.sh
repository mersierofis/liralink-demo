#!/usr/bin/env bash
# Builds and deploys the invoice contract to testnet with the local platform account as admin,
# then points backend/.env and packages/invoice-client at the new contract id.
set -euo pipefail
cd "$(dirname "$0")/../.."

NET=testnet
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
PLATFORM=liralink-local-platform
ALIAS=liralink-invoice
BINDINGS=packages/invoice-client/src/index.ts

TOKEN=$(stellar contract id asset --asset "USDC:$USDC_ISSUER" --network "$NET")
ADMIN=$(stellar keys address "$PLATFORM")
echo "USDC SAC: $TOKEN"
echo "admin:    $ADMIN"

(cd contracts && cargo test --quiet && stellar contract build)

CONTRACT_ID=$(stellar contract deploy --network "$NET" --source-account "$PLATFORM" --alias "$ALIAS" \
  --wasm contracts/target/wasm32v1-none/release/invoice.wasm \
  -- --token "$TOKEN" --admin "$ADMIN" | tail -1)
echo "contract: $CONTRACT_ID"

sed -i '' "s|^INVOICE_CONTRACT_ID=.*|INVOICE_CONTRACT_ID=$CONTRACT_ID|" backend/.env
sed -i '' "s|contractId: \"C[A-Z0-9]\{55\}\"|contractId: \"$CONTRACT_ID\"|" "$BINDINGS"
grep -n "contractId:" "$BINDINGS"
echo "Update docs/deployments.md with the new contract id if you want it recorded."
