import { UnboundStellarError } from '../errors.js';
import type { LedgerReader } from '../ports.js';
import type { TrustedAssetRegistry } from '../registry.js';
import { assertTestnet } from './tx.js';
import type { AssetRef } from '../types/index.js';

export interface IssuerReport {
  asset: AssetRef;
  authRequired: boolean;
  authRevocable: boolean;
  authClawbackEnabled: boolean;
  authImmutable: boolean;
  /** Human-facing risk notes the client must show before a holder takes the asset. */
  warnings: string[];
}

/**
 * Checks that an asset's issuer is on the verified registry AND exists on the ledger, and
 * reports the flags that change holder experience. A Stellar asset alone is NOT evidence that a
 * shop will redeem it - that stays an off-chain issuer-verification decision owned by unbound-core.
 */
export async function verifyIssuerAccount(
  reader: LedgerReader,
  registry: TrustedAssetRegistry,
  asset: AssetRef,
  opts: { requireAuthControl?: boolean } = {},
): Promise<IssuerReport> {
  assertTestnet(reader.networkPassphrase);
  registry.assertTrusted(asset);
  if (asset.issuer === null) throw new UnboundStellarError('INVALID_ASSET', 'native asset has no issuer');
  const acct = await reader.loadAccount(asset.issuer);
  if (!acct) throw new UnboundStellarError('ISSUER_ACCOUNT_MISSING', 'issuer account does not exist on this network');
  const f = acct.flags;
  const warnings: string[] = [];
  if (f.authClawbackEnabled) warnings.push('Issuer can claw back this asset.');
  if (f.authRevocable) warnings.push('Issuer can revoke a holder authorization (freeze balance).');
  if (!f.authRequired) warnings.push('Issuer does not gate trustlines; any account may hold this asset.');
  if (opts.requireAuthControl && !f.authRequired) {
    throw new UnboundStellarError('TRUSTLINE_UNAUTHORIZED', 'issuer must require authorization for this program');
  }
  return {
    asset,
    authRequired: f.authRequired,
    authRevocable: f.authRevocable,
    authClawbackEnabled: f.authClawbackEnabled,
    authImmutable: f.authImmutable,
    warnings,
  };
}
