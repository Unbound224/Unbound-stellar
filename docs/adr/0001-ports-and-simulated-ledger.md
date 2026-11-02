# ADR 0001: Ports, Horizon adapters and a labeled SimulatedLedger

Status: accepted (M1)

## Context
`unbound-stellar` must be testable without Stellar network access and must never pretend an
integration works. Failure paths (missing trustline, unauthorized trustline, no liquidity, min-output
violation, timeout after submit, duplicate submit) need deterministic tests.

## Decision
- All ledger I/O sits behind small ports in `src/ports.ts` (`LedgerReader`, `PathSource`,
  `Submitter`, `TransactionLookup`, `LedgerEventSource`, `Signer`).
- `src/rpc/horizon.ts` implements the ports with `Horizon.Server`. It is type-checked and its mapping
  functions are unit-tested with hand-written payloads, but it has NOT been exercised against live
  Testnet.
- `src/testing/simulated-ledger.ts` is an in-memory TEST ADAPTER. It verifies real XDR (network,
  signature, sequence, timebounds) and applies a small subset of operations. It is not consensus.
- Transactions are built with `@stellar/stellar-sdk` and returned UNSIGNED; signing is a separate
  step so the user's device can sign without secrets reaching any server.
- Outcome rules follow `docs/SRD.md`: definitive rejection -> FAILED; unknown outcome -> RECONCILING;
  a known hash short-circuits to its recorded outcome; an expired never-included tx -> FAILED(EXPIRED).

## Consequences
Core and mobile consume the reconciliation event JSON Schema (`schemas/`) and fixtures, not this
package's internals, until a published SDK exists.
