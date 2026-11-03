# Changelog

All notable changes to this repository. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are
tagged by the maintainer; nothing below has been deployed to Stellar Testnet or Mainnet.

## [Unreleased]

### Added
- `contracts/redemption-escrow`: Soroban redemption-return escrow (Rust, soroban-sdk 29.0.1) with `init`,
  `open_return`, `confirm`, `reject`, `expire_refund`, `set_paused`, getters and lifecycle events; single-use
  redemption ids, 1 h - 30 day deadlines, issuer must be the SAC admin.
- Contract tests: behaviour and failure paths, a seeded randomized invariant test (escrow balance == locked == sum
  of open returns, value conserved) and golden XDR fixtures shared with TypeScript.
- `SorobanRedemptionEscrow` behind the `RedemptionEscrow` interface and `SorobanRpcPort`; `FixtureSorobanRpc` test
  adapter; type-checked `StellarRpcSorobanPort`.
- Gateway endpoints `/gateway/v1/escrow/{open,confirm,reject,expire,returns/:id}` (422 `ESCROW_UNAVAILABLE` without
  a configured contract) and shared fixtures.
- `scripts/deploy-testnet.sh` (stellar-cli; dry-run in CI, never run for real) and ADR 0002.
- Escrow `open_return` / `expire_refund` XDR in `fixtures/xdr/transactions.v1.json` for the mobile decoder.
- CI: `contracts.yml` with cargo fmt, clippy, test and a `wasm32v1-none` release build.

### Not done
- No Testnet deployment, contract id or Testnet hashes; no RPC event indexing for the escrow; unaudited.

## [0.1.0] - pre-release scaffold
- SDK (issuer/trustline checks, strict-send quotes, builders, submission classification, reconciliation events),
  gateway service and chain worker on the labeled `SimulatedLedger`.
