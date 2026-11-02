import { describe, expect, it } from 'vitest';
import { parseAmount } from '../src/amount.js';
import { buildRedemptionReturnTx } from '../src/ledger/issuance.js';
import { assertTestnet } from '../src/ledger/tx.js';
import { buildSettlementTx } from '../src/settlement/build.js';
import { signTransaction } from '../src/settlement/signing.js';
import { reconcileByHash, submitSettlement } from '../src/settlement/submit.js';
import { TESTNET_PASSPHRASE } from '../src/types/index.js';
import { makeWorld } from './helpers.js';

async function ready() {
  const w = makeWorld();
  await w.issueSampleCredit('100');
  await w.seedLiquidity();
  return w;
}

describe('M1 happy path (SimulatedLedger test adapter)', () => {
  it('settles a quoted strict-send and balances reflect exact amounts', async () => {
    const w = await ready();
    const q = await w.quote('80', 100);
    const { built, signed } = await w.settlementXdr(q);
    const out = await submitSettlement(w.ledger, w.ledger, signed);
    expect(out).toMatchObject({ state: 'CONFIRMED', hash: built.hash, amountOutActual: parseAmount('72') });
    expect(w.ledger.balanceOf(w.user.publicKey, w.SHOP)).toBe(parseAmount('20'));
    expect(w.ledger.balanceOf(w.user.publicKey, w.USDC)).toBe(parseAmount('72'));
    expect(w.ledger.balanceOf(w.maker.publicKey, w.SHOP)).toBe(parseAmount('80'));
    expect(w.ledger.balanceOf(w.maker.publicKey, w.USDC)).toBe(parseAmount('4928'));
  });

  it('tx hash is known before signing and the tx expires with the quote', async () => {
    const w = await ready();
    const q = await w.quote();
    const { built } = await w.settlementXdr(q);
    expect(built.hash).toMatch(/^[0-9a-f]{64}$/);
    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const tx = TransactionBuilder.fromXDR(built.xdr, TESTNET_PASSPHRASE) as import('@stellar/stellar-sdk').Transaction;
    expect(Number(tx.timeBounds!.maxTime)).toBe(Math.floor(Date.parse(q.expiresAt) / 1000));
  });
});

describe('pre-sign guards (nothing built, nothing spent)', () => {
  it('rejects a stale quote', async () => {
    const w = await ready();
    const q = await w.quote();
    w.clock.t += 61_000;
    await expect(w.settlementXdr(q)).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
  });
  it('rejects a tampered quote', async () => {
    const w = await ready();
    const q = await w.quote();
    await expect(w.settlementXdr({ ...q, minDestinationAmount: '0.0000001' })).rejects.toMatchObject({ code: 'QUOTE_TAMPERED' });
  });
  it('rejects when the destination lacks a trustline', async () => {
    const w = await ready();
    const q = await w.quote();
    await expect(
      buildSettlementTx(w.ledger, w.registry, { quote: q, sourceAccount: w.user.publicKey, destinationAccount: w.stranger.publicKey, idempotencyKey: 'k', nowMs: w.clock.t }),
    ).rejects.toMatchObject({ code: 'NO_TRUSTLINE' });
  });
  it('rejects when the destination account does not exist', async () => {
    const w = await ready();
    const q = await w.quote();
    await expect(
      buildSettlementTx(w.ledger, w.registry, { quote: q, sourceAccount: w.user.publicKey, destinationAccount: w.Keypair.random().publicKey(), idempotencyKey: 'k', nowMs: w.clock.t }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_MISSING' });
  });
  it('rejects when the sender balance dropped below the sell amount since quoting', async () => {
    const w = await ready();
    const q = await w.quote('80');
    w.ledger.setBalance(w.user.publicKey, w.SHOP, parseAmount('10'));
    await expect(w.settlementXdr(q)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });
  it('rejects when the issuer revoked the sender authorization (stale authorization)', async () => {
    const w = await ready();
    const q = await w.quote('80');
    const { Operation } = await import('@stellar/stellar-sdk');
    const { buildTx, toSdkAsset } = await import('../src/ledger/tx.js');
    const acct = (await w.ledger.loadAccount(w.issuer.publicKey))!;
    const revoke = buildTx({
      sourceId: w.issuer.publicKey,
      sequence: acct.sequence,
      networkPassphrase: TESTNET_PASSPHRASE,
      maxTime: w.maxTime(),
      operations: [Operation.setTrustLineFlags({ trustor: w.user.publicKey, asset: toSdkAsset(w.SHOP), flags: { authorized: false } })],
    });
    expect((await w.exec(revoke, w.issuer)).status).toBe('SUCCESS');
    await expect(w.settlementXdr(q)).rejects.toMatchObject({ code: 'TRUSTLINE_UNAUTHORIZED' });
  });
  it('rejects a quote for an issuer later removed from the registry', async () => {
    const w = await ready();
    const q = await w.quote();
    w.registry.remove(w.SHOP);
    await expect(w.settlementXdr(q)).rejects.toMatchObject({ code: 'UNTRUSTED_ISSUER' });
  });
  it('refuses a signer that is not the tx source', async () => {
    const w = await ready();
    const q = await w.quote();
    const { built } = await w.settlementXdr(q);
    expect(() => signTransaction(built.xdr, TESTNET_PASSPHRASE, w.stranger)).toThrowError(/not the transaction source/);
  });
  it('refuses any network other than Testnet', () => {
    expect(() => assertTestnet('Public Global Stellar Network ; September 2015')).toThrowError(/unrecognized network/);
  });
});

describe('ledger-side failures classify safely', () => {
  it('liquidity moves after quote: min-output violation fails with no funds moved', async () => {
    const w = await ready();
    const q = await w.quote('80', 100);
    const { signed } = await w.settlementXdr(q);
    // market worsens: new price 10 SHOP : 8 USDC => 80 SHOP buys 64 < min 71.28
    w.ledger.clearOffers();
    w.ledger.addOffer({ seller: w.maker.publicKey, selling: w.USDC, buying: w.SHOP, amount: parseAmount('5000'), n: 10n, d: 8n });
    const before = w.ledger.balanceOf(w.user.publicKey, w.SHOP);
    const out = await submitSettlement(w.ledger, w.ledger, signed);
    expect(out).toMatchObject({ state: 'FAILED', reason: 'MIN_OUTPUT_VIOLATION' });
    expect(w.ledger.balanceOf(w.user.publicKey, w.SHOP)).toBe(before);
    expect(w.ledger.balanceOf(w.user.publicKey, w.USDC)).toBe(0n);
  });

  it('liquidity vanishes after quote: fails as NO_ROUTE, nothing spent', async () => {
    const w = await ready();
    const q = await w.quote();
    const { signed } = await w.settlementXdr(q);
    w.ledger.clearOffers();
    const out = await submitSettlement(w.ledger, w.ledger, signed);
    expect(out).toMatchObject({ state: 'FAILED', reason: 'NO_ROUTE' });
    expect(w.ledger.balanceOf(w.user.publicKey, w.SHOP)).toBe(parseAmount('100'));
  });

  it('tx signed by the wrong key is rejected as BAD_AUTH', async () => {
    const w = await ready();
    const q = await w.quote();
    const { built } = await w.settlementXdr(q);
    // sign with the stranger key by constructing the signature manually
    const { Keypair, TransactionBuilder, xdr } = await import('@stellar/stellar-sdk');
    const tx = TransactionBuilder.fromXDR(built.xdr, TESTNET_PASSPHRASE);
    const other = Keypair.random();
    tx.addDecoratedSignature(new xdr.DecoratedSignature({ hint: other.signatureHint(), signature: other.sign(tx.hash()) }));
    const out = await submitSettlement(w.ledger, w.ledger, tx.toXDR());
    expect(out).toMatchObject({ state: 'FAILED', reason: 'BAD_AUTH' });
  });

  it('a submit after the quote window lapses is rejected as EXPIRED', async () => {
    const w = await ready();
    const q = await w.quote();
    const { signed } = await w.settlementXdr(q);
    w.clock.t += 120_000;
    expect(await submitSettlement(w.ledger, w.ledger, signed)).toMatchObject({ state: 'FAILED', reason: 'EXPIRED' });
  });
});

describe('timeout and idempotency (SRD failure modes)', () => {
  it('timeout AFTER apply is RECONCILING, then resolves CONFIRMED by hash without resubmitting', async () => {
    const w = await ready();
    const { built, signed } = await w.settlementXdr(await w.quote());
    w.ledger.injectNextSubmit('timeout-after-apply');
    const out = await submitSettlement(w.ledger, w.ledger, signed);
    expect(out).toMatchObject({ state: 'RECONCILING', hash: built.hash });
    const calls = w.ledger.submitCalls;
    const resolved = await reconcileByHash(w.ledger, built.hash);
    expect(resolved).toMatchObject({ state: 'CONFIRMED', hash: built.hash });
    expect(w.ledger.submitCalls).toBe(calls);
    expect(w.ledger.balanceOf(w.user.publicKey, w.USDC)).toBe(parseAmount('72'));
  });

  it('retrying the SAME signed tx after an ambiguous timeout does not double spend', async () => {
    const w = await ready();
    const { signed } = await w.settlementXdr(await w.quote());
    w.ledger.injectNextSubmit('timeout-after-apply');
    expect((await submitSettlement(w.ledger, w.ledger, signed)).state).toBe('RECONCILING');
    const calls = w.ledger.submitCalls;
    const again = await submitSettlement(w.ledger, w.ledger, signed);
    expect(again.state).toBe('CONFIRMED');
    expect(w.ledger.submitCalls).toBe(calls); // resolved from the ledger record, not re-sent
    expect(w.ledger.balanceOf(w.user.publicKey, w.USDC)).toBe(parseAmount('72'));
    expect(w.ledger.balanceOf(w.user.publicKey, w.SHOP)).toBe(parseAmount('20'));
  });

  it('duplicate submit of a confirmed tx returns the recorded outcome and never reaches the network', async () => {
    const w = await ready();
    const { signed } = await w.settlementXdr(await w.quote());
    const first = await submitSettlement(w.ledger, w.ledger, signed);
    const calls = w.ledger.submitCalls;
    const second = await submitSettlement(w.ledger, w.ledger, signed);
    expect(second).toMatchObject({ state: 'CONFIRMED', hash: (first as { hash: string }).hash });
    expect(w.ledger.submitCalls).toBe(calls);
    expect(w.ledger.balanceOf(w.user.publicKey, w.USDC)).toBe(parseAmount('72'));
  });

  it('timeout BEFORE apply stays RECONCILING until the tx can no longer be included, then FAILED/EXPIRED', async () => {
    const w = await ready();
    const q = await w.quote();
    const { built, signed } = await w.settlementXdr(q);
    const maxTime = Math.floor(Date.parse(q.expiresAt) / 1000);
    w.ledger.injectNextSubmit('timeout-before-apply');
    const out = await submitSettlement(w.ledger, w.ledger, signed);
    expect(out.state).toBe('RECONCILING');
    const early = await reconcileByHash(w.ledger, built.hash, { txMaxTimeSec: maxTime, nowMs: w.clock.t });
    expect(early.state).toBe('RECONCILING'); // never assume failure while it could still land
    const late = await reconcileByHash(w.ledger, built.hash, { txMaxTimeSec: maxTime, nowMs: (maxTime + 31) * 1000 });
    expect(late).toMatchObject({ state: 'FAILED', reason: 'EXPIRED' });
    expect(w.ledger.balanceOf(w.user.publicKey, w.USDC)).toBe(0n);
  });
});

describe('redemption return (burn)', () => {
  it('holder returns credit to the issuer; supply decreases and unsupported amounts are refused', async () => {
    const w = await ready();
    const built = await buildRedemptionReturnTx(w.ledger, w.SHOP, w.user.publicKey, parseAmount('30'), { maxTime: w.maxTime(), idempotencyKey: 'redeem-1' });
    expect((await w.exec(built, w.user)).status).toBe('SUCCESS');
    expect(w.ledger.balanceOf(w.user.publicKey, w.SHOP)).toBe(parseAmount('70'));
    await expect(buildRedemptionReturnTx(w.ledger, w.SHOP, w.user.publicKey, parseAmount('71'), { maxTime: w.maxTime() })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    await expect(buildRedemptionReturnTx(w.ledger, { code: 'XLM', issuer: null }, w.user.publicKey, 1n, { maxTime: w.maxTime() })).rejects.toMatchObject({ code: 'INVALID_ASSET' });
  });
});
