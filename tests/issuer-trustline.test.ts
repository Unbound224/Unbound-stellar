import { describe, expect, it } from 'vitest';
import { parseAmount } from '../src/amount.js';
import { verifyIssuerAccount } from '../src/ledger/issuer.js';
import { buildIssueTx } from '../src/ledger/issuance.js';
import { assertCanReceive, buildChangeTrustTx, checkTrustline } from '../src/ledger/trustline.js';
import { TrustedAssetRegistry } from '../src/registry.js';
import { makeWorld } from './helpers.js';

describe('issuer verification', () => {
  it('rejects an issuer that is not on the verified registry (fail closed)', async () => {
    const w = makeWorld();
    const rogue = { code: 'SHOP', issuer: w.stranger.publicKey };
    await expect(verifyIssuerAccount(w.ledger, w.registry, rogue)).rejects.toMatchObject({ code: 'UNTRUSTED_ISSUER' });
  });
  it('rejects a registered issuer whose account does not exist on the network', async () => {
    const w = makeWorld();
    const ghost = { code: 'GHOST', issuer: w.Keypair.random().publicKey() };
    const reg = new TrustedAssetRegistry([ghost]);
    await expect(verifyIssuerAccount(w.ledger, reg, ghost)).rejects.toMatchObject({ code: 'ISSUER_ACCOUNT_MISSING' });
  });
  it('rejects malformed assets', () => {
    expect(() => new TrustedAssetRegistry([{ code: 'bad code!', issuer: 'G123' }])).toThrow(/invalid/);
  });
  it('reports flags and warnings after issuer setup', async () => {
    const w = makeWorld();
    const before = await verifyIssuerAccount(w.ledger, w.registry, w.SHOP);
    expect(before.warnings.join(' ')).toMatch(/does not gate trustlines/);
    await w.issueSampleCredit();
    const after = await verifyIssuerAccount(w.ledger, w.registry, w.SHOP, { requireAuthControl: true });
    expect(after.authRequired).toBe(true);
    expect(after.warnings.join(' ')).toMatch(/revoke/);
  });
  it('requireAuthControl fails when the issuer does not gate trustlines', async () => {
    const w = makeWorld();
    await expect(verifyIssuerAccount(w.ledger, w.registry, w.SHOP, { requireAuthControl: true })).rejects.toMatchObject({
      code: 'TRUSTLINE_UNAUTHORIZED',
    });
  });
});

describe('trustlines', () => {
  it('blocks issuing when the holder has no trustline, and builds nothing', async () => {
    const w = makeWorld();
    await expect(buildIssueTx(w.ledger, w.SHOP, w.user.publicKey, 1n, { maxTime: w.maxTime() })).rejects.toMatchObject({ code: 'NO_TRUSTLINE' });
    expect((await checkTrustline(w.ledger, w.user.publicKey, w.SHOP, 1n)).status).toBe('MISSING');
  });
  it('blocks issuing while the issuer has not authorized the trustline', async () => {
    const w = makeWorld();
    const { buildIssuerSetupTx } = await import('../src/ledger/issuance.js');
    await w.exec(await buildIssuerSetupTx(w.ledger, w.issuer.publicKey, { maxTime: w.maxTime() }), w.issuer);
    await w.exec(await buildChangeTrustTx(w.ledger, w.user.publicKey, w.SHOP, { limit: parseAmount('10'), maxTime: w.maxTime() }), w.user);
    await expect(assertCanReceive(w.ledger, w.user.publicKey, w.SHOP, 1n)).rejects.toMatchObject({ code: 'TRUSTLINE_UNAUTHORIZED' });
  });
  it('blocks issuing beyond the trustline limit', async () => {
    const w = makeWorld();
    await w.exec(await buildChangeTrustTx(w.ledger, w.user.publicKey, w.SHOP, { limit: parseAmount('10'), maxTime: w.maxTime() }), w.user);
    const r = await checkTrustline(w.ledger, w.user.publicKey, w.SHOP, parseAmount('11'));
    expect(r.status).toBe('LIMIT_EXCEEDED');
    await expect(assertCanReceive(w.ledger, w.user.publicKey, w.SHOP, parseAmount('11'))).rejects.toMatchObject({ code: 'TRUSTLINE_LIMIT_EXCEEDED' });
  });
  it('reports a missing destination account', async () => {
    const w = makeWorld();
    const nobody = w.Keypair.random().publicKey();
    expect((await checkTrustline(w.ledger, nobody, w.SHOP, 1n)).status).toBe('ACCOUNT_MISSING');
  });
  it('refuses to build a trustline for the native asset', async () => {
    const w = makeWorld();
    await expect(buildChangeTrustTx(w.ledger, w.user.publicKey, { code: 'XLM', issuer: null }, { limit: 1n, maxTime: w.maxTime() })).rejects.toMatchObject({ code: 'INVALID_ASSET' });
  });
  it('issues credit end to end once trustline exists and is authorized', async () => {
    const w = makeWorld();
    await w.issueSampleCredit('100');
    expect(w.ledger.balanceOf(w.user.publicKey, w.SHOP)).toBe(parseAmount('100'));
  });
});
