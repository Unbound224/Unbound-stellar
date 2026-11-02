import { AuthRequiredFlag, AuthRevocableFlag, AuthClawbackEnabledFlag } from '@stellar/stellar-sdk';
import { UnboundStellarError } from '../errors.js';
import type { LedgerReader } from '../ports.js';
import { formatAmount } from '../amount.js';
import { assertCanReceive } from './trustline.js';
import { buildTx, Operation, toSdkAsset, type BuiltTx } from './tx.js';
import type { AssetRef } from '../types/index.js';


async function load(reader: LedgerReader, id: string, what: string) {
  const a = await reader.loadAccount(id);
  if (!a) throw new UnboundStellarError('ACCOUNT_MISSING', `${what} account does not exist`);
  return a;
}

/**
 * Unsigned issuer configuration tx: require authorization + allow revocation so the issuer
 * explicitly authorizes every holder (issuers must authorize/honor redemption). Clawback is
 * opt-in and, once enabled, must be shown to holders (see verifyIssuerAccount warnings).
 */
export async function buildIssuerSetupTx(
  reader: LedgerReader,
  issuer: string,
  opts: { maxTime: number; enableClawback?: boolean; homeDomain?: string },
): Promise<BuiltTx> {
  const acct = await load(reader, issuer, 'issuer');
  let flags = AuthRequiredFlag | AuthRevocableFlag;
  if (opts.enableClawback) flags |= AuthClawbackEnabledFlag;
  return buildTx({
    sourceId: issuer,
    sequence: acct.sequence,
    networkPassphrase: reader.networkPassphrase,
    maxTime: opts.maxTime,
    operations: [Operation.setOptions({ setFlags: flags, ...(opts.homeDomain ? { homeDomain: opts.homeDomain } : {}) })],
  });
}

/** Unsigned issuer tx authorizing `holder`'s existing trustline for `asset`. */
export async function buildAuthorizeTrustlineTx(
  reader: LedgerReader,
  asset: AssetRef,
  holder: string,
  opts: { maxTime: number },
): Promise<BuiltTx> {
  if (asset.issuer === null) throw new UnboundStellarError('INVALID_ASSET', 'native asset has no issuer');
  const acct = await load(reader, asset.issuer, 'issuer');
  return buildTx({
    sourceId: asset.issuer,
    sequence: acct.sequence,
    networkPassphrase: reader.networkPassphrase,
    maxTime: opts.maxTime,
    operations: [
      Operation.setTrustLineFlags({
        trustor: holder,
        asset: toSdkAsset(asset),
        flags: { authorized: true },
      }),
    ],
  });
}

/**
 * Unsigned issuer tx distributing `amount` of the credit to `holder`. Refuses when the holder
 * lacks a trustline, is unauthorized, or would exceed the limit - nothing is built.
 */
export async function buildIssueTx(
  reader: LedgerReader,
  asset: AssetRef,
  holder: string,
  amount: bigint,
  opts: { maxTime: number; idempotencyKey?: string },
): Promise<BuiltTx> {
  if (asset.issuer === null) throw new UnboundStellarError('INVALID_ASSET', 'cannot issue native asset');
  await assertCanReceive(reader, holder, asset, amount);
  const acct = await load(reader, asset.issuer, 'issuer');
  return buildTx({
    sourceId: asset.issuer,
    sequence: acct.sequence,
    networkPassphrase: reader.networkPassphrase,
    maxTime: opts.maxTime,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    operations: [Operation.payment({ destination: holder, asset: toSdkAsset(asset), amount: formatAmount(amount) })],
  });
}

/**
 * Unsigned holder tx returning (burning) credit to its issuer, the on-chain half of a merchant
 * redemption. Whether the shop honors it is an off-chain obligation tracked by unbound-core.
 */
export async function buildRedemptionReturnTx(
  reader: LedgerReader,
  asset: AssetRef,
  holder: string,
  amount: bigint,
  opts: { maxTime: number; idempotencyKey?: string },
): Promise<BuiltTx> {
  if (asset.issuer === null) throw new UnboundStellarError('INVALID_ASSET', 'native asset is not redeemable credit');
  const acct = await load(reader, holder, 'holder');
  const line = acct.balances.find((b) => b.asset.code === asset.code && b.asset.issuer === asset.issuer);
  if (!line) throw new UnboundStellarError('NO_TRUSTLINE', 'holder has no balance of this credit');
  if (line.balance < amount) throw new UnboundStellarError('INSUFFICIENT_BALANCE', 'holder balance is below redemption amount');
  return buildTx({
    sourceId: holder,
    sequence: acct.sequence,
    networkPassphrase: reader.networkPassphrase,
    maxTime: opts.maxTime,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    operations: [Operation.payment({ destination: asset.issuer, asset: toSdkAsset(asset), amount: formatAmount(amount) })],
  });
}
