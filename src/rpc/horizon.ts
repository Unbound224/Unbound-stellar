/**
 * Horizon adapters. UNVERIFIED AGAINST LIVE TESTNET: the sandbox that built this package had no
 * route to horizon-testnet.stellar.org. The pure mapping functions below are unit-tested against
 * hand-written payloads that follow the public Horizon response shape (NOT recorded responses).
 * The thin Horizon.Server wrappers are type-checked only. A Testnet smoke script is open work (docs/CONTRIBUTOR_ISSUES.md); run one on a
 * networked machine before relying on them.
 */
import { Horizon, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { formatAmount, parseAmount } from '../amount.js';
import { SubmitTimeoutError, UnboundStellarError } from '../errors.js';
import { assertTestnet } from '../ledger/tx.js';
import type {
  LedgerEventPage,
  LedgerEventSource,
  LedgerReader,
  PathCandidate,
  PathSource,
  SubmitResult,
  Submitter,
  TransactionLookup,
  TxRecord,
} from '../ports.js';
import { NATIVE, TESTNET_PASSPHRASE, type AccountSnapshot, type AssetRef } from '../types/index.js';
import { toSdkAsset } from '../ledger/tx.js';

export interface HorizonAssetJson {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}

export function mapAsset(a: HorizonAssetJson): AssetRef {
  if (a.asset_type === 'native') return NATIVE;
  if (!a.asset_code || !a.asset_issuer) throw new UnboundStellarError('INVALID_ASSET', 'malformed Horizon asset');
  return { code: a.asset_code, issuer: a.asset_issuer };
}

export interface HorizonAccountJson {
  id: string;
  sequence: string;
  flags: { auth_required: boolean; auth_revocable: boolean; auth_immutable: boolean; auth_clawback_enabled?: boolean };
  balances: Array<HorizonAssetJson & { balance: string; limit?: string; is_authorized?: boolean }>;
}

export function mapAccount(j: HorizonAccountJson): AccountSnapshot {
  return {
    id: j.id,
    sequence: j.sequence,
    flags: {
      authRequired: j.flags.auth_required,
      authRevocable: j.flags.auth_revocable,
      authImmutable: j.flags.auth_immutable,
      authClawbackEnabled: j.flags.auth_clawback_enabled ?? false,
    },
    balances: j.balances
      .filter((b) => b.asset_type !== 'liquidity_pool_shares')
      .map((b) => ({
        asset: mapAsset(b),
        balance: parseAmount(b.balance, { allowZero: true }),
        limit: b.limit !== undefined ? parseAmount(b.limit, { allowZero: true }) : null,
        // Horizon omits is_authorized for accounts of issuers that do not require auth
        isAuthorized: b.asset_type === 'native' ? true : (b.is_authorized ?? true),
      })),
  };
}

export interface HorizonPathJson {
  destination_amount: string;
  path: HorizonAssetJson[];
}

export function mapPath(j: HorizonPathJson): PathCandidate {
  return { path: j.path.map(mapAsset), destinationAmount: parseAmount(j.destination_amount, { allowZero: true }) };
}

export interface HorizonTxJson {
  hash: string;
  ledger: number;
  successful: boolean;
  paging_token: string;
  created_at: string;
}

export function mapTx(j: HorizonTxJson): TxRecord {
  return { hash: j.hash, ledger: j.ledger, successful: j.successful, pagingToken: j.paging_token, observedAt: j.created_at };
}

interface HorizonErrorLike {
  response?: { status?: number; data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } };
}

/**
 * Horizon returns a 400 with result_codes for a definitive rejection. Anything else
 * (no response, 5xx, 504 timeout) is an UNKNOWN outcome and must become RECONCILING.
 */
export function mapSubmitError(hash: string, e: unknown): SubmitResult {
  const r = (e as HorizonErrorLike).response;
  const codes = r?.data?.extras?.result_codes;
  if (r?.status === 400 && codes?.transaction) {
    return { status: 'REJECTED', hash, codes: { transaction: codes.transaction, operations: codes.operations ?? [] } };
  }
  throw new SubmitTimeoutError('horizon did not give a definitive answer');
}

export class HorizonClient implements LedgerReader, PathSource, Submitter, TransactionLookup, LedgerEventSource {
  readonly networkPassphrase = TESTNET_PASSPHRASE;
  private readonly server: Horizon.Server;

  constructor(horizonUrl = 'https://horizon-testnet.stellar.org') {
    this.server = new Horizon.Server(horizonUrl);
    assertTestnet(this.networkPassphrase);
  }

  async loadAccount(id: string): Promise<AccountSnapshot | null> {
    try {
      const a = await this.server.accounts().accountId(id).call();
      return mapAccount(a as unknown as HorizonAccountJson);
    } catch (e) {
      if ((e as HorizonErrorLike).response?.status === 404) return null;
      throw e;
    }
  }

  async findStrictSendPaths(source: AssetRef, sourceAmount: bigint, destination: AssetRef): Promise<PathCandidate[]> {
    const res = await this.server
      .strictSendPaths(toSdkAsset(source), formatAmount(sourceAmount), [toSdkAsset(destination)])
      .call();
    return res.records.map((r) => mapPath(r as unknown as HorizonPathJson));
  }

  async submit(signedXdr: string): Promise<SubmitResult> {
    const tx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase) as Transaction;
    const hash = Buffer.from(tx.hash()).toString('hex');
    try {
      const r = await this.server.submitTransaction(tx);
      return { status: 'SUCCESS', hash: r.hash, ledger: r.ledger };
    } catch (e) {
      return mapSubmitError(hash, e);
    }
  }

  async getTransaction(hash: string): Promise<TxRecord | null> {
    try {
      const t = await this.server.transactions().transaction(hash).call();
      return mapTx(t as unknown as HorizonTxJson);
    } catch (e) {
      if ((e as HorizonErrorLike).response?.status === 404) return null;
      throw e;
    }
  }

  async fetch(cursor: string, limit: number): Promise<LedgerEventPage> {
    const page = await this.server.transactions().cursor(cursor).order('asc').limit(limit).call();
    const events = page.records.map((r) => mapTx(r as unknown as HorizonTxJson));
    return { events, nextCursor: events.length ? events[events.length - 1]!.pagingToken : cursor };
  }
}
