import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { xdr } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { TrustedAssetRegistry } from '../src/registry.js';
import { createGatewayServer } from '../src/service/server.js';
import { SorobanRedemptionEscrow } from '../src/soroban/escrow.js';
import { TestnetKeypairSigner } from '../src/settlement/signing.js';
import { FixtureSorobanRpc } from '../src/testing/fixture-soroban-rpc.js';
import { SimulatedLedger } from '../src/testing/simulated-ledger.js';
import { InMemoryPendingStore } from '../src/worker/pending-store.js';

const TOKEN = 'test-service-token-0123456789';
const NOW = Date.UTC(2025, 11, 25, 0, 0, 0);
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/gateway/${n}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const golden = JSON.parse(readFileSync(new URL('../fixtures/soroban/redemption-escrow.v1.json', import.meta.url), 'utf8')) as Record<string, string>;
const keys = (o: object) => Object.keys(o).sort();

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function boot(withEscrow: boolean) {
  const ledger = new SimulatedLedger(() => NOW);
  const consumer = new TestnetKeypairSigner();
  const issuer = new TestnetKeypairSigner();
  const SHOP = { code: 'SHOP', issuer: issuer.publicKey };
  const registry = new TrustedAssetRegistry([SHOP]);
  const rpc = new FixtureSorobanRpc();
  rpc.sequences.set(consumer.publicKey, '10');
  rpc.sequences.set(issuer.publicKey, '20');
  const pending = new InMemoryPendingStore();
  const escrow = new SorobanRedemptionEscrow({ rpc, contractId: golden.contractId!, registry });
  server = createGatewayServer({ reader: ledger, pathSource: ledger, submitter: ledger, lookup: ledger, registry, pending, token: TOKEN, now: () => NOW, ...(withEscrow ? { escrow } : {}) });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const openIn = { asset: SHOP, holder: consumer.publicKey, amount: '80', redemptionId: 'red_0001abcd', deadline: NOW / 1000 + 7 * 86_400 };
  return { call, rpc, pending, consumer, issuer, SHOP, openIn };
}

describe('gateway escrow endpoints (FixtureSorobanRpc behind the adapter)', () => {
  it('builds open/confirm/reject/expire transactions in the shared fixture shape and queues their hashes', async () => {
    const { call, pending, issuer, consumer, openIn } = await boot(true);
    const o = await call('POST', '/gateway/v1/escrow/open', openIn);
    expect(o.status).toBe(200);
    expect(keys(o.json)).toEqual(keys(fixture('escrow-built')));
    expect(o.json.fn).toBe('open_return');
    expect(o.json.hash).toMatch(/^[0-9a-f]{64}$/);
    const c = await call('POST', '/gateway/v1/escrow/confirm', { redemptionId: 'red_0001abcd', issuer: issuer.publicKey });
    const r = await call('POST', '/gateway/v1/escrow/reject', { redemptionId: 'red_0001abcd', issuer: issuer.publicKey });
    const e = await call('POST', '/gateway/v1/escrow/expire', { redemptionId: 'red_0001abcd', source: consumer.publicKey });
    expect([c.json.fn, r.json.fn, e.json.fn]).toEqual(['confirm', 'reject', 'expire_refund']);
    const queued = (await pending.list()).map((p) => p.hash);
    for (const h of [o, c, r, e].map((x) => x.json.hash)) expect(queued).toContain(h);
  });

  it('reads an escrowed return in the shared fixture shape; unknown ids are null', async () => {
    const { call, rpc } = await boot(true);
    const none = await call('GET', '/gateway/v1/escrow/returns/red_unknown1');
    expect(none.json).toEqual({ contractId: golden.contractId, return: null });
    rpc.returns.set(golden.redemptionKeyHex!, xdr.ScVal.fromXdr(golden.returnOpenScValHex!, 'hex'));
    const got = await call('GET', `/gateway/v1/escrow/returns/${golden.redemptionId}`);
    expect(got.status).toBe(200);
    expect(got.json).toEqual(fixture('escrow-return'));
  });

  it('refuses untrusted credit, malformed input and contract refusals with typed errors', async () => {
    const { call, rpc, openIn } = await boot(true);
    const untrusted = await call('POST', '/gateway/v1/escrow/open', { ...openIn, asset: { code: 'EVIL', issuer: new TestnetKeypairSigner().publicKey } });
    expect(untrusted.json.error.code).toBe('UNTRUSTED_ISSUER');
    expect((await call('POST', '/gateway/v1/escrow/open', { ...openIn, extra: 1 })).status).toBe(400);
    expect((await call('POST', '/gateway/v1/escrow/open', { ...openIn, deadline: NOW / 1000 + 60 })).json.error.code).toBe('ESCROW_INVALID');
    rpc.failures.set('confirm', '8');
    const refused = await call('POST', '/gateway/v1/escrow/confirm', { redemptionId: 'red_0001abcd', issuer: openIn.asset.issuer });
    expect(refused.status).toBe(422);
    expect(refused.json.error.code).toBe('ESCROW_REJECTED');
  });

  it('without a configured escrow every escrow call is ESCROW_UNAVAILABLE (core falls back to the native return)', async () => {
    const { call, openIn } = await boot(false);
    const o = await call('POST', '/gateway/v1/escrow/open', openIn);
    expect(o.status).toBe(422);
    expect(o.json).toEqual({ error: { code: 'ESCROW_UNAVAILABLE', message: expect.any(String) } });
    expect((await call('GET', '/gateway/v1/escrow/returns/red_0001abcd')).json.error.code).toBe('ESCROW_UNAVAILABLE');
  });
});
