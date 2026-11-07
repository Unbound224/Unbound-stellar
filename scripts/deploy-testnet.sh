#!/usr/bin/env bash
# Deploy the Unbound redemption-return escrow (contracts/redemption-escrow) to Stellar TESTNET.
#
# STATUS: run for real on 2026-11-04 (stellar-cli 27.1.0). The resulting contract id, wasm hash and transaction links are
# recorded in contracts/deployments/testnet.json and docs/DEPLOYMENT.md. DRY_RUN=1 prints the plan without sending anything.
#
# Requirements: stellar-cli >= 25.2 (https://developers.stellar.org/docs/tools/cli), Rust with the
# wasm32v1-none target, network access to Testnet RPC + Friendbot.
#
# Usage:
#   scripts/deploy-testnet.sh                      # build, deploy, init with a fresh admin identity
#   ADMIN=my-admin scripts/deploy-testnet.sh       # use an existing stellar-cli identity as admin
#   DRY_RUN=1 scripts/deploy-testnet.sh            # print the commands without running them
#   AUTHORIZE_ASSET=SHOP:G... ISSUER=issuer-identity scripts/deploy-testnet.sh authorize <CONTRACT_ID>
#
# What it does:
#   1. `stellar contract build` (stellar-cli performs the spec shaking soroban-sdk 29 requires).
#   2. Creates/funds the admin identity with Friendbot when it does not exist (Testnet only).
#   3. Deploys the wasm and calls `init --admin <admin>` IMMEDIATELY, then reads `admin` back and
#      aborts if it is not ours (init is first-caller-wins; never leave a deployed escrow uninitialized).
#   4. Writes contracts/deployments/testnet.json (contract id, wasm hash, admin, timestamp).
#
# `authorize` subcommand: issuers whose credit uses AUTH_REQUIRED (all Unbound credits do) must
# authorize the escrow contract to hold their asset once, through the asset's Stellar Asset Contract:
#   stellar contract asset deploy --asset CODE:ISSUER   (idempotent if the SAC already exists)
#   stellar contract invoke --id <SAC> -- set_authorized --id <ESCROW> --authorize true
#
# Never use Mainnet with this script: it refuses any network other than testnet.
set -euo pipefail

NETWORK="testnet"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/contracts"
WASM="$CONTRACTS/target/wasm32v1-none/release/unbound_redemption_escrow.wasm"
ADMIN="${ADMIN:-unbound-escrow-admin}"
DRY_RUN="${DRY_RUN:-0}"

if [[ "${STELLAR_NETWORK:-testnet}" != "testnet" ]]; then
  echo "refusing: only Stellar Testnet is supported (STELLAR_NETWORK=${STELLAR_NETWORK})" >&2
  exit 2
fi

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

require_cli() {
  if ! command -v stellar >/dev/null 2>&1; then
    echo "stellar-cli not found; install v25.2+ (cargo install --locked stellar-cli)" >&2
    exit 3
  fi
  local v
  v="$(stellar --version | head -n1 | grep -Eo '[0-9]+\.[0-9]+' | head -n1)"
  if [[ "$(printf '%s\n25.2\n' "$v" | sort -V | head -n1)" != "25.2" ]]; then
    echo "stellar-cli $v is too old; soroban-sdk 29 needs v25.2+" >&2
    exit 3
  fi
}

authorize() {
  local escrow_id="$1"
  : "${AUTHORIZE_ASSET:?set AUTHORIZE_ASSET=CODE:ISSUER}"
  : "${ISSUER:?set ISSUER=<stellar-cli identity of the asset issuer>}"
  local sac
  if [[ "$DRY_RUN" == "1" ]]; then
    sac="<SAC_ID>"
  else
    sac="$(stellar contract id asset --asset "$AUTHORIZE_ASSET" --network "$NETWORK")"
  fi
  # deploying the SAC fails harmlessly when it already exists
  run stellar contract asset deploy --asset "$AUTHORIZE_ASSET" --source-account "$ISSUER" --network "$NETWORK" || true
  run stellar contract invoke --id "$sac" --source-account "$ISSUER" --network "$NETWORK" -- \
    set_authorized --id "$escrow_id" --authorize true
  echo "escrow $escrow_id may now hold $AUTHORIZE_ASSET (SAC $sac)"
}

deploy() {
  run stellar contract build --manifest-path "$CONTRACTS/redemption-escrow/Cargo.toml"
  [[ "$DRY_RUN" == "1" || -f "$WASM" ]] || { echo "build did not produce $WASM" >&2; exit 4; }

  if [[ "$DRY_RUN" != "1" ]] && ! stellar keys address "$ADMIN" >/dev/null 2>&1; then
    stellar keys generate "$ADMIN" --network "$NETWORK" --fund
  fi
  local admin_addr="<ADMIN_ADDRESS>" contract_id="<CONTRACT_ID>" wasm_hash="<WASM_HASH>"
  if [[ "$DRY_RUN" != "1" ]]; then
    admin_addr="$(stellar keys address "$ADMIN")"
    wasm_hash="$(stellar contract upload --wasm "$WASM" --source-account "$ADMIN" --network "$NETWORK")"
    contract_id="$(stellar contract deploy --wasm-hash "$wasm_hash" --source-account "$ADMIN" --network "$NETWORK")"
  else
    run stellar contract upload --wasm "$WASM" --source-account "$ADMIN" --network "$NETWORK"
    run stellar contract deploy --wasm-hash "$wasm_hash" --source-account "$ADMIN" --network "$NETWORK"
  fi

  run stellar contract invoke --id "$contract_id" --source-account "$ADMIN" --network "$NETWORK" -- init --admin "$admin_addr"

  if [[ "$DRY_RUN" != "1" ]]; then
    local onchain
    onchain="$(stellar contract invoke --id "$contract_id" --source-account "$ADMIN" --network "$NETWORK" --send no -- admin | tr -d '"')"
    if [[ "$onchain" != "$admin_addr" ]]; then
      echo "ABORT: escrow admin is $onchain, expected $admin_addr (someone else initialized it). Do not use $contract_id." >&2
      exit 5
    fi
    mkdir -p "$CONTRACTS/deployments"
    cat >"$CONTRACTS/deployments/testnet.json" <<JSON
{
  "network": "testnet",
  "contractId": "$contract_id",
  "wasmHash": "$wasm_hash",
  "admin": "$admin_addr",
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
    echo "deployed escrow $contract_id (admin $admin_addr)"
    echo "set ESCROW_CONTRACT_ID=$contract_id for the gateway, then run: $0 authorize $contract_id per issuer asset"
  fi
}

if [[ "$DRY_RUN" != "1" ]]; then require_cli; fi
case "${1:-deploy}" in
  deploy) deploy ;;
  authorize) authorize "${2:?usage: $0 authorize <CONTRACT_ID>}" ;;
  *) echo "usage: $0 [deploy|authorize <CONTRACT_ID>]" >&2; exit 1 ;;
esac
