import { readFileSync } from 'node:fs';
import { Keypair, Networks, TransactionBuilder, scValToNative, xdr, type Transaction } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { UnboundStellarError } from '../src/errors.js';
import { TrustedAssetRegistry } from '../src/registry.js';
import { signTransaction, TestnetKeypairSigner } from '../src/settlement/signing.js';
import {
  creditContractId,
  decodeEscrowEvent,
  decodeEscrowedReturn,
  decodeGetReturn,
  ESCROW_MAX_WINDOW_SECS,
  ESCROW_MIN_WINDOW_SECS,
  redemptionKey,
  SorobanRedemptionEscrow,
} from '../src/soroban/escrow.js';
import { FixtureSorobanRpc, invocationOf } from '../src/testing/fixture-soroban-rpc.js';
import { TESTNET_PASSPHRASE } from '../src/types/index.js';

/** Produced by the Rust contract tests (contracts/redemption-escrow/src/test_golden.rs). */
const golden = JSON.parse(readFileSync(new URL('../fixtures/soroban/redemption-escrow.v1.json', import.meta.url), 'utf8')) as {
  contractId: string;
  consumer: string;
  issuer: string;
  token: string;
  redemptionId: string;
  redemptionKeyHex: string;
  deadline: number;
  openedAt: number;
  returnOpenScValHex: string;
  returnConfirmedScValHex: string;
  returnExpiredScValHex: string;
  events: Record<'opened' | 'confirmed' | 'rejected' | 'expired', string>;
};

const scv = (hex: string) => xdr.ScVal.fromXdr(hex, 'hex');
const event = (hex: string) => xdr.ContractEvent.fromXdr(hex, 'hex');
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as UnboundStellarError).code;
  }
  return 'NO_ERROR';
};
const codeAsync = async (p: Promise<unknown>) => p.then(() => 'NO_ERROR', (e: UnboundStellarError) => e.code);

describe('golden contract XDR (Rust <-> TypeScript)', () => {
  it('derives the same redemption key and credit contract id as the contract fixtures', () => {
    expect(redemptionKey(golden.redemptionId).toString('hex')).toBe(golden.redemptionKeyHex);
    expect(creditContractId({ code: 'SHOP', issuer: golden.issuer })).toBe(golden.token);
  });

  it('decodes an open EscrowedReturn record', () => {
    expect(decodeEscrowedReturn(scv(golden.returnOpenScValHex))).toEqual({
      consumer: golden.consumer,
      issuer: golden.issuer,
      token: golden.token,
      amount: 800_000_000n,
      deadline: golden.deadline,
      openedAt: golden.openedAt,
      status: 'OPEN',
      closedAt: null,
    });
  });

  it('decodes closed records and the Option wrapper', () => {
    const c = decodeEscrowedReturn(scv(golden.returnConfirmedScValHex));
    expect(c.status).toBe('CONFIRMED');
    expect(c.closedAt).toBe(1_766_707_200);
    expect(decodeEscrowedReturn(scv(golden.returnExpiredScValHex)).status).toBe('EXPIRED');
    expect(decodeGetReturn(xdr.ScVal.scvVoid())).toBeNull();
    expect(code(() => decodeEscrowedReturn(xdr.ScVal.scvU32(1)))).toBe('ESCROW_INVALID');
  });

  it('decodes all four lifecycle events', () => {
    const base = { contractId: golden.contractId, redemptionKeyHex: golden.redemptionKeyHex, amount: 800_000_000n };
    expect(decodeEscrowEvent(event(golden.events.opened))).toEqual({
      ...base,
      kind: 'OPENED',
      consumer: golden.consumer,
      issuer: golden.issuer,
      token: golden.token,
      deadline: golden.deadline,
    });
    expect(decodeEscrowEvent(event(golden.events.confirmed))).toEqual({ ...base, kind: 'CONFIRMED', issuer: golden.issuer });
    expect(decodeEscrowEvent(event(golden.events.rejected))).toEqual({ ...base, kind: 'REJECTED', consumer: golden.consumer });
    expect(decodeEscrowEvent(event(golden.events.expired))).toEqual({ ...base, kind: 'EXPIRED', consumer: golden.consumer });
  });

  it('ignores events from another contract or with foreign topics', () => {
    const other = 'CA6LKTSR5SVSQ2RV5LRXEZIIGV7MLJSJ5LVP3ROH27HDKPE4VXUEGANI';
    expect(decodeEscrowEvent(event(golden.events.opened), other)).toBeNull();
    expect(decodeEscrowEvent(event(golden.events.opened), golden.contractId)?.kind).toBe('OPENED');
    const ev = event(golden.events.confirmed);
    const foreign = new xdr.ContractEvent({
      ext: ev.ext,
      contractId: ev.contractId,
      type: ev.type,
      body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol('paused_changed')], data: xdr.ScVal.scvVoid() })),
    });
    expect(decodeEscrowEvent(foreign)).toBeNull();
  });

  it('fails closed on a lifecycle event without a redemption key', () => {
    const ev = event(golden.events.confirmed);
    const bad = new xdr.ContractEvent({
      ext: ev.ext,
      contractId: ev.contractId,
      type: ev.type,
      body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol('return_confirmed'), xdr.ScVal.scvU32(1)], data: xdr.ScVal.scvVoid() })),
    });
    expect(code(() => decodeEscrowEvent(bad))).toBe('ESCROW_INVALID');
  });
});

describe('SorobanRedemptionEscrow builders', () => {
  const NOW = 1_766_620_800;
  let rpc: FixtureSorobanRpc;
  let escrow: SorobanRedemptionEscrow;
  let consumer: TestnetKeypairSigner;
  let issuer: TestnetKeypairSigner;
  let SHOP: { code: string; issuer: string };

  beforeEach(() => {
    rpc = new FixtureSorobanRpc();
    consumer = new TestnetKeypairSigner();
    issuer = new TestnetKeypairSigner();
    SHOP = { code: 'SHOP', issuer: issuer.publicKey };
    rpc.sequences.set(consumer.publicKey, '4100');
    rpc.sequences.set(issuer.publicKey, '9000');
    escrow = new SorobanRedemptionEscrow({ rpc, contractId: golden.contractId, registry: new TrustedAssetRegistry([SHOP]) });
  });

  const open = (over: Partial<Parameters<SorobanRedemptionEscrow['buildOpenReturn']>[0]> = {}) =>
    escrow.buildOpenReturn({ consumer: consumer.publicKey, asset: SHOP, amount: 800_000_000n, redemptionId: 'red_0001abcd', deadline: NOW + 7 * 86_400, nowSec: NOW, ...over });

  it('builds a prepared, unsigned open_return invocation with the exact contract arguments', async () => {
    const built = await open();
    const tx = TransactionBuilder.fromXDR(built.xdr, TESTNET_PASSPHRASE) as Transaction;
    expect(tx.source).toBe(consumer.publicKey);
    expect(tx.sequence).toBe('4101');
    expect(tx.signatures).toHaveLength(0);
    expect(Number(tx.timeBounds?.maxTime)).toBe(NOW + 300);
    expect(Buffer.from(tx.hash()).toString('hex')).toBe(built.hash);
    // the resource fee from simulation is added on top of the inclusion fee
    expect(Number(tx.fee)).toBeGreaterThanOrEqual(123_456);
    const inv = invocationOf(tx);
    expect(inv.contractId).toBe(golden.contractId);
    expect(inv.fn).toBe('open_return');
    const args = inv.args.map((a) => scValToNative(a) as unknown);
    expect(args[0]).toBe(consumer.publicKey);
    expect(args[1]).toBe(issuer.publicKey);
    expect(args[2]).toBe(creditContractId(SHOP));
    expect(args[3]).toBe(800_000_000n);
    expect(Buffer.from(args[4] as Uint8Array).toString('hex')).toBe(redemptionKey('red_0001abcd').toString('hex'));
    expect(args[5]).toBe(BigInt(NOW + 7 * 86_400));
    expect(inv.args[3]!.type).toBe('scvI128');
    expect(inv.args[5]!.type).toBe('scvU64');
    expect(built).toMatchObject({ fn: 'open_return', contractId: golden.contractId, networkPassphrase: TESTNET_PASSPHRASE, redemptionKeyHex: redemptionKey('red_0001abcd').toString('hex') });
  });

  it('the consumer can sign it on-device (source account auth), nobody else', async () => {
    const built = await open();
    expect(() => signTransaction(built.xdr, TESTNET_PASSPHRASE, consumer)).not.toThrow();
    expect(code(() => signTransaction(built.xdr, TESTNET_PASSPHRASE, issuer))).toBe('SIGNER_MISMATCH');
  });

  it('refuses invalid open_return requests before touching RPC', async () => {
    expect(await codeAsync(open({ amount: 0n }))).toBe('INVALID_AMOUNT');
    expect(await codeAsync(open({ amount: -5n }))).toBe('INVALID_AMOUNT');
    expect(await codeAsync(open({ amount: 2n ** 63n }))).toBe('INVALID_AMOUNT');
    expect(await codeAsync(open({ deadline: NOW + ESCROW_MIN_WINDOW_SECS - 1 }))).toBe('ESCROW_INVALID');
    expect(await codeAsync(open({ deadline: NOW + ESCROW_MAX_WINDOW_SECS + 1 }))).toBe('ESCROW_INVALID');
    expect(await codeAsync(open({ consumer: issuer.publicKey }))).toBe('ESCROW_INVALID');
    expect(await codeAsync(open({ consumer: 'GNOTAKEY' }))).toBe('ESCROW_INVALID');
    expect(await codeAsync(open({ asset: { code: 'XLM', issuer: null } }))).toBe('INVALID_ASSET');
    expect(await codeAsync(open({ asset: { code: 'OTHER', issuer: Keypair.random().publicKey() } }))).toBe('UNTRUSTED_ISSUER');
    expect(await codeAsync(open({ redemptionId: 'x' }))).toBe('ESCROW_INVALID');
    expect(rpc.prepared).toHaveLength(0);
    // boundaries are accepted
    expect(await codeAsync(open({ deadline: NOW + ESCROW_MIN_WINDOW_SECS }))).toBe('NO_ERROR');
    expect(await codeAsync(open({ deadline: NOW + ESCROW_MAX_WINDOW_SECS }))).toBe('NO_ERROR');
  });

  it('a missing source account or a contract refusal in simulation builds nothing', async () => {
    rpc.sequences.delete(consumer.publicKey);
    expect(await codeAsync(open())).toBe('ACCOUNT_MISSING');
    rpc.sequences.set(consumer.publicKey, '1');
    rpc.failures.set('open_return', '6'); // DuplicateRedemption
    expect(await codeAsync(open())).toBe('ESCROW_REJECTED');
  });

  it('refuses a prepared transaction that does not match the request', async () => {
    // an RPC that answers with a different (valid, prepared) transaction, e.g. a compromised endpoint
    const other = new TestnetKeypairSigner();
    rpc.sequences.set(other.publicKey, '77');
    const swapped = await escrow.buildConfirm({ issuer: other.publicKey, redemptionId: 'red_0001abcd', nowSec: NOW });
    const evil = new FixtureSorobanRpc();
    evil.sequences.set(issuer.publicKey, '9000');
    evil.prepare = async () => TransactionBuilder.fromXDR(swapped.xdr, TESTNET_PASSPHRASE) as Transaction;
    const e = new SorobanRedemptionEscrow({ rpc: evil, contractId: golden.contractId });
    expect(await codeAsync(e.buildConfirm({ issuer: issuer.publicKey, redemptionId: 'red_0001abcd', nowSec: NOW }))).toBe('ESCROW_INVALID');
  });

  it('builds issuer confirm / reject and anyone-can-call expire_refund', async () => {
    const key = redemptionKey('red_0001abcd').toString('hex');
    for (const [fn, built, source] of [
      ['confirm', await escrow.buildConfirm({ issuer: issuer.publicKey, redemptionId: 'red_0001abcd', nowSec: NOW }), issuer.publicKey],
      ['reject', await escrow.buildReject({ issuer: issuer.publicKey, redemptionId: 'red_0001abcd', nowSec: NOW }), issuer.publicKey],
      ['expire_refund', await escrow.buildExpireRefund({ source: consumer.publicKey, redemptionId: 'red_0001abcd', nowSec: NOW }), consumer.publicKey],
    ] as const) {
      const tx = TransactionBuilder.fromXDR(built.xdr, TESTNET_PASSPHRASE) as Transaction;
      const inv = invocationOf(tx);
      expect(tx.source).toBe(source);
      expect(inv.fn).toBe(fn);
      expect(inv.args).toHaveLength(1);
      expect(Buffer.from(scValToNative(inv.args[0]!) as Uint8Array).toString('hex')).toBe(key);
      expect(built.fn).toBe(fn);
    }
    expect(await codeAsync(escrow.buildConfirm({ issuer: 'nope', redemptionId: 'red_0001abcd', nowSec: NOW }))).toBe('ESCROW_INVALID');
  });

  it('reads records through simulation and treats an unknown id as never opened', async () => {
    expect(await escrow.getReturn('red_0001abcd')).toBeNull();
    rpc.returns.set(golden.redemptionKeyHex, scv(golden.returnOpenScValHex));
    const r = await escrow.getReturn(golden.redemptionId);
    expect(r?.status).toBe('OPEN');
    expect(r?.amount).toBe(800_000_000n);
  });

  it('is Testnet-only and needs a contract strkey', () => {
    const mainnet = new FixtureSorobanRpc();
    mainnet.networkPassphrase = Networks.PUBLIC;
    expect(code(() => new SorobanRedemptionEscrow({ rpc: mainnet, contractId: golden.contractId }))).toBe('UNKNOWN_NETWORK');
    expect(code(() => new SorobanRedemptionEscrow({ rpc, contractId: issuer.publicKey }))).toBe('ESCROW_INVALID');
    expect(code(() => creditContractId(SHOP, Networks.PUBLIC))).toBe('UNKNOWN_NETWORK');
  });
});
