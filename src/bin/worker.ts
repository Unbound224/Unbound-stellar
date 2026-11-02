/**
 * Runs the chain worker: resolves pending tx hashes against Horizon and reports to unbound-core.
 * UNVERIFIED against live Testnet. Env: CORE_URL, CORE_TOKEN (admin session token for the worker),
 * HORIZON_URL, STATE_DIR, POLL_INTERVAL_MS.
 */
import { join } from 'node:path';
import { HorizonClient } from '../rpc/horizon.js';
import { DeadLetterFile, FilePendingStore } from '../worker/pending-store.js';
import { HttpEventSink } from '../worker/sink.js';
import { HashWatcher } from '../worker/watcher.js';
import { ChainWorker } from '../worker/worker.js';

const coreUrl = process.env.CORE_URL;
const coreToken = process.env.CORE_TOKEN;
if (!coreUrl || !coreToken) {
  console.error('CORE_URL and CORE_TOKEN are required.');
  process.exit(1);
}
const stateDir = process.env.STATE_DIR ?? './state';
const deadLetter = new DeadLetterFile(join(stateDir, 'dead-letter.jsonl'));
const worker = new ChainWorker(
  {
    watcher: new HashWatcher({
      lookup: new HorizonClient(process.env.HORIZON_URL),
      pending: new FilePendingStore(join(stateDir, 'pending.json')),
      sink: new HttpEventSink({ url: coreUrl, token: coreToken, deadLetter }),
    }),
  },
  { intervalMs: Number(process.env.POLL_INTERVAL_MS ?? 5000), onError: (e) => console.error('tick failed:', e instanceof Error ? e.message : e) },
);
process.on('SIGINT', () => worker.stop());
process.on('SIGTERM', () => worker.stop());
await worker.run();
console.log('worker stopped', JSON.stringify(worker.metrics));
