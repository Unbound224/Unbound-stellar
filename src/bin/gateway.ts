/**
 * Runs the gateway service against Horizon TESTNET. UNVERIFIED against live Testnet (see README).
 * Env: GATEWAY_TOKEN (>=16 chars, shared with unbound-core), HORIZON_URL, PORT, STATE_DIR.
 */
import { join } from 'node:path';
import { TrustedAssetRegistry } from '../registry.js';
import { HorizonClient } from '../rpc/horizon.js';
import { createGatewayServer } from '../service/server.js';
import { FilePendingStore } from '../worker/pending-store.js';

const token = process.env.GATEWAY_TOKEN;
if (!token) {
  console.error('GATEWAY_TOKEN is required (>= 16 characters). Generate your own; never commit it.');
  process.exit(1);
}
const horizon = new HorizonClient(process.env.HORIZON_URL);
const stateDir = process.env.STATE_DIR ?? './state';
const server = createGatewayServer({
  reader: horizon,
  pathSource: horizon,
  submitter: horizon,
  lookup: horizon,
  registry: new TrustedAssetRegistry(), // empty until unbound-core pushes the trusted list
  pending: new FilePendingStore(join(stateDir, 'pending.json')),
  token,
});
const port = Number(process.env.PORT ?? 3002);
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`unbound-stellar gateway on :${port} (TESTNET)`));
