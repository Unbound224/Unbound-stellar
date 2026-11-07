/**
 * Runs the gateway service against Horizon TESTNET. UNVERIFIED against live Testnet (see README).
 * Env: GATEWAY_TOKEN (>=16 chars, shared with unbound-core), HORIZON_URL, PORT, STATE_DIR.
 * Optional Soroban redemption escrow (ADR 0002): ESCROW_CONTRACT_ID (C...) + SOROBAN_RPC_URL.
 */
import { join } from 'node:path';
import { TrustedAssetRegistry } from '../registry.js';
import { HorizonClient } from '../rpc/horizon.js';
import { LedgerClock } from '../rpc/ledger-clock.js';
import { createGatewayServer } from '../service/server.js';
import { FilePendingStore } from '../worker/pending-store.js';
import { SorobanRedemptionEscrow, StellarRpcSorobanPort } from '../soroban/escrow.js';

const token = process.env.GATEWAY_TOKEN;
if (!token) {
  console.error('GATEWAY_TOKEN is required (>= 16 characters). Generate your own; never commit it.');
  process.exit(1);
}
const horizon = new HorizonClient(process.env.HORIZON_URL);
const stateDir = process.env.STATE_DIR ?? './state';
const registry = new TrustedAssetRegistry(); // empty until unbound-core pushes the trusted list
const escrowId = process.env.ESCROW_CONTRACT_ID;
const escrow = escrowId ? new SorobanRedemptionEscrow({ rpc: new StellarRpcSorobanPort(process.env.SOROBAN_RPC_URL), contractId: escrowId, registry }) : undefined;
// Anchor quote expiry and transaction time bounds to network time: a slow host clock would make every settlement tx_too_late.
const clock = new LedgerClock(process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org');
const skew = await clock.sync();
if (Math.abs(skew) > 5000) console.warn(`host clock differs from network time by ${Math.round(skew / 1000)} s; using network time. Fix the host clock (NTP).`);
setInterval(() => void clock.sync(), 5 * 60_000).unref();
const server = createGatewayServer({
  reader: horizon,
  pathSource: horizon,
  submitter: horizon,
  lookup: horizon,
  registry,
  pending: new FilePendingStore(join(stateDir, 'pending.json')),
  token,
  now: clock.now,
  ...(escrow ? { escrow } : {}),
});
const port = Number(process.env.PORT ?? 3002);
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`unbound-stellar gateway on :${port} (TESTNET${escrow ? `, escrow ${escrow.contractId}` : ', no escrow'})`));
