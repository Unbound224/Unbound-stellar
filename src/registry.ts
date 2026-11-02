import { UnboundStellarError } from './errors.js';
import { assetKey, type AssetRef } from './types/index.js';
import { StrKey } from '@stellar/stellar-sdk';

/**
 * Set of issuers/assets that unbound-core has verified. Fed BY core; this package never decides
 * who is trustworthy. Everything not listed is rejected (fail closed). Native XLM is always allowed
 * as a routing/fee asset.
 */
export class TrustedAssetRegistry {
  private readonly assets = new Set<string>();

  constructor(trusted: AssetRef[] = []) {
    for (const a of trusted) this.add(a);
  }

  add(asset: AssetRef): void {
    assertWellFormed(asset);
    this.assets.add(assetKey(asset));
  }

  remove(asset: AssetRef): void {
    this.assets.delete(assetKey(asset));
  }

  isTrusted(asset: AssetRef): boolean {
    return asset.issuer === null ? asset.code === 'XLM' : this.assets.has(assetKey(asset));
  }

  assertTrusted(asset: AssetRef): void {
    assertWellFormed(asset);
    if (!this.isTrusted(asset)) {
      throw new UnboundStellarError('UNTRUSTED_ISSUER', `asset ${asset.code} is not from a verified issuer`);
    }
  }
}

export function assertWellFormed(asset: AssetRef): void {
  if (asset.issuer === null) {
    if (asset.code !== 'XLM') throw new UnboundStellarError('INVALID_ASSET', 'native asset must be XLM');
    return;
  }
  if (!/^[A-Za-z0-9]{1,12}$/.test(asset.code)) throw new UnboundStellarError('INVALID_ASSET', 'invalid asset code');
  if (!StrKey.isValidEd25519PublicKey(asset.issuer)) throw new UnboundStellarError('INVALID_ASSET', 'invalid issuer key');
}
