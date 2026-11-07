/**
 * Deterministic, SYNTHETIC XDR fixtures for consumers that must decode transactions (unbound-mobile).
 * Keys are derived from public labels (no secret is stored); they exist only on the SimulatedLedger and
 * must never be funded on any real network. Output is stable, so a test can assert the checked-in files.
 */
import { createHash } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { parseAmount } from '../src/amount.js';
import { buildAuthorizeTrustlineTx, buildIssuerSetupTx, buildIssueTx, buildRedemptionReturnTx } from '../src/ledger/issuance.js';
import { buildChangeTrustTx } from '../src/ledger/trustline.js';
import { quoteStrictSend } from '../src/quotes/quote.js';
import { TrustedAssetRegistry } from '../src/registry.js';
import { buildSettlementTx } from '../src/settlement/build.js';
import { signTransaction, TestnetKeypairSigner } from '../src/settlement/signing.js';
import { SimulatedLedger } from '../src/testing/simulated-ledger.js';
import { TESTNET_PASSPHRASE, type AssetRef } from '../src/types/index.js';
import type { BuiltTx } from '../src/ledger/tx.js';
import { SorobanRedemptionEscrow } from '../src/soroban/escrow.js';
import { FixtureSorobanRpc } from '../src/testing/fixture-soroban-rpc.js';

const kp = (label: string) => new TestnetKeypairSigner(Keypair.fromRawEd25519Seed(createHash('sha256').update(`unbound-fixture:${label}`).digest()));

export async function generateXdrFixtures(): Promise<Record<string, unknown>> {
  const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
  const ledger = new SimulatedLedger(() => T0);
  const issuer = kp('issuer');
  const targetIssuer = kp('target-issuer');
  const user = kp('user');
  const maker = kp('maker');
  for (const s of [issuer, targetIssuer, user, maker]) ledger.createAccount(s.publicKey);
  const SHOP: AssetRef = { code: 'SHOP', issuer: issuer.publicKey };
  const USDC: AssetRef = { code: 'USDC', issuer: targetIssuer.publicKey };
  const registry = new TrustedAssetRegistry([SHOP, USDC]);
  const maxTime = Math.floor(T0 / 1000) + 600;
  const exec = async (b: BuiltTx, s: TestnetKeypairSigner) => ledger.submit(signTransaction(b.xdr, TESTNET_PASSPHRASE, s));

  await exec(await buildIssuerSetupTx(ledger, issuer.publicKey, { maxTime }), issuer);
  await exec(await buildChangeTrustTx(ledger, user.publicKey, SHOP, { limit: parseAmount('1000'), maxTime }), user);
  await exec(await buildAuthorizeTrustlineTx(ledger, SHOP, user.publicKey, { maxTime }), issuer);
  await exec(await buildIssueTx(ledger, SHOP, user.publicKey, parseAmount('100'), { maxTime }), issuer);
  await exec(await buildChangeTrustTx(ledger, user.publicKey, USDC, { limit: parseAmount('100000'), maxTime }), user);
  ledger.setBalance(maker.publicKey, USDC, parseAmount('5000'));
  ledger.setBalance(maker.publicKey, SHOP, 0n);
  ledger.addOffer({ seller: maker.publicKey, selling: USDC, buying: SHOP, amount: parseAmount('5000'), n: 10n, d: 9n });

  const quote = await quoteStrictSend({ pathSource: ledger, registry, now: () => T0 }, { sourceAsset: SHOP, targetAsset: USDC, sourceAmount: '80', slippageBps: 100 });
  const settle = await buildSettlementTx(ledger, registry, { quote, sourceAccount: user.publicKey, destinationAccount: user.publicKey, idempotencyKey: 'fixture-intent-1', nowMs: T0 });
  const signed = signTransaction(settle.xdr, TESTNET_PASSPHRASE, user);
  const burn = await buildRedemptionReturnTx(ledger, SHOP, user.publicKey, parseAmount('30'), { maxTime, idempotencyKey: 'fixture-redeem-1' });
  const pub = (s: TestnetKeypairSigner) => s.publicKey;

  // Soroban redemption escrow invocations (ADR 0002), assembled with the real SDK over the fixture RPC.
  const rpc = new FixtureSorobanRpc();
  rpc.sequences.set(user.publicKey, '4100');
  const escrowId = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
  const escrow = new SorobanRedemptionEscrow({ rpc, contractId: escrowId, registry });
  const nowSec = Math.floor(T0 / 1000);
  const deadline = nowSec + 7 * 86_400;
  const open = await escrow.buildOpenReturn({ consumer: user.publicKey, asset: SHOP, amount: parseAmount('30'), redemptionId: 'red_fixture0001', deadline, nowSec });
  const expire = await escrow.buildExpireRefund({ source: user.publicKey, redemptionId: 'red_fixture0001', nowSec: deadline });

  return {
    note: 'SYNTHETIC. Keys derived from public labels; never fund on any real network.',
    networkPassphrase: TESTNET_PASSPHRASE,
    accounts: { issuer: pub(issuer), targetIssuer: pub(targetIssuer), user: pub(user) },
    quote,
    settlement: { xdr: settle.xdr, signedXdr: signed, hash: settle.hash },
    redemptionReturn: { xdr: burn.xdr, hash: burn.hash, asset: SHOP, amount: '30.0000000' },
    escrowOpen: { xdr: open.xdr, hash: open.hash, contractId: escrowId, redemptionId: 'red_fixture0001', redemptionKeyHex: open.redemptionKeyHex, asset: SHOP, amount: '30.0000000', deadline },
    escrowExpire: { xdr: expire.xdr, hash: expire.hash, contractId: escrowId, redemptionKeyHex: expire.redemptionKeyHex },
  };
}
