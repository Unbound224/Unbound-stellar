import { Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { SubmitTimeoutError } from '../errors.js';
import { assertTestnet } from '../ledger/tx.js';
import type { Submitter, TransactionLookup, TxResultCodes } from '../ports.js';
import type { ReconciliationStatus } from '../types/index.js';

export type FailureReason =
  | 'MIN_OUTPUT_VIOLATION'
  | 'NO_ROUTE'
  | 'NO_TRUSTLINE'
  | 'TRUSTLINE_UNAUTHORIZED'
  | 'TRUSTLINE_LIMIT_EXCEEDED'
  | 'INSUFFICIENT_BALANCE'
  | 'BAD_SEQUENCE'
  | 'EXPIRED'
  | 'BAD_AUTH'
  | 'REJECTED_OTHER';

export type SettlementOutcome =
  | { state: 'CONFIRMED'; hash: string; ledger: number; amountOutActual?: bigint }
  | { state: 'FAILED'; hash: string; reason: FailureReason; codes: TxResultCodes }
  | { state: 'RECONCILING'; hash: string; detail: string };

const OP_REASON: Record<string, FailureReason> = {
  op_under_dest_min: 'MIN_OUTPUT_VIOLATION',
  op_too_few_offers: 'NO_ROUTE',
  op_over_source_max: 'NO_ROUTE',
  op_no_trust: 'NO_TRUSTLINE',
  op_src_no_trust: 'NO_TRUSTLINE',
  op_no_issuer: 'NO_ROUTE',
  op_not_authorized: 'TRUSTLINE_UNAUTHORIZED',
  op_src_not_authorized: 'TRUSTLINE_UNAUTHORIZED',
  op_line_full: 'TRUSTLINE_LIMIT_EXCEEDED',
  op_underfunded: 'INSUFFICIENT_BALANCE',
};

export function classifyRejection(codes: TxResultCodes): FailureReason {
  for (const op of codes.operations) {
    const r = OP_REASON[op];
    if (r) return r;
  }
  switch (codes.transaction) {
    case 'tx_bad_seq':
      return 'BAD_SEQUENCE';
    case 'tx_too_late':
      return 'EXPIRED';
    case 'tx_bad_auth':
    case 'tx_bad_auth_extra':
      return 'BAD_AUTH';
    default:
      return 'REJECTED_OTHER';
  }
}

export function txHashOf(signedXdr: string, networkPassphrase: string): string {
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase) as Transaction;
  return Buffer.from(tx.hash()).toString('hex');
}

/**
 * Submit and classify. Rules:
 *  - a definitive rejection is FAILED with a reason (nothing was applied);
 *  - a timeout / unknown error AFTER submission is RECONCILING, never FAILED and never retried
 *    with changed parameters;
 *  - a hash already known to the ledger short-circuits to its recorded outcome (idempotent).
 */
export async function submitSettlement(
  submitter: Submitter,
  lookup: TransactionLookup,
  signedXdr: string,
): Promise<SettlementOutcome> {
  assertTestnet(submitter.networkPassphrase);
  const hash = txHashOf(signedXdr, submitter.networkPassphrase);

  const known = await safeLookup(lookup, hash);
  if (known) return fromRecord(known);

  try {
    const res = await submitter.submit(signedXdr);
    if (res.status === 'SUCCESS') {
      return { state: 'CONFIRMED', hash: res.hash, ledger: res.ledger, ...(res.amountOutActual !== undefined ? { amountOutActual: res.amountOutActual } : {}) };
    }
    return { state: 'FAILED', hash: res.hash, reason: classifyRejection(res.codes), codes: res.codes };
  } catch (e) {
    const detail = e instanceof SubmitTimeoutError ? e.message : 'unexpected submit error; outcome unknown';
    return { state: 'RECONCILING', hash, detail };
  }
}

/**
 * Resolve a RECONCILING settlement by hash. While the ledger has no record it stays RECONCILING,
 * unless the tx's own maxTime (plus grace) has passed: an expired, never-included tx can no longer
 * be applied, so it is definitively FAILED(EXPIRED).
 */
export async function reconcileByHash(
  lookup: TransactionLookup,
  hash: string,
  expiry?: { txMaxTimeSec: number; nowMs: number; graceSec?: number },
): Promise<SettlementOutcome> {
  const rec = await lookup.getTransaction(hash);
  if (rec) return fromRecord(rec);
  if (expiry && expiry.nowMs / 1000 > expiry.txMaxTimeSec + (expiry.graceSec ?? 30)) {
    return { state: 'FAILED', hash, reason: 'EXPIRED', codes: { transaction: 'tx_too_late', operations: [] } };
  }
  return { state: 'RECONCILING', hash, detail: 'transaction not yet observed on ledger' };
}

async function safeLookup(lookup: TransactionLookup, hash: string) {
  try {
    return await lookup.getTransaction(hash);
  } catch {
    return null; // lookup failure must not block a first-time submit; submit path handles ambiguity
  }
}

function fromRecord(rec: { hash: string; ledger: number; successful: boolean; amountOutActual?: bigint }): SettlementOutcome {
  if (rec.successful) {
    return { state: 'CONFIRMED', hash: rec.hash, ledger: rec.ledger, ...(rec.amountOutActual !== undefined ? { amountOutActual: rec.amountOutActual } : {}) };
  }
  return { state: 'FAILED', hash: rec.hash, reason: 'REJECTED_OTHER', codes: { transaction: 'tx_failed', operations: [] } };
}

export function toReconciliationStatus(o: SettlementOutcome): ReconciliationStatus {
  return o.state;
}
