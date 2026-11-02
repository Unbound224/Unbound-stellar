/**
 * M1 protocol-slice demo against the SimulatedLedger TEST ADAPTER (in-memory, offline).
 * It signs REAL transaction XDR with throwaway keys and prints the REAL deterministic tx hashes
 * of those envelopes. These hashes were NOT submitted to Stellar Testnet.
 */
import { buildIssueTx } from '../src/ledger/issuance.js';
import { parseAmount } from '../src/amount.js';
import { submitSettlement } from '../src/settlement/submit.js';
import { makeWorld } from '../tests/helpers.js';

const w = makeWorld();
await w.issueSampleCredit('100');
await w.seedLiquidity();
console.log('network passphrase:', w.ledger.networkPassphrase);
console.log('issuer (SHOP):', w.issuer.publicKey);
console.log('user:', w.user.publicKey);

const q = await w.quote('80', 100);
console.log('quote', q.quoteId, 'expected', q.expectedDestinationAmount, 'min', q.minDestinationAmount, 'expires', q.expiresAt);

const { built, signed } = await w.settlementXdr(q, 'demo-intent-1');
console.log('settlement tx hash (pre-submit):', built.hash);
const out = await submitSettlement(w.ledger, w.ledger, signed);
console.log('outcome:', JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
console.log('user SHOP:', w.ledger.balanceOf(w.user.publicKey, w.SHOP), 'USDC:', w.ledger.balanceOf(w.user.publicKey, w.USDC));

// failure: issue to an account with no trustline
await buildIssueTx(w.ledger, w.SHOP, w.stranger.publicKey, parseAmount('1'), { maxTime: w.maxTime() }).catch((e: Error) => console.log('blocked as expected:', e.message));
