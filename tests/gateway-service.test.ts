import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { QuoteSchema } from '../src/quotes/schema.js';
import { createGatewayServer } from '../src/service/server.js';
import { signTransaction } from '../src/settlement/signing.js';
import { TESTNET_PASSPHRASE } from '../src/types/index.js';
import { InMemoryPendingStore } from '../src/worker/pending-store.js';
import { makeWorld } from './helpers.js';

const TOKEN = 'test-service-token-0123456789';
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/gateway/${n}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const keys = (o: Record<string, unknown>) => Object.keys(o).sort();

async function boot() {
  const w = await (async () => {
    const x = makeWorld();
    await x.issueSampleCredit('100');
    await x.seedLiquidity();
    return x;
  })();
  const pending = new InMemoryPendingStore();
  server = createGatewayServer({ reader: w.ledger, pathSource: w.ledger, submitter: w.ledger, lookup: w.ledger, registry: w.registry, pending, token: TOKEN, now: () => w.clock.t });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, token: string | null = TOKEN) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const quoteIn = { sourceAsset: w.SHOP, targetAsset: w.USDC, sourceAmount: '80', slippageBps: 100 };
  return { w, call, pending, quoteIn };
}

describe('gateway service over HTTP (SimulatedLedger behind it)', () => {
  it('serves the documented contract: shapes match the shared fixtures', async () => {
    const { w, call, quoteIn } = await boot();
    const q = await call('POST', '/gateway/v1/quote', quoteIn);
    expect(q.status).toBe(200);
    expect(keys(q.json)).toEqual(keys(fixture('quote')));
    expect(QuoteSchema.safeParse(q.json).success).toBe(true);
    expect(QuoteSchema.safeParse(fixture('quote')).success).toBe(true); // the shared fixture itself is valid

    const s = await call('POST', '/gateway/v1/settlement', { quote: q.json, sourceAccount: w.user.publicKey, destinationAccount: w.user.publicKey, idempotencyKey: 'int_1' });
    expect(s.status).toBe(200);
    expect(keys(s.json)).toEqual(keys(fixture('unsigned-settlement')));

    const signed = signTransaction(s.json.xdr, TESTNET_PASSPHRASE, w.user);
    const o = await call('POST', '/gateway/v1/submit', { signedXdr: signed, expectedHash: s.json.hash });
    expect(o.json).toMatchObject({ state: 'CONFIRMED', amountOutActual: '72.0000000' });
    expect(keys(o.json)).toEqual(keys(fixture('outcome-confirmed')));

    const b = await call('GET', `/gateway/v1/accounts/${w.user.publicKey}/balances`);
    expect(keys(b.json)).toEqual(keys(fixture('balances')));
    expect(Object.keys(b.json.balances[0]).sort()).toEqual(Object.keys((fixture('balances').balances as object[])[0]!).sort());
    const usdc = b.json.balances.find((x: any) => x.asset.code === 'USDC'); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(usdc.balance).toBe('72.0000000');
  });

  it('error bodies match the shared error fixture shape', async () => {
    const { call, w } = await boot();
    w.ledger.clearOffers();
    const r = await call('POST', '/gateway/v1/quote', { sourceAsset: w.SHOP, targetAsset: w.USDC, sourceAmount: '80', slippageBps: 100 });
    expect(r.status).toBe(422);
    expect(r.json).toEqual({ error: { code: 'NO_ROUTE', message: expect.any(String) } });
    expect(keys(r.json.error)).toEqual(keys((fixture('error-no-route') as { error: Record<string, unknown> }).error));
  });

  it('requires the service token', async () => {
    const { call, quoteIn } = await boot();
    expect((await call('POST', '/gateway/v1/quote', quoteIn, null)).status).toBe(401);
    expect((await call('POST', '/gateway/v1/quote', quoteIn, 'wrong-token-wrong-token-1')).status).toBe(401);
    expect(() => createGatewayServer({ token: 'short' } as never)).toThrow(/token/);
  });

  it('rejects unknown fields, bad JSON, and unknown routes without leaking internals', async () => {
    const { call, quoteIn } = await boot();
    expect((await call('POST', '/gateway/v1/quote', { ...quoteIn, extra: 1 })).status).toBe(400);
    expect((await call('POST', '/gateway/v1/quote', '{not json')).json.error.code).toBe('VALIDATION_FAILED');
    expect((await call('GET', '/gateway/v1/nope')).status).toBe(404);
    expect((await call('POST', '/gateway/v1/quote', { ...quoteIn, sourceAmount: '1e3' })).json.error.code).toBe('INVALID_AMOUNT');
  });

  it('refuses untrusted issuers and honours a trusted-asset sync from core', async () => {
    const { call, w, quoteIn } = await boot();
    const rogue = { code: 'SHOP', issuer: w.stranger.publicKey };
    expect((await call('POST', '/gateway/v1/quote', { ...quoteIn, sourceAsset: rogue })).json.error.code).toBe('UNTRUSTED_ISSUER');
    // core revokes SHOP: only USDC remains trusted
    expect((await call('PUT', '/gateway/v1/trusted-assets', { assets: [w.USDC] })).json).toEqual({ count: 1 });
    expect((await call('POST', '/gateway/v1/quote', quoteIn)).json.error.code).toBe('UNTRUSTED_ISSUER');
    // malformed sync leaves the previous set intact
    expect((await call('PUT', '/gateway/v1/trusted-assets', { assets: [{ code: 'bad code', issuer: 'x' }] })).status).toBe(422);
    expect((await call('POST', '/gateway/v1/quote', { ...quoteIn, sourceAsset: w.USDC, targetAsset: w.SHOP })).json.error?.code).toBe('UNTRUSTED_ISSUER');
  });

  it('settlement refuses a stale or tampered quote and a destination without a trustline', async () => {
    const { call, w, quoteIn } = await boot();
    const q = (await call('POST', '/gateway/v1/quote', quoteIn)).json;
    const base = { sourceAccount: w.user.publicKey, destinationAccount: w.user.publicKey, idempotencyKey: 'k1' };
    expect((await call('POST', '/gateway/v1/settlement', { ...base, quote: { ...q, minDestinationAmount: '0.0000001' } })).json.error.code).toBe('QUOTE_TAMPERED');
    expect((await call('POST', '/gateway/v1/settlement', { ...base, destinationAccount: w.stranger.publicKey, quote: q })).json.error.code).toBe('NO_TRUSTLINE');
    w.clock.t += 61_000;
    expect((await call('POST', '/gateway/v1/settlement', { ...base, quote: q })).json.error.code).toBe('QUOTE_EXPIRED');
  });

  it('submit: hash mismatch is refused; unknown outcome returns RECONCILING; a duplicate is idempotent; built hashes are queued for the worker', async () => {
    const { call, w, pending, quoteIn } = await boot();
    const q = (await call('POST', '/gateway/v1/quote', quoteIn)).json;
    const s = (await call('POST', '/gateway/v1/settlement', { quote: q, sourceAccount: w.user.publicKey, destinationAccount: w.user.publicKey, idempotencyKey: 'k2' })).json;
    expect((await pending.list()).map((p) => p.hash)).toEqual([s.hash]);
    const signed = signTransaction(s.xdr, TESTNET_PASSPHRASE, w.user);
    expect((await call('POST', '/gateway/v1/submit', { signedXdr: signed, expectedHash: 'f'.repeat(64) })).json.error.code).toBe('HASH_MISMATCH');
    w.ledger.injectNextSubmit('timeout-after-apply');
    const calls = w.ledger.submitCalls;
    const first = await call('POST', '/gateway/v1/submit', { signedXdr: signed, expectedHash: s.hash });
    expect(first.json.state).toBe('RECONCILING');
    const again = await call('POST', '/gateway/v1/submit', { signedXdr: signed, expectedHash: s.hash });
    expect(again.json).toMatchObject({ state: 'CONFIRMED', amountOutActual: '72.0000000' });
    expect(w.ledger.submitCalls).toBe(calls + 1);
    expect((await call('POST', '/gateway/v1/submit', { signedXdr: 'garbage', expectedHash: s.hash })).status).toBe(422);
  });

  it('on-ledger rejection is reported as FAILED with a reason', async () => {
    const { call, w, quoteIn } = await boot();
    const q = (await call('POST', '/gateway/v1/quote', quoteIn)).json;
    const s = (await call('POST', '/gateway/v1/settlement', { quote: q, sourceAccount: w.user.publicKey, destinationAccount: w.user.publicKey, idempotencyKey: 'k3' })).json;
    w.ledger.clearOffers();
    const o = await call('POST', '/gateway/v1/submit', { signedXdr: signTransaction(s.xdr, TESTNET_PASSPHRASE, w.user), expectedHash: s.hash });
    expect(o.json).toMatchObject({ state: 'FAILED', reason: 'NO_ROUTE' });
    expect(keys(o.json)).toEqual(keys(fixture('outcome-failed')));
  });

  it('redemption-return builds an unsigned burn payment, only for trusted assets and sufficient balance', async () => {
    const { call, w } = await boot();
    const ok = await call('POST', '/gateway/v1/redemption-return', { asset: w.SHOP, holder: w.user.publicKey, amount: '30', idempotencyKey: 'r1' });
    expect(ok.status).toBe(200);
    expect(ok.json.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await call('POST', '/gateway/v1/redemption-return', { asset: w.SHOP, holder: w.user.publicKey, amount: '1000', idempotencyKey: 'r2' })).json.error.code).toBe('INSUFFICIENT_BALANCE');
    expect((await call('POST', '/gateway/v1/redemption-return', { asset: { code: 'SHOP', issuer: w.stranger.publicKey }, holder: w.user.publicKey, amount: '1', idempotencyKey: 'r3' })).json.error.code).toBe('UNTRUSTED_ISSUER');
  });

  it('balances for an unknown account is an empty list, not an error', async () => {
    const { call, w } = await boot();
    expect((await call('GET', `/gateway/v1/accounts/${w.Keypair.random().publicKey()}/balances`)).json).toEqual({ balances: [] });
  });
});
