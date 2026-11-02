import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeEvent, type ReconciliationEvent } from '../src/indexer/event.js';
import { Indexer, InMemoryCursorStore, type EventSink } from '../src/indexer/indexer.js';
import type { TransactionLookup, TxRecord } from '../src/ports.js';
import { submitSettlement } from '../src/settlement/submit.js';
import { DeadLetterFile, FileCursorStore, FilePendingStore, InMemoryPendingStore } from '../src/worker/pending-store.js';
import { HttpEventSink } from '../src/worker/sink.js';
import { HashWatcher } from '../src/worker/watcher.js';
import { ChainWorker } from '../src/worker/worker.js';
import { makeWorld } from './helpers.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'unbound-worker-'));
  dirs.push(d);
  return d;
};

class Collect implements EventSink {
  events: ReconciliationEvent[] = [];
  fail = false;
  async publish(e: ReconciliationEvent[]) {
    if (this.fail) throw new Error('core down');
    this.events.push(...e);
  }
}

describe('durable stores', () => {
  it('FileCursorStore survives a restart and never leaves temp files', async () => {
    const d = tmp();
    const a = new FileCursorStore(join(d, 'cursor.json'), '0');
    expect(await a.get()).toBe('0');
    await a.set('12345');
    expect(await new FileCursorStore(join(d, 'cursor.json')).get()).toBe('12345');
    expect(readdirSync(d)).toEqual(['cursor.json']);
  });
  it('FilePendingStore persists add/remove across instances', async () => {
    const d = tmp();
    const a = new FilePendingStore(join(d, 'p.json'));
    await a.add({ hash: 'h1', txMaxTimeSec: 1, addedAt: 'x' });
    await a.add({ hash: 'h2', txMaxTimeSec: 2, addedAt: 'x' });
    await a.remove('h1');
    expect((await new FilePendingStore(join(d, 'p.json')).list()).map((p) => p.hash)).toEqual(['h2']);
  });
  it('dead-letter file is append-only JSONL', () => {
    const d = tmp();
    const f = new DeadLetterFile(join(d, 'dl.jsonl'));
    f.append({ a: 1 });
    f.append({ a: 2 });
    expect(f.read()).toEqual([{ a: 1 }, { a: 2 }]);
    expect(readFileSync(join(d, 'dl.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});

async function stubCore(statuses: number[]) {
  const seen: { auth: string | undefined; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: JSON.parse(b) });
      const s = statuses[Math.min(seen.length - 1, statuses.length - 1)]!;
      res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify({ n: seen.length }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
const ev = (i: number) => makeEvent({ hash: String(i).padStart(64, '0'), status: 'CONFIRMED', ledgerCursor: String(i), observedAt: '2026-11-02T12:00:00.000Z' });

describe('HttpEventSink (stub core over real HTTP)', () => {
  it('posts each event with the bearer token', async () => {
    const core = await stubCore([201]);
    const sink = new HttpEventSink({ url: core.url, token: 't0k', deadLetter: new DeadLetterFile(join(tmp(), 'dl')) });
    await sink.publish([ev(1), ev(2)]);
    expect(core.seen.map((s) => s.auth)).toEqual(['Bearer t0k', 'Bearer t0k']);
    expect((core.seen[1]!.body as ReconciliationEvent).ledgerCursor).toBe('2');
  });
  it.each([500, 503, 429, 401, 403])('throws on %i so the cursor is not advanced', async (status) => {
    const core = await stubCore([status]);
    const sink = new HttpEventSink({ url: core.url, token: 't', deadLetter: new DeadLetterFile(join(tmp(), 'dl')) });
    await expect(sink.publish([ev(1)])).rejects.toThrow(String(status));
    expect(sink.deadLettered).toBe(0);
  });
  it('dead-letters a permanently refused event (400) and keeps delivering the rest', async () => {
    const core = await stubCore([400, 201]);
    const dl = new DeadLetterFile(join(tmp(), 'dl.jsonl'));
    const sink = new HttpEventSink({ url: core.url, token: 't', deadLetter: dl });
    await sink.publish([ev(1), ev(2)]);
    expect(sink.deadLettered).toBe(1);
    expect(core.seen).toHaveLength(2);
    expect((dl.read()[0] as { eventId: string }).eventId).toBe(ev(1).id);
  });
  it('a dead core (connection refused) throws', async () => {
    const sink = new HttpEventSink({ url: 'http://127.0.0.1:9', token: 't', deadLetter: new DeadLetterFile(join(tmp(), 'dl')), timeoutMs: 500 });
    await expect(sink.publish([ev(1)])).rejects.toThrow();
  });
});

async function settled() {
  const w = makeWorld();
  await w.issueSampleCredit();
  await w.seedLiquidity();
  return w;
}

describe('HashWatcher', () => {
  it('reports a confirmed settlement exactly once with the ledger amount, then forgets it', async () => {
    const w = await settled();
    const { built, signed } = await w.settlementXdr(await w.quote());
    const pending = new InMemoryPendingStore();
    await pending.add({ hash: built.hash, txMaxTimeSec: Math.floor(w.clock.t / 1000) + 60, addedAt: 'x' });
    w.ledger.injectNextSubmit('timeout-after-apply');
    expect((await submitSettlement(w.ledger, w.ledger, signed)).state).toBe('RECONCILING');
    const sink = new Collect();
    const watcher = new HashWatcher({ lookup: w.ledger, pending, sink, now: () => w.clock.t });
    expect(await watcher.tick()).toMatchObject({ checked: 1, resolved: 1 });
    expect(sink.events[0]).toMatchObject({ status: 'CONFIRMED', amountOutActual: '72.0000000', entityRef: { ref: built.hash } });
    expect(await watcher.tick()).toMatchObject({ checked: 0 });
    expect(sink.events).toHaveLength(1);
  });

  it('reports an on-ledger failure (min output violation) as FAILED', async () => {
    const w = await settled();
    const { built, signed } = await w.settlementXdr(await w.quote());
    w.ledger.clearOffers();
    w.ledger.addOffer({ seller: w.maker.publicKey, selling: w.USDC, buying: w.SHOP, amount: 5_000_0000000n, n: 10n, d: 8n });
    w.ledger.injectNextSubmit('timeout-after-apply');
    await submitSettlement(w.ledger, w.ledger, signed);
    const pending = new InMemoryPendingStore();
    await pending.add({ hash: built.hash, txMaxTimeSec: 9e9, addedAt: 'x' });
    const sink = new Collect();
    await new HashWatcher({ lookup: w.ledger, pending, sink }).tick();
    expect(sink.events[0]!.status).toBe('FAILED');
  });

  it('keeps waiting while the tx could still land, then reports FAILED(expired) once it cannot', async () => {
    const w = await settled();
    const { built } = await w.settlementXdr(await w.quote());
    const maxTime = Math.floor(w.clock.t / 1000) + 60;
    const pending = new InMemoryPendingStore();
    await pending.add({ hash: built.hash, txMaxTimeSec: maxTime, addedAt: 'x' });
    const sink = new Collect();
    let now = w.clock.t;
    const watcher = new HashWatcher({ lookup: w.ledger, pending, sink, now: () => now });
    expect(await watcher.tick()).toMatchObject({ resolved: 0, expired: 0 });
    now = (maxTime + 29) * 1000;
    expect(await watcher.tick()).toMatchObject({ expired: 0 });
    expect(sink.events).toHaveLength(0);
    now = (maxTime + 31) * 1000;
    expect(await watcher.tick()).toMatchObject({ expired: 1 });
    expect(sink.events[0]).toMatchObject({ status: 'FAILED', ledgerCursor: `expired:${maxTime}` });
    expect(await pending.list()).toEqual([]);
  });

  it('keeps the tx pending when lookup or the sink fails (nothing lost)', async () => {
    const pending = new InMemoryPendingStore();
    await pending.add({ hash: 'a'.repeat(64), txMaxTimeSec: 9e9, addedAt: 'x' });
    const rec: TxRecord = { hash: 'a'.repeat(64), ledger: 5, successful: true, pagingToken: '5', observedAt: '2026-11-02T12:00:00.000Z' };
    let broken = true;
    const lookup: TransactionLookup = {
      async getTransaction() {
        if (broken) throw new Error('horizon 503');
        return rec;
      },
    };
    const sink = new Collect();
    const watcher = new HashWatcher({ lookup, pending, sink });
    expect(await watcher.tick()).toMatchObject({ lookupErrors: 1, resolved: 0 });
    broken = false;
    sink.fail = true;
    await expect(watcher.tick()).rejects.toThrow('core down');
    expect(await pending.list()).toHaveLength(1);
    sink.fail = false;
    expect(await watcher.tick()).toMatchObject({ resolved: 1 });
  });

  it('a restarted watcher continues from the file-backed pending set', async () => {
    const w = await settled();
    const { built, signed } = await w.settlementXdr(await w.quote());
    const file = join(tmp(), 'pending.json');
    await new FilePendingStore(file).add({ hash: built.hash, txMaxTimeSec: 9e9, addedAt: 'x' });
    await submitSettlement(w.ledger, w.ledger, signed);
    const sink = new Collect();
    await new HashWatcher({ lookup: w.ledger, pending: new FilePendingStore(file), sink }).tick();
    expect(sink.events).toHaveLength(1);
  });
});

describe('ChainWorker', () => {
  it('backs off exponentially on failure, resets on success, and reports metrics', async () => {
    const pending = new InMemoryPendingStore();
    await pending.add({ hash: 'b'.repeat(64), txMaxTimeSec: 9e9, addedAt: 'x' });
    const rec: TxRecord = { hash: 'b'.repeat(64), ledger: 1, successful: true, pagingToken: '1', observedAt: '2026-11-02T12:00:00.000Z' };
    const sink = new Collect();
    sink.fail = true;
    const sleeps: number[] = [];
    const watcher = new HashWatcher({ lookup: { getTransaction: async () => rec }, pending, sink });
    const worker: ChainWorker = new ChainWorker(
      { watcher },
      {
        intervalMs: 1000,
        maxBackoffMs: 5000,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 3) sink.fail = false;
          if (sleeps.length === 5) worker.stop();
        },
      },
    );
    await worker.run();
    expect(sleeps.slice(0, 3)).toEqual([2000, 4000, 5000]); // 1000*2^n capped at 5000
    expect(sleeps[3]).toBe(1000); // healthy again => normal interval
    expect(worker.metrics).toMatchObject({ consecutiveFailures: 0, resolved: 1, lastError: null });
    expect(worker.metrics.lastSuccessAt).not.toBeNull();
  });

  it('also drives a cursor Indexer when configured', async () => {
    const w = await settled();
    const { built, signed } = await w.settlementXdr(await w.quote());
    await submitSettlement(w.ledger, w.ledger, signed);
    const sink = new Collect();
    const indexer = new Indexer(w.ledger, new InMemoryCursorStore(), sink, { watchHashes: new Set([built.hash]) });
    const worker = new ChainWorker({ watcher: new HashWatcher({ lookup: w.ledger, pending: new InMemoryPendingStore(), sink }), indexer });
    await worker.runOnce();
    expect(worker.metrics.indexerPublished).toBe(1);
  });
});
