import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CursorStore } from '../indexer/indexer.js';

function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path); // atomic on POSIX: readers see the old or new file, never a partial one
}

/** Durable cursor on disk (atomic replace). Survives crashes and restarts. */
export class FileCursorStore implements CursorStore {
  constructor(
    private readonly path: string,
    private readonly initial = '0',
  ) {}
  async get(): Promise<string> {
    if (!existsSync(this.path)) return this.initial;
    const j = JSON.parse(readFileSync(this.path, 'utf8')) as { cursor?: unknown };
    return typeof j.cursor === 'string' ? j.cursor : this.initial;
  }
  async set(cursor: string): Promise<void> {
    atomicWrite(this.path, JSON.stringify({ cursor }));
  }
}

export interface PendingTx {
  hash: string;
  /** unix seconds after which the tx can no longer be included */
  txMaxTimeSec: number;
  addedAt: string;
}

/** Transactions the gateway built/forwarded whose verdict must be reported to core. */
export interface PendingStore {
  add(p: PendingTx): Promise<void>;
  remove(hash: string): Promise<void>;
  list(): Promise<PendingTx[]>;
}

export class InMemoryPendingStore implements PendingStore {
  private readonly m = new Map<string, PendingTx>();
  async add(p: PendingTx) {
    this.m.set(p.hash, p);
  }
  async remove(hash: string) {
    this.m.delete(hash);
  }
  async list() {
    return [...this.m.values()];
  }
}

export class FilePendingStore implements PendingStore {
  constructor(private readonly path: string) {}
  private read(): Record<string, PendingTx> {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, PendingTx>) : {};
  }
  async add(p: PendingTx) {
    const m = this.read();
    m[p.hash] = p;
    atomicWrite(this.path, JSON.stringify(m));
  }
  async remove(hash: string) {
    const m = this.read();
    delete m[hash];
    atomicWrite(this.path, JSON.stringify(m));
  }
  async list() {
    return Object.values(this.read());
  }
}

/** Append-only JSONL of events core refused permanently (4xx). Visible to operators; never silently dropped. */
export class DeadLetterFile {
  constructor(private readonly path: string) {}
  append(entry: unknown): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }
  read(): unknown[] {
    return existsSync(this.path) ? readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown) : [];
  }
}
