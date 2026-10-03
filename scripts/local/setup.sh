#!/usr/bin/env bash
# Local testnet bootstrap: .env files, funded keypairs, USDC trustlines. Idempotent.
# Secrets go only into gitignored .env files / the stellar CLI keystore; only 4 chars are printed.
set -euo pipefail
cd "$(dirname "$0")/../.."

NET=testnet
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
PLATFORM=liralink-local-platform
PAYER=liralink-local-payer

command -v stellar >/dev/null || { echo "stellar CLI not found" >&2; exit 1; }

set_env() { # file key value
  if grep -q "^$2=" "$1"; then
    sed -i '' "s|^$2=.*|$2=$3|" "$1"
  else
    echo "$2=$3" >> "$1"
  fi
}
get_env() { grep "^$2=" "$1" | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//' ; }

ensure_env() { # dir
  [ -f "$1/.env" ] || cp "$1/.env.example" "$1/.env"
}

ensure_identity() { # name
  if stellar keys address "$1" >/dev/null 2>&1; then
    echo "identity $1 exists: $(stellar keys address "$1")"
  else
    stellar keys generate "$1" --network "$NET" --fund >/dev/null
    echo "identity $1 created + funded: $(stellar keys address "$1")"
  fi
}

ensure_trustline() { # name
  stellar tx new change-trust --source-account "$1" --line "USDC:$USDC_ISSUER" --network "$NET" >/dev/null 2>&1 \
    && echo "USDC trustline set for $1" || { echo "trustline failed for $1" >&2; exit 1; }
}

ensure_env backend
ensure_env merchant-web
ensure_env pay-web

[ "$(get_env backend/.env JWT_SECRET)" != "change-me" ] || set_env backend/.env JWT_SECRET "$(openssl rand -hex 32)"
[ -n "$(get_env backend/.env SEED_DEMO_PASSWORD)" ] || set_env backend/.env SEED_DEMO_PASSWORD "$(openssl rand -hex 8)"

set_env merchant-web/.env VITE_USE_MOCK false
set_env pay-web/.env VITE_USE_MOCK false

ensure_identity "$PLATFORM"
ensure_identity "$PAYER"
ensure_trustline "$PLATFORM"
ensure_trustline "$PAYER"

PLATFORM_SECRET=$(stellar keys secret "$PLATFORM")
set_env backend/.env PLATFORM_ACCOUNT_SECRET "$PLATFORM_SECRET"

echo
echo "platform: $(stellar keys address "$PLATFORM")  secret ${PLATFORM_SECRET:0:4}…  (in backend/.env)"
echo "payer:    $(stellar keys address "$PAYER")  secret $(stellar keys secret "$PAYER" | cut -c1-4)…  (in stellar keystore as $PAYER)"
echo "demo login: demo@liralink.app / SEED_DEMO_PASSWORD in backend/.env"
echo
echo "Next: get testnet USDC for the payer at https://faucet.circle.com (Stellar, Testnet) -> $(stellar keys address "$PAYER")"
