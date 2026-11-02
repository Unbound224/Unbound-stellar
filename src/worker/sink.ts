import type { ReconciliationEvent } from '../indexer/event.js';
import type { EventSink } from '../indexer/indexer.js';
import type { DeadLetterFile } from './pending-store.js';

/**
 * Delivers reconciliation events to unbound-core (POST /v1/admin/ledger-events).
 *  - 2xx: delivered (core dedupes by event id, so redelivery is harmless).
 *  - 408/429/5xx/network error: THROWS -> caller does not advance its cursor and retries later.
 *  - other 4xx: core permanently refuses this event -> written to the dead-letter file and skipped
 *    so one poisoned event cannot block the stream; operators see it in the dead-letter log.
 */
export class HttpEventSink implements EventSink {
  deadLettered = 0;
  constructor(
    private readonly opts: { url: string; token: string; deadLetter: DeadLetterFile; fetchImpl?: typeof fetch; timeoutMs?: number },
  ) {}

  async publish(events: ReconciliationEvent[]): Promise<void> {
    for (const ev of events) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
      let status: number;
      let body: string;
      try {
        const res = await (this.opts.fetchImpl ?? fetch)(this.opts.url.replace(/\/$/, '') + '/v1/admin/ledger-events', {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.opts.token}` },
          body: JSON.stringify(ev),
        });
        status = res.status;
        body = await res.text().catch(() => '');
      } finally {
        clearTimeout(timer);
      }
      if (status >= 200 && status < 300) continue;
      if (status === 408 || status === 429 || status >= 500 || status === 401 || status === 403) {
        // 401/403 means OUR credentials are wrong or expired: an operator problem, never a reason to drop events.
        throw new Error(`core returned ${status}; will retry`);
      }
      this.deadLettered++;
      this.opts.deadLetter.append({ at: new Date().toISOString(), status, eventId: ev.id, body: body.slice(0, 500), event: ev });
    }
  }
}
