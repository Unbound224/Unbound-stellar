import { Keypair } from '@stellar/stellar-sdk';
import { parseAmount } from '../src/amount.js';
import { buildAuthorizeTrustlineTx, buildIssuerSetupTx, buildIssueTx } from '../src/ledger/issuance.js';
import { buildChangeTrustTx } from '../src/ledger/trustline.js';
import { TrustedAssetRegistry } from '../src/registry.js';
import { quoteStrictSend, type Quote } from '../src/quotes/quote.js';
import { buildSettlementTx } from '../src/settlement/build.js';
import { signTransaction, TestnetKeypairSigner } from '../src/settlement/signing.js';
import { SimulatedLedger } from '../src/testing/simulated-ledger.js';
import { TESTNET_PASSPHRASE, type AssetRef } from '../src/types/index.js';
import type { BuiltTx } from '../src/ledger/tx.js';

/** All keys are throwaway, generated per test run. Nothing here is a real secret or address. */
export function makeWorld() {
  const clock = { t: Date.UTC(2026, 10, 2, 12, 0, 0) };
  const ledger = new SimulatedLedger(() => clock.t);
  const issuer = new TestnetKeypairSigner();
  const targetIssuer = new TestnetKeypairSigner();
  const user = new TestnetKeypairSigner();
  const maker = new TestnetKeypairSigner();
  const stranger = new TestnetKeypairSigner();
  const SHOP: AssetRef = { code: 'SHOP', issuer: issuer.publicKey };
  const USDC: AssetRef = { code: 'USDC', issuer: targetIssuer.publicKey };
  const registry = new TrustedAssetRegistry([SHOP, USDC]);
  for (const s of [issuer, targetIssuer, user, maker, stranger]) ledger.createAccount(s.publicKey);
  const maxTime = () => Math.floor(clock.t / 1000) + 600;

  async function exec(built: BuiltTx, signer: TestnetKeypairSigner) {
    return ledger.submit(signTransaction(built.xdr, TESTNET_PASSPHRASE, signer));
  }

  /** Issuer requires auth; user trusts SHOP; issuer authorizes; issuer sends `amount` SHOP. */
  async function issueSampleCredit(amount = '100.0000000') {
    await exec(await buildIssuerSetupTx(ledger, issuer.publicKey, { maxTime: maxTime() }), issuer);
    await exec(await buildChangeTrustTx(ledger, user.publicKey, SHOP, { limit: parseAmount('1000'), maxTime: maxTime() }), user);
    await exec(await buildAuthorizeTrustlineTx(ledger, SHOP, user.publicKey, { maxTime: maxTime() }), issuer);
    await exec(await buildIssueTx(ledger, SHOP, user.publicKey, parseAmount(amount), { maxTime: maxTime() }), issuer);
  }

  /** User trusts USDC; maker sells USDC for SHOP at 10 SHOP : 9 USDC. */
  async function seedLiquidity(usdcDepth = '5000') {
    await exec(await buildChangeTrustTx(ledger, user.publicKey, USDC, { limit: parseAmount('100000'), maxTime: maxTime() }), user);
    ledger.setBalance(maker.publicKey, USDC, parseAmount(usdcDepth));
    ledger.setBalance(maker.publicKey, SHOP, 0n);
    ledger.addOffer({ seller: maker.publicKey, selling: USDC, buying: SHOP, amount: parseAmount(usdcDepth), n: 10n, d: 9n });
  }

  async function quote(sourceAmount = '80', slippageBps = 100, extra: { minimumDestinationAmount?: string } = {}): Promise<Quote> {
    return quoteStrictSend(
      { pathSource: ledger, registry, now: () => clock.t },
      { sourceAsset: SHOP, targetAsset: USDC, sourceAmount, slippageBps, ...extra },
    );
  }

  async function settlementXdr(q: Quote, key = 'intent-1') {
    const built = await buildSettlementTx(ledger, registry, {
      quote: q,
      sourceAccount: user.publicKey,
      destinationAccount: user.publicKey,
      idempotencyKey: key,
      nowMs: clock.t,
    });
    return { built, signed: signTransaction(built.xdr, TESTNET_PASSPHRASE, user) };
  }

  return { clock, ledger, issuer, targetIssuer, user, maker, stranger, SHOP, USDC, registry, exec, issueSampleCredit, seedLiquidity, quote, settlementXdr, maxTime, Keypair };
}
