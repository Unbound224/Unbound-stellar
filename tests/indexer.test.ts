import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { reconciliationEventJsonSchema } from '../scripts/generate-schemas.js';
import { eventId, makeEvent, ReconciliationEventSchema, type ReconciliationEvent } from '../src/indexer/event.js';
import { Indexer, InMemoryCursorStore, type EventSink } from '../src/indexer/indexer.js';
import type { LedgerEventSource, TxRecord } from '../src/ports.js';
import { submitSettlement } from '../src/settlement/submit.js';
import { TESTNET_PASSPHRASE } from '../src/types/index.js';
import { readFileSync } from 'node:fs';
import { makeWorld } from './helpers.js';

class CollectSink implements EventSink {
  events: ReconciliationEvent[] = [];
  failNext = false;
  async publish(e: ReconciliationEvent[]) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('sink down');
    }
    this.events.push(...e);
  }
}

function rec(i: number, hash = String(i).padStart(64, '0'), ok = true): TxRecord {
  return { hash, ledger: 100 + i, successful: ok, pagingToken: String(i), observedAt: '2026-11-02T12:00:00.000Z' };
}

function sourceOf(all: TxRecord[]): LedgerEventSource {
  return {
    networkPassphrase: TESTNET_PASSPHRASE,
    async fetch(cursor, limit) {
      const start = Number(cursor);
      const events = all.slice(start, start + limit);
      return { events, nextCursor: String(start + events.length) };
    },
  };
}

describe('reconciliation event contract', () => {
  it('matches the ARCHITECTURE.md field set and validates', () => {
    const e = makeEvent({ hash: 'a'.repeat(64), status: 'CONFIRMED', ledgerCursor: '42', observedAt: '2026-11-02T12:00:00.000Z', ledger: 7, amountOutActual: '72.0000000' });
    expect(Object.keys(e).sort()).toEqual(
      ['amountOutActual', 'entityRef', 'id', 'ledger', 'ledgerCursor', 'network', 'observedAt', 'schemaVersion', 'sourceRepo', 'status'].sort(),
    );
    expect(e.id).toBe(eventId('a'.repeat(64)));
  });
  it('rejects unknown fields, wrong versions and bad hashes', () => {
    const good = makeEvent({ hash: 'b'.repeat(64), status: 'FAILED', ledgerCursor: '1', observedAt: '2026-11-02T12:00:00.000Z' });
    expect(() => ReconciliationEventSchema.parse({ ...good, extra: 1 })).toThrow();
    expect(() => ReconciliationEventSchema.parse({ ...good, schemaVersion: '2.0' })).toThrow();
    expect(() => ReconciliationEventSchema.parse({ ...good, entityRef: { type: 'transaction', ref: 'xyz' } })).toThrow();
    expect(() => ReconciliationEventSchema.parse({ ...good, network: 'PUBLIC' })).toThrow();
  });
  it('checked-in JSON Schema snapshot matches the zod source (regenerate with npm run schemas)', () => {
    const onDisk = readFileSync(new URL('../schemas/reconciliation-event.v1.json', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(reconciliationEventJsonSchema());
    expect(z.toJSONSchema(ReconciliationEventSchema)).toMatchObject({ type: 'object' });
  });
  it('golden fixture stays valid', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/reconciliation-event.confirmed.v1.json', import.meta.url), 'utf8'));
    const ev = ReconciliationEventSchema.parse(fixture);
    expect(ev.status).toBe('CONFIRMED');
    expect(ev.id).toBe(eventId(ev.entityRef.ref));
  });
});

describe('indexer', () => {
  it('publishes in order, advances the cursor, and is quiet when caught up', async () => {
    const sink = new CollectSink();
    const cursors = new InMemoryCursorStore();
    const ix = new Indexer(sourceOf([rec(1), rec(2, undefined, false), rec(3)]), cursors, sink, { batchSize: 2 });
    const rs = await ix.catchUp();
    expect(sink.events.map((e) => e.status)).toEqual(['CONFIRMED', 'FAILED', 'CONFIRMED']);
    expect(await cursors.get()).toBe('3');
    expect(rs.at(-1)?.fetched).toBe(0);
  });

  it('does not advance the cursor when the sink fails, and replays without loss', async () => {
    const sink = new CollectSink();
    const cursors = new InMemoryCursorStore();
    const ix = new Indexer(sourceOf([rec(1), rec(2)]), cursors, sink);
    sink.failNext = true;
    await expect(ix.pollOnce()).rejects.toThrow('sink down');
    expect(await cursors.get()).toBe('0');
    await ix.pollOnce();
    expect(sink.events).toHaveLength(2);
  });

  it('collapses duplicate observations of the same transaction', async () => {
    const sink = new CollectSink();
    const dup = rec(1, 'c'.repeat(64));
    const ix = new Indexer(sourceOf([dup, { ...dup, pagingToken: '2' }]), new InMemoryCursorStore(), sink);
    const r = await ix.pollOnce();
    expect(r.published).toBe(1);
    expect(r.duplicatesSkipped).toBe(1);
  });

  it('survives a process restart: a new indexer resumes from the stored cursor', async () => {
    const all = [rec(1), rec(2), rec(3)];
    const cursors = new InMemoryCursorStore();
    const sink = new CollectSink();
    await new Indexer(sourceOf(all), cursors, sink, { batchSize: 2 }).pollOnce();
    await new Indexer(sourceOf(all), cursors, sink, { batchSize: 2 }).pollOnce();
    expect(sink.events.map((e) => e.ledgerCursor)).toEqual(['1', '2', '3']);
  });

  it('replayFrom re-emits history (downstream must dedupe by event id)', async () => {
    const sink = new CollectSink();
    const ix = new Indexer(sourceOf([rec(1), rec(2)]), new InMemoryCursorStore(), sink);
    await ix.catchUp();
    await ix.replayFrom('0');
    await ix.catchUp();
    expect(sink.events).toHaveLength(4);
    expect(new Set(sink.events.map((e) => e.id)).size).toBe(2);
  });

  it('can restrict emission to watched hashes', async () => {
    const sink = new CollectSink();
    const ix = new Indexer(sourceOf([rec(1), rec(2)]), new InMemoryCursorStore(), sink, { watchHashes: new Set([rec(2).hash]) });
    await ix.pollOnce();
    expect(sink.events.map((e) => e.entityRef.ref)).toEqual([rec(2).hash]);
  });

  it('refuses to run against a non-Testnet source', () => {
    const bad: LedgerEventSource = { networkPassphrase: 'Public Global Stellar Network ; September 2015', fetch: async () => ({ events: [], nextCursor: '0' }) };
    expect(() => new Indexer(bad, new InMemoryCursorStore(), new CollectSink())).toThrow(/unrecognized network/);
  });

  it('end to end: a settlement submitted through the adapter becomes a CONFIRMED event with the actual amount out', async () => {
    const w = makeWorld();
    await w.issueSampleCredit();
    await w.seedLiquidity();
    const { built, signed } = await w.settlementXdr(await w.quote());
    w.ledger.injectNextSubmit('timeout-after-apply');
    expect((await submitSettlement(w.ledger, w.ledger, signed)).state).toBe('RECONCILING');
    const sink = new CollectSink();
    await new Indexer(w.ledger, new InMemoryCursorStore(), sink, { watchHashes: new Set([built.hash]) }).catchUp();
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ status: 'CONFIRMED', entityRef: { ref: built.hash }, amountOutActual: '72.0000000', sourceRepo: 'unbound-stellar' });
  });
});
