import { formatAmount } from '../amount.js';
import type { LedgerEventSource, TxRecord } from '../ports.js';
import { assertTestnet } from '../ledger/tx.js';
import { makeEvent, type ReconciliationEvent } from './event.js';

export interface CursorStore {
  get(): Promise<string>;
  set(cursor: string): Promise<void>;
}

export class InMemoryCursorStore implements CursorStore {
  private cursor: string;
  constructor(initial = '0') {
    this.cursor = initial;
  }
  async get(): Promise<string> {
    return this.cursor;
  }
  async set(c: string): Promise<void> {
    this.cursor = c;
  }
}

/** Receives events at-least-once. MUST be idempotent on event.id. */
export interface EventSink {
  publish(events: ReconciliationEvent[]): Promise<void>;
}

export interface IndexerOptions {
  /** only emit for these hashes (the transactions Unbound knows about); undefined = all */
  watchHashes?: ReadonlySet<string>;
  batchSize?: number;
}

export interface PollResult {
  fetched: number;
  published: number;
  duplicatesSkipped: number;
  cursor: string;
}

/**
 * Cursor-based poller. Delivery is at-least-once: the cursor is advanced only AFTER the sink
 * accepted the batch, so a crash or sink failure replays the batch; duplicates are collapsed by
 * the deterministic event id (network + hash) both here and downstream.
 */
export class Indexer {
  private readonly seen = new Set<string>();
  constructor(
    private readonly source: LedgerEventSource,
    private readonly cursors: CursorStore,
    private readonly sink: EventSink,
    private readonly opts: IndexerOptions = {},
  ) {
    assertTestnet(source.networkPassphrase);
  }

  async pollOnce(): Promise<PollResult> {
    const start = await this.cursors.get();
    const page = await this.source.fetch(start, this.opts.batchSize ?? 100);
    const out: ReconciliationEvent[] = [];
    let duplicates = 0;
    for (const rec of page.events) {
      if (this.opts.watchHashes && !this.opts.watchHashes.has(rec.hash)) continue;
      const ev = this.toEvent(rec);
      if (this.seen.has(ev.id) || out.some((o) => o.id === ev.id)) {
        duplicates++;
        continue;
      }
      out.push(ev);
    }
    if (out.length > 0) await this.sink.publish(out); // throws -> cursor not advanced -> replay
    for (const e of out) this.seen.add(e.id);
    if (page.nextCursor !== start) await this.cursors.set(page.nextCursor);
    return { fetched: page.events.length, published: out.length, duplicatesSkipped: duplicates, cursor: page.nextCursor };
  }

  /** Drain until the source has nothing new. Bounded to avoid unbounded loops. */
  async catchUp(maxPages = 1000): Promise<PollResult[]> {
    const results: PollResult[] = [];
    for (let i = 0; i < maxPages; i++) {
      const r = await this.pollOnce();
      results.push(r);
      if (r.fetched === 0) break;
    }
    return results;
  }

  /** Historical replay from an explicit cursor (e.g. after drift is detected). Resets cursor. */
  async replayFrom(cursor: string): Promise<void> {
    this.seen.clear();
    await this.cursors.set(cursor);
  }

  private toEvent(rec: TxRecord): ReconciliationEvent {
    return makeEvent({
      hash: rec.hash,
      status: rec.successful ? 'CONFIRMED' : 'FAILED',
      ledgerCursor: rec.pagingToken,
      observedAt: rec.observedAt,
      ledger: rec.ledger,
      ...(rec.amountOutActual !== undefined ? { amountOutActual: formatAmount(rec.amountOutActual) } : {}),
    });
  }
}
