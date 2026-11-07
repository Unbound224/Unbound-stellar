# ADR 0002: Soroban only for the redemption-return escrow

Status: accepted (code and tests complete; **not deployed** - no Testnet contract id exists yet)

## Context

`docs/ARCHITECTURE.md` says Unbound uses classic Stellar issued assets, trustlines and path payments,
and that Soroban should be introduced "only if a capability demonstrably requires contract logic".
Everything Unbound did up to M1 met that bar without contracts:

| Capability | Why classic Stellar is enough |
|---|---|
| Issuing merchant credit | A classic issued asset `(code, issuer)`; `AUTH_REQUIRED` + `AUTH_REVOCABLE` flags let the issuer approve every holder. |
| Holding / transferring credit | Trustlines and payments. |
| Exchanging credit | Strict-send path payments over the native order book, with a min-output floor. The ledger enforces the floor atomically. |
| Settlement truth | Transaction results and hashes; the indexer reconciles them. |

One capability does not fit: **redemption returns**. The product rules say
a consumer returns credit to the issuer, the merchant then either confirms fulfilment or rejects, a
rejection must refund the consumer, and a merchant that never answers must not keep the credit.

With a classic payment the returned credit reaches the issuer at once, and an issuer receiving its
own asset burns it. If the merchant then rejects or ignores the request, the consumer has nothing
on-chain, only an off-chain refund promise (`refundDue` in core) that someone has to chase. Classic
Stellar cannot express "hold these funds, release them to A if A signs before time T, otherwise
return them to B":

- **Claimable balances** come closest, but a claimable balance has one set of claimants and
  predicates fixed at creation. You can give the issuer "before T" and the consumer "after T", but
  then the issuer can claim at any time before T *without confirming anything*, and a rejection
  cannot return the funds early. There is also no single-use redemption id, no record of the
  outcome, and the issuer claiming is indistinguishable from fulfilment.
- **Pre-signed transactions or multisig escrow accounts** need a third party (Unbound) to hold keys
  or co-sign, and the SRD forbids server-side custody of user funds.

This is conditional custody with three exits (confirm, reject, timeout), which needs contract logic.

## Decision

Add one Soroban contract, `contracts/redemption-escrow` (Rust, `soroban-sdk = 29.0.1`), and use it
only for redemption returns. The credit itself stays a classic issued asset; the contract moves it
through the asset's **Stellar Asset Contract (SAC)** token interface, so there is no Unbound token
and no wrapped asset.

| Function | Who authorizes | Effect |
|---|---|---|
| `init(admin)` | admin | One time only. The admin can pause new returns; it can never move escrowed funds. |
| `open_return(consumer, issuer, token, amount, redemption_id, deadline)` | consumer | Moves `amount` into escrow. `redemption_id` (sha256 of core's id) is single-use forever. `deadline` is 1 hour to 30 days away. `issuer` must be the SAC admin (the asset's real issuer). |
| `confirm(redemption_id)` | issuer | Before the deadline: credit goes to the issuer (burned). |
| `reject(redemption_id)` | issuer | Any time while open: credit is refunded to the consumer. |
| `expire_refund(redemption_id)` | anyone | At or after the deadline: credit is refunded to the consumer. |
| `get_return`, `locked`, `admin`, `is_paused` | - | Read-only getters. |
| `set_paused(bool)` | admin | Stops new `open_return` calls; confirm/reject/expire keep working. |

Events: `return_opened`, `return_confirmed`, `return_rejected`, `return_expired` (topic 2 is the
redemption key) and `paused_changed`.

Invariant (tested by a seeded randomized test over 24 runs of 60 steps with 2 credits and 3
consumers): for every token, `escrow balance == locked(token) == sum(amount of Open returns)`, and
consumer balances + escrowed + burned == minted supply.

### Integration

- `unbound-stellar` owns the adapter: `SorobanRedemptionEscrow` (behind the `RedemptionEscrow`
  interface and a `SorobanRpcPort`) builds **unsigned, simulated** invocations; the user's device or
  the issuer signs. The gateway exposes `/gateway/v1/escrow/{open,confirm,reject,expire,returns/:id}`
  and answers `422 ESCROW_UNAVAILABLE` when no escrow is configured. Golden XDR produced by the Rust
  tests (`fixtures/soroban/redemption-escrow.v1.json`) is decoded by the TypeScript tests.
- `unbound-core` reaches it only through its `StellarGateway` port (`gateway.escrow`). Escrow mode is
  used when the gateway has an escrow **and** the build succeeds; otherwise core falls back to the
  existing classic return payment, unchanged. Each redemption records its `mode`.
- Escrow transactions are ordinary Stellar transactions with ordinary hashes, so the existing
  pending-hash watcher and reconciliation events confirm them with no new indexer.
- `unbound-mobile` shows the escrow state (held, released, refunded, refund available after the
  deadline). `unbound-site` lets a merchant fetch the confirm/reject transaction to sign with the
  issuer key.

### Fallback (native path stays)

The native path is not removed. It is used when the escrow is not deployed or not configured, when
an issuer has not authorized the escrow to hold its `AUTH_REQUIRED` credit (the SAC refuses the
transfer and simulation fails), or when the escrow is paused. In native mode a rejection keeps the
old behaviour: `refundDue = true`, settled off-chain or through a dispute.

## Consequences

- One audited-surface contract instead of none. It is small (under 400 lines with docs) and has no admin path
  to user funds, but it is **unaudited** and must be reviewed before any Mainnet use.
- Issuers must authorize the escrow contract once per asset (`set_authorized` on the SAC); the
  deploy script has an `authorize` subcommand for this.
- An issuer that deauthorizes the consumer's trustline (or the escrow) can block refunds until it
  re-authorizes. The funds stay in escrow and are never lost, and the authorization change is
  visible on-chain. This is the same power `AUTH_REVOCABLE` already gives the issuer and is disclosed
  in the redemption policy.
- `init` is first-caller-wins. `scripts/deploy-testnet.sh` initializes immediately after deploying
  and aborts if `admin()` does not read back as ours.
- `soroban-sdk 29` requires the build system to shake the contract spec; CI builds the wasm with
  `SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1` to prove it compiles, and deployments use
  `stellar contract build`.
- Not done: Testnet deployment, live RPC calls (`StellarRpcSorobanPort` is type-checked only),
  decoding escrow events from RPC `getEvents` in the indexer (hash reconciliation covers the
  lifecycle today), fee sponsorship.

## Alternatives rejected

- **Claimable balances** - see Context: no way to tell confirmation from a plain claim, no early refund.
- **A custom Unbound token on Soroban** - would replace real issuer-controlled credit with a wrapper
  and break the "issuer-authorized credit" promise.
- **Server-held escrow account** - custody of user funds by Unbound; forbidden by the SRD.
