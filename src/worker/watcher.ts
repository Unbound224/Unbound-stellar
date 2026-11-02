import { formatAmount } from '../amount.js';
import { makeEvent } from '../indexer/event.js';
import type { EventSink } from '../indexer/indexer.js';
import type { TransactionLookup } from '../ports.js';
import type { PendingStore } from './pending-store.js';

export interface WatchTickResult {
  checked: number;
  resolved: number;
  expired: number;
  lookupErrors: number;
}

/**
 * Resolves the hashes the gateway handed out. For every pending tx it asks the ledger by hash:
 *  - found: publish CONFIRMED/FAILED and forget it (only after the sink accepted it);
 *  - not found and the tx can no longer be included (maxTime + grace passed): publish FAILED (expired);
 *  - not found yet: keep waiting (never assume failure while it could still land);
 *  - lookup/sink error: keep it pending; retried on the next tick.
 */
export class HashWatcher {
  constructor(
    private readonly deps: { lookup: TransactionLookup; pending: PendingStore; sink: EventSink; now?: () => number; graceSec?: number },
  ) {}

  async tick(): Promise<WatchTickResult> {
    const now = (this.deps.now ?? Date.now)();
    const grace = this.deps.graceSec ?? 30;
    const r: WatchTickResult = { checked: 0, resolved: 0, expired: 0, lookupErrors: 0 };
    for (const p of await this.deps.pending.list()) {
      r.checked++;
      let rec;
      try {
        rec = await this.deps.lookup.getTransaction(p.hash);
      } catch {
        r.lookupErrors++;
        continue;
      }
      if (rec) {
        await this.deps.sink.publish([
          makeEvent({
            hash: p.hash,
            status: rec.successful ? 'CONFIRMED' : 'FAILED',
            ledgerCursor: rec.pagingToken,
            observedAt: rec.observedAt,
            ledger: rec.ledger,
            ...(rec.amountOutActual !== undefined ? { amountOutActual: formatAmount(rec.amountOutActual) } : {}),
          }),
        ]);
        await this.deps.pending.remove(p.hash);
        r.resolved++;
      } else if (now / 1000 > p.txMaxTimeSec + grace) {
        await this.deps.sink.publish([
          makeEvent({ hash: p.hash, status: 'FAILED', ledgerCursor: `expired:${p.txMaxTimeSec}`, observedAt: new Date(now).toISOString() }),
        ]);
        await this.deps.pending.remove(p.hash);
        r.expired++;
      }
    }
    return r;
  }
}
