import type { AccountSnapshot, AssetRef } from './types/index.js';

/** Reads account state from a ledger source (Horizon in production, SimulatedLedger in tests). */
export interface LedgerReader {
  readonly networkPassphrase: string;
  loadAccount(id: string): Promise<AccountSnapshot | null>;
}

export interface PathCandidate {
  /** intermediate assets only (excludes source and destination) */
  path: AssetRef[];
  destinationAmount: bigint;
}

export interface PathSource {
  readonly networkPassphrase: string;
  findStrictSendPaths(source: AssetRef, sourceAmount: bigint, destination: AssetRef): Promise<PathCandidate[]>;
}

export interface TxResultCodes {
  transaction: string;
  operations: string[];
}

export type SubmitResult =
  | { status: 'SUCCESS'; hash: string; ledger: number; amountOutActual?: bigint }
  /** Definitively NOT applied to the ledger (e.g. Horizon 400 tx_failed / tx_bad_seq). */
  | { status: 'REJECTED'; hash: string; codes: TxResultCodes };

/** Submitters throw SubmitTimeoutError when the outcome is unknown. */
export interface Submitter {
  readonly networkPassphrase: string;
  submit(signedXdr: string): Promise<SubmitResult>;
}

export interface TxRecord {
  hash: string;
  ledger: number;
  successful: boolean;
  pagingToken: string;
  observedAt: string;
  amountOutActual?: bigint;
}

export interface TransactionLookup {
  getTransaction(hash: string): Promise<TxRecord | null>;
}

export interface LedgerEventPage {
  events: TxRecord[];
  nextCursor: string;
}

/** Cursor-addressed history; implementations must return events in ascending order. */
export interface LedgerEventSource {
  readonly networkPassphrase: string;
  fetch(cursor: string, limit: number): Promise<LedgerEventPage>;
}

export interface Signer {
  readonly publicKey: string;
  /** Signs a transaction hash payload. Secrets never leave the signer. */
  signHash(hash: Uint8Array): Uint8Array;
}
