# Unbound — Environment, Deployment and Recovery

## Environment boundaries
- Local: deterministic Docker Compose services, Stellar local network/Testnet, synthetic users/fixtures.
- Staging: separate database, bucket, API credentials, signing identities, Testnet assets/contracts, observability.
- Production: requires security audit, real issuer/provider agreements and relevant jurisdictional legal/compliance review. Not included in preimplementation scaffold.

## Suggested variables (non-secret examples only)
```dotenv
APP_ENV=development
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org
DATABASE_URL=postgresql://localhost:5432/unbound
REDIS_URL=redis://localhost:6379
API_BASE_URL=http://localhost:3001
CHAIN_START_LEDGER=0
LOG_LEVEL=info
```
- Credentials to sign on-chain go into a secure secret manager or hardware-backed user wallet, never into a public mobile/web bundle.
- Signed store badge links are configured after actual publication; no fabricated App Store or Google Play app URLs.

## CI & GitHub setup
- GitHub Actions per repo: formatting/lint, schema checks, unit tests, dependency scanning; chain/devices smoke tests where supported.
- Branch protection and PR review recommended.
- Release tag points to tested sibling versions in an integration lockfile.
- All paths use offline/synthetic test fixtures, not real user financial records.

## Failure recovery
- Rebuild indexers from ledger cursor; compare DB projection vs chain truth.
- Restore DB backups after verifying transaction-intent reconciliation.
- Never republish user transactions solely because a client request timed out.
- Test signing-key rotation, dependency outages, stale quotes, malicious user input, insufficient balances and duplicate delivery.
- External reference infrastructure may change; check upstream project versions and licenses at build time.

## Testnet run log (2026-11-04)

Everything here ran on **Stellar Testnet** with throwaway accounts. No audit has been done. Public data only.

### Escrow deployment (`scripts/deploy-testnet.sh`, stellar-cli 27.1.0)

| Item | Value |
|---|---|
| Contract id | [`CC4ETHM44IUJ4GDRT57VH4OSNEMPEGUKQHQJCUQDIU2LKIAKZYIYOP6C`](https://stellar.expert/explorer/testnet/contract/CC4ETHM44IUJ4GDRT57VH4OSNEMPEGUKQHQJCUQDIU2LKIAKZYIYOP6C) |
| Wasm hash | `37726f8c76df9302c8c6923104fb7fd884a6ceb2ead6b1933b3bf5f30f7c415a` |
| Admin (public) | `GC4OYFENIRHVPAZIAFRPVUJRC37UGWNZOWGYW3CDGBYYIGLI5S5E467O` |
| Deployed at | 2026-11-04T10:20:28Z |
| Upload tx | [f4c594da02…](https://stellar.expert/explorer/testnet/tx/f4c594da02264172e2cc7e325622329e8d2820f8abc5680c07057a82a0d7be12) |
| Deploy tx | [1c827ee3ed…](https://stellar.expert/explorer/testnet/tx/1c827ee3ed78890545716540160f2e87b1f81b0b8cb5e3d2461e2ca246aac36f) |
| `init` tx | [23e600cd69…](https://stellar.expert/explorer/testnet/tx/23e600cd69599455b7be3b016925b925198d8960f1c9d06df620bb73e0c081be) |

The script read the admin back from the contract and it matched. It ran on the first attempt with no script changes.

### Test credit (`SHOP:GDRIDJU3VKOYAQXMI4WVEVSLFATOSOK4JAVJQMYK2D5YGIY4Z6ALYQWX`)

- Issuer (public): `GDRIDJU3VKOYAQXMI4WVEVSLFATOSOK4JAVJQMYK2D5YGIY4Z6ALYQWX` with AUTH_REQUIRED and AUTH_REVOCABLE set (checked on Horizon: `auth_required: true, auth_revocable: true`).
- Distributor alias `unbound-distributor` (public `GAOEO57YBDDCJGTNUTD7CFFA6OIZUW44RQ7GN6MEJ4VDXXFFLEVZ5FPC`) holds 1000 SHOP, authorized (checked on Horizon).
- Consumer (public): `GBC5IXHMZLVVNUKPS55ZZ4BHXEBYCCZBBBCKJYYYHLHOYMKWABBTV5FX`, funded with 100 SHOP.
- Stellar Asset Contract: `CBGICNAOTEYV4ZMZFHEWM5MD6VTV6NXLVEXLJP6R7OI7HDMESPXEYCK7`. Escrow authorized for it with `deploy-testnet.sh authorize`: [63f4ba754f…](https://stellar.expert/explorer/testnet/tx/63f4ba754ffac62aec50af2e2fe50a6a0c545fb2b1b15e148b675bdb53b4598d) (SAC deploy) and [309d4fabbe…](https://stellar.expert/explorer/testnet/tx/309d4fabbe47c6eb5dd42bf4c3efa7f3f08736ec5e215578f157b5430a652e20) (`set_authorized`).
- The set-options, trustline and payment transactions were checked by their effect on Horizon; their hashes were not captured.

### Smoke run (`npx tsx scripts/testnet-smoke.ts`)

Raw evidence: `contracts/deployments/testnet-smoke.json`.

| Step | Result | Tx |
|---|---|---|
| open_return (to be confirmed) | ok | [ed82231098…](https://stellar.expert/explorer/testnet/tx/ed82231098cf13676478d8e05e5acdd08da3d20098fab30b2831d90569be0d93) |
| confirm by the issuer | ok | [8af95ad4e2…](https://stellar.expert/explorer/testnet/tx/8af95ad4e234b4e14721f39198d464a958900b578c8870c570eef6a8a0a51c05) |
| replay of a used redemption id | refused (Error(Contract, #6)) | n/a |
| open_return (to be rejected) | ok | [3e7340d46a…](https://stellar.expert/explorer/testnet/tx/3e7340d46afba56df18895cee8aec421a3bf00bda6adc2c8bfe7ae91a5f83dcb) |
| reject by the issuer | ok | [3a05c7b222…](https://stellar.expert/explorer/testnet/tx/3a05c7b222cb02752cf2fc968d2ec263c20e438a8a6069e960ad81bea4320b07) |
| open_return (wrong-signer target) | ok | [5ca68b9841…](https://stellar.expert/explorer/testnet/tx/5ca68b98413a2bdb090be80fd6cdc3d50bbb6ff25bd4ce2cbb182fa58f1ca84b) |
| confirm signed by the consumer (not the issuer) | refused (client-side: ❌ error: Missing signing key for account GDRIDJU3VKOYAQXMI4WVEVSLFATOSOK4JAVJQMYK2D5YGIY4Z6ALYQWX) | n/a |
| open_return naming a victim account, signed by the issuer | refused (client-side: ❌ error: Missing signing key for account GDQ3SQGSNDWSLMVCTSOC444PLJIEJUC7EQ3VARDLL56MKEX6RQMM7T2K) | n/a |
| reject (cleanup of the wrong-signer target) | ok | [0134ea6a4b…](https://stellar.expert/explorer/testnet/tx/0134ea6a4b90f556a4e4a23c96a29e85135055956e2a45db701cbc27e6811ea2) |
| open_return (to be refunded by expiry) | ok (deadline 2026-11-04T12:03:06.000Z) | [573ee85ba2…](https://stellar.expert/explorer/testnet/tx/573ee85ba2eb2e00cd0c37c9d097ee1ee256ea534ede42429eb937f5ef6202be) |
| expire_refund before the deadline | refused (Error(Contract, #9)) | n/a |

Notes, stated plainly:
- The "refused" rows for the replayed id (`Error(Contract, #6)`) and early `expire_refund` (`#9`) are **contract** refusals from simulation.
- The two wrong-signer rows are refused **client-side** by stellar-cli ("Missing signing key"), because no signature for that account can be produced. They are not on-chain rejections. stellar-cli signs the auth of any account whose key is in the local keystore, so the victim account's key was created in a throwaway config dir and deleted. On-chain auth enforcement is covered by the contract's Rust tests, not by this run.
- The expiry refund needs the contract's 1 hour minimum window. It was opened in this run and must be finished with `npx tsx scripts/testnet-smoke.ts finish`. Status: **pending until 2026-11-04T12:03:06.000Z**.
- An earlier run of the script aborted on a transient network error and left test returns open; they were rejected by the issuer afterwards. Those extra transactions exist on Testnet but are not part of this log.
