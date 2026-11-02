import { UnboundStellarError } from '../errors.js';
import type { LedgerReader } from '../ports.js';
import { assetKey, type AssetRef } from '../types/index.js';
import { formatAmount } from '../amount.js';
import { buildTx, Operation, toSdkAsset, type BuiltTx } from './tx.js';

export type TrustlineStatus =
  | { status: 'OK'; available: bigint }
  | { status: 'ACCOUNT_MISSING' }
  | { status: 'MISSING' }
  | { status: 'UNAUTHORIZED' }
  | { status: 'LIMIT_EXCEEDED'; available: bigint };

/** Pure check of whether `holder` can receive `amount` of `asset` right now. */
export async function checkTrustline(
  reader: LedgerReader,
  holder: string,
  asset: AssetRef,
  amount: bigint,
): Promise<TrustlineStatus> {
  if (asset.issuer === null) return { status: 'OK', available: (1n << 63n) - 1n };
  if (holder === asset.issuer) return { status: 'OK', available: (1n << 63n) - 1n };
  const acct = await reader.loadAccount(holder);
  if (!acct) return { status: 'ACCOUNT_MISSING' };
  const line = acct.balances.find((b) => assetKey(b.asset) === assetKey(asset));
  if (!line) return { status: 'MISSING' };
  if (!line.isAuthorized) return { status: 'UNAUTHORIZED' };
  const available = (line.limit ?? 0n) - line.balance;
  if (available < amount) return { status: 'LIMIT_EXCEEDED', available };
  return { status: 'OK', available };
}

export async function assertCanReceive(reader: LedgerReader, holder: string, asset: AssetRef, amount: bigint): Promise<void> {
  const r = await checkTrustline(reader, holder, asset, amount);
  switch (r.status) {
    case 'OK':
      return;
    case 'ACCOUNT_MISSING':
      throw new UnboundStellarError('ACCOUNT_MISSING', 'destination account does not exist');
    case 'MISSING':
      throw new UnboundStellarError('NO_TRUSTLINE', `destination has no trustline for ${asset.code}`);
    case 'UNAUTHORIZED':
      throw new UnboundStellarError('TRUSTLINE_UNAUTHORIZED', `issuer has not authorized destination for ${asset.code}`);
    case 'LIMIT_EXCEEDED':
      throw new UnboundStellarError('TRUSTLINE_LIMIT_EXCEEDED', `trustline limit for ${asset.code} would be exceeded`);
  }
}

/** Unsigned changeTrust tx. The holder signs it themselves; this package never sees the secret. */
export async function buildChangeTrustTx(
  reader: LedgerReader,
  holder: string,
  asset: AssetRef,
  opts: { limit: bigint; maxTime: number },
): Promise<BuiltTx> {
  if (asset.issuer === null) throw new UnboundStellarError('INVALID_ASSET', 'native asset needs no trustline');
  const acct = await reader.loadAccount(holder);
  if (!acct) throw new UnboundStellarError('ACCOUNT_MISSING', 'holder account does not exist');
  return buildTx({
    sourceId: holder,
    sequence: acct.sequence,
    networkPassphrase: reader.networkPassphrase,
    maxTime: opts.maxTime,
    operations: [Operation.changeTrust({ asset: toSdkAsset(asset), limit: formatAmount(opts.limit) })],
  });
}
