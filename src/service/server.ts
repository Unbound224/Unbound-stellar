import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { formatAmount, parseAmount } from '../amount.js';
import { UnboundStellarError } from '../errors.js';
import { buildRedemptionReturnTx } from '../ledger/issuance.js';
import type { LedgerReader, PathSource, Submitter, TransactionLookup } from '../ports.js';
import { quoteStrictSend } from '../quotes/quote.js';
import { QuoteSchema } from '../quotes/schema.js';
import type { TrustedAssetRegistry } from '../registry.js';
import { buildSettlementTx } from '../settlement/build.js';
import { submitSettlement, txHashOf } from '../settlement/submit.js';
import type { AssetRef } from '../types/index.js';
import type { PendingStore } from '../worker/pending-store.js';
import type { BuiltSorobanTx, EscrowedReturn, RedemptionEscrow } from '../soroban/escrow.js';

const MAX_BODY = 256 * 1024;

export interface GatewayDeps {
  reader: LedgerReader;
  pathSource: PathSource;
  submitter: Submitter;
  lookup: TransactionLookup;
  registry: TrustedAssetRegistry;
  pending: PendingStore;
  /** shared service token (unbound-core -> this service) */
  token: string;
  now?: () => number;
  /**
   * Soroban redemption escrow (ADR 0002). Optional: without it every /gateway/v1/escrow/* call
   * answers 422 ESCROW_UNAVAILABLE and core falls back to the native redemption-return payment.
   */
  escrow?: RedemptionEscrow;
}

const Asset = z.object({ code: z.string(), issuer: z.string().nullable() }).strict();
const QuoteIn = z
  .object({
    sourceAsset: Asset,
    targetAsset: Asset,
    sourceAmount: z.string(),
    slippageBps: z.number().int(),
    minimumDestinationAmount: z.string().optional(),
  })
  .strict();
const SettlementIn = z.object({ quote: QuoteSchema, sourceAccount: z.string(), destinationAccount: z.string(), idempotencyKey: z.string().min(1).max(128) }).strict();
const ReturnIn = z
  .object({ asset: z.object({ code: z.string(), issuer: z.string() }).strict(), holder: z.string(), amount: z.string(), idempotencyKey: z.string().min(1).max(128) })
  .strict();
const SubmitIn = z.object({ signedXdr: z.string().min(1).max(50_000), expectedHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const RedemptionId = z.string().regex(/^[\w-]{4,128}$/);
const EscrowOpenIn = z
  .object({ asset: z.object({ code: z.string(), issuer: z.string() }).strict(), holder: z.string(), amount: z.string(), redemptionId: RedemptionId, deadline: z.number().int() })
  .strict();
const EscrowIssuerIn = z.object({ redemptionId: RedemptionId, issuer: z.string() }).strict();
const EscrowExpireIn = z.object({ redemptionId: RedemptionId, source: z.string() }).strict();
const TrustedIn = z.object({ assets: z.array(z.object({ code: z.string(), issuer: z.string() }).strict()).max(5000) }).strict();

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function tokenOk(header: string | undefined, expected: string): boolean {
  const got = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * The unbound-stellar gateway service: the HTTP boundary unbound-core's HttpStellarGateway talks to.
 * It owns all Stellar semantics (quotes, tx building, submission, classification). Ports make it
 * runnable on SimulatedLedger in tests or HorizonClient (UNVERIFIED against live Testnet) in dev.
 */
export function createGatewayServer(deps: GatewayDeps): Server {
  if (!deps.token || deps.token.length < 16) throw new Error('gateway token must be at least 16 characters');
  const nowMs = () => (deps.now ?? Date.now)();

  async function route(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    if (method === 'POST' && path === '/gateway/v1/quote') {
      const i = QuoteIn.parse(body);
      const q = await quoteStrictSend({ pathSource: deps.pathSource, registry: deps.registry, now: nowMs }, i as never);
      return { status: 200, body: q };
    }
    if (method === 'POST' && path === '/gateway/v1/settlement') {
      const i = SettlementIn.parse(body);
      const built = await buildSettlementTx(deps.reader, deps.registry, { quote: i.quote as never, sourceAccount: i.sourceAccount, destinationAccount: i.destinationAccount, idempotencyKey: i.idempotencyKey, nowMs: nowMs() });
      await deps.pending.add({ hash: built.hash, txMaxTimeSec: Math.floor(Date.parse(i.quote.expiresAt) / 1000), addedAt: new Date(nowMs()).toISOString() });
      return { status: 200, body: built };
    }
    if (method === 'POST' && path === '/gateway/v1/redemption-return') {
      const i = ReturnIn.parse(body);
      const asset: AssetRef = i.asset;
      deps.registry.assertTrusted(asset);
      const maxTime = Math.floor(nowMs() / 1000) + 600;
      const built = await buildRedemptionReturnTx(deps.reader, asset, i.holder, parseAmount(i.amount), { maxTime, idempotencyKey: i.idempotencyKey });
      await deps.pending.add({ hash: built.hash, txMaxTimeSec: maxTime, addedAt: new Date(nowMs()).toISOString() });
      return { status: 200, body: built };
    }
    if (method === 'POST' && path === '/gateway/v1/submit') {
      const i = SubmitIn.parse(body);
      let hash: string;
      try {
        hash = txHashOf(i.signedXdr, deps.submitter.networkPassphrase);
      } catch {
        throw new UnboundStellarError('INVALID_ASSET', 'signedXdr is not a valid transaction envelope for this network');
      }
      if (hash !== i.expectedHash) throw new HttpError(422, 'HASH_MISMATCH', 'signed transaction does not match the expected hash');
      // Make sure the worker reports the verdict even if this response is lost.
      const known = (await deps.pending.list()).some((p) => p.hash === hash);
      if (!known) await deps.pending.add({ hash, txMaxTimeSec: Math.floor(nowMs() / 1000) + 600, addedAt: new Date(nowMs()).toISOString() });
      const o = await submitSettlement(deps.submitter, deps.lookup, i.signedXdr);
      if (o.state === 'CONFIRMED') {
        return { status: 200, body: { state: 'CONFIRMED', hash: o.hash, ledger: o.ledger, ...(o.amountOutActual !== undefined ? { amountOutActual: formatAmount(o.amountOutActual) } : {}) } };
      }
      if (o.state === 'FAILED') return { status: 200, body: { state: 'FAILED', hash: o.hash, reason: o.reason } };
      return { status: 200, body: { state: 'RECONCILING', hash: o.hash, detail: o.detail } };
    }
    const bal = /^\/gateway\/v1\/accounts\/([A-Z0-9]{56})\/balances$/.exec(path);
    if (method === 'GET' && bal) {
      const acct = await deps.reader.loadAccount(bal[1]!);
      return {
        status: 200,
        body: {
          balances: (acct?.balances ?? []).map((b) => ({ asset: { code: b.asset.code, issuer: b.asset.issuer }, balance: formatAmount(b.balance), isAuthorized: b.isAuthorized })),
        },
      };
    }
    if (method === 'PUT' && path === '/gateway/v1/trusted-assets') {
      const i = TrustedIn.parse(body);
      deps.registry.replaceAll(i.assets);
      return { status: 200, body: { count: deps.registry.size() } };
    }
    if (path.startsWith('/gateway/v1/escrow/')) return escrowRoute(method, path, body);
    throw new HttpError(404, 'NOT_FOUND', 'route not found');
  }

  const builtBody = (b: BuiltSorobanTx) => ({ xdr: b.xdr, hash: b.hash, networkPassphrase: b.networkPassphrase, contractId: b.contractId, fn: b.fn, redemptionKeyHex: b.redemptionKeyHex });
  const returnBody = (r: EscrowedReturn) => ({
    consumer: r.consumer,
    issuer: r.issuer,
    token: r.token,
    amount: formatAmount(r.amount),
    deadline: r.deadline,
    openedAt: r.openedAt,
    status: r.status,
    closedAt: r.closedAt,
  });

  async function escrowRoute(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const escrow = deps.escrow;
    if (!escrow) throw new UnboundStellarError('ESCROW_UNAVAILABLE', 'the Soroban redemption escrow is not configured on this gateway');
    const nowSec = Math.floor(nowMs() / 1000);
    const watch = async (b: BuiltSorobanTx) => {
      await deps.pending.add({ hash: b.hash, txMaxTimeSec: nowSec + 300, addedAt: new Date(nowMs()).toISOString() });
      return { status: 200, body: builtBody(b) };
    };
    if (method === 'POST' && path === '/gateway/v1/escrow/open') {
      const i = EscrowOpenIn.parse(body);
      deps.registry.assertTrusted(i.asset);
      return watch(await escrow.buildOpenReturn({ consumer: i.holder, asset: i.asset, amount: parseAmount(i.amount), redemptionId: i.redemptionId, deadline: i.deadline, nowSec }));
    }
    if (method === 'POST' && path === '/gateway/v1/escrow/confirm') {
      const i = EscrowIssuerIn.parse(body);
      return watch(await escrow.buildConfirm({ issuer: i.issuer, redemptionId: i.redemptionId, nowSec }));
    }
    if (method === 'POST' && path === '/gateway/v1/escrow/reject') {
      const i = EscrowIssuerIn.parse(body);
      return watch(await escrow.buildReject({ issuer: i.issuer, redemptionId: i.redemptionId, nowSec }));
    }
    if (method === 'POST' && path === '/gateway/v1/escrow/expire') {
      const i = EscrowExpireIn.parse(body);
      return watch(await escrow.buildExpireRefund({ source: i.source, redemptionId: i.redemptionId, nowSec }));
    }
    const ret = /^\/gateway\/v1\/escrow\/returns\/([\w-]{4,128})$/.exec(path);
    if (method === 'GET' && ret) {
      const r = await escrow.getReturn(ret[1]!);
      return { status: 200, body: { contractId: escrow.contractId, return: r ? returnBody(r) : null } };
    }
    throw new HttpError(404, 'NOT_FOUND', 'route not found');
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!tokenOk(req.headers.authorization, deps.token)) throw new HttpError(401, 'UNAUTHENTICATED', 'invalid service token');
      const url = new URL(req.url ?? '/', 'http://localhost');
      let parsed: unknown;
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_BODY) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'body too large');
          chunks.push(c as Buffer);
        }
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          throw new HttpError(400, 'VALIDATION_FAILED', 'body is not valid JSON');
        }
      }
      const out = await route(req.method ?? 'GET', url.pathname, parsed);
      send(out.status, out.body);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: { code: e.code, message: e.message } });
      if (e instanceof UnboundStellarError) return send(422, { error: { code: e.code, message: e.message } });
      if (e instanceof z.ZodError) return send(400, { error: { code: 'VALIDATION_FAILED', message: 'request failed validation' } });
      send(500, { error: { code: 'INTERNAL', message: 'internal error' } });
    }
  }

  return createServer((req, res) => void handle(req, res));
}
