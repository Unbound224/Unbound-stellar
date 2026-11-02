import { Account, Asset, Memo, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { createHash } from 'node:crypto';
import { UnboundStellarError } from '../errors.js';
import type { AssetRef } from '../types/index.js';
import { TESTNET_PASSPHRASE } from '../types/index.js';

export function toSdkAsset(a: AssetRef): Asset {
  return a.issuer === null ? Asset.native() : new Asset(a.code, a.issuer);
}

export function assertTestnet(passphrase: string): void {
  if (passphrase !== TESTNET_PASSPHRASE) {
    throw new UnboundStellarError('UNKNOWN_NETWORK', 'unrecognized network passphrase (only TESTNET is supported)');
  }
}

export interface BuiltTx {
  xdr: string;
  /** hex tx hash; independent of signatures so it can be stored before submission */
  hash: string;
  networkPassphrase: string;
}

export interface BuildOptions {
  sourceId: string;
  /** the account's CURRENT sequence number; the builder uses sequence + 1 */
  sequence: string;
  operations: xdr.Operation[];
  networkPassphrase: string;
  /** unix seconds after which the tx is invalid */
  maxTime: number;
  minTime?: number;
  baseFee?: number;
  /** optional idempotency key, bound into a MemoHash so a tx is traceable to its intent */
  idempotencyKey?: string;
}

export const DEFAULT_BASE_FEE = 100;

export function buildTx(opts: BuildOptions): BuiltTx {
  assertTestnet(opts.networkPassphrase);
  const builder = new TransactionBuilder(new Account(opts.sourceId, opts.sequence), {
    fee: String(opts.baseFee ?? DEFAULT_BASE_FEE),
    networkPassphrase: opts.networkPassphrase,
    timebounds: { minTime: opts.minTime ?? 0, maxTime: opts.maxTime },
    memo: opts.idempotencyKey ? Memo.hash(createHash('sha256').update(opts.idempotencyKey).digest('hex')) : undefined,
  });
  for (const op of opts.operations) builder.addOperation(op);
  const tx = builder.build();
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString('hex'), networkPassphrase: opts.networkPassphrase };
}

export { Operation };
