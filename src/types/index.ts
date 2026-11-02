import { Networks } from '@stellar/stellar-sdk';

/** Only Testnet is supported. Mainnet requires external review (docs/SECURITY.md). */
export const TESTNET_PASSPHRASE: string = Networks.TESTNET;
export const NETWORK_NAME = 'TESTNET' as const;
export type NetworkName = typeof NETWORK_NAME;

/** `issuer === null` means native XLM. Credits are always issued assets. */
export interface AssetRef {
  code: string;
  issuer: string | null;
}

export const NATIVE: AssetRef = { code: 'XLM', issuer: null };

export function assetKey(a: AssetRef): string {
  return a.issuer === null ? 'native' : `${a.code}:${a.issuer}`;
}

export function sameAsset(a: AssetRef, b: AssetRef): boolean {
  return assetKey(a) === assetKey(b);
}

export interface AccountFlags {
  authRequired: boolean;
  authRevocable: boolean;
  authImmutable: boolean;
  authClawbackEnabled: boolean;
}

export interface BalanceLine {
  asset: AssetRef;
  /** base units (1 unit = 1e-7), never floats */
  balance: bigint;
  /** trustline limit in base units; null for native */
  limit: bigint | null;
  isAuthorized: boolean;
}

export interface AccountSnapshot {
  id: string;
  sequence: string;
  flags: AccountFlags;
  balances: BalanceLine[];
}

export type ReconciliationStatus = 'CONFIRMED' | 'FAILED' | 'RECONCILING';
