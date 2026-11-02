<img src="./brand/icon.svg" alt="Unbound logo" width="144" />

# unbound-stellar

> Unbound — Turn stranded value into something usable.

**Status: M1 protocol slice implemented and tested offline; NOT yet verified against live Stellar Testnet. See "Status" below.** This repo is one of **exactly four meaningful independent codebases** in the Unbound Stellar-native project. It is not a placeholder created merely to increase Drips Wave submissions.

## Owns
Native Stellar asset issuance integration, account trustlines, issuer flags, order-book/path quoting, transactions, indexing/reconciliation, typed integration SDK

## Why it is separate
It has a distinct runtime/toolchain, external interface, tests, release cadence and maintainership boundary. Its siblings depend on its delivered interface, but implementation responsibilities must not be duplicated.

## Sibling repositories
- `unbound-mobile` — Consumer asset inventory, issuer discovery, offers, approvals, wallet/secure signing, redemption status, transaction receipts
- `unbound-core` — Merchant onboarding, verified issuer/redemption policies, listings and reservations, user accounts, authorization, canonical operational data, dispute workflow
- `unbound-site` — Public consumer landing, official store badges, merchant issuer console, merchant redemption operations, docs and partner onboarding

## Architecture and development context
Start with:
- `AGENTS.md` — coding agent rules;
- `docs/PRD.md` — product purpose and MVP;
- `docs/SRD.md` — user/system requirements, APIs and state;
- `docs/ARCHITECTURE.md` — four-repository responsibilities, data and execution paths;
- `docs/TECHNICAL_BUILD.md` — recommended bootstrap, testing, phases;
- `docs/SECURITY.md` — security/trust boundaries;
- `docs/BRAND.md` — approved flat logo and flexible UI direction;
- `docs/ROADMAP.md` — milestone acceptance gates.

## Status (honest)
| Capability | State |
|---|---|
| Amount math (integer base units, 7 dp, no floats) | Implemented, unit-tested |
| Verified-issuer registry, fail-closed on untrusted/malformed assets | Implemented, unit-tested |
| Issuer account/flag checks, trustline checks (missing / unauthorized / limit) | Implemented, tested on SimulatedLedger |
| Unsigned tx builders: issuer setup, authorize trustline, issue credit, change trust, redemption return (burn) | Implemented, tested on SimulatedLedger |
| Strict-send path quotes: expiry, slippage cap (<=10%), min-output floor, tamper-evident id, approved-route filter | Implemented, unit-tested |
| Settlement tx builder re-validating quote freshness, balances, authorization, destination trustline | Implemented, tested |
| Submit classification: CONFIRMED / FAILED(reason) / RECONCILING; reconcile by hash; expiry resolution | Implemented, tested |
| Cursor indexer, dedup, replay, at-least-once delivery, versioned reconciliation event + JSON Schema | Implemented, tested |
| Horizon adapters (`HorizonClient`) | Type-checked + mapping unit tests only. **Never run against Testnet** (no network route in the build sandbox) |
| Real Testnet transaction hashes | **None yet.** Hashes printed by `scripts/m1-demo.ts` come from a local simulator |
| Soroban / path payments via liquidity pools / partial offer crossing / reserves / liabilities | Not modeled |
| Published npm package / chain worker process | Not done |

`SimulatedLedger` (`src/testing/`) is an in-memory TEST ADAPTER, clearly not Stellar. It verifies real
XDR signatures/sequence/timebounds but implements only a subset of operations.

## What cannot work without Stellar
Holding a transferable merchant credit as an issued asset, issuer-gated trustlines, and
strict-send settlement against real order-book liquidity are ledger features. The simulator only
rehearses their failure semantics; it proves nothing about real liquidity.

## Quick start
```
npm ci
npm run check        # lint + typecheck + tests + build
npx tsx scripts/m1-demo.ts   # offline demo on the simulator
npm run schemas      # regenerate schemas/reconciliation-event.v1.json
```

## Public boundary
- TypeScript API exported from `src/index.ts`.
- `schemas/reconciliation-event.v1.json` (generated from zod, snapshot-tested) and
  `fixtures/reconciliation-event.confirmed.v1.json`: the contract consumed by `unbound-core`.
- Quote object (`Quote`, schema version 1.0) matches the quote/intent shape in `docs/STELLAR_PROTOCOL.md`.

## Security notes
No secrets are committed; tests generate throwaway keys. `TestnetKeypairSigner` is test-only. Only the
Testnet passphrase is accepted (every builder/adapter fails closed on any other network).
Fee sponsorship is not implemented and nothing here promises it.

## Sibling versions
Developed against `unbound-core` / `unbound-site` / `unbound-mobile` at their `claude/drips-wave-maintainer-projects-iwucl5` branches (no tagged releases yet).

## Minimal integration contract
Always test the dependency path stated in ARCHITECTURE.md. Every new public endpoint/ABI/package message must be versioned and covered by consumer fixtures. See `docs/SRD.md` and `docs/TECHNICAL_BUILD.md`.

## Drips Wave
Stellar is essential: Native asset issuance: merchant issuance identity and redemption promise live off-chain, asset code+issuer on Stellar. Approval/eligibility for Wave depends on substantive open-source implementation and organizer review, not repo count.


## Official project identity

The project uses the **approved flat SVG logo** in [`brand/icon.svg`](./brand/icon.svg), with an editable transparent vector mark in [`brand/mark.svg`](./brand/mark.svg). The [512 px GitHub organization avatar](./brand/org-avatar.png) is in the same directory. This logo is shared by all four project repositories. UI design remains intentionally flexible.
