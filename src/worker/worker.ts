import type { Indexer } from '../indexer/indexer.js';
import type { HashWatcher } from './watcher.js';

export interface WorkerMetrics {
  ticks: number;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  resolved: number;
  expired: number;
  indexerPublished: number;
}

export interface WorkerOptions {
  intervalMs?: number;
  maxBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onError?: (e: unknown) => void;
}

/**
 * Chain worker loop. Drives the HashWatcher (and optionally a cursor Indexer) with exponential
 * backoff on failure. A failing tick never loses work: state only advances after the sink accepted.
 */
export class ChainWorker {
  readonly metrics: WorkerMetrics = { ticks: 0, consecutiveFailures: 0, lastSuccessAt: null, lastError: null, resolved: 0, expired: 0, indexerPublished: 0 };
  private running = false;
  private stopSignal: (() => void) | undefined;

  constructor(
    private readonly parts: { watcher: HashWatcher; indexer?: Indexer },
    private readonly opts: WorkerOptions = {},
  ) {}

  /** One pass of all duties. Throws on the first failure so the loop can back off. */
  async runOnce(): Promise<void> {
    this.metrics.ticks++;
    try {
      const w = await this.parts.watcher.tick();
      this.metrics.resolved += w.resolved;
      this.metrics.expired += w.expired;
      if (this.parts.indexer) this.metrics.indexerPublished += (await this.parts.indexer.pollOnce()).published;
      this.metrics.consecutiveFailures = 0;
      this.metrics.lastError = null;
      this.metrics.lastSuccessAt = new Date((this.opts.now ?? Date.now)()).toISOString();
    } catch (e) {
      this.metrics.consecutiveFailures++;
      this.metrics.lastError = e instanceof Error ? e.message : 'unknown error';
      throw e;
    }
  }

  backoffMs(): number {
    const base = this.opts.intervalMs ?? 5_000;
    return Math.min(base * 2 ** this.metrics.consecutiveFailures, this.opts.maxBackoffMs ?? 60_000);
  }

  async run(): Promise<void> {
    this.running = true;
    const sleep =
      this.opts.sleep ??
      ((ms: number) =>
        new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          this.stopSignal = () => {
            clearTimeout(t);
            r();
          };
        }));
    while (this.running) {
      try {
        await this.runOnce();
        if (this.running) await sleep(this.opts.intervalMs ?? 5_000);
      } catch (e) {
        this.opts.onError?.(e);
        if (this.running) await sleep(this.backoffMs());
      }
    }
  }

  stop(): void {
    this.running = false;
    this.stopSignal?.();
  }
}
