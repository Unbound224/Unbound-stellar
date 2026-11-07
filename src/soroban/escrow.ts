/**
 * TypeScript adapter for the `unbound-redemption-escrow` Soroban contract (contracts/redemption-escrow,
 * ADR 0002). It builds UNSIGNED, simulated ("prepared") InvokeHostFunction transactions for the
 * consumer (open_return), the issuer (confirm / reject) or anyone (expire_refund), and decodes the
 * contract's records and events.
 *
 * All RPC access goes through `SorobanRpcPort`. `StellarRpcSorobanPort` wraps `rpc.Server` and was run
 * against Stellar Testnet RPC on 2026-11-04 (prepared open_return / confirm / reject / expire_refund landed;
 * see docs/DEPLOYMENT.md). Unit tests drive `SorobanRedemptionEscrow` with `FixtureSorobanRpc` and with
 * byte-for-byte golden XDR produced by the Rust contract tests (fixtures/soroban/redemption-escrow.v1.json).
 */
import { createHash } from 'node:crypto';
import {
  Account,
  Address,
  Asset,
  Contract,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { formatAmount } from '../amount.js';
import { UnboundStellarError } from '../errors.js';
import { assertTestnet, DEFAULT_BASE_FEE, type BuiltTx } from '../ledger/tx.js';
import type { TrustedAssetRegistry } from '../registry.js';
import { TESTNET_PASSPHRASE, type AssetRef } from '../types/index.js';

/** Mirrors MIN_WINDOW_SECS / MAX_WINDOW_SECS in the contract. */
export const ESCROW_MIN_WINDOW_SECS = 3_600;
export const ESCROW_MAX_WINDOW_SECS = 30 * 24 * 3_600;
/** Prepared transactions are valid for 5 minutes; after that a fresh build is required. */
export const ESCROW_TX_TTL_SECS = 300;
const I64_MAX = 9_223_372_036_854_775_807n;

export type EscrowStatus = 'OPEN' | 'CONFIRMED' | 'REJECTED' | 'EXPIRED';

export interface EscrowedReturn {
  consumer: string;
  issuer: string;
  /** Stellar Asset Contract id of the credit */
  token: string;
  /** base units (7 dp) */
  amount: bigint;
  /** ledger timestamp (unix seconds) */
  deadline: number;
  openedAt: number;
  status: EscrowStatus;
  /** null while OPEN */
  closedAt: number | null;
}

export type EscrowEvent =
  | { kind: 'OPENED'; contractId: string; redemptionKeyHex: string; consumer: string; issuer: string; token: string; amount: bigint; deadline: number }
  | { kind: 'CONFIRMED'; contractId: string; redemptionKeyHex: string; issuer: string; amount: bigint }
  | { kind: 'REJECTED' | 'EXPIRED'; contractId: string; redemptionKeyHex: string; consumer: string; amount: bigint };

export interface BuiltSorobanTx extends BuiltTx {
  contractId: string;
  /** which contract function the tx invokes */
  fn: 'open_return' | 'confirm' | 'reject' | 'expire_refund';
  redemptionKeyHex: string;
}

/** The contract keys returns by sha256(core redemption id): ids are single-use on-chain. */
export function redemptionKey(redemptionId: string): Buffer {
  if (!/^[\w-]{4,128}$/.test(redemptionId)) throw new UnboundStellarError('ESCROW_INVALID', 'invalid redemption id');
  return createHash('sha256').update(redemptionId, 'utf8').digest();
}

/** The SAC id of an issued credit on Testnet; deterministic, needs no RPC. */
export function creditContractId(asset: AssetRef, networkPassphrase = TESTNET_PASSPHRASE): string {
  assertTestnet(networkPassphrase);
  if (asset.issuer === null) throw new UnboundStellarError('INVALID_ASSET', 'native XLM is not redeemable credit');
  return new Asset(asset.code, asset.issuer).contractId(networkPassphrase);
}

const STATUS: Record<string, EscrowStatus> = { Open: 'OPEN', Confirmed: 'CONFIRMED', Rejected: 'REJECTED', Expired: 'EXPIRED' };

function mapStatus(v: unknown): EscrowStatus {
  const tag = Array.isArray(v) ? v[0] : v;
  const s = typeof tag === 'string' ? STATUS[tag] : undefined;
  if (!s) throw new UnboundStellarError('ESCROW_INVALID', 'unknown escrow status in contract data');
  return s;
}

function asBigInt(v: unknown, what: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new UnboundStellarError('ESCROW_INVALID', `malformed ${what} in contract data`);
}

function asString(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new UnboundStellarError('ESCROW_INVALID', `malformed ${what} in contract data`);
  return v;
}

/** Decodes an `EscrowedReturn` contracttype (ScMap with snake_case symbol keys). */
export function decodeEscrowedReturn(scv: xdr.ScVal): EscrowedReturn {
  if (scv.type !== 'scvMap') throw new UnboundStellarError('ESCROW_INVALID', 'escrow record is not a map');
  const m = scValToNative(scv) as Record<string, unknown>;
  const closedAt = Number(asBigInt(m.closed_at, 'closed_at'));
  return {
    consumer: asString(m.consumer, 'consumer'),
    issuer: asString(m.issuer, 'issuer'),
    token: asString(m.token, 'token'),
    amount: asBigInt(m.amount, 'amount'),
    deadline: Number(asBigInt(m.deadline, 'deadline')),
    openedAt: Number(asBigInt(m.opened_at, 'opened_at')),
    status: mapStatus(m.status),
    closedAt: closedAt === 0 ? null : closedAt,
  };
}

/** `get_return` returns Option<EscrowedReturn>: void means "never opened". */
export function decodeGetReturn(scv: xdr.ScVal): EscrowedReturn | null {
  return scv.type === 'scvVoid' ? null : decodeEscrowedReturn(scv);
}

const EVENT_KIND: Record<string, EscrowEvent['kind']> = {
  return_opened: 'OPENED',
  return_confirmed: 'CONFIRMED',
  return_rejected: 'REJECTED',
  return_expired: 'EXPIRED',
};

/**
 * Decodes one contract event. Returns null for events that are not escrow lifecycle events (e.g.
 * `paused_changed` or another contract's event) so an indexer can skip them; throws on a lifecycle
 * event with malformed data (fail closed).
 */
export function decodeEscrowEvent(ev: xdr.ContractEvent, expectedContractId?: string): EscrowEvent | null {
  const cid = ev.contractId;
  if (!cid || ev.body.type !== 'v0') return null;
  const contractId = StrKey.encodeContract(Buffer.from(cid.toBytes()));
  if (expectedContractId && contractId !== expectedContractId) return null;
  const { topics, data } = ev.body.v0;
  const [name, keyVal] = topics;
  if (topics.length !== 2 || name?.type !== 'scvSymbol') return null;
  const kind = EVENT_KIND[name.value];
  if (!kind) return null;
  if (keyVal?.type !== 'scvBytes') throw new UnboundStellarError('ESCROW_INVALID', 'escrow event without a redemption key');
  const redemptionKeyHex = Buffer.from(keyVal.bytes.toBytes()).toString('hex');
  const d = scValToNative(data) as Record<string, unknown>;
  const amount = asBigInt(d.amount, 'amount');
  switch (kind) {
    case 'OPENED':
      return {
        kind,
        contractId,
        redemptionKeyHex,
        consumer: asString(d.consumer, 'consumer'),
        issuer: asString(d.issuer, 'issuer'),
        token: asString(d.token, 'token'),
        amount,
        deadline: Number(asBigInt(d.deadline, 'deadline')),
      };
    case 'CONFIRMED':
      return { kind, contractId, redemptionKeyHex, issuer: asString(d.issuer, 'issuer'), amount };
    default:
      return { kind, contractId, redemptionKeyHex, consumer: asString(d.consumer, 'consumer'), amount };
  }
}

/** The RPC capabilities the escrow adapter needs. */
export interface SorobanRpcPort {
  readonly networkPassphrase: string;
  /** Current sequence of `account`, or null when the account does not exist. */
  loadSequence(account: string): Promise<string | null>;
  /** Simulates and assembles (footprint, resource fee, auth entries). Throws on simulation failure. */
  prepare(tx: Transaction): Promise<Transaction>;
  /** Read-only simulation; returns the invocation's return value. */
  simulateRead(tx: Transaction): Promise<xdr.ScVal>;
}

/** What unbound-stellar's gateway (and through it unbound-core) needs from the escrow. */
export interface RedemptionEscrow {
  readonly contractId: string;
  buildOpenReturn(args: { consumer: string; asset: AssetRef; amount: bigint; redemptionId: string; deadline: number; nowSec: number }): Promise<BuiltSorobanTx>;
  buildConfirm(args: { issuer: string; redemptionId: string; nowSec: number }): Promise<BuiltSorobanTx>;
  buildReject(args: { issuer: string; redemptionId: string; nowSec: number }): Promise<BuiltSorobanTx>;
  buildExpireRefund(args: { source: string; redemptionId: string; nowSec: number }): Promise<BuiltSorobanTx>;
  getReturn(redemptionId: string): Promise<EscrowedReturn | null>;
}

/** All-zero ed25519 key: a valid strkey used only as the source of read-only simulations. */
const READ_SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

function assertAccount(id: string, what: string): void {
  if (!StrKey.isValidEd25519PublicKey(id)) throw new UnboundStellarError('ESCROW_INVALID', `${what} must be a Stellar account (G...)`);
}

export class SorobanRedemptionEscrow implements RedemptionEscrow {
  readonly contractId: string;
  private readonly contract: Contract;

  constructor(
    private readonly opts: {
      rpc: SorobanRpcPort;
      contractId: string;
      /** when given, only credits of verified issuers (fed by unbound-core) may be escrowed */
      registry?: TrustedAssetRegistry;
    },
  ) {
    assertTestnet(opts.rpc.networkPassphrase);
    if (!StrKey.isValidContract(opts.contractId)) throw new UnboundStellarError('ESCROW_INVALID', 'escrow contract id must be a C... strkey');
    this.contractId = opts.contractId;
    this.contract = new Contract(opts.contractId);
  }

  async buildOpenReturn(a: { consumer: string; asset: AssetRef; amount: bigint; redemptionId: string; deadline: number; nowSec: number }): Promise<BuiltSorobanTx> {
    assertAccount(a.consumer, 'consumer');
    if (a.asset.issuer === null) throw new UnboundStellarError('INVALID_ASSET', 'native XLM is not redeemable credit');
    assertAccount(a.asset.issuer, 'issuer');
    this.opts.registry?.assertTrusted(a.asset);
    if (a.consumer === a.asset.issuer) throw new UnboundStellarError('ESCROW_INVALID', 'consumer cannot be the issuer');
    if (a.amount <= 0n || a.amount > I64_MAX) throw new UnboundStellarError('INVALID_AMOUNT', 'amount must be a positive base-unit amount');
    if (!Number.isSafeInteger(a.deadline) || a.deadline < a.nowSec + ESCROW_MIN_WINDOW_SECS) {
      throw new UnboundStellarError('ESCROW_INVALID', `deadline must be at least ${ESCROW_MIN_WINDOW_SECS}s away`);
    }
    if (a.deadline > a.nowSec + ESCROW_MAX_WINDOW_SECS) throw new UnboundStellarError('ESCROW_INVALID', 'deadline is more than 30 days away');
    const key = redemptionKey(a.redemptionId);
    const token = creditContractId(a.asset, this.opts.rpc.networkPassphrase);
    return this.build(a.consumer, 'open_return', key, a.nowSec, [
      new Address(a.consumer).toScVal(),
      new Address(a.asset.issuer).toScVal(),
      new Address(token).toScVal(),
      nativeToScVal(a.amount, { type: 'i128' }),
      xdr.ScVal.scvBytes(key),
      nativeToScVal(BigInt(a.deadline), { type: 'u64' }),
    ]);
  }

  async buildConfirm(a: { issuer: string; redemptionId: string; nowSec: number }): Promise<BuiltSorobanTx> {
    assertAccount(a.issuer, 'issuer');
    const key = redemptionKey(a.redemptionId);
    return this.build(a.issuer, 'confirm', key, a.nowSec, [xdr.ScVal.scvBytes(key)]);
  }

  async buildReject(a: { issuer: string; redemptionId: string; nowSec: number }): Promise<BuiltSorobanTx> {
    assertAccount(a.issuer, 'issuer');
    const key = redemptionKey(a.redemptionId);
    return this.build(a.issuer, 'reject', key, a.nowSec, [xdr.ScVal.scvBytes(key)]);
  }

  async buildExpireRefund(a: { source: string; redemptionId: string; nowSec: number }): Promise<BuiltSorobanTx> {
    assertAccount(a.source, 'source');
    const key = redemptionKey(a.redemptionId);
    return this.build(a.source, 'expire_refund', key, a.nowSec, [xdr.ScVal.scvBytes(key)]);
  }

  async getReturn(redemptionId: string): Promise<EscrowedReturn | null> {
    const key = redemptionKey(redemptionId);
    const tx = new TransactionBuilder(new Account(READ_SOURCE, '0'), { fee: String(DEFAULT_BASE_FEE), networkPassphrase: this.opts.rpc.networkPassphrase })
      .addOperation(this.contract.call('get_return', xdr.ScVal.scvBytes(key)))
      .setTimeout(ESCROW_TX_TTL_SECS)
      .build();
    return decodeGetReturn(await this.opts.rpc.simulateRead(tx));
  }

  private async build(source: string, fn: BuiltSorobanTx['fn'], key: Buffer, nowSec: number, args: xdr.ScVal[]): Promise<BuiltSorobanTx> {
    const passphrase = this.opts.rpc.networkPassphrase;
    assertTestnet(passphrase);
    const seq = await this.opts.rpc.loadSequence(source);
    if (seq === null) throw new UnboundStellarError('ACCOUNT_MISSING', 'transaction source account does not exist');
    const raw = new TransactionBuilder(new Account(source, seq), {
      fee: String(DEFAULT_BASE_FEE),
      networkPassphrase: passphrase,
      timebounds: { minTime: 0, maxTime: nowSec + ESCROW_TX_TTL_SECS },
    })
      .addOperation(this.contract.call(fn, ...args))
      .build();
    let prepared: Transaction;
    try {
      prepared = await this.opts.rpc.prepare(raw);
    } catch (e) {
      if (e instanceof UnboundStellarError) throw e;
      // simulation failure = the contract would refuse (e.g. NotOpen, DeadlinePassed, unauthorized SAC balance)
      throw new UnboundStellarError('ESCROW_REJECTED', `escrow simulation failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'}`);
    }
    if (prepared.source !== source || prepared.sequence !== raw.sequence || prepared.operations.length !== 1) {
      throw new UnboundStellarError('ESCROW_INVALID', 'prepared transaction does not match the requested invocation');
    }
    return {
      xdr: prepared.toXDR(),
      hash: Buffer.from(prepared.hash()).toString('hex'),
      networkPassphrase: passphrase,
      contractId: this.contractId,
      fn,
      redemptionKeyHex: key.toString('hex'),
    };
  }
}

/** Human-readable 7-dp amount of an escrowed return (for gateway responses). */
export function escrowAmount(r: EscrowedReturn): string {
  return formatAmount(r.amount);
}

/**
 * `SorobanRpcPort` over Stellar RPC (`rpc.Server`). Exercised against soroban-testnet.stellar.org
 * (see docs/DEPLOYMENT.md); Testnet only.
 */
export class StellarRpcSorobanPort implements SorobanRpcPort {
  readonly networkPassphrase = TESTNET_PASSPHRASE;
  private readonly server: rpc.Server;

  constructor(rpcUrl = 'https://soroban-testnet.stellar.org') {
    this.server = new rpc.Server(rpcUrl);
  }

  async loadSequence(account: string): Promise<string | null> {
    try {
      return (await this.server.getAccount(account)).sequenceNumber();
    } catch (e) {
      if (e instanceof Error && /not found/i.test(e.message)) return null;
      throw e;
    }
  }

  prepare(tx: Transaction): Promise<Transaction> {
    return this.server.prepareTransaction(tx) as Promise<Transaction>;
  }

  async simulateRead(tx: Transaction): Promise<xdr.ScVal> {
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new UnboundStellarError('ESCROW_REJECTED', 'read simulation failed');
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) throw new UnboundStellarError('ESCROW_INVALID', 'read simulation returned no value');
    return retval;
  }
}
