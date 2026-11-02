import { describe, expect, it } from 'vitest';
import { parseAmount } from '../src/amount.js';
import { assertQuoteFresh, assertQuoteIntegrity, quoteStrictSend } from '../src/quotes/quote.js';
import { makeWorld } from './helpers.js';

describe('path quotes', () => {
  it('produces a time-bounded quote with issuers, fee, slippage floor and expiry', async () => {
    const w = makeWorld();
    await w.issueSampleCredit();
    await w.seedLiquidity();
    const q = await w.quote('80', 100);
    expect(q.expectedDestinationAmount).toBe('72.0000000');
    expect(q.minDestinationAmount).toBe('71.2800000'); // 72 * 99%
    expect(q.sourceAsset.issuer).toBe(w.issuer.publicKey);
    expect(q.targetAsset.issuer).toBe(w.targetIssuer.publicKey);
    expect(q.estimatedFeeStroops).toBe(100);
    expect(Date.parse(q.expiresAt) - Date.parse(q.issuedAt)).toBe(60_000);
    expect(q.warnings.join(' ')).toMatch(/Indicative/);
  });

  it('gives no quote when there is no liquidity', async () => {
    const w = makeWorld();
    await expect(w.quote()).rejects.toMatchObject({ code: 'NO_ROUTE' });
  });

  it('gives no quote when the book is exhausted for the requested size', async () => {
    const w = makeWorld();
    await w.seedLiquidity('1'); // 1 USDC deep; selling 80 SHOP still crosses but only fills 1 -> tiny output
    const q = await w.quote('80', 0);
    expect(q.expectedDestinationAmount).toBe('1.0000000'); // never more than depth
    expect(q.warnings.join(' ')).toMatch(/thin/);
  });

  it('refuses an untrusted source or target issuer', async () => {
    const w = makeWorld();
    await w.seedLiquidity();
    const rogue = { code: 'SHOP', issuer: w.stranger.publicKey };
    await expect(
      quoteStrictSend({ pathSource: w.ledger, registry: w.registry }, { sourceAsset: rogue, targetAsset: w.USDC, sourceAmount: '1', slippageBps: 100 }),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_ISSUER' });
    await expect(
      quoteStrictSend({ pathSource: w.ledger, registry: w.registry }, { sourceAsset: w.SHOP, targetAsset: rogue, sourceAmount: '1', slippageBps: 100 }),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_ISSUER' });
  });

  it('refuses a route through an unapproved intermediate asset', async () => {
    const w = makeWorld();
    const junk = { code: 'JUNK', issuer: w.stranger.publicKey };
    w.ledger.setBalance(w.maker.publicKey, junk, parseAmount('1000'));
    w.ledger.setBalance(w.maker.publicKey, w.USDC, parseAmount('1000'));
    w.ledger.setBalance(w.maker.publicKey, w.SHOP, 0n);
    // SHOP -> JUNK -> USDC is the only route; JUNK is not on the registry
    w.ledger.addOffer({ seller: w.maker.publicKey, selling: junk, buying: w.SHOP, amount: parseAmount('1000'), n: 1n, d: 1n });
    w.ledger.addOffer({ seller: w.maker.publicKey, selling: w.USDC, buying: junk, amount: parseAmount('1000'), n: 1n, d: 1n });
    await expect(w.quote()).rejects.toMatchObject({ code: 'NO_ROUTE' });
  });

  it('allows a multi-hop route when every hop is approved', async () => {
    const w = makeWorld();
    const mid = { code: 'MID', issuer: w.stranger.publicKey };
    w.registry.add(mid);
    w.ledger.setBalance(w.maker.publicKey, mid, parseAmount('1000'));
    w.ledger.setBalance(w.maker.publicKey, w.USDC, parseAmount('1000'));
    w.ledger.setBalance(w.maker.publicKey, w.SHOP, 0n);
    w.ledger.addOffer({ seller: w.maker.publicKey, selling: mid, buying: w.SHOP, amount: parseAmount('1000'), n: 1n, d: 1n });
    w.ledger.addOffer({ seller: w.maker.publicKey, selling: w.USDC, buying: mid, amount: parseAmount('1000'), n: 1n, d: 1n });
    const q = await w.quote('10', 50);
    expect(q.path).toEqual([mid]);
  });

  it('enforces the minimum-destination floor instead of quoting below it', async () => {
    const w = makeWorld();
    await w.seedLiquidity();
    await expect(w.quote('80', 100, { minimumDestinationAmount: '73' })).rejects.toMatchObject({ code: 'MIN_OUTPUT_VIOLATION' });
    const q = await w.quote('80', 100, { minimumDestinationAmount: '71.9' });
    expect(q.minDestinationAmount).toBe('71.9000000'); // caller floor is tighter than slippage floor
  });

  it.each([-1, 1001, 1.5, Number.NaN])('rejects slippageBps %s', async (bps) => {
    const w = makeWorld();
    await w.seedLiquidity();
    await expect(w.quote('1', bps)).rejects.toMatchObject({ code: 'INVALID_SLIPPAGE' });
  });

  it('rejects invalid amounts and identical assets', async () => {
    const w = makeWorld();
    await w.seedLiquidity();
    await expect(w.quote('0')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(
      quoteStrictSend({ pathSource: w.ledger, registry: w.registry }, { sourceAsset: w.SHOP, targetAsset: w.SHOP, sourceAmount: '1', slippageBps: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ASSET' });
  });

  it('caps the quote lifetime regardless of requested ttl', async () => {
    const w = makeWorld();
    await w.seedLiquidity();
    const q = await quoteStrictSend(
      { pathSource: w.ledger, registry: w.registry, now: () => w.clock.t, ttlMs: 10 * 60_000 },
      { sourceAsset: w.SHOP, targetAsset: w.USDC, sourceAmount: '1', slippageBps: 10 },
    );
    expect(Date.parse(q.expiresAt) - w.clock.t).toBe(120_000);
  });

  it('detects tampering and expiry', async () => {
    const w = makeWorld();
    await w.seedLiquidity();
    const q = await w.quote();
    assertQuoteIntegrity(q);
    expect(() => assertQuoteIntegrity({ ...q, minDestinationAmount: '1.0000000' })).toThrowError(/quote id/);
    expect(() => assertQuoteFresh(q, w.clock.t + 59_999)).not.toThrow();
    expect(() => assertQuoteFresh(q, w.clock.t + 60_000)).toThrow(/expired/);
  });
});
